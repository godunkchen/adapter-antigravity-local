import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  createAntigravityLiveEventBridge,
  DEFAULT_ANTIGRAVITY_DELTA_THROTTLE_MS,
  type AdapterRuntimeEvent,
  type AdapterRuntimeProgressUpdate,
  type AdapterExecutionPhase,
  type AdapterProviderStoppedEvent,
} from "../../src/server/live-events.js";
import { execute } from "../../src/server/execute.js";

/**
 * Mirrors Paperclip's `readLiveRunToolName` logic (`server/src/services/heartbeat.ts`)
 * so unit tests can assert that tool ACTIVE sets `currentToolName` and tool DONE/ERROR clears it.
 */
function simulatePaperclipReadLiveRunToolName(
  payload: Record<string, unknown> | null | undefined,
  eventType: string,
): string | null {
  const candidates = [
    payload?.toolName,
    payload?.tool_name,
    payload?.tool,
    payload?.name,
    payload?.title,
    typeof payload?.tool_call === "object" && payload.tool_call !== null
      ? (payload.tool_call as Record<string, unknown>).name
      : null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return eventType.toLowerCase().includes("tool") ? eventType.trim() : null;
}

describe("createAntigravityLiveEventBridge", () => {
  it("defaults delta throttling interval to 1500ms", () => {
    expect(DEFAULT_ANTIGRAVITY_DELTA_THROTTLE_MS).toBe(1500);
  });

  it("emits init, tool_call ACTIVE, step.completed DONE, and result events immediately while clearing currentToolName on completion", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const bridge = createAntigravityLiveEventBridge({
      onEvent: (event) => {
        events.push(event);
      },
    });

    await bridge.handleStdoutChunk(
      `${JSON.stringify({
        event: "init",
        conversation_id: "conv-live-1",
        init: { model: "gemini-4-argon", cwd: "/workspace" },
      })}\n`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("init");
    expect(events[0]?.message).toContain("Session initialized (gemini-4-argon)");

    // Tool ACTIVE -> sets currentToolName to "grep_search"
    await bridge.handleStdoutChunk(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 10,
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "grep_search",
          tool_info: {
            name: "grep_search",
            parameters: { Query: "onEvent" },
          },
        },
      })}\n`,
    );
    expect(events).toHaveLength(2);
    const activeToolEvent = events[1]!;
    expect(activeToolEvent.eventType).toBe("tool_call");
    expect(activeToolEvent.message).toBe("Using grep_search");
    expect(simulatePaperclipReadLiveRunToolName(activeToolEvent.payload, activeToolEvent.eventType)).toBe(
      "grep_search",
    );

    // Tool DONE -> clears currentToolName (returns null) and sets message to "Completed grep_search"
    await bridge.handleStdoutChunk(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 10,
          step_type: "tool",
          state: "DONE",
          tool_name: "grep_search",
          tool_info: {
            name: "grep_search",
            output: "src/server/execute.ts",
          },
        },
      })}\n`,
    );
    expect(events).toHaveLength(3);
    const completedToolEvent = events[2]!;
    expect(completedToolEvent.eventType).toBe("step.completed");
    expect(completedToolEvent.message).toBe("Completed grep_search");
    expect(simulatePaperclipReadLiveRunToolName(completedToolEvent.payload, completedToolEvent.eventType)).toBeNull();
    expect(completedToolEvent.payload?.completedTool).toBe("grep_search");

    // Tool ERROR -> clears currentToolName and emits step.failed
    await bridge.handleStdoutChunk(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 11,
          step_type: "tool",
          state: "ERROR",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            error: "Exit code 1",
          },
        },
      })}\n`,
    );
    expect(events).toHaveLength(4);
    const failedToolEvent = events[3]!;
    expect(failedToolEvent.eventType).toBe("step.failed");
    expect(failedToolEvent.level).toBe("warn");
    expect(failedToolEvent.message).toBe("Tool run_command failed");
    expect(simulatePaperclipReadLiveRunToolName(failedToolEvent.payload, failedToolEvent.eventType)).toBeNull();
  });

  it("throttles thinking and assistant text deltas to 1500ms and flushes immediately before tool calls or results", async () => {
    let fakeNow = 10_000;
    const events: AdapterRuntimeEvent[] = [];
    const bridge = createAntigravityLiveEventBridge({
      now: () => fakeNow,
      throttleMs: 1500,
      onEvent: (event) => {
        events.push(event);
      },
    });

    // t = 10000ms: first thinking delta buffered, not yet emitted
    await bridge.handleStdoutChunk(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "thinking",
          thinking_delta: "Checking adapter ",
        },
      })}\n`,
    );
    expect(events).toHaveLength(0);

    // t = 10800ms (+800ms < 1500ms): second thinking delta coalesced, still buffered
    fakeNow = 10_800;
    await bridge.handleStdoutChunk(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "thinking",
          thinking_delta: "streaming telemetry...",
        },
      })}\n`,
    );
    expect(events).toHaveLength(0);

    // t = 11500ms (+1500ms >= 1500ms): third thinking delta triggers throttled flush
    fakeNow = 11_500;
    await bridge.handleStdoutChunk(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "thinking",
          thinking_delta: " done.",
        },
      })}\n`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      eventType: "thinking",
      stream: "stdout",
      level: "info",
      message: "Thinking: Checking adapter streaming telemetry... done.",
      payload: {
        text: "Thinking: Checking adapter streaming telemetry... done.",
        channel: "thinking",
      },
    });

    // t = 11700ms (+200ms < 1500ms): assistant text_delta arrives and is buffered
    fakeNow = 11_700;
    await bridge.handleStdoutChunk(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 2,
          step_type: "agent_response",
          text_delta: "I will now inspect the file.",
        },
      })}\n`,
    );
    expect(events).toHaveLength(1);

    // t = 11800ms: tool_call ACTIVE arrives -> immediately flushes buffered assistant delta before emitting tool_call
    fakeNow = 11_800;
    await bridge.handleStdoutChunk(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 3,
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "view_file",
        },
      })}\n`,
    );
    expect(events).toHaveLength(3);
    expect(events[1]?.eventType).toBe("assistant.text_delta");
    expect(events[1]?.message).toBe("I will now inspect the file.");
    expect(events[2]?.eventType).toBe("tool_call");
    expect(events[2]?.message).toBe("Using view_file");
  });

  it("handles fragmented stdout chunks split across arbitrary byte boundaries and emits orchestration step_update", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const bridge = createAntigravityLiveEventBridge({
      onEvent: (event) => {
        events.push(event);
      },
    });

    const fullLine = `${JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 4,
        step_type: "subagent",
        state: "ACTIVE",
        title: "Delegating codebase research",
      },
    })}\n`;

    // Split line across 3 chunks
    await bridge.handleStdoutChunk(fullLine.slice(0, 22));
    expect(events).toHaveLength(0);
    await bridge.handleStdoutChunk(fullLine.slice(22, 65));
    expect(events).toHaveLength(0);
    await bridge.handleStdoutChunk(fullLine.slice(65));

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("step_update");
    expect(events[0]?.message).toBe("step (subagent) [active]: Delegating codebase research");
  });

  it("wires ctx.onEvent, ctx.onExecutionPhase, ctx.onRuntimeProgress, and ctx.onProviderStopped during execute()", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-live-events-test-"));
    const fakeAgyPath = path.join(tmpDir, "fake-agy.mjs");
    try {
      const scriptLines = [
        `#!${process.execPath}`,
        'console.log(JSON.stringify({ event: "init", conversation_id: "sess-live-99", init: { model: "gemini-4-argon" } }));',
        'console.log(JSON.stringify({ event: "step_update", step_update: { step_index: 1, step_type: "thinking", thinking_delta: "Planning execution" } }));',
        'console.log(JSON.stringify({ event: "step_update", step_update: { step_index: 2, step_type: "tool", state: "ACTIVE", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "ls" } } } }));',
        'console.log(JSON.stringify({ event: "step_update", step_update: { step_index: 2, step_type: "tool", state: "DONE", tool_name: "run_command", tool_info: { name: "run_command", output: "README.md" } } }));',
        'console.log(JSON.stringify({ event: "step_update", step_update: { step_index: 3, step_type: "agent_response", text_delta: "All done!" } }));',
        'console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "All done!", usage: { input_tokens: 50, output_tokens: 12 } } }));',
      ];
      await fs.writeFile(fakeAgyPath, `${scriptLines.join("\n")}\n`, { mode: 0o755 });

      const events: AdapterRuntimeEvent[] = [];
      const phases: AdapterExecutionPhase[] = [];
      const progressUpdates: AdapterRuntimeProgressUpdate[] = [];
      const stoppedEvents: AdapterProviderStoppedEvent[] = [];
      const logs: Array<{ stream: string; chunk: string }> = [];

      const res = await execute({
        runId: "run-live-test",
        agent: {
          id: "agent-1",
          companyId: "comp-1",
          name: "Agy Live Agent",
          adapterType: "antigravity_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: fakeAgyPath,
          cwd: tmpDir,
        },
        context: {},
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
        onEvent: async (event) => {
          events.push(event);
        },
        onExecutionPhase: async (phase) => {
          phases.push(phase);
        },
        onRuntimeProgress: async (update) => {
          progressUpdates.push(update);
        },
        onProviderStopped: async (stopped) => {
          stoppedEvents.push(stopped);
        },
      });

      expect(res.exitCode).toBe(0);
      expect(res.sessionId).toBe("sess-live-99");
      expect(res.summary).toBe("All done!");

      // Lifecycle phases emitted in order
      expect(phases).toEqual([
        "prepare.workspace",
        "prepare.session",
        "adapter.invoke",
        "adapter.postprocess",
      ]);

      // Runtime progress transitions from waiting_for_first_event -> streaming_output
      expect(progressUpdates.map((u) => u.state)).toContain("waiting_for_first_event");
      expect(progressUpdates.map((u) => u.state)).toContain("streaming_output");

      // Provider stopped callback fired on completion
      expect(stoppedEvents).toHaveLength(1);
      expect(stoppedEvents[0]?.reason).toBe("completed");
      expect(stoppedEvents[0]?.exitCode).toBe(0);

      // Live runtime events emitted in exact sequence (thinking flushed before tool_call, assistant delta flushed before result)
      expect(events.map((e) => e.eventType)).toEqual([
        "init",
        "thinking",
        "tool_call",
        "step.completed",
        "assistant.text_delta",
        "result",
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
