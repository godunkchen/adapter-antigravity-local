/**
 * @fileoverview Stream event formatter for the Antigravity local CLI execution.
 * Intercepts stdout chunks and outputs formatted messages with custom colors in the terminal.
 * 
 * @copyright Antigravity Adapter Contributors
 * @license MIT
 */

import pc from "picocolors";

function safeRecord(val: unknown): Record<string, unknown> | null {
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return null;
}

/**
 * Formats and prints streaming event logs received from the running Antigravity process.
 * Matches errors or plain text chunks and colors them appropriately before logging.
 *
 * @param raw - The raw text line event from the process stream.
 * @param debug - Flag indicating debug mode.
 */
export function printAntigravityStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) {
    return;
  }

  // Support structured NDJSON events emitted by --output-format stream-json
  if (line.startsWith("{") && line.endsWith("}")) {
    try {
      const eventObj = safeRecord(JSON.parse(line));
      if (eventObj) {
        const eventType = eventObj.event;

        // 1. Session Init Event
        if (eventType === "init") {
          const convId = eventObj.conversation_id || (safeRecord(eventObj.init)?.conversation_id);
          console.log(pc.blue(`[antigravity] Session initialized${convId ? ` (${convId})` : ""}`));
          return;
        }

        // 2. Step Update Event
        if (eventType === "step_update" && eventObj.step_update) {
          const update = safeRecord(eventObj.step_update);
          if (!update) return;

          const stepType = typeof update.step_type === "string" ? update.step_type : "";
          const state = typeof update.state === "string" ? update.state : "";

          // Tool Step
          if (stepType === "tool") {
            const toolInfoObj = safeRecord(update.tool_info);
            const toolName = (typeof update.tool_name === "string" ? update.tool_name : typeof toolInfoObj?.name === "string" ? toolInfoObj.name : "tool").trim();

            if (state === "ACTIVE") {
              console.log(pc.yellow(`tool_call: ${toolName}`));
              const params = safeRecord(toolInfoObj?.parameters) || safeRecord(update.parameters);
              if (params && Object.keys(params).length > 0) {
                console.log(pc.gray(JSON.stringify(params, null, 2)));
              }
              return;
            }

            if (state === "DONE") {
              const isError = update.is_error === true || update.state === "ERROR";
              const rawOutput = toolInfoObj?.output ?? update.output ?? update.result;
              const outputText = typeof rawOutput === "string" ? rawOutput : rawOutput ? JSON.stringify(rawOutput) : "";
              
              console.log((isError ? pc.red : pc.cyan)(`tool_result: ${toolName}${isError ? " (error)" : ""}`));
              if (outputText) {
                const preview = outputText.length > 300 ? `${outputText.slice(0, 300)}...` : outputText;
                console.log((isError ? pc.red : pc.gray)(preview));
              }
              return;
            }
          }

          // Agent Response Step
          if (stepType === "agent_response") {
            if (typeof update.text_delta === "string" && update.text_delta.length > 0) {
              process.stdout.write(pc.green(update.text_delta));
            } else if (typeof update.text === "string" && update.text.length > 0) {
              console.log(pc.green(update.text));
            }

            if (typeof update.thinking === "string" && update.thinking.length > 0 && debug) {
              console.log(pc.gray(`thinking: ${update.thinking}`));
            }
            return;
          }

          // Checkpoint / User input
          if (stepType === "checkpoint" || stepType === "user_input") {
            return;
          }
        }

        // 3. Final Result Event
        if (eventType === "result" && eventObj.result) {
          const res = safeRecord(eventObj.result);
          if (res) {
            const usageObj = safeRecord(res.usage);
            if (usageObj) {
              const inTokens = Number(usageObj.input_tokens ?? 0);
              const outTokens = Number(usageObj.output_tokens ?? 0);
              const totalTokens = Number(usageObj.total_tokens ?? (inTokens + outTokens));
              console.log(pc.blue(`[antigravity] Run completed (${totalTokens.toLocaleString()} tokens: ${inTokens.toLocaleString()} in, ${outTokens.toLocaleString()} out)`));
            }
            if (typeof res.response === "string" && res.response.trim().length > 0) {
              console.log(pc.green(`result: ${res.response.trim()}`));
            }
            return;
          }
        }
      }
    } catch {
      // Fallback to plain text output below
    }
  }

  // Intercept explicit errors printed during stream sessions
  const lowerLine = line.toLowerCase();
  if (lowerLine.startsWith("error:") || lowerLine.startsWith("fatal:")) {
    console.log(pc.red(line));
    return;
  }

  // For regular plain-text outputs, log in high-visibility green
  console.log(pc.green(line));
}