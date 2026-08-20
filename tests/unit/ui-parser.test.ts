import { describe, it, expect } from "vitest";
import { createStdoutParser, parseStdoutLine } from "../../src/ui-parser.js";

describe("ui-parser", () => {
  it("parses init events into init transcript entries", () => {
    const parser = createStdoutParser();
    const line = JSON.stringify({
      event: "init",
      conversation_id: "conv-123",
      init: { model: "gemini-3.6-flash", cwd: "/home/user" },
    });
    const entries = parser.parseLine(line, "2026-08-20T00:00:00Z");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      kind: "init",
      ts: "2026-08-20T00:00:00Z",
      model: "gemini-3.6-flash",
      sessionId: "conv-123",
    });
  });

  it("parses agent_response step updates into assistant transcript entries", () => {
    const parser = createStdoutParser();
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        step_type: "agent_response",
        text_delta: "Hello, world!",
      },
    });
    const entries = parser.parseLine(line, "2026-08-20T00:00:00Z");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      kind: "assistant",
      ts: "2026-08-20T00:00:00Z",
      text: "Hello, world!",
      delta: true,
    });
  });

  it("parses tool call ACTIVE and DONE events with tool_info.output and command input shape for Paperclip isCommandTool", () => {
    const parser = createStdoutParser();

    const callLine = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 21,
        step_type: "tool",
        state: "ACTIVE",
        tool_name: "grep_search",
        tool_info: {
          name: "grep_search",
          parameters: { Query: "PAPERCLIP_API_KEY", SearchPath: "/tmp" },
        },
      },
    });

    const callEntries = parser.parseLine(callLine, "2026-08-20T00:00:00Z");
    expect(callEntries).toHaveLength(1);
    expect(callEntries[0]).toEqual({
      kind: "tool_call",
      ts: "2026-08-20T00:00:00Z",
      name: "command_execution",
      input: { command: 'grep "PAPERCLIP_API_KEY" /tmp' },
      toolUseId: "agy-tool-21-grep_search",
    });

    const doneLine = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 21,
        step_type: "tool",
        state: "DONE",
        tool_name: "grep_search",
        duration_seconds: 8.6279,
        tool_info: {
          name: "grep_search",
          parameters: { Query: "PAPERCLIP_API_KEY", SearchPath: "/tmp" },
          output: "./child-resp.json\n./wake-re.md\n./newissue.py",
        },
      },
    });

    const doneEntries = parser.parseLine(doneLine, "2026-08-20T00:00:08Z");
    expect(doneEntries).toHaveLength(1);
    expect(doneEntries[0]).toEqual({
      kind: "tool_result",
      ts: "2026-08-20T00:00:08Z",
      toolUseId: "agy-tool-21-grep_search",
      content: "tool call (completed):  8.63s: ```console\n./child-resp.json\n./wake-re.md\n./newissue.py\n```",
      isError: false,
    });
  });

  it("emits token usage system entries matching paperclip usage format", () => {
    const parser = createStdoutParser();
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        step_type: "agent_response",
        text_delta: "Response text",
        usage: {
          input_tokens: 13877,
          output_tokens: 770,
          thinking_tokens: 689,
          cache_read_tokens: 12193,
          total_tokens: 14647,
        },
      },
    });

    const entries = parser.parseLine(line, "2026-08-20T00:00:00Z");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      kind: "system",
      ts: "2026-08-20T00:00:00Z",
      text: "usage updated: 14647/200000 (14647/200000 ctx)",
    });
    expect(entries[1]).toEqual({
      kind: "assistant",
      ts: "2026-08-20T00:00:00Z",
      text: "Response text",
      delta: true,
    });
  });

  it("parses result events into assistant response entries", () => {
    const line = JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "All tasks completed successfully.",
      },
    });

    const entries = parseStdoutLine(line, "2026-08-20T00:00:02Z");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      kind: "assistant",
      ts: "2026-08-20T00:00:02Z",
      text: "All tasks completed successfully.",
    });
  });

  it("handles non-JSON raw stdout lines cleanly", () => {
    const entries = parseStdoutLine("Plain log message", "2026-08-20T00:00:03Z");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      kind: "assistant",
      ts: "2026-08-20T00:00:03Z",
      text: "Plain log message",
    });
  });
});
