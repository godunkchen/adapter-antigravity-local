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
  | TranscriptInitEntry
  | TranscriptAssistantEntry
  | TranscriptThinkingEntry
  | TranscriptToolCallEntry
  | TranscriptToolResultEntry
  | TranscriptSystemEntry
  | TranscriptStderrEntry
  | TranscriptStdoutEntry;

function safeRecord(val: unknown): Record<string, unknown> | null {
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return null;
}

/**
 * Maps agy tool calls into Paperclip command tool execution shapes.
 * Paperclip UI's isCommandTool requires:
 * 1. name === "command_execution" or "bash" or "shell"
 * 2. input contains { command: string }
 */
function resolveToolCallDisplay(toolName: string, parameters: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
  const name = (toolName || "").toLowerCase();

  if (name === "run_command") {
    const commandStr = typeof parameters.CommandLine === "string" ? parameters.CommandLine : "";
    return {
      name: "command_execution",
      input: { command: commandStr, ...(parameters.Cwd ? { cwd: parameters.Cwd } : {}) },
    };
  }

  if (name === "grep_search") {
    const query = typeof parameters.Query === "string" ? parameters.Query : "";
    const path = typeof parameters.SearchPath === "string" ? parameters.SearchPath : ".";
    return {
      name: "command_execution",
      input: { command: `grep "${query}" ${path}` },
    };
  }

  if (name === "find_by_name") {
    const pattern = typeof parameters.Pattern === "string" ? parameters.Pattern : "";
    const dir = typeof parameters.SearchDirectory === "string" ? parameters.SearchDirectory : ".";
    return {
      name: "command_execution",
      input: { command: `find ${dir} -name "${pattern}"` },
    };
  }

  if (name === "view_file" || name === "read_file") {
    const file = typeof parameters.AbsolutePath === "string" ? parameters.AbsolutePath : "";
    return {
      name: "command_execution",
      input: { command: `cat ${file}` },
    };
  }

  if (name === "write_to_file" || name === "replace_file_content") {
    const file = typeof parameters.TargetFile === "string" ? parameters.TargetFile : "";
    return {
      name: "command_execution",
      input: { command: `write ${file}` },
    };
  }

  return {
    name: "command_execution",
    input: { command: toolName || "tool_call", ...parameters },
  };
}

/**
 * Formats tool execution output into clean text.
 */
function formatToolOutputContent(
  rawOutput: unknown,
  parameters: Record<string, unknown>,
  durationStr: string,
  isError: boolean,
): string {
  let text = "";
  if (typeof rawOutput === "string") {
    text = rawOutput.trim();
  } else if (rawOutput && typeof rawOutput === "object") {
    try {
      text = JSON.stringify(rawOutput, null, 2);
    } catch {
      text = String(rawOutput);
    }
  }

  if (!text && parameters && Object.keys(parameters).length > 0) {
    try {
      text = JSON.stringify(parameters, null, 2);
    } catch {
      text = "";
    }
  }

  const metaTag = isError ? " (error)" : " (completed)";
  const header = `tool call${metaTag}:${durationStr ? `  ${durationStr}` : ""}`;

  if (!text) {
    return header;
  }

  if (text.includes("\n") || text.length > 80) {
    const truncated = text.length > 2000 ? `${text.slice(0, 2000)}\n... (truncated ${text.length - 2000} chars)` : text;
    return `${header}: \`\`\`console\n${truncated}\n\`\`\``;
  }

  return `${header}: ${text}`;
}

/**
 * Formats usage metrics matching Paperclip system usage entries.
 */
function formatUsageSummary(usage: Record<string, unknown>): string | null {
  const inTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
  const outTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : inTokens + outTokens;

  if (totalTokens === 0 && inTokens === 0 && outTokens === 0) {
    return null;
  }

  return `usage updated: ${totalTokens}/200000 (${totalTokens}/200000 ctx)`;
}

/**
 * Creates a stateful stdout stream parser for Antigravity CLI output.
 */
export function createStdoutParser() {
  const activeTools = new Map<string, { name: string; toolUseId: string; parameters: Record<string, unknown> }>();
  let toolCounter = 0;
  let lastReportedTotalTokens = 0;

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
        const eventObj = safeRecord(JSON.parse(trimmed));
        if (eventObj) {
          const eventType = eventObj.event;

          // 1. Session Init Event -> emit INIT kind
          if (eventType === "init") {
            const convId = typeof eventObj.conversation_id === "string" ? eventObj.conversation_id : (safeRecord(eventObj.init)?.conversation_id as string) || "";
            const modelName = (safeRecord(eventObj.init)?.model as string) || "gemini-3.6-flash";
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

            const stepType = typeof update.step_type === "string" ? update.step_type : "";
            const state = typeof update.state === "string" ? update.state : "";
            const entries: TranscriptEntry[] = [];

            // Extract usage metrics if present -> emit SYSTEM kind
            const usageObj = safeRecord(update.usage);
            if (usageObj) {
              const currentTotal = typeof usageObj.total_tokens === "number" ? usageObj.total_tokens : 0;
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
              const toolName = (typeof update.tool_name === "string" ? update.tool_name : typeof toolInfoObj?.name === "string" ? toolInfoObj.name : "tool").trim();
              const stepIndex = typeof update.step_index === "number" ? update.step_index : ++toolCounter;
              const toolUseId = `agy-tool-${stepIndex}-${toolName}`;
              const rawParameters = safeRecord(toolInfoObj?.parameters) || safeRecord(update.parameters) || {};
              const { name: displayName, input: formattedInput } = resolveToolCallDisplay(toolName, rawParameters);

              if (state === "ACTIVE") {
                activeTools.set(toolUseId, { name: displayName, toolUseId, parameters: rawParameters });
                entries.push({
                  kind: "tool_call",
                  ts,
                  name: displayName,
                  input: formattedInput,
                  toolUseId,
                });
                return entries;
              }

              if (state === "DONE") {
                const isError = update.is_error === true || update.state === "ERROR";
                const durationNum = typeof update.duration_seconds === "number" ? update.duration_seconds : 0;
                const durationStr = durationNum > 0 ? `${durationNum.toFixed(2)}s` : "";

                const rawOutput = toolInfoObj?.output ?? update.output ?? update.result;
                const contentStr = formatToolOutputContent(rawOutput, rawParameters, durationStr, isError);

                if (!activeTools.has(toolUseId)) {
                  entries.push({
                    kind: "tool_call",
                    ts,
                    name: displayName,
                    input: formattedInput,
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
              return entries;
            }

            return entries;
          }

          // 3. Final Result Event
          if (eventType === "result" && eventObj.result) {
            const res = safeRecord(eventObj.result);
            if (res) {
              const entries: TranscriptEntry[] = [];
              const usageObj = safeRecord(res.usage);
              if (usageObj) {
                const usageText = formatUsageSummary(usageObj);
                if (usageText) {
                  entries.push({ kind: "system", ts, text: usageText });
                }
              }

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
    lastReportedTotalTokens = 0;
  }

  return { parseLine, reset };
}

/** Shared persistent module parser instance so parseStdoutLine retains cross-line state */
const defaultModuleParser = createStdoutParser();

/**
 * Static parser entry point fallback.
 */
export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return defaultModuleParser.parseLine(line, ts);
}
