/**
 * @fileoverview Standalone UI stdout parser module for Antigravity local CLI execution.
 * Converts raw agy stream-json events into structured Paperclip TranscriptEntry objects.
 *
 * Rules:
 * 1. ZERO runtime imports (loaded dynamically in browser sandbox).
 * 2. Error tolerant - never throws, falls back gracefully.
 * 3. Export createStdoutParser and parseStdoutLine.
 */

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

export interface TranscriptToolCallEntry {
  kind: "tool_call";
  ts: string;
  name: string;
  input: unknown;
  toolUseId?: string;
}

export interface TranscriptToolResultEntry {
  kind: "tool_result";
  ts: string;
  toolUseId: string;
  content: string;
  isError: boolean;
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
  | TranscriptAssistantEntry
  | TranscriptThinkingEntry
  | TranscriptToolCallEntry
  | TranscriptToolResultEntry
  | TranscriptSystemEntry
  | TranscriptStderrEntry
  | TranscriptStdoutEntry;

/**
 * Creates a stateful stdout stream parser for Antigravity CLI output.
 */
export function createStdoutParser() {
  const activeTools = new Map<string, { name: string; toolUseId: string; parameters: unknown }>();
  let toolCounter = 0;

  function parseLine(line: string, ts: string): TranscriptEntry[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    // System log prefixes
    if (trimmed.startsWith("[antigravity]") || trimmed.startsWith("[paperclip]")) {
      return [{ kind: "system", ts, text: trimmed }];
    }

    // Parse agy stream-json event line
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const eventObj = JSON.parse(trimmed);
        if (eventObj && typeof eventObj === "object") {
          const eventType = eventObj.event;

          // 1. Session Init Event
          if (eventType === "init") {
            const convId = eventObj.conversation_id || eventObj.init?.conversation_id;
            return [
              {
                kind: "system",
                ts,
                text: `[antigravity] Session initialized${convId ? ` (${convId})` : ""}`,
              },
            ];
          }

          // 2. Step Update Event
          if (eventType === "step_update" && eventObj.step_update) {
            const update = eventObj.step_update;
            const stepType = update.step_type;
            const state = update.state;

            // Tool Execution Step
            if (stepType === "tool") {
              const toolName = update.tool_name || update.tool_info?.name || "tool";
              const stepIndex = update.step_index ?? ++toolCounter;
              const toolUseId = `agy-tool-${stepIndex}-${toolName}`;
              const parameters = update.tool_info?.parameters || {};

              if (state === "ACTIVE") {
                activeTools.set(toolUseId, { name: toolName, toolUseId, parameters });
                return [
                  {
                    kind: "tool_call",
                    ts,
                    name: toolName,
                    input: parameters,
                    toolUseId,
                  },
                ];
              }

              if (state === "DONE") {
                const isError = update.is_error === true || update.state === "ERROR";
                const durationStr = typeof update.duration_seconds === "number" ? `${update.duration_seconds.toFixed(2)}s` : "";

                let contentStr = "";
                if (update.result) {
                  contentStr = typeof update.result === "string" ? update.result : JSON.stringify(update.result);
                } else if (parameters && Object.keys(parameters).length > 0) {
                  contentStr = JSON.stringify(parameters);
                } else {
                  contentStr = durationStr ? `Completed in ${durationStr}` : "Done";
                }

                const entries: TranscriptEntry[] = [];
                if (!activeTools.has(toolUseId)) {
                  entries.push({
                    kind: "tool_call",
                    ts,
                    name: toolName,
                    input: parameters,
                    toolUseId,
                  });
                }
                activeTools.delete(toolUseId);

                entries.push({
                  kind: "tool_result",
                  ts,
                  toolUseId,
                  content: contentStr,
                  isError,
                });
                return entries;
              }
            }

            // Agent Response Step
            if (stepType === "agent_response") {
              const entries: TranscriptEntry[] = [];
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

            // Internal Checkpoint / User input
            if (stepType === "checkpoint" || stepType === "user_input") {
              return [];
            }
          }

          // 3. Final Result Event
          if (eventType === "result" && eventObj.result) {
            const res = eventObj.result;
            const entries: TranscriptEntry[] = [];
            if (typeof res.response === "string" && res.response.trim().length > 0) {
              entries.push({
                kind: "assistant",
                ts,
                text: res.response,
              });
            }
            return entries;
          }
        }
      } catch {
        // Fall back to plain text formatting
      }
    }

    // Stderr / Errors
    if (trimmed.startsWith("Error:") || trimmed.startsWith("ERROR:") || trimmed.startsWith("Traceback")) {
      return [{ kind: "stderr", ts, text: trimmed }];
    }

    // Fallback plain assistant message
    return [{ kind: "assistant", ts, text: line }];
  }

  function reset() {
    activeTools.clear();
    toolCounter = 0;
  }

  return { parseLine, reset };
}

/**
 * Static parser entry point fallback.
 */
export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parser = createStdoutParser();
  return parser.parseLine(line, ts);
}
