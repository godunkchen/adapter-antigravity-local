# Phase 5 Test & Validation Report: Live Interaction, Real-Time Runtime Telemetry (`ctx.onEvent`) & Browser UI Parser Parity

- **Branch**: `feat/agy-1.3.6-phase5-live-streaming` (stacked on `feat/agy-1.3.6-phase4-probe`)
- **Version**: `2.7.0`
- **Date**: 2026-10-18
- **Target CLI Version**: Google Antigravity CLI (`agy`) `v1.3.6`
- **Design Specification**: [`docs/design-spec-live-interaction-and-streaming.md`](../design-spec-live-interaction-and-streaming.md) (v1.1 Approved)

---

## 1. Root Cause & Architectural Summary

### Root Cause of `"Receiving agent output"` in Paperclip WebUI
Paperclip's WebUI renders running agent progress through two independent channels:
1. **Channel 1 — Live Run Status Banner (`HeartbeatRunRuntimeStatus`)**: Driven by structured `ctx.onEvent(event: AdapterRuntimeEvent)` callbacks in `server/src/services/heartbeat.ts`. When an adapter only writes raw stdout chunks to `ctx.onLog("stdout", chunk)` without invoking `ctx.onEvent`, Paperclip's fallback handler (`noteLiveRunStdoutChunk`) sets `runtimeStatus.state = "streaming_output"` and `runtimeStatus.message = "Receiving agent output"` for the entire duration of the run (`currentToolName` and `lastAssistantSnippet` remain `null`).
2. **Channel 2 — Live Transcript Drawer (`TranscriptEntry[]`)**: Driven by `dist/ui-parser.js` inside Paperclip's sandboxed browser WebWorker (`sandboxed-parser-worker.ts`). Previously, `src/ui-parser.ts` did not extract `thinking_delta`/`thinking`, did not handle tool `ERROR`/`FAILED` states or alternate `step`/`tool_call` schemas, ignored non-tool internal orchestration `step_update` events, and lacked stateful deduplication between incremental `text_delta` chunks and cumulative `text`/`result.response` summaries.

### Implemented Solution (Phase 5 / `v2.7.0`)
1. **Server-Side Live Event Bridge (`src/server/live-events.ts`, `src/server/execute.ts`, `src/server/index.ts`)**:
   - Implemented `createAntigravityLiveEventBridge({ onEvent, throttleMs, now })` with `DEFAULT_ANTIGRAVITY_DELTA_THROTTLE_MS = 1500`.
   - Emits lifecycle, orchestration, and tool state transitions **immediately**:
     - `init` -> `eventType: "init"`, `message: "Session initialized (<model>)"`.
     - Tool `ACTIVE`/`RUNNING` -> `eventType: "tool_call"`, `payload: { toolName, toolUseId, input, state }`, `message: "Using <toolName>"` (sets `currentToolName` in Paperclip).
     - Tool `DONE`/`ERROR`/`FAILED` -> `eventType: "step.completed"` / `"step.failed"`, `payload: { completedTool, toolUseId, isError, state, summary }` (intentionally omits `"tool"` from `eventType` and `toolName`/`name`/`title` from `payload` so Paperclip's `readLiveRunToolName` clears `currentToolName` upon tool completion).
     - Non-tool orchestration `step_update` -> `eventType: "step_update"`, `message: "step (<type>) [<state>]: <label>"`.
     - Terminal `result` / `error` -> `eventType: "result"` / `"error"`.
   - Coalesces and throttles high-frequency `thinking_delta` (`eventType: "thinking"`) and `text_delta` (`eventType: "assistant.text_delta"`) updates to **`1500ms`**, with an immediate flush before any tool call, step transition, or terminal result.
   - Wired optional lifecycle callbacks (`ctx.onEvent`, `ctx.onExecutionPhase`, `ctx.onRuntimeProgress`, `ctx.onProviderStopped`) into `execute()`.

2. **Browser & CLI Transcript Parser Upgrade (`src/ui-parser.ts`, `dist/ui-parser.js`)**:
   - Added `thinking_delta` / `thought_delta` (`delta: true`), `thinking` / `thought`, and `step_type: "thinking" | "thought" | "reasoning"` parsing into `{ kind: "thinking", ts, text, delta }` entries.
   - Preserved inter-token whitespace on `delta: true` chunks while trimming non-delta blocks so `appendTranscriptEntry` (`ui/src/adapters/transcript.ts`) coalesces consecutive deltas without word concatenation.
   - Added stateful per-turn deduplication (`streamedAssistantStepIds`, `streamedThinkingStepIds`, `allTurnAssistantText`, `lastSegmentAssistantText`) aligned with `paperclip-runner` and `cursor-local` so cumulative `text` on `step_update` (`state: "DONE"`) or `result.response` does not duplicate already-streamed prose.
   - Added support for tool failure states (`state: "ERROR" | "FAILED" | "CANCELLED"`) and alternate `step` / `tool_call` (`args` / `arguments` / `input`) schemas.
   - Added deduplicated `{ kind: "system", ts, text }` entries for non-tool internal `agy` orchestration steps (`planning`, `subagent`, etc.).

---

## 2. Local Validation (`vitest` & Build)

- **Commands**:
  ```bash
  npm run typecheck
  npm run build
  npm test
  ```
- **Results**:
  - `15 passed` test files (`135 passed` total tests, `0 failed`).
  - Added 4 new unit tests in `tests/unit/ui-parser.test.ts` (`11 tests` total in suite) covering `thinking_delta`, cumulative `DONE`/`result.response` deduplication, tool `ERROR`/`FAILED` + alternate `step`/`tool_call` schemas, and deduplicated orchestration `step_update` system entries.
  - Added `tests/unit/live-events.test.ts` (`5 tests`) covering:
    - `DEFAULT_ANTIGRAVITY_DELTA_THROTTLE_MS = 1500`
    - Immediate `init`, `tool_call` (`ACTIVE`), `step.completed` (`DONE`), and `step.failed` (`ERROR`) emission + Paperclip `readLiveRunToolName` verification (`currentToolName` set on `ACTIVE` and cleared to `null` on `DONE`/`ERROR`)
    - `1500ms` delta throttling for `thinking_delta` and `text_delta` + immediate pre-tool flush
    - Arbitrary chunk boundary line-buffering + orchestration `step_update` emission
    - End-to-end `execute()` integration with `ctx.onEvent`, `ctx.onExecutionPhase`, `ctx.onRuntimeProgress`, and `ctx.onProviderStopped`

---

## 3. Remote Validation on `oci-sig-1` (Zero-Touch Isolated Worktree)

- **Worktree**: `/tmp/agy-adapter-phase5-validate` (detached worktree, automatically cleaned up upon exit; running Paperclip server process untouched).
- **Unit & Integration Test Suite on `oci-sig-1`**:
  - `npm run typecheck && npm run build && npm test` -> **15 test files passed, 135 tests passed**.
- **Live `execute()` + `dist/ui-parser.js` End-to-End Telemetry Probe against `/home/ubuntu/.local/bin/agy` (`v1.3.6`)**:
  ```json
  {
    "exitCode": 0,
    "sessionId": "3322298c-d810-48e3-b605-54e16f41d87c",
    "summary": "READY\n",
    "phases": [
      "prepare.workspace",
      "prepare.session",
      "adapter.invoke",
      "adapter.postprocess"
    ],
    "progress": [
      "waiting_for_first_event",
      "streaming_output"
    ],
    "stopped": [
      {
        "reason": "completed",
        "exitCode": 0
      }
    ],
    "events": [
      {
        "eventType": "init",
        "message": "Session initialized (gemini-3.8-flash-low)"
      },
      {
        "eventType": "assistant.text_delta",
        "message": "READY"
      },
      {
        "eventType": "result",
        "message": "READY"
      }
    ],
    "transcriptKinds": [
      "system",
      "init",
      "assistant",
      "system",
      "assistant",
      "result"
    ]
  }
  ```
  - Note: In `transcriptKinds`, the two `"assistant"` entries have `delta: true` (`"READY"` and `"\n"`), which Paperclip's `appendTranscriptEntry` coalesces into a single assistant bubble, while the trailing `result.response` (`"READY\n"`) is cleanly deduplicated so only the final `"result"` entry is emitted.
