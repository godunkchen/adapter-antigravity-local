import { describe, it, expect } from "vitest";
import { createStdoutParser, parseStdoutLine } from "../../src/ui-parser.js";

describe("ui-parser", () => {
  it("parses init events into system transcript entries", () => {
    const parser = createStdoutParser();
    const line = JSON.stringify({
      event: "init",
      conversation_id: "conv-123",
      init: { cwd: "/home/user" },
    });
    const entries = parser.parseLine(line, "2026-08-20T00:00:00Z");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      kind: "system",
      ts: "2026-08-20T00:00:00Z",
      text: "[antigravity] Session initialized (conv-123)",
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

  it("parses tool call ACTIVE and DONE events into paired tool_call and tool_result entries", () => {
    const parser = createStdoutParser();

    const callLine = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 3,
        step_type: "tool",
        state: "ACTIVE",
        tool_name: "write_to_file",
        tool_info: {
          name: "write_to_file",
          parameters: { TargetFile: "/tmp/foo.txt" },
        },
      },
    });

    const callEntries = parser.parseLine(callLine, "2026-08-20T00:00:00Z");
    expect(callEntries).toHaveLength(1);
    expect(callEntries[0]).toEqual({
      kind: "tool_call",
      ts: "2026-08-20T00:00:00Z",
      name: "write_to_file",
      input: { TargetFile: "/tmp/foo.txt" },
      toolUseId: "agy-tool-3-write_to_file",
    });

    const doneLine = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 3,
        step_type: "tool",
        state: "DONE",
        tool_name: "write_to_file",
        duration_seconds: 0.12,
        tool_info: {
          name: "write_to_file",
          parameters: { TargetFile: "/tmp/foo.txt" },
        },
      },
    });

    const doneEntries = parser.parseLine(doneLine, "2026-08-20T00:00:01Z");
    expect(doneEntries).toHaveLength(1);
    expect(doneEntries[0]).toEqual({
      kind: "tool_result",
      ts: "2026-08-20T00:00:01Z",
      toolUseId: "agy-tool-3-write_to_file",
      content: '{"TargetFile":"/tmp/foo.txt"}',
      isError: false,
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
