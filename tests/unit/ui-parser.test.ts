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

  it("parses tool call ACTIVE and DONE events with native tool names, structured parameters, and clean output", () => {
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
      name: "grep_search",
      input: {
        Query: "PAPERCLIP_API_KEY",
        SearchPath: "/tmp",
        query: "PAPERCLIP_API_KEY in /tmp",
      },
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
      toolName: "grep_search",
      content: "./child-resp.json\n./wake-re.md\n./newissue.py",
      isError: false,
    });
  });

  it("parses user_input step updates into user transcript entries", () => {
    const parser = createStdoutParser();
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        step_type: "user_input",
        text: "Please list the open files",
      },
    });
    const entries = parser.parseLine(line, "2026-08-20T00:00:00Z");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      kind: "user",
      ts: "2026-08-20T00:00:00Z",
      text: "Please list the open files",
    });
  });

  it("does not emit noisy interim usage system entries on step_update so tool/command grouping stays contiguous", () => {
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
    expect(entries).toEqual([
      {
        kind: "assistant",
        ts: "2026-08-20T00:00:00Z",
        text: "Response text",
        delta: true,
      },
    ]);
  });

  it("parses result events into structured result and assistant transcript entries", () => {
    const line = JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "All tasks completed successfully.",
        usage: {
          input_tokens: 15000,
          output_tokens: 500,
          cache_read_tokens: 10000,
        },
        cost_usd: 0.0045,
      },
    });

    const entries = parseStdoutLine(line, "2026-08-20T00:00:02Z");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      kind: "assistant",
      ts: "2026-08-20T00:00:02Z",
      text: "All tasks completed successfully.",
    });
    expect(entries[1]).toEqual({
      kind: "result",
      ts: "2026-08-20T00:00:02Z",
      text: "All tasks completed successfully.",
      inputTokens: 15000,
      outputTokens: 500,
      cachedTokens: 10000,
      costUsd: 0.0045,
      subtype: "success",
      isError: false,
      errors: [],
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

  it("parses thinking_delta and step_type thinking into thinking transcript entries with delta: true", () => {
    const parser = createStdoutParser();

    const deltaLine = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 3,
        step_type: "thinking",
        thinking_delta: "Analyzing the repository ",
      },
    });
    const deltaEntries = parser.parseLine(deltaLine, "2026-08-20T00:00:01Z");
    expect(deltaEntries).toEqual([
      {
        kind: "thinking",
        ts: "2026-08-20T00:00:01Z",
        text: "Analyzing the repository ",
        delta: true,
      },
    ]);

    // Trailing cumulative thinking on DONE for the same step_index is deduplicated
    const doneLine = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 3,
        step_type: "thinking",
        state: "DONE",
        thinking: "Analyzing the repository structure.",
      },
    });
    const doneEntries = parser.parseLine(doneLine, "2026-08-20T00:00:02Z");
    expect(doneEntries).toEqual([]);
  });

  it("deduplicates cumulative step_update DONE text and result.response when text_delta was already streamed", () => {
    const parser = createStdoutParser();

    const chunk1 = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 5,
        step_type: "agent_response",
        text_delta: "Phase 5 ",
      },
    });
    const chunk2 = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 5,
        step_type: "agent_response",
        text_delta: "is complete.",
      },
    });
    const doneStep = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 5,
        step_type: "agent_response",
        state: "DONE",
        text: "Phase 5 is complete.",
      },
    });
    const resultEvent = JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "Phase 5 is complete.",
        usage: { input_tokens: 200, output_tokens: 10 },
      },
    });

    expect(parser.parseLine(chunk1, "2026-08-20T00:00:01Z")).toEqual([
      { kind: "assistant", ts: "2026-08-20T00:00:01Z", text: "Phase 5 ", delta: true },
    ]);
    expect(parser.parseLine(chunk2, "2026-08-20T00:00:02Z")).toEqual([
      { kind: "assistant", ts: "2026-08-20T00:00:02Z", text: "is complete.", delta: true },
    ]);
    // Cumulative text on DONE step is suppressed because step 5 already streamed deltas
    expect(parser.parseLine(doneStep, "2026-08-20T00:00:03Z")).toEqual([]);

    // Terminal result event emits only the `result` entry without duplicating the assistant prose
    const resultEntries = parser.parseLine(resultEvent, "2026-08-20T00:00:04Z");
    expect(resultEntries).toHaveLength(1);
    expect(resultEntries[0]?.kind).toBe("result");
  });

  it("parses tool ERROR/FAILED states and alternate tool_call/args schemas", () => {
    const parser = createStdoutParser();

    const activeLine = JSON.stringify({
      type: "step",
      step: {
        id: "step-42",
        type: "tool",
        status: "RUNNING",
        tool_call: {
          id: "call-42",
          name: "run_command",
          args: { CommandLine: "npm test" },
        },
      },
    });
    expect(parser.parseLine(activeLine, "2026-08-20T00:00:01Z")).toEqual([
      {
        kind: "tool_call",
        ts: "2026-08-20T00:00:01Z",
        name: "run_command",
        input: { CommandLine: "npm test", command: "npm test" },
        toolUseId: "call-42",
      },
    ]);

    const errorLine = JSON.stringify({
      type: "step",
      step: {
        id: "step-42",
        type: "tool",
        status: "ERROR",
        tool_call: {
          id: "call-42",
          name: "run_command",
          error: "Command exited with code 1",
        },
      },
    });
    expect(parser.parseLine(errorLine, "2026-08-20T00:00:02Z")).toEqual([
      {
        kind: "tool_result",
        ts: "2026-08-20T00:00:02Z",
        toolUseId: "call-42",
        toolName: "run_command",
        content: "Command exited with code 1",
        isError: true,
      },
    ]);
  });

  it("emits deduplicated system transcript entries for non-tool internal orchestration step_update events", () => {
    const parser = createStdoutParser();

    const stepLine = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 9,
        step_type: "planning",
        state: "ACTIVE",
        title: "Formulating execution plan",
      },
    });

    const first = parser.parseLine(stepLine, "2026-08-20T00:00:01Z");
    expect(first).toEqual([
      {
        kind: "system",
        ts: "2026-08-20T00:00:01Z",
        text: "step (planning) [active]: Formulating execution plan",
      },
    ]);

    // Identical state update is deduplicated
    const duplicate = parser.parseLine(stepLine, "2026-08-20T00:00:02Z");
    expect(duplicate).toEqual([]);
  });

  it("never poisons subsequent NDJSON lines when a truncated JSON line occurs and salvages structured tool/assistant entries", () => {
    const parser = createStdoutParser();

    // 1. Truncated tool DONE line (e.g. cut off at 256KB RUN_LOG_PAGE_BYTES boundary)
    const truncatedToolLine =
      '{"event":"step_update","conversation_id":"conv-trunc","step_update":{"step_index":12,"step_type":"tool","state":"DONE","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/src/app.ts"},"output":"line 1\\nline 2';
    expect(parser.parseLine(truncatedToolLine, "2026-08-20T00:00:01Z")).toEqual([]);

    // 2. Next valid NDJSON line starts with {"event":... -> salvages the truncated tool step AND parses the new line cleanly!
    const nextValidLine = JSON.stringify({
      event: "step_update",
      conversation_id: "conv-trunc",
      step_update: {
        step_index: 13,
        step_type: "agent_response",
        text_delta: "Parsed cleanly after truncated line!",
      },
    });
    expect(parser.parseLine(nextValidLine, "2026-08-20T00:00:02Z")).toEqual([
      {
        kind: "tool_call",
        ts: "2026-08-20T00:00:02Z",
        name: "view_file",
        input: { AbsolutePath: "/src/app.ts", path: "/src/app.ts" },
        toolUseId: "agy-tool-12-view_file",
      },
      {
        kind: "tool_result",
        ts: "2026-08-20T00:00:02Z",
        toolUseId: "agy-tool-12-view_file",
        toolName: "view_file",
        content: "line 1\nline 2\n...[truncated]",
        isError: false,
      },
      {
        kind: "assistant",
        ts: "2026-08-20T00:00:02Z",
        text: "Parsed cleanly after truncated line!",
        delta: true,
      },
    ]);
  });

  it("suppresses mid-line sliced NDJSON tail fragments caused by 8KB WebSocket tail-slicing or 256KB offset reads", () => {
    const parser = createStdoutParser();

    const tailFragment1 =
      'file_content_tail\\n","is_error":false},"usage":{"input_tokens":14000,"output_tokens":300,"total_tokens":14300}}}';
    const tailFragment2 =
      '","step_index":8,"step_type":"tool","state":"DONE","tool_name":"run_command"}}';

    expect(parser.parseLine(tailFragment1, "2026-08-20T00:00:01Z")).toEqual([]);
    expect(parser.parseLine(tailFragment2, "2026-08-20T00:00:02Z")).toEqual([]);
  });

  it("deduplicates repeated ACTIVE step_update events for the same tool step", () => {
    const parser = createStdoutParser();

    const active1 = JSON.stringify({
      event: "step_update",
      conversation_id: "conv-dedup",
      step_update: {
        step_index: 7,
        step_type: "tool",
        state: "ACTIVE",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "npm test" } },
      },
    });
    const active2WithUsage = JSON.stringify({
      event: "step_update",
      conversation_id: "conv-dedup",
      step_update: {
        step_index: 7,
        step_type: "tool",
        state: "ACTIVE",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "npm test" } },
        usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050 },
      },
    });

    expect(parser.parseLine(active1, "2026-08-20T00:00:01Z")).toHaveLength(1);
    const secondEntries = parser.parseLine(active2WithUsage, "2026-08-20T00:00:02Z");
    // Duplicate ACTIVE tool_call and interim usage are both suppressed
    expect(secondEntries).toEqual([]);
  });

  it("repairs Paperclip secret-redactor broken escaped quotes (***REDACTED***\") in NDJSON lines", () => {
    const parser = createStdoutParser();

    // When Paperclip's sanitizeLogChunk replaces `os.environ[\"` with `***REDACTED***`, it leaves an unescaped `"` before PAPERCLIP_API_KEY
    const redactedLine =
      '{"event":"step_update","conversation_id":"conv-redacted","step_update":{"step_index":437,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"python3 -c \'import os; key = ***REDACTED***"PAPERCLIP_API_KEY\\"]\'"}}}}';

    const entries = parser.parseLine(redactedLine, "2026-08-20T00:00:01Z");
    expect(entries).toEqual([
      {
        kind: "tool_call",
        ts: "2026-08-20T00:00:01Z",
        name: "run_command",
        input: {
          CommandLine: 'python3 -c \'import os; key = ***REDACTED***"PAPERCLIP_API_KEY"]\'',
          command: 'python3 -c \'import os; key = ***REDACTED***"PAPERCLIP_API_KEY"]\'',
        },
        toolUseId: "agy-tool-437-run_command",
      },
    ]);
  });
});



