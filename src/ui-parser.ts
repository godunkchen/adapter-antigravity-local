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
 */
function createStdoutParser() {
  const activeTools = new Map<string, { name: string; toolUseId: string; parameters: Record<string, unknown> }>();
  let jsonBuffer = "";
  let toolCounter = 0;
  let lastReportedTotalTokens = 0;

  function processEventObject(eventObj: Record<string, unknown>, ts: string): TranscriptEntry[] {
    const eventType = asString(eventObj.event, asString(eventObj.type));

    // 1. Session Init Event -> emit INIT kind
    if (eventType === "init") {
      const convId = asString(eventObj.conversation_id) || asString(safeRecord(eventObj.init)?.conversation_id);
      const modelName = asString(safeRecord(eventObj.init)?.model, "gemini-3.6-flash");
      return [
        {
          kind: "init",
          ts,
          model: modelName,
          sessionId: convId,
        },
      ];
    }

    // 2. Step Update Event
    if (eventType === "step_update" && eventObj.step_update) {
      const update = safeRecord(eventObj.step_update);
      if (!update) return [];

      const stepType = asString(update.step_type);
      const state = asString(update.state);
      const entries: TranscriptEntry[] = [];

      // Extract interim usage metrics if present -> emit SYSTEM kind
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

      // Tool Execution Step
      if (stepType === "tool") {
        const toolInfoObj = safeRecord(update.tool_info);
        const toolName = (asString(update.tool_name) || asString(toolInfoObj?.name) || "tool").trim();
        const stepIndex = typeof update.step_index === "number" ? update.step_index : ++toolCounter;
        const toolUseId = asString(update.tool_use_id) || asString(toolInfoObj?.tool_use_id) || asString(update.call_id) || `agy-tool-${stepIndex}-${toolName}`;
        const rawParameters = safeRecord(toolInfoObj?.parameters) || safeRecord(update.parameters) || {};

        if (state === "ACTIVE") {
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

        if (state === "DONE") {
          const isError = update.is_error === true || update.state === "ERROR";
          const rawOutput = toolInfoObj?.output ?? update.output ?? update.result ?? update.error;
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

      // Agent Response Step
      if (stepType === "agent_response") {
        if (typeof update.text_delta === "string" && update.text_delta.length > 0) {
          entries.push({
            kind: "assistant",
            ts,
            text: update.text_delta,
            delta: true,
          });
        } else if (typeof update.text === "string" && update.text.length > 0) {
          entries.push({
            kind: "assistant",
            ts,
            text: update.text,
          });
        }

        if (typeof update.thinking === "string" && update.thinking.length > 0) {
          entries.push({
            kind: "thinking",
            ts,
            text: update.thinking,
          });
        }
        return entries;
      }

      // User Input / Interaction Step
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

      // Internal Checkpoint
      if (stepType === "checkpoint") {
        return entries;
      }

      return entries;
    }

    // 3. User Message Event
    if (eventType === "user") {
      const userText = asString(eventObj.text) || asString(eventObj.message) || asString(safeRecord(eventObj.message)?.text);
      if (userText.trim()) {
        return [{ kind: "user", ts, text: userText.trim() }];
      }
      return [];
    }

    // 4. Final Result Event -> emit RESULT kind (and assistant text if not already emitted)
    if (eventType === "result" && eventObj.result) {
      const res = safeRecord(eventObj.result) || {};
      const usageObj = safeRecord(res.usage) || {};
      const inTokens = asNumber(usageObj.input_tokens, asNumber(usageObj.inputTokens, 0));
      const outTokens = asNumber(usageObj.output_tokens, asNumber(usageObj.outputTokens, 0));
      const cachedTokens = asNumber(
        usageObj.cache_read_tokens,
        asNumber(usageObj.cached_input_tokens, asNumber(usageObj.cachedInputTokens, 0)),
      );
      const costUsd = asNumber(res.cost_usd, asNumber(res.costUsd, asNumber(res.total_cost_usd, 0)));
      const status = asString(res.status, "success").toLowerCase();
      const isError = res.is_error === true || status === "error" || status === "failed";
      const responseText = asString(res.response, asString(res.text));
      const errors = isError
        ? [asString(res.error, responseText || "Run failed")].filter(Boolean)
        : [];

      const entries: TranscriptEntry[] = [];
      if (responseText && !isError) {
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

      return entries;
    }

    // 5. Error Event
    if (eventType === "error" || eventObj.error) {
      const errText = asString(eventObj.error, asString(safeRecord(eventObj.error)?.message, JSON.stringify(eventObj.error)));
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
        // Incomplete JSON payload, keep accumulating
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
    if (trimmed.startsWith("Error:") || trimmed.startsWith("ERROR:") || trimmed.startsWith("Traceback")) {
      return [{ kind: "stderr", ts, text: trimmed }];
    }

    // Fallback plain assistant message
    return [{ kind: "assistant", ts, text: line }];
  }

  function reset() {
    jsonBuffer = "";
    activeTools.clear();
    toolCounter = 0;
    lastReportedTotalTokens = 0;
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





