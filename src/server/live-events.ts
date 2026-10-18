/**
 * @fileoverview Real-time stream-json event bridge for Antigravity local CLI execution.
 * Parses line-buffered NDJSON from `agy --print --output-format stream-json` during live execution
 * and forwards structured `AdapterRuntimeEvent` notifications to `ctx.onEvent`.
 *
 * Contract alignment with Paperclip (`server/src/services/heartbeat.ts`):
 * - Tool activation (`state: "ACTIVE"`) emits `eventType: "tool_call"` with `payload.toolName` immediately,
 *   setting `currentToolName` and `message: "Using <toolName>"` on `HeartbeatRunRuntimeStatus`.
 * - Tool completion (`state: "DONE" | "ERROR" | "FAILED"`) emits `eventType: "step.completed"` / `"step.failed"`
 *   without `tool` in `eventType` or `payload.toolName`, clearing `currentToolName` and updating `message`.
 * - Streaming `thinking_delta` and `text_delta` updates are coalesced and throttled to `1500ms`
 *   (and flushed immediately before tool/step/result transitions) to avoid PostgreSQL write amplification
 *   while keeping `lastAssistantSnippet` responsive.
 */

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

export type AdapterExecutionPhase =
  | "prepare.workspace"
  | "prepare.session"
  | "adapter.invoke"
  | "adapter.postprocess";

export interface AdapterRuntimeProgressUpdate {
  phase?: AdapterExecutionPhase | null;
  state:
    | "queued"
    | "preparing_workspace"
    | "starting_adapter"
    | "waiting_for_first_event"
    | "streaming_output"
    | "Cleanup"
    | "cleanup";
  message?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface AdapterProviderStoppedEvent {
  reason: string;
  stoppedAt?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  summary?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface AdapterRuntimeEvent {
  eventType: string;
  stream?: "stdout" | "stderr" | "system";
  level?: "info" | "warn" | "error";
  message?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface AntigravityExecutionContext extends AdapterExecutionContext {
  signal?: AbortSignal;
  onCancellationReady?: () => Promise<void> | void;
  stopRemoteStartup?: () => Promise<void> | void;
  onEvent?: (event: AdapterRuntimeEvent) => Promise<void> | void;
  onRuntimeProgress?: (update: AdapterRuntimeProgressUpdate) => Promise<void> | void;
  onExecutionPhase?: (
    phase: AdapterExecutionPhase,
    detail?: { message?: string | null; meta?: Record<string, unknown> | null },
  ) => Promise<void> | void;
  onProviderStopped?: (event: AdapterProviderStoppedEvent) => Promise<void> | void;
}

/** Default throttle interval (1500ms) for streaming text/thinking delta events sent to `ctx.onEvent`. */
export const DEFAULT_ANTIGRAVITY_DELTA_THROTTLE_MS = 1500;

/** Maximum snippet length aligned with Paperclip's `MAX_HEARTBEAT_RUN_RUNTIME_ASSISTANT_SNIPPET_CHARS`. */
const MAX_LIVE_SNIPPET_CHARS = 220;

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

function formatLiveSnippet(text: string, maxChars = MAX_LIVE_SNIPPET_CHARS): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `...${normalized.slice(normalized.length - (maxChars - 3))}`;
}

export interface AntigravityLiveEventBridgeOptions {
  onEvent?: (event: AdapterRuntimeEvent) => Promise<void> | void;
  throttleMs?: number;
  now?: () => number;
}

export interface AntigravityLiveEventBridge {
  handleStdoutChunk(chunk: string): Promise<void>;
  flush(): Promise<void>;
}

/**
 * Creates a stateful line-buffered bridge that parses `agy` `stream-json` stdout chunks
 * and emits structured `AdapterRuntimeEvent` items to `ctx.onEvent`.
 */
export function createAntigravityLiveEventBridge(
  options: AntigravityLiveEventBridgeOptions,
): AntigravityLiveEventBridge {
  const {
    onEvent,
    throttleMs = DEFAULT_ANTIGRAVITY_DELTA_THROTTLE_MS,
    now = () => Date.now(),
  } = options;

  let lineBuffer = "";
  let pendingThinkingDelta = "";
  let pendingAssistantDelta = "";
  let firstBufferedDeltaAt: number | null = null;
  let lastDeltaFlushAt = 0;
  let toolCounter = 0;
  let lastCoalescedToolName: string | null = null;

  const streamedAssistantStepIds = new Set<string>();
  const streamedThinkingStepIds = new Set<string>();
  const emittedStepStates = new Set<string>();
  const emittedActiveToolIds = new Set<string>();
  const emittedCompletedToolIds = new Set<string>();
  const suppressedConsecutiveToolIds = new Set<string>();

  async function emitEvent(event: AdapterRuntimeEvent): Promise<void> {
    if (!onEvent) return;
    await onEvent(event);
  }

  async function flushPendingDeltas(): Promise<void> {
    if (!onEvent) {
      pendingThinkingDelta = "";
      pendingAssistantDelta = "";
      firstBufferedDeltaAt = null;
      return;
    }

    const currentNow = now();

    if (pendingThinkingDelta.trim().length > 0) {
      const snippet = formatLiveSnippet(pendingThinkingDelta, MAX_LIVE_SNIPPET_CHARS - 10);
      pendingThinkingDelta = "";
      if (snippet) {
        lastCoalescedToolName = null;
        const message = `Thinking: ${snippet}`;
        await emitEvent({
          eventType: "thinking",
          stream: "stdout",
          level: "info",
          message,
          payload: {
            text: message,
            channel: "thinking",
          },
        });
        lastDeltaFlushAt = currentNow;
      }
    } else {
      pendingThinkingDelta = "";
    }

    if (pendingAssistantDelta.trim().length > 0) {
      const snippet = formatLiveSnippet(pendingAssistantDelta, MAX_LIVE_SNIPPET_CHARS);
      pendingAssistantDelta = "";
      if (snippet) {
        lastCoalescedToolName = null;
        await emitEvent({
          eventType: "assistant.text_delta",
          stream: "stdout",
          level: "info",
          message: snippet,
          payload: {
            text: snippet,
            delta: snippet,
          },
        });
        lastDeltaFlushAt = currentNow;
      }
    } else {
      pendingAssistantDelta = "";
    }

    firstBufferedDeltaAt = null;
  }

  async function maybeFlushDeltasByTimer(): Promise<void> {
    if (!pendingThinkingDelta.trim() && !pendingAssistantDelta.trim()) {
      return;
    }
    const currentNow = now();
    if (firstBufferedDeltaAt === null) {
      firstBufferedDeltaAt = currentNow;
    }
    const referenceTime = lastDeltaFlushAt > 0 ? lastDeltaFlushAt : firstBufferedDeltaAt;
    if (currentNow - referenceTime >= throttleMs) {
      await flushPendingDeltas();
    }
  }

  function queueThinkingDelta(text: string): void {
    if (!text) return;
    if (firstBufferedDeltaAt === null) {
      firstBufferedDeltaAt = now();
    }
    pendingThinkingDelta += text;
  }

  function queueAssistantDelta(text: string): void {
    if (!text) return;
    if (firstBufferedDeltaAt === null) {
      firstBufferedDeltaAt = now();
    }
    pendingAssistantDelta += text;
  }

  async function processStepUpdate(
    update: Record<string, unknown>,
    eventObj: Record<string, unknown>,
  ): Promise<void> {
    const rawStepType = asString(update.step_type, asString(update.type)).trim();
    const stepType = rawStepType.toLowerCase();
    const rawState = asString(update.state, asString(update.status)).trim();
    const state = rawState.toUpperCase();
    const stepKey =
      update.step_index !== undefined && update.step_index !== null
        ? String(update.step_index)
        : asString(update.id) || "default-step";

    // 1. Tool Execution Step
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

      if (
        state === "ACTIVE" ||
        state === "RUNNING" ||
        state === "IN_PROGRESS" ||
        state === "STARTED" ||
        state === "PENDING"
      ) {
        if (emittedActiveToolIds.has(toolUseId)) {
          return;
        }
        emittedActiveToolIds.add(toolUseId);
        await flushPendingDeltas();
        if (lastCoalescedToolName === toolName) {
          suppressedConsecutiveToolIds.add(toolUseId);
          return;
        }
        lastCoalescedToolName = toolName;
        await emitEvent({
          eventType: "tool_call",
          stream: "stdout",
          level: "info",
          message: `Using ${toolName}`,
          payload: {
            toolName,
            toolUseId,
            input: rawParameters,
            state: state || "ACTIVE",
          },
        });
        return;
      }

      if (
        state === "DONE" ||
        state === "COMPLETED" ||
        state === "ERROR" ||
        state === "FAILED" ||
        state === "CANCELLED"
      ) {
        if (emittedCompletedToolIds.has(toolUseId)) {
          return;
        }
        emittedCompletedToolIds.add(toolUseId);
        await flushPendingDeltas();
        const isError =
          update.is_error === true ||
          toolInfoObj?.is_error === true ||
          state === "ERROR" ||
          state === "FAILED" ||
          state === "CANCELLED";
        if (!isError && suppressedConsecutiveToolIds.has(toolUseId)) {
          return;
        }
        if (isError) {
          lastCoalescedToolName = null;
        } else {
          lastCoalescedToolName = toolName;
        }
        const message = isError ? `Tool ${toolName} failed` : `Completed ${toolName}`;
        // Note: eventType intentionally omits "tool" and payload omits `toolName`/`name`/`title`
        // so Paperclip's `readLiveRunToolName` clears `currentToolName` once the tool finishes.
        await emitEvent({
          eventType: isError ? "step.failed" : "step.completed",
          stream: "stdout",
          level: isError ? "warn" : "info",
          message,
          payload: {
            completedTool: toolName,
            toolUseId,
            isError,
            state,
            summary: message,
          },
        });
        return;
      }
    }

    if (stepType === "user_input" || stepType === "user" || stepType === "checkpoint") {
      return;
    }

    // 2. Thinking & Agent Response Steps
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
      queueThinkingDelta(thinkingDelta);
    }

    const thinkingFull =
      asString(update.thinking) ||
      asString(update.thought) ||
      (isThinkingStep && !thinkingDelta ? asString(update.text) || asString(update.content) : "");
    if (thinkingFull.length > 0 && !streamedThinkingStepIds.has(stepKey)) {
      queueThinkingDelta(thinkingFull);
    }

    const textDelta = !isThinkingStep
      ? asString(update.text_delta) || (isAgentResponseStep ? asString(update.delta) : "")
      : "";
    if (textDelta.length > 0) {
      streamedAssistantStepIds.add(stepKey);
      queueAssistantDelta(textDelta);
    }

    if (isAgentResponseStep && !textDelta) {
      const fullText = asString(update.text) || asString(update.response) || asString(update.content);
      if (fullText.length > 0 && !streamedAssistantStepIds.has(stepKey)) {
        queueAssistantDelta(fullText);
      }
    }

    if (isThinkingStep || isAgentResponseStep || thinkingDelta || thinkingFull || textDelta) {
      await maybeFlushDeltasByTimer();
      return;
    }

    // 3. Non-tool internal orchestration step (e.g. planning, subagent, task)
    const stepLabel = (
      asString(update.title) ||
      asString(update.description) ||
      asString(update.message) ||
      asString(update.summary) ||
      asString(update.name) ||
      asString(eventObj.message)
    ).trim();

    if (rawStepType || stepLabel) {
      const dedupKey = `${stepKey}:${state}:${rawStepType}:${stepLabel}`;
      if (!emittedStepStates.has(dedupKey)) {
        emittedStepStates.add(dedupKey);
        lastCoalescedToolName = null;
        await flushPendingDeltas();
        const stateTag = state ? ` [${state.toLowerCase()}]` : "";
        const message =
          stepLabel && stepLabel !== rawStepType
            ? `step${rawStepType ? ` (${rawStepType})` : ""}${stateTag}: ${stepLabel}`
            : `step${stateTag}: ${rawStepType || stepLabel}`;
        await emitEvent({
          eventType: "step_update",
          stream: "stdout",
          level: "info",
          message,
          payload: {
            stepIndex: update.step_index ?? stepKey,
            stepType: rawStepType || "step",
            state: state || "ACTIVE",
            summary: message,
          },
        });
      }
    }
  }

  async function processEventObject(eventObj: Record<string, unknown>): Promise<void> {
    const eventType = asString(eventObj.event, asString(eventObj.type)).trim();

    if (eventType === "init") {
      streamedAssistantStepIds.clear();
      streamedThinkingStepIds.clear();
      emittedStepStates.clear();
      emittedActiveToolIds.clear();
      emittedCompletedToolIds.clear();
      suppressedConsecutiveToolIds.clear();
      lastCoalescedToolName = null;
      const initObj = safeRecord(eventObj.init);
      const sessionId =
        asString(eventObj.conversation_id) ||
        asString(eventObj.session_id) ||
        asString(initObj?.conversation_id) ||
        asString(initObj?.session_id);
      const model = asString(initObj?.model, asString(eventObj.model, "auto"));
      await emitEvent({
        eventType: "init",
        stream: "stdout",
        level: "info",
        message: `Session initialized (${model})`,
        payload: {
          sessionId,
          model,
        },
      });
      return;
    }

    if (eventType === "step_update") {
      const update = safeRecord(eventObj.step_update) ?? safeRecord(eventObj.step);
      if (!update) return;
      await processStepUpdate(update, eventObj);
      return;
    }

    if (eventType === "agent_response" || eventType === "thinking" || eventType === "thought") {
      await processStepUpdate({ ...eventObj, step_type: eventType }, eventObj);
      return;
    }

    if (eventType === "error" || (eventObj.error && eventType !== "result")) {
      await flushPendingDeltas();
      const errText = asString(
        eventObj.error,
        asString(safeRecord(eventObj.error)?.message, "Antigravity runtime error"),
      );
      await emitEvent({
        eventType: "error",
        stream: "stderr",
        level: "error",
        message: formatLiveSnippet(errText, MAX_LIVE_SNIPPET_CHARS) || "Antigravity runtime error",
        payload: {
          error: errText,
        },
      });
      return;
    }

    if (eventType === "result") {
      await flushPendingDeltas();
      const res = safeRecord(eventObj.result) ?? eventObj;
      const usageObj = safeRecord(res.usage) ?? safeRecord(eventObj.usage) ?? {};
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
      const costUsd = asNumber(
        res.cost_usd,
        asNumber(res.costUsd, asNumber(res.total_cost_usd, asNumber(eventObj.total_cost_usd, 0))),
      );
      const snippet = formatLiveSnippet(responseText, MAX_LIVE_SNIPPET_CHARS);
      const message = isError
        ? formatLiveSnippet(asString(res.error, responseText || "Run failed"), MAX_LIVE_SNIPPET_CHARS)
        : snippet || "Run completed";

      await emitEvent({
        eventType: "result",
        stream: "stdout",
        level: isError ? "error" : "info",
        message,
        payload: {
          status,
          isError,
          usage: usageObj,
          costUsd,
          summary: message,
        },
      });
    }
  }

  async function processLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("[antigravity]") || trimmed.startsWith("[paperclip]")) {
      return;
    }

    if (trimmed.startsWith("{")) {
      try {
        const eventObj = safeRecord(JSON.parse(trimmed));
        if (eventObj && (typeof eventObj.event === "string" || typeof eventObj.type === "string")) {
          await processEventObject(eventObj);
          return;
        }
      } catch {
        try {
          const sanitized = trimmed.replace(/[\r\n]+/g, "\\n");
          const eventObj = safeRecord(JSON.parse(sanitized));
          if (eventObj && (typeof eventObj.event === "string" || typeof eventObj.type === "string")) {
            await processEventObject(eventObj);
            return;
          }
        } catch {
          // Ignore malformed single line so subsequent NDJSON lines are never poisoned
        }
      }
    }
  }

  async function handleStdoutChunk(chunk: string): Promise<void> {
    if (!onEvent || !chunk) return;
    const combined = lineBuffer + chunk;
    const lines = combined.split(/\r?\n/);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      await processLine(line);
    }
  }

  async function flush(): Promise<void> {
    if (!onEvent) return;
    if (lineBuffer.trim().length > 0) {
      const remaining = lineBuffer;
      lineBuffer = "";
      await processLine(remaining);
    }
    await flushPendingDeltas();
  }

  return {
    handleStdoutChunk,
    flush,
  };
}
