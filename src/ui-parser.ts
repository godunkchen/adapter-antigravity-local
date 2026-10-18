/**
 * @fileoverview Standalone UI stdout parser module for Antigravity local CLI execution.
 * Converts raw agy stream-json events into structured Paperclip TranscriptEntry objects.
 *
 * Rules:
 * 1. ZERO runtime imports (loaded dynamically in browser sandbox).
 * 2. Error tolerant - never throws, falls back gracefully.
 * 3. Export createStdoutParser and parseStdoutLine.
 */

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

export type TranscriptEntry =
  | TranscriptInitEntry
  | TranscriptAssistantEntry
  | TranscriptThinkingEntry
  | TranscriptUserEntry
  | TranscriptToolCallEntry
  | TranscriptToolResultEntry
  | TranscriptResultEntry
  | TranscriptSystemEntry
  | TranscriptStderrEntry
  | TranscriptStdoutEntry;

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
function formatToolOutput(
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
 * Formats usage metrics matching Paperclip system usage entries for step updates.
 */
function formatUsageSummary(usage: Record<string, unknown>): string | null {
  const inTokens = asNumber(usage.input_tokens, asNumber(usage.inputTokens, 0));
  const outTokens = asNumber(usage.output_tokens, asNumber(usage.outputTokens, 0));
  const totalTokens = asNumber(usage.total_tokens, inTokens + outTokens);

  if (totalTokens === 0 && inTokens === 0 && outTokens === 0) {
    return null;
  }

  return `usage updated: ${totalTokens}/200000 (${totalTokens}/200000 ctx)`;
}

/**
 * Creates a stateful stdout stream parser for Antigravity CLI output.
 * Aligned with Paperclip's `paperclip-runner` and `cursor-local` transcript parsers:
 * - Preserves inter-token whitespace on `delta: true` entries so `appendTranscriptEntry` coalesces smoothly.
 * - Tracks per-step delta streaming (`streamedAssistantStepIds`, `streamedThinkingStepIds`) and turn-level
 *   assistant text so cumulative `DONE` step summaries or `result.response` payloads do not duplicate
 *   already-streamed text.
 * - Emits deduplicated `system` entries for internal `agy` orchestration steps.
 */
function createStdoutParser() {
  const activeTools = new Map<string, { name: string; toolUseId: string; parameters: unknown }>();
  const streamedAssistantStepIds = new Set<string>();
  const streamedThinkingStepIds = new Set<string>();
  const emittedSystemStepStates = new Set<string>();
  let jsonBuffer = "";
  let toolCounter = 0;
  let lastReportedTotalTokens = 0;
  let allTurnAssistantText = "";
  let lastSegmentAssistantText = "";

  function resetTurnState() {
    activeTools.clear();
    streamedAssistantStepIds.clear();
    streamedThinkingStepIds.clear();
    emittedSystemStepStates.clear();
    lastReportedTotalTokens = 0;
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
    const rawStepType = asString(update.step_type, asString(update.type)).trim();
    const stepType = rawStepType.toLowerCase();
    const rawState = asString(update.state, asString(update.status)).trim();
    const state = rawState.toUpperCase();
    const stepKey =
      update.step_index !== undefined && update.step_index !== null
        ? String(update.step_index)
        : asString(update.id) || "default-step";
    const entries: TranscriptEntry[] = [];

    // 1. Extract interim usage metrics if present -> emit SYSTEM kind
    const usageObj = safeRecord(update.usage);
    if (usageObj) {
      const currentTotal = asNumber(usageObj.total_tokens, 0);
      if (currentTotal > 0 && currentTotal !== lastReportedTotalTokens) {
        lastReportedTotalTokens = currentTotal;
        const usageText = formatUsageSummary(usageObj);
        if (usageText) {
          entries.push({ kind: "system", ts, text: usageText });
        }
      }
    }

    // 2. Tool Execution Step (`step_type: "tool"` or explicit tool payload)
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
      const rawParameters =
        safeRecord(toolInfoObj?.parameters) ??
        safeRecord(toolInfoObj?.args) ??
        safeRecord(toolInfoObj?.arguments) ??
        safeRecord(toolInfoObj?.input) ??
        safeRecord(update.parameters) ??
        safeRecord(update.args) ??
        safeRecord(update.input) ??
        {};

      // A tool call breaks the current assistant segment
      lastSegmentAssistantText = "";

      if (
        state === "ACTIVE" ||
        state === "RUNNING" ||
        state === "IN_PROGRESS" ||
        state === "STARTED" ||
        state === "PENDING"
      ) {
        activeTools.set(toolUseId, { name: toolName, toolUseId, parameters: rawParameters });
        entries.push({
          kind: "tool_call",
          ts,
          name: toolName,
          input: rawParameters,
          toolUseId,
        });
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

        if (!activeTools.has(toolUseId)) {
          entries.push({
            kind: "tool_call",
            ts,
            name: toolName,
            input: rawParameters,
            toolUseId,
          });
        }
        activeTools.delete(toolUseId);

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

    // 4. Internal Checkpoint
    if (stepType === "checkpoint") {
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

    if (isThinkingStep || isAgentResponseStep || entries.length > 0) {
      // If this is a non-tool orchestration step that only had usage, still allow orchestration label below
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

      entries.push({
        kind: "result",
        ts,
        text: responseText,
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

  function parseLine(line: string, ts: string): TranscriptEntry[] {
    const trimmed = line.trim();
    if (!trimmed && !jsonBuffer) return [];

    // System log prefixes
    if (trimmed.startsWith("[antigravity]") || trimmed.startsWith("[paperclip]")) {
      if (jsonBuffer) {
        jsonBuffer = "";
      }
      return [{ kind: "system", ts, text: trimmed }];
    }

    // Accumulate multi-line JSON chunks if jsonBuffer is active or line starts with {
    const candidate = jsonBuffer ? `${jsonBuffer}\n${line}` : line;
    const candidateTrimmed = candidate.trim();

    if (candidateTrimmed.startsWith("{")) {
      try {
        const eventObj = safeRecord(JSON.parse(candidateTrimmed));
        if (eventObj && (typeof eventObj.event === "string" || typeof eventObj.type === "string")) {
          jsonBuffer = "";
          return processEventObject(eventObj, ts);
        }
      } catch {
        // Try sanitizing unescaped newlines in JSON strings
        try {
          const sanitized = candidateTrimmed.replace(/[\r\n]+/g, "\\n");
          const eventObj = safeRecord(JSON.parse(sanitized));
          if (eventObj && (typeof eventObj.event === "string" || typeof eventObj.type === "string")) {
            jsonBuffer = "";
            return processEventObject(eventObj, ts);
          }
        } catch {
          // Still incomplete payload
        }
        jsonBuffer = candidate;
        return [];
      }
    }

    if (jsonBuffer) {
      const flushed = jsonBuffer;
      jsonBuffer = "";
      return [{ kind: "assistant", ts, text: flushed }];
    }

    // Stderr / Errors
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("error:") || lower.startsWith("fatal:") || lower.startsWith("traceback")) {
      return [{ kind: "stderr", ts, text: trimmed }];
    }

    // Fallback plain assistant message
    return [{ kind: "assistant", ts, text: line }];
  }

  function reset() {
    jsonBuffer = "";
    toolCounter = 0;
    resetTurnState();
  }

  return { parseLine, reset };
}

const defaultModuleParser = createStdoutParser();

function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return defaultModuleParser.parseLine(line, ts);
}

export { createStdoutParser, parseStdoutLine };

if (typeof module !== "undefined" && module && module.exports) {
  module.exports = {
    createStdoutParser,
    parseStdoutLine,
  };
}
