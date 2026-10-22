/**
 * @fileoverview Core stdout parser logic for Antigravity local CLI execution.
 * Converts raw agy stream-json events into structured Paperclip TranscriptEntry objects.
 *
 * Rules:
 * 1. ZERO runtime external dependencies.
 * 2. Error tolerant - never throws, falls back gracefully.
 * 3. Supports both stateless single-line parsing (for Web Worker line caching)
 *    and stateful multi-line / turn-aware parsing via `createStdoutParser`.
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export interface TranscriptInitEntry {
  kind: "init";
  ts: string;
  model: string;
  sessionId: string;
}

export interface TranscriptAssistantEntry {
  kind: "assistant";
  ts: string;
  text: string;
  delta?: boolean;
}

export interface TranscriptThinkingEntry {
  kind: "thinking";
  ts: string;
  text: string;
  delta?: boolean;
}

export interface TranscriptUserEntry {
  kind: "user";
  ts: string;
  text: string;
}

export interface TranscriptToolCallEntry {
  kind: "tool_call";
  ts: string;
  name: string;
  input: unknown;
  toolUseId?: string;
  invocationId?: string;
  actionRequestId?: string;
}

export interface TranscriptToolResultEntry {
  kind: "tool_result";
  ts: string;
  toolUseId: string;
  toolName?: string;
  content: string;
  isError: boolean;
}

export interface TranscriptResultEntry {
  kind: "result";
  ts: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  subtype: string;
  isError: boolean;
  errors: string[];
}

export interface TranscriptSystemEntry {
  kind: "system";
  ts: string;
  text: string;
}

export interface TranscriptStderrEntry {
  kind: "stderr";
  ts: string;
  text: string;
}

export interface TranscriptStdoutEntry {
  kind: "stdout";
  ts: string;
  text: string;
}

export type { TranscriptEntry };

function safeRecord(val: unknown): Record<string, unknown> | null {
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return null;
}

function asString(val: unknown, fallback = ""): string {
  return typeof val === "string" ? val : fallback;
}

function asNumber(val: unknown, fallback = 0): number {
  return typeof val === "number" && Number.isFinite(val) ? val : fallback;
}

/**
 * Formats tool execution output into clean text without synthetic markdown code fences or duration headers.
 * The Paperclip UI natively renders code formatting, status icons, and durations from entry timestamps.
 */
export function formatToolOutput(
  rawOutput: unknown,
  toolName: string,
  isError: boolean,
): string {
  if (typeof rawOutput === "string") {
    return rawOutput;
  }
  if (rawOutput && typeof rawOutput === "object") {
    try {
      return JSON.stringify(rawOutput, null, 2);
    } catch {
      return String(rawOutput);
    }
  }
  if (rawOutput !== undefined && rawOutput !== null) {
    return String(rawOutput);
  }
  return isError ? `${toolName} execution failed` : `${toolName} completed`;
}

/**
 * Normalizes Antigravity tool input parameters (PascalCase keys like CommandLine, AbsolutePath,
 * TargetFile, Query, Pattern, SearchPath, Url) to also include standard lowercase keys expected by
 * Paperclip's RunTranscriptView and TaskChatThread (`command`, `cwd`, `path`, `query`, `url`, `prompt`, `message`).
 */
export function normalizeToolInput(
  rawParameters: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...rawParameters };

  const commandLine = asString(rawParameters.CommandLine) || asString(rawParameters.command);
  if (commandLine && typeof normalized.command !== "string") {
    normalized.command = commandLine;
  }
  const cwd = asString(rawParameters.Cwd) || asString(rawParameters.cwd);
  if (cwd && typeof normalized.cwd !== "string") {
    normalized.cwd = cwd;
  }

  const filePath =
    asString(rawParameters.AbsolutePath) ||
    asString(rawParameters.TargetFile) ||
    asString(rawParameters.DirectoryPath) ||
    asString(rawParameters.File);
  if (filePath && typeof normalized.path !== "string") {
    normalized.path = filePath;
  }

  const searchQuery = asString(rawParameters.Query) || asString(rawParameters.Pattern);
  const searchScope = asString(rawParameters.SearchPath) || asString(rawParameters.SearchDirectory);
  if (searchQuery && typeof normalized.query !== "string") {
    normalized.query = searchScope ? `${searchQuery} in ${searchScope}` : searchQuery;
  } else if (searchScope && typeof normalized.path !== "string" && !searchQuery) {
    normalized.path = searchScope;
  }

  const url = asString(rawParameters.Url);
  if (url && typeof normalized.url !== "string") {
    normalized.url = url;
  }

  const promptText =
    asString(rawParameters.Prompt) ||
    asString(rawParameters.Instruction) ||
    asString(rawParameters.Description);
  if (
    promptText &&
    typeof normalized.prompt !== "string" &&
    !commandLine &&
    !filePath &&
    !searchQuery &&
    !url
  ) {
    normalized.prompt = promptText;
  }

  const messageText = asString(rawParameters.Message) || asString(rawParameters.Input);
  if (
    messageText &&
    typeof normalized.message !== "string" &&
    !commandLine &&
    !filePath &&
    !searchQuery &&
    !url
  ) {
    normalized.message = messageText;
  }

  return normalized;
}

/**
 * Detects whether a line that does not start with `{` is actually a mid-line sliced
 * NDJSON tail fragment (caused by Paperclip's 8KB live WebSocket tail-slice or 256KB offset reads).
 */
export function isLikelyJsonFragment(trimmed: string): boolean {
  if (
    trimmed.includes('"conversation_id":') ||
    trimmed.includes('"step_update":') ||
    trimmed.includes('"step_index":') ||
    trimmed.includes('"step_type":') ||
    trimmed.includes('"tool_info":') ||
    trimmed.includes('"tool_name":') ||
    trimmed.includes('"thinking_delta":') ||
    trimmed.includes('"text_delta":') ||
    trimmed.includes('"event":"') ||
    trimmed.includes('"event": "')
  ) {
    return true;
  }
  if ((trimmed.endsWith("}") || trimmed.endsWith("}}") || trimmed.endsWith('"}')) && /"[a-zA-Z0-9_]+":/.test(trimmed)) {
    return true;
  }
  return false;
}

function unescapePartialJsonString(raw: string): string {
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function extractJsonStringField(line: string, fieldName: string): string {
  const escapedField = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const completeRegex = new RegExp(`"${escapedField}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
  const completeMatch = completeRegex.exec(line);
  if (completeMatch && completeMatch[1] !== undefined) {
    return unescapePartialJsonString(completeMatch[1]);
  }
  const partialRegex = new RegExp(`"${escapedField}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)$`);
  const partialMatch = partialRegex.exec(line);
  if (partialMatch && partialMatch[1] !== undefined) {
    return unescapePartialJsonString(partialMatch[1]);
  }
  return "";
}

function extractSalvagedToolInput(trimmed: string): Record<string, unknown> {
  const rawParams: Record<string, unknown> = {};
  const cmdLine =
    extractJsonStringField(trimmed, "CommandLine") || extractJsonStringField(trimmed, "command");
  if (cmdLine) rawParams.CommandLine = cmdLine;
  const cwd = extractJsonStringField(trimmed, "Cwd") || extractJsonStringField(trimmed, "cwd");
  if (cwd) rawParams.Cwd = cwd;
  const absPath =
    extractJsonStringField(trimmed, "AbsolutePath") ||
    extractJsonStringField(trimmed, "TargetFile") ||
    extractJsonStringField(trimmed, "DirectoryPath");
  if (absPath) rawParams.AbsolutePath = absPath;
  const query = extractJsonStringField(trimmed, "Query") || extractJsonStringField(trimmed, "Pattern");
  if (query) rawParams.Query = query;
  const searchPath =
    extractJsonStringField(trimmed, "SearchPath") ||
    extractJsonStringField(trimmed, "SearchDirectory");
  if (searchPath) rawParams.SearchPath = searchPath;
  const url = extractJsonStringField(trimmed, "Url");
  if (url) rawParams.Url = url;
  return normalizeToolInput(rawParams);
}

/**
 * Best-effort salvage for a single NDJSON line starting with `{` that was truncated
 * at the 256KB log page boundary (`RUN_LOG_PAGE_BYTES`) so the user still sees a clean
 * human-readable entry instead of raw JSON or a poisoned parser buffer.
 */
function salvageTruncatedJsonLine(
  trimmed: string,
  ts: string,
  activeTools: Map<string, { name: string; toolUseId: string; parameters: unknown }>,
  emittedActiveToolIds: Set<string>,
): TranscriptEntry[] {
  const eventType = extractJsonStringField(trimmed, "event") || extractJsonStringField(trimmed, "type");
  if (eventType === "init") {
    const convId = extractJsonStringField(trimmed, "conversation_id") || extractJsonStringField(trimmed, "session_id");
    const modelName = extractJsonStringField(trimmed, "model") || "gemini-3.6-flash";
    return [{ kind: "init", ts, model: modelName, sessionId: convId }];
  }

  const stepType = (extractJsonStringField(trimmed, "step_type") || "").toLowerCase();
  const state = (extractJsonStringField(trimmed, "state") || extractJsonStringField(trimmed, "status") || "").toUpperCase();
  const toolName = extractJsonStringField(trimmed, "tool_name") || extractJsonStringField(trimmed, "name");

  if (stepType === "tool" || Boolean(toolName)) {
    const resolvedTool = (toolName || "tool").trim();
    const stepIdxMatch = /"step_index"\s*:\s*(\d+)/.exec(trimmed);
    const stepIdx = stepIdxMatch ? stepIdxMatch[1] : "truncated";
    const convId = extractJsonStringField(trimmed, "conversation_id") || extractJsonStringField(trimmed, "session_id");
    const rawToolUseId =
      extractJsonStringField(trimmed, "tool_use_id") || `agy-tool-${stepIdx}-${resolvedTool}`;
    const scopedToolUseId = convId ? `${convId}:${rawToolUseId}` : rawToolUseId;
    const salvagedInput = extractSalvagedToolInput(trimmed);

    if (
      state === "DONE" ||
      state === "COMPLETED" ||
      state === "ERROR" ||
      state === "FAILED" ||
      state === "CANCELLED"
    ) {
      const isError = state === "ERROR" || state === "FAILED" || state === "CANCELLED" || /"is_error"\s*:\s*true/.test(trimmed);
      const rawOutput =
        extractJsonStringField(trimmed, "output") ||
        extractJsonStringField(trimmed, "result") ||
        extractJsonStringField(trimmed, "error");
      const entries: TranscriptEntry[] = [];
      if (!activeTools.has(scopedToolUseId) && !emittedActiveToolIds.has(scopedToolUseId)) {
        emittedActiveToolIds.add(scopedToolUseId);
        entries.push({
          kind: "tool_call",
          ts,
          name: resolvedTool,
          input: salvagedInput,
          toolUseId: rawToolUseId,
        });
      }
      activeTools.delete(scopedToolUseId);
      entries.push({
        kind: "tool_result",
        ts,
        toolUseId: rawToolUseId,
        toolName: resolvedTool,
        content: rawOutput ? `${rawOutput}\n...[truncated]` : formatToolOutput(undefined, resolvedTool, isError),
        isError,
      });
      return entries;
    }

    if (!emittedActiveToolIds.has(scopedToolUseId)) {
      emittedActiveToolIds.add(scopedToolUseId);
      activeTools.set(scopedToolUseId, { name: resolvedTool, toolUseId: rawToolUseId, parameters: salvagedInput });
      return [
        {
          kind: "tool_call",
          ts,
          name: resolvedTool,
          input: salvagedInput,
          toolUseId: rawToolUseId,
        },
      ];
    }
    return [];
  }

  const thinkingText =
    extractJsonStringField(trimmed, "thinking_delta") ||
    extractJsonStringField(trimmed, "thought_delta") ||
    extractJsonStringField(trimmed, "thinking") ||
    extractJsonStringField(trimmed, "thought");
  if (thinkingText) {
    return [{ kind: "thinking", ts, text: thinkingText, delta: true }];
  }

  const assistantText =
    extractJsonStringField(trimmed, "text_delta") ||
    extractJsonStringField(trimmed, "response") ||
    (stepType === "agent_response" || stepType === "assistant" ? extractJsonStringField(trimmed, "text") : "");
  if (assistantText) {
    return [{ kind: "assistant", ts, text: assistantText, delta: true }];
  }

  return [];
}

function isNewJsonEventStart(trimmed: string): boolean {
  return (
    trimmed.startsWith('{"event"') ||
    trimmed.startsWith('{ "event"') ||
    trimmed.startsWith('{"type"') ||
    trimmed.startsWith('{ "type"')
  );
}

/**
 * Creates a stateful stdout stream parser for Antigravity CLI output.
 * Aligned with Paperclip's `claude-local`, `paperclip-runner`, and `cursor-local` transcript parsers:
 * - Preserves inter-token whitespace on `delta: true` entries so `appendTranscriptEntry` coalesces smoothly.
 * - Tracks per-step delta streaming (`streamedAssistantStepIds`, `streamedThinkingStepIds`) and turn-level
 *   assistant text so cumulative `DONE` step summaries or `result.response` payloads do not duplicate
 *   already-streamed text, while emitting fallback assistant text on `result` when no deltas were streamed.
 * - Normalizes tool parameters (`command`, `path`, `query`, `url`) so `RunTranscriptView` groups consecutive
 *   commands/tools and displays human-readable summaries.
 * - Emits deduplicated `system` entries for internal `agy` orchestration steps without flooding the transcript
 *   with per-step token usage lines between tool calls.
 * - Repairs Paperclip secret-redactor quote corruption (`***REDACTED***"`) and salvages truncated JSON lines.
 */
export function createStdoutParser() {
  const activeTools = new Map<string, { name: string; toolUseId: string; parameters: unknown }>();
  const emittedActiveToolIds = new Set<string>();
  const streamedAssistantStepIds = new Set<string>();
  const streamedThinkingStepIds = new Set<string>();
  const emittedSystemStepStates = new Set<string>();
  let jsonBuffer = "";
  let toolCounter = 0;
  let allTurnAssistantText = "";
  let lastSegmentAssistantText = "";

  function resetTurnState() {
    activeTools.clear();
    emittedActiveToolIds.clear();
    streamedAssistantStepIds.clear();
    streamedThinkingStepIds.clear();
    emittedSystemStepStates.clear();
    allTurnAssistantText = "";
    lastSegmentAssistantText = "";
  }

  function recordAssistantEmission(text: string) {
    allTurnAssistantText += text;
    lastSegmentAssistantText += text;
  }

  function processStepUpdate(
    update: Record<string, unknown>,
    eventObj: Record<string, unknown>,
    ts: string,
  ): TranscriptEntry[] {
    const convPrefix = asString(eventObj.conversation_id) || asString(eventObj.session_id);
    const rawStepType = asString(update.step_type, asString(update.type)).trim();
    const stepType = rawStepType.toLowerCase();
    const rawState = asString(update.state, asString(update.status)).trim();
    const state = rawState.toUpperCase();
    const rawStepKey =
      update.step_index !== undefined && update.step_index !== null
        ? String(update.step_index)
        : asString(update.id) || "default-step";
    const stepKey = convPrefix ? `${convPrefix}:${rawStepKey}` : rawStepKey;
    const entries: TranscriptEntry[] = [];

    // 1. Tool Execution Step (`step_type: "tool"` or explicit tool payload)
    const toolInfoObj = safeRecord(update.tool_info) ?? safeRecord(update.tool_call);
    if (stepType === "tool" || Boolean(update.tool_name || toolInfoObj)) {
      const toolName = (
        asString(update.tool_name) ||
        asString(toolInfoObj?.name) ||
        asString(update.name) ||
        asString(update.title) ||
        "tool"
      ).trim();
      const stepIndex =
        typeof update.step_index === "number"
          ? update.step_index
          : asString(update.id) || ++toolCounter;
      const toolUseId =
        asString(update.tool_use_id) ||
        asString(toolInfoObj?.tool_use_id) ||
        asString(toolInfoObj?.id) ||
        asString(update.call_id) ||
        `agy-tool-${stepIndex}-${toolName}`;
      const scopedToolUseId = convPrefix ? `${convPrefix}:${toolUseId}` : toolUseId;
      const rawParameters =
        safeRecord(toolInfoObj?.parameters) ??
        safeRecord(toolInfoObj?.args) ??
        safeRecord(toolInfoObj?.arguments) ??
        safeRecord(toolInfoObj?.input) ??
        safeRecord(update.parameters) ??
        safeRecord(update.args) ??
        safeRecord(update.input) ??
        {};
      const normalizedParameters = normalizeToolInput(rawParameters);

      // A tool call breaks the current assistant segment
      lastSegmentAssistantText = "";

      if (
        state === "ACTIVE" ||
        state === "RUNNING" ||
        state === "IN_PROGRESS" ||
        state === "STARTED" ||
        state === "PENDING"
      ) {
        if (!emittedActiveToolIds.has(scopedToolUseId)) {
          emittedActiveToolIds.add(scopedToolUseId);
          activeTools.set(scopedToolUseId, { name: toolName, toolUseId, parameters: normalizedParameters });
          entries.push({
            kind: "tool_call",
            ts,
            name: toolName,
            input: normalizedParameters,
            toolUseId,
          });
        }
        return entries;
      }

      if (
        state === "DONE" ||
        state === "COMPLETED" ||
        state === "ERROR" ||
        state === "FAILED" ||
        state === "CANCELLED"
      ) {
        const isError =
          update.is_error === true ||
          toolInfoObj?.is_error === true ||
          state === "ERROR" ||
          state === "FAILED" ||
          state === "CANCELLED";
        const rawOutput =
          toolInfoObj?.output ??
          toolInfoObj?.result ??
          toolInfoObj?.error ??
          update.output ??
          update.result ??
          update.error;
        const content = formatToolOutput(rawOutput, toolName, isError);

        if (!activeTools.has(scopedToolUseId) && !emittedActiveToolIds.has(scopedToolUseId)) {
          emittedActiveToolIds.add(scopedToolUseId);
          entries.push({
            kind: "tool_call",
            ts,
            name: toolName,
            input: normalizedParameters,
            toolUseId,
          });
        }
        activeTools.delete(scopedToolUseId);
        // Also remove from emittedActiveToolIds on completion so if the same step index
        // is reused in a subsequent stateless/shared worker turn, a new ACTIVE call is not dropped!
        emittedActiveToolIds.delete(scopedToolUseId);

        entries.push({
          kind: "tool_result",
          ts,
          toolUseId,
          toolName,
          content,
          isError,
        });
        return entries;
      }
    }

    // 3. User Input / Interaction Step
    if (stepType === "user_input" || stepType === "user") {
      const userText = asString(update.text) || asString(update.prompt) || asString(eventObj.message);
      if (userText.trim()) {
        entries.push({
          kind: "user",
          ts,
          text: userText.trim(),
        });
      }
      return entries;
    }

    // 4. Internal Checkpoint / Empty System Message
    if (
      stepType === "checkpoint" ||
      (stepType === "system_message" &&
        !asString(update.text) &&
        !asString(update.message) &&
        !asString(update.title))
    ) {
      return entries;
    }

    // 5. Thinking & Agent Response Steps (supports both incremental deltas and cumulative text)
    const isThinkingStep = stepType === "thinking" || stepType === "thought" || stepType === "reasoning";
    const isAgentResponseStep =
      stepType === "agent_response" ||
      stepType === "assistant" ||
      stepType === "message" ||
      stepType === "";

    const thinkingDelta =
      asString(update.thinking_delta) ||
      asString(update.thought_delta) ||
      (isThinkingStep ? asString(update.delta) || asString(update.text_delta) : "");
    if (thinkingDelta.length > 0) {
      streamedThinkingStepIds.add(stepKey);
      entries.push({
        kind: "thinking",
        ts,
        text: thinkingDelta,
        delta: true,
      });
    }

    const thinkingFull =
      asString(update.thinking) ||
      asString(update.thought) ||
      (isThinkingStep && !thinkingDelta ? asString(update.text) || asString(update.content) : "");
    if (thinkingFull.length > 0 && !streamedThinkingStepIds.has(stepKey)) {
      entries.push({
        kind: "thinking",
        ts,
        text: thinkingFull,
      });
    }
    if (isThinkingStep && (state === "DONE" || state === "COMPLETED")) {
      streamedThinkingStepIds.delete(stepKey);
    }

    const textDelta = !isThinkingStep
      ? asString(update.text_delta) || (isAgentResponseStep ? asString(update.delta) : "")
      : "";
    if (textDelta.length > 0) {
      streamedAssistantStepIds.add(stepKey);
      recordAssistantEmission(textDelta);
      entries.push({
        kind: "assistant",
        ts,
        text: textDelta,
        delta: true,
      });
    }

    if (isAgentResponseStep && !textDelta) {
      const fullText = asString(update.text) || asString(update.response) || asString(update.content);
      if (fullText.length > 0 && !streamedAssistantStepIds.has(stepKey)) {
        recordAssistantEmission(fullText);
        entries.push({
          kind: "assistant",
          ts,
          text: fullText,
        });
      }
    }
    if (isAgentResponseStep && (state === "DONE" || state === "COMPLETED")) {
      streamedAssistantStepIds.delete(stepKey);
    }

    if (isThinkingStep || isAgentResponseStep || entries.length > 0) {
      if (isThinkingStep || isAgentResponseStep || thinkingDelta || thinkingFull || textDelta) {
        return entries;
      }
    }

    // 6. Non-tool internal orchestration step (e.g. planning, subagent, task, etc.) -> emit deduplicated SYSTEM line
    const stepLabel = (
      asString(update.title) ||
      asString(update.description) ||
      asString(update.message) ||
      asString(update.summary) ||
      asString(update.name)
    ).trim();

    if (rawStepType || stepLabel) {
      const dedupKey = `${stepKey}:${state}:${rawStepType}:${stepLabel}`;
      if (!emittedSystemStepStates.has(dedupKey)) {
        emittedSystemStepStates.add(dedupKey);
        const stateTag = state ? ` [${state.toLowerCase()}]` : "";
        const text =
          stepLabel && stepLabel !== rawStepType
            ? `step${rawStepType ? ` (${rawStepType})` : ""}${stateTag}: ${stepLabel}`
            : `step${stateTag}: ${rawStepType || stepLabel}`;
        entries.push({ kind: "system", ts, text });
      }
    }

    return entries;
  }

  function processEventObject(eventObj: Record<string, unknown>, ts: string): TranscriptEntry[] {
    const eventType = asString(eventObj.event, asString(eventObj.type)).trim();

    // 1. Session Init Event -> reset turn state and emit INIT kind
    if (eventType === "init") {
      resetTurnState();
      const initObj = safeRecord(eventObj.init);
      const convId =
        asString(eventObj.conversation_id) ||
        asString(eventObj.session_id) ||
        asString(initObj?.conversation_id) ||
        asString(initObj?.session_id);
      const modelName = asString(initObj?.model, asString(eventObj.model, "gemini-3.6-flash"));
      return [
        {
          kind: "init",
          ts,
          model: modelName,
          sessionId: convId,
        },
      ];
    }

    // 2. Step Update Event (`eventObj.step_update` or `eventObj.step`)
    if (eventType === "step_update" || eventType === "step") {
      const update = safeRecord(eventObj.step_update) ?? safeRecord(eventObj.step);
      if (!update) return [];
      return processStepUpdate(update, eventObj, ts);
    }

    // 2b. Direct top-level `agent_response` or `thinking` event
    if (eventType === "agent_response" || eventType === "thinking" || eventType === "thought") {
      return processStepUpdate({ ...eventObj, step_type: eventType }, eventObj, ts);
    }

    // 3. User Message Event
    if (eventType === "user") {
      const userText =
        asString(eventObj.text) ||
        asString(eventObj.message) ||
        asString(safeRecord(eventObj.message)?.text);
      if (userText.trim()) {
        return [{ kind: "user", ts, text: userText.trim() }];
      }
      return [];
    }

    // 4. Final Result Event -> emit RESULT kind (and fallback assistant text only if not already streamed)
    if (eventType === "result") {
      const res = safeRecord(eventObj.result) ?? eventObj;
      const usageObj = safeRecord(res.usage) ?? safeRecord(eventObj.usage) ?? {};
      const inTokens = asNumber(usageObj.input_tokens, asNumber(usageObj.inputTokens, 0));
      const outTokens = asNumber(usageObj.output_tokens, asNumber(usageObj.outputTokens, 0));
      const cachedTokens = asNumber(
        usageObj.cache_read_tokens,
        asNumber(usageObj.cached_input_tokens, asNumber(usageObj.cachedInputTokens, 0)),
      );
      const costUsd = asNumber(
        res.cost_usd,
        asNumber(res.costUsd, asNumber(res.total_cost_usd, asNumber(eventObj.total_cost_usd, 0))),
      );
      const status = asString(res.status, asString(eventObj.status, "success")).toLowerCase();
      const isError =
        res.is_error === true ||
        eventObj.is_error === true ||
        status === "error" ||
        status === "failed";
      const responseText = asString(
        res.response,
        asString(res.text, typeof eventObj.result === "string" ? eventObj.result : ""),
      );
      const errors = isError
        ? [asString(res.error, asString(eventObj.error, responseText || "Run failed"))].filter(Boolean)
        : [];

      const entries: TranscriptEntry[] = [];
      const normResponse = responseText.trim();
      const alreadyStreamedSameResponse =
        normResponse.length > 0 &&
        (normResponse === lastSegmentAssistantText.trim() ||
          normResponse === allTurnAssistantText.trim() ||
          allTurnAssistantText.trim().endsWith(normResponse));

      if (responseText && !isError && !alreadyStreamedSameResponse) {
        entries.push({
          kind: "assistant",
          ts,
          text: responseText,
        });
      }

      const resultDisplayText = isError
        ? responseText || errors[0] || "Run failed"
        : alreadyStreamedSameResponse
          ? "Completed"
          : responseText;

      entries.push({
        kind: "result",
        ts,
        text: resultDisplayText,
        inputTokens: inTokens,
        outputTokens: outTokens,
        cachedTokens,
        costUsd,
        subtype: status,
        isError,
        errors,
      });

      resetTurnState();
      return entries;
    }

    // 5. Error Event
    if (eventType === "error" || eventObj.error) {
      const errText = asString(
        eventObj.error,
        asString(safeRecord(eventObj.error)?.message, JSON.stringify(eventObj.error)),
      );
      return [{ kind: "stderr", ts, text: errText || "error" }];
    }

    return [];
  }

  function tryParseJsonEvent(candidateTrimmed: string, ts: string): TranscriptEntry[] | null {
    try {
      const eventObj = safeRecord(JSON.parse(candidateTrimmed));
      if (eventObj && (typeof eventObj.event === "string" || typeof eventObj.type === "string")) {
        return processEventObject(eventObj, ts);
      }
    } catch {
      try {
        const sanitized = candidateTrimmed
          .replace(/[\r\n]+/g, "\\n")
          .replace(/\*\*\*REDACTED\*\*\*"(?!\s*[,}\]:])/g, '***REDACTED***\\"');
        const eventObj = safeRecord(JSON.parse(sanitized));
        if (eventObj && (typeof eventObj.event === "string" || typeof eventObj.type === "string")) {
          return processEventObject(eventObj, ts);
        }
      } catch {
        // Still incomplete
      }
    }
    return null;
  }

  function flushTruncatedJsonBuffer(ts: string): TranscriptEntry[] {
    if (!jsonBuffer) return [];
    const pending = jsonBuffer.trim();
    jsonBuffer = "";
    if (!pending) return [];
    return salvageTruncatedJsonLine(pending, ts, activeTools, emittedActiveToolIds);
  }

  function parseLine(line: string, ts: string): TranscriptEntry[] {
    const trimmed = line.trim();
    if (!trimmed && !jsonBuffer) return [];

    // System log prefixes
    if (trimmed.startsWith("[antigravity]") || trimmed.startsWith("[paperclip]")) {
      const salvaged = flushTruncatedJsonBuffer(ts);
      return [...salvaged, { kind: "system", ts, text: trimmed }];
    }

    let salvagedFromPrevious: TranscriptEntry[] = [];
    if (jsonBuffer) {
      if (trimmed && !isNewJsonEventStart(trimmed)) {
        const combined = `${jsonBuffer}\n${line}`.trim();
        const combinedParsed = tryParseJsonEvent(combined, ts);
        if (combinedParsed !== null) {
          jsonBuffer = "";
          return combinedParsed;
        }
      }
      salvagedFromPrevious = flushTruncatedJsonBuffer(ts);
      if (!trimmed) {
        return salvagedFromPrevious;
      }
    }

    if (trimmed.startsWith("{")) {
      const parsed = tryParseJsonEvent(trimmed, ts);
      if (parsed !== null) {
        return salvagedFromPrevious.length > 0 ? [...salvagedFromPrevious, ...parsed] : parsed;
      }
      jsonBuffer = line;
      return salvagedFromPrevious;
    }

    // Suppress mid-line sliced NDJSON tail fragments (from 8KB WebSocket tail-slicing or 256KB offset reads)
    if (isLikelyJsonFragment(trimmed)) {
      return salvagedFromPrevious;
    }

    // Stderr / Errors
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("error:") || lower.startsWith("fatal:") || lower.startsWith("traceback")) {
      return [...salvagedFromPrevious, { kind: "stderr", ts, text: trimmed }];
    }

    // Fallback plain assistant message
    return [...salvagedFromPrevious, { kind: "assistant", ts, text: line }];
  }

  function reset() {
    jsonBuffer = "";
    toolCounter = 0;
    resetTurnState();
  }

  return { parseLine, reset };
}

const defaultModuleParser = createStdoutParser();

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return defaultModuleParser.parseLine(line, ts);
}
