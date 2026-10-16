/**
 * @fileoverview Log parsers and telemetry analysis helpers for the Antigravity local CLI execution.
 * Extracts specific execution failures, rate limits, quota windows, session statuses, model errors,
 * refusals, retry timestamps, and authentication triggers from stdout/stderr.
 * Aligned with `@paperclipai/adapter-claude-local`.
 *
 * @copyright Antigravity Adapter Contributors
 * @license MIT
 */

import { parseMultilineLines } from "../utils.js";

/**
 * Combines and normalizes stdout and stderr into a single list of trimmed, non-empty lines.
 * Reusable utility to avoid duplicate output merging logic.
 *
 * @param stdout - The stdout string output.
 * @param stderr - The stderr string output.
 * @returns An array of sanitized message lines.
 */
function combineAndCleanLines(stdout: string, stderr: string): string[] {
  return parseMultilineLines(`${stdout}\n${stderr}`);
}

/** Regex pattern to identify CLI authentication failures, missing API keys, or GCP ADC errors. */
const AGY_AUTH_REQUIRED_RE =
  /(?:not\s+authenticated|please\s+authenticate|api[_ ]?key\s+(?:required|missing|invalid)|authentication\s+required|unauthorized|invalid\s+credentials|not\s+logged\s+in|login\s+required|run\s+`?agy\s+auth(?:\s+login)?`?\s+first|could\s+not\s+find\s+default\s+credentials|application\s+default\s+credentials|gcloud\s+auth\s+application-default\s+login|account\s+verification\s+required|sign-in\s+error)/i;

/** Regex pattern to identify API quota exhaustions, billing issues, AI credits, or rate limits. */
const AGY_QUOTA_EXHAUSTED_RE =
  /(?:resource_exhausted|quota|rate[-\s]?limit|too many requests|\b429\b|billing details|ai\s+credits\s+balance\s+is\s+too\s+low|insufficient\s+credits|out\s+of\s+credits|weekly\s+limit|five\s+hour\s+limit|5-hour\s+limit|spending\s+cap)/i;

/** Regex pattern to distinguish hard provider quota/credits/billing exhaustion from transient per-minute rate limits. */
const AGY_HARD_PROVIDER_QUOTA_RE =
  /(?:quota\s+(?:exceeded|exhausted)|ai\s+credits\s+balance\s+is\s+too\s+low|insufficient\s+credits|out\s+of\s+credits|weekly\s+limit|five\s+hour\s+limit|5-hour\s+limit|billing\s+details|spending\s+cap|plan\s+limit|exceeded\s+your\s+current\s+quota)/i;

/** Regex pattern to identify transient upstream errors (429 rate limits, 502/503/504/529 overload, or network resets). */
const AGY_TRANSIENT_UPSTREAM_RE =
  /(?:rate[-\s]?limit|too many requests|\b429\b|resource_exhausted|\b502\b|\b503\b|\b504\b|\b529\b|overloaded|service\s+unavailable|bad\s+gateway|gateway\s+timeout|temporarily\s+unavailable|econnreset|etimedout|enotfound|eai_again|socket\s+hang\s+up|connection\s+reset|upstream\s+error)/i;

/** Regex pattern to identify unknown or unsupported model errors. */
const AGY_MODEL_NOT_FOUND_RE =
  /(?:model\s+[^\n]*?\s+(?:not\s+found|is\s+not\s+available)|unknown\s+model|invalid\s+model|unsupported\s+model|model_not_found|\b404\b[^\n]*model)/i;

/** Regex pattern to extract HTTP/HTTPS URLs from auth/verification error messages. */
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>)\]]+/i;

/**
 * Checks whether the CLI process execution failed because the requested conversation
 * session was unknown, deleted, corrupted, or contained unreadable media/steps
 * (such as truncated WebM/MP4/MOV attachments or missing conversation steps in `agy` v1.3.4).
 *
 * @param stdout - The process stdout stream content.
 * @param stderr - The process stderr stream content.
 * @returns True if an unknown or unrecoverable session error signature is matched.
 */
export function isAntigravityUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = combineAndCleanLines(stdout, stderr).join("\n");

  return /unknown\s+(?:conversation|session)|(?:conversation|session)\s+.*\s+not\s+found|no\s+conversation\s+found|resume\s+.*\s+not\s+found|cannot\s+resume|failed\s+to\s+resume|corrupt(?:ed)?\s+conversation|missing\s+step|could\s+not\s+process\s+(?:image|video|audio|media)|truncated\s+(?:webm|mp4|mov|media)|previous_message_id/i.test(
    haystack,
  );
}

/**
 * Extracts a login, verification, or appeal URL from CLI stdout/stderr if present.
 *
 * @param stdout - Process stdout stream content.
 * @param stderr - Process stderr stream content.
 * @returns Extracted URL or null.
 */
export function extractAntigravityLoginUrl(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`;
  const match = combined.match(URL_IN_TEXT_RE);
  if (!match || !match[0]) return null;
  return match[0].replace(/[.,;:!?]+$/, "");
}

/**
 * Probes stdout/stderr output lines for missing authentication configurations.
 * Allows the orchestrator to automatically flag required interactive auth and surface login/verification URLs.
 *
 * @param input - Object containing stdout and stderr streams.
 * @returns Object indicating if authentication is required (and `loginUrl` when present).
 */
export function detectAntigravityAuthRequired(input: {
  stdout: string;
  stderr: string;
}): { requiresAuth: boolean; loginUrl?: string } {
  const messages = combineAndCleanLines(input.stdout, input.stderr);
  const requiresAuth = messages.some((line) => AGY_AUTH_REQUIRED_RE.test(line));
  const loginUrl = requiresAuth ? extractAntigravityLoginUrl(input.stdout, input.stderr) : null;
  return loginUrl ? { requiresAuth, loginUrl } : { requiresAuth };
}

/**
 * Checks if the Antigravity execution failed because of billing quotas,
 * rate-limits (HTTP 429), AI credits exhaustion, or API resource limit exhaustion.
 *
 * @param input - Object containing stdout and stderr streams.
 * @returns Object indicating if quota is exhausted.
 */
export function detectAntigravityQuotaExhausted(input: {
  stdout: string;
  stderr: string;
}): { exhausted: boolean } {
  const messages = combineAndCleanLines(input.stdout, input.stderr);
  const exhausted = messages.some((line) => AGY_QUOTA_EXHAUSTED_RE.test(line));
  return { exhausted };
}

/**
 * Distinguishes hard provider quota / AI credits / billing exhaustion (`errorCode: "provider_quota"`)
 * from transient per-minute rate limits or upstream overload.
 */
export function isAntigravityProviderQuotaExhausted(input: {
  stdout: string;
  stderr: string;
}): boolean {
  const messages = combineAndCleanLines(input.stdout, input.stderr);
  return messages.some((line) => AGY_HARD_PROVIDER_QUOTA_RE.test(line));
}

/**
 * Detects transient upstream failures (429 rate limits that are not hard billing/weekly caps,
 * 502/503/504/529 server overload, or transient network resets).
 */
export function isAntigravityTransientUpstreamError(input: {
  stdout: string;
  stderr: string;
}): boolean {
  if (isAntigravityProviderQuotaExhausted(input)) {
    return false;
  }
  const messages = combineAndCleanLines(input.stdout, input.stderr);
  return messages.some((line) => AGY_TRANSIENT_UPSTREAM_RE.test(line));
}

/**
 * Detects whether the CLI failed because the requested model ID was not found or is unsupported.
 */
export function isAntigravityModelNotFoundError(input: {
  stdout: string;
  stderr: string;
}): boolean {
  const messages = combineAndCleanLines(input.stdout, input.stderr);
  return messages.some((line) => AGY_MODEL_NOT_FOUND_RE.test(line));
}

/**
 * Detects whether the model terminated with a structured safety/policy refusal.
 */
export function isAntigravityRefusalError(input: {
  stdout: string;
  stderr: string;
}): boolean {
  const combined = `${input.stdout}\n${input.stderr}`;
  for (const rawLine of combined.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const resultObj =
        typeof parsed.result === "object" && parsed.result !== null
          ? (parsed.result as Record<string, unknown>)
          : parsed;
      const candidates = [
        parsed.subtype,
        parsed.stop_reason,
        parsed.stopReason,
        parsed.error_code,
        parsed.errorCode,
        resultObj.subtype,
        resultObj.stop_reason,
        resultObj.stopReason,
        resultObj.error_code,
        resultObj.errorCode,
      ]
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim().toLowerCase());
      if (candidates.some((c) => c === "refusal" || c === "model_refusal")) {
        return true;
      }
    } catch {
      // Ignore malformed JSON
    }
  }
  return false;
}

/**
 * Extracts an ISO-8601 `retryNotBefore` timestamp from quota/rate-limit error messages or JSON payloads.
 *
 * @param input - Object containing stdout and stderr streams.
 * @param now - Reference date for relative durations (defaults to `new Date()`).
 * @returns ISO-8601 timestamp string or null.
 */
export function extractAntigravityRetryNotBefore(
  input: { stdout: string; stderr: string },
  now = new Date(),
): string | null {
  const combined = `${input.stdout}\n${input.stderr}`;

  // 1. Check explicit ISO-8601 timestamp in JSON or text (e.g. reset_time: "2026-10-23T04:15:53Z" or "resets at 2026-10-16T09:15:53Z")
  const isoMatch = combined.match(
    /(?:reset_time|resets?\s+at|retry[_ -]?after|try\s+again\s+at)["'\s:=]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i,
  );
  if (isoMatch && isoMatch[1]) {
    const ts = Date.parse(isoMatch[1]);
    if (!Number.isNaN(ts)) {
      return new Date(ts).toISOString();
    }
  }

  // 2. Check relative hours/minutes (e.g. "refresh in 4 hours, 56 minutes" or "in 2 hours")
  const relHoursMinutes = combined.match(
    /(?:refresh|reset|retry|try\s+again)\s+in\s+(?:(\d+)\s+days?,\s*)?(?:(\d+)\s+hours?(?:,\s*)?)?(?:(\d+)\s+minutes?)?/i,
  );
  if (relHoursMinutes && (relHoursMinutes[1] || relHoursMinutes[2] || relHoursMinutes[3])) {
    const days = Number.parseInt(relHoursMinutes[1] || "0", 10);
    const hours = Number.parseInt(relHoursMinutes[2] || "0", 10);
    const minutes = Number.parseInt(relHoursMinutes[3] || "0", 10);
    const deltaMs = ((days * 24 + hours) * 60 + minutes) * 60_000;
    if (deltaMs > 0) {
      return new Date(now.getTime() + deltaMs).toISOString();
    }
  }

  // 3. Check relative seconds (e.g. "retry after 45s" or "retry in 30 seconds")
  const relSeconds = combined.match(/(?:retry|reset|try\s+again)\s+(?:after|in)\s+(\d+)\s*s(?:ec(?:ond)?s?)?\b/i);
  if (relSeconds && relSeconds[1]) {
    const seconds = Number.parseInt(relSeconds[1], 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return new Date(now.getTime() + seconds * 1000).toISOString();
    }
  }

  return null;
}

/**
 * Detects if the run hit the safety maximum agent turn thresholds.
 * Evaluates the exit code (typically code 53), structured JSON subtypes, or stderr logs.
 *
 * @param exitCode - Optional exit code returned by the command execution.
 * @param stderr - Optional error outputs.
 * @param stdout - Optional stdout outputs for structured JSON check.
 * @returns True if safety thresholds or maximum turns limit was crossed.
 */
export function isAntigravityTurnLimitResult(
  exitCode?: number | null,
  stderr?: string,
  stdout?: string,
): boolean {
  if (exitCode === 53) {
    return true;
  }

  const combined = `${stderr || ""}\n${stdout || ""}`.toLowerCase();
  if (
    combined.includes("turn_limit") ||
    combined.includes("max_turns") ||
    combined.includes("error_max_turns")
  ) {
    return true;
  }

  return false;
}

/**
 * Extracts a concise error description representing the first failure log line.
 * Useful to present user-friendly error boundaries to the Paperclip Web UI.
 *
 * @param stdout - The stdout string output.
 * @param stderr - The stderr string output.
 * @returns A formatted failure message, or null if no logs exist.
 */
export function describeAntigravityFailure(stdout: string, stderr: string): string | null {
  const lines = parseMultilineLines(`${stderr}\n${stdout}`);
  if (lines.length === 0) {
    return null;
  }
  return `Antigravity run failed: ${lines[0]}`;
}

/**
 * Extracts the conversation/session ID from process stdout/stderr.
 * Inspects NDJSON events (init, step_update, result) as well as text regex fallbacks.
 *
 * @param stdout - The process stdout stream content.
 * @param stderr - The process stderr stream content.
 * @returns The resolved session ID or null.
 */
export function extractAntigravitySessionId(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`;
  const lines = combined.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        const convId =
          parsed.conversation_id ||
          parsed.session_id ||
          parsed.init?.conversation_id ||
          parsed.step_update?.conversation_id ||
          parsed.result?.conversation_id;
        if (typeof convId === "string" && convId.trim().length > 0) {
          return convId.trim();
        }
      } catch {
        // Ignore JSON parse errors
      }
    }
  }

  const regexes = [
    /conversation[_ -]?id["']?\s*[:=]\s*["']?([a-zA-Z0-9_-]{8,})/i,
    /session[_ -]?id["']?\s*[:=]\s*["']?([a-zA-Z0-9_-]{8,})/i,
    /agy\s+(?:-c|--conversation|-r|--resume)\s+([a-zA-Z0-9_-]{8,})/i,
    /Conversation ID:\s*([a-zA-Z0-9_-]+)/i,
    /Session ID:\s*([a-zA-Z0-9_-]+)/i,
    /Resuming conversation:\s*([a-zA-Z0-9_-]+)/i,
    /Created conversation:\s*([a-zA-Z0-9_-]+)/i,
  ];

  for (const re of regexes) {
    const match = re.exec(combined);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/** Strongly-typed token usage and execution metrics structure. */
export interface AntigravityExecutionMetrics {
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
  usageBasis: "per_run";
  costUsd: number | null;
  response: string | null;
  resultJson: Record<string, unknown> | null;
  isError: boolean;
}

/**
 * Detects whether stdout contains a terminal NDJSON result event from `agy --output-format stream-json`.
 * Used by `terminalResultCleanup` so lingering child processes don't hang the heartbeat after completion.
 */
export function hasAntigravityTerminalResult(output: { stdout: string; stderr: string }): boolean {
  const lines = (output.stdout || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        parsed.event === "result" ||
        parsed.type === "result" ||
        (typeof parsed.status === "string" &&
          (parsed.status === "SUCCESS" || parsed.status === "ERROR" || parsed.status === "FAILED") &&
          typeof parsed.usage === "object")
      ) {
        return true;
      }
    } catch {
      // Ignore partial or non-JSON line
    }
  }
  return false;
}

/**
 * Extracts token usage, cost metrics, terminal result JSON, and response summary from NDJSON events or stdout.
 *
 * @param stdout - Process stdout stream content.
 * @param stderr - Process stderr stream content.
 * @returns Parsed execution metrics object.
 */
export function extractAntigravityExecutionMetrics(stdout: string, stderr: string): AntigravityExecutionMetrics {
  const metrics: AntigravityExecutionMetrics = {
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    },
    usageBasis: "per_run",
    costUsd: null,
    response: null,
    resultJson: null,
    isError: false,
  };

  const combined = `${stdout}\n${stderr}`;
  const lines = combined.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);

        if (parsed.event === "result" || parsed.type === "result" || typeof parsed.status === "string") {
          metrics.resultJson = parsed;
          if (
            parsed.is_error === true ||
            parsed.result?.is_error === true ||
            parsed.status === "ERROR" ||
            parsed.status === "FAILED"
          ) {
            metrics.isError = true;
          }
        }

        if (parsed.event === "result" && parsed.result?.response) {
          metrics.response = String(parsed.result.response);
        } else if (parsed.response && typeof parsed.response === "string") {
          metrics.response = parsed.response;
        } else if (parsed.type === "result" && typeof parsed.result === "string") {
          metrics.response = parsed.result;
        }

        const usageObj = parsed.result?.usage || parsed.step_update?.usage || parsed.usage;
        if (usageObj && typeof usageObj === "object") {
          if (typeof usageObj.input_tokens === "number") {
            metrics.usage.inputTokens = Math.max(metrics.usage.inputTokens, usageObj.input_tokens);
          } else if (typeof usageObj.inputTokens === "number") {
            metrics.usage.inputTokens = Math.max(metrics.usage.inputTokens, usageObj.inputTokens);
          }

          if (typeof usageObj.output_tokens === "number") {
            metrics.usage.outputTokens = Math.max(metrics.usage.outputTokens, usageObj.output_tokens);
          } else if (typeof usageObj.outputTokens === "number") {
            metrics.usage.outputTokens = Math.max(metrics.usage.outputTokens, usageObj.outputTokens);
          }

          const cached = usageObj.cache_read_tokens ?? usageObj.cached_input_tokens ?? usageObj.cachedInputTokens;
          if (typeof cached === "number") {
            metrics.usage.cachedInputTokens = Math.max(metrics.usage.cachedInputTokens, cached);
          }
        }

        const cost = parsed.result?.cost_usd ?? parsed.cost_usd ?? parsed.costUsd;
        if (typeof cost === "number") {
          metrics.costUsd = cost;
        }
      } catch {
        // Ignore JSON parse errors
      }
    }
  }

  return metrics;
}

/**
 * Alias for structured stream-JSON parsing used by environment probes and execution analysis.
 */
export function parseAntigravityStreamJson(stdout: string, stderr = "") {
  const sessionId = extractAntigravitySessionId(stdout, stderr);
  const metrics = extractAntigravityExecutionMetrics(stdout, stderr);
  return {
    sessionId,
    summary: metrics.response ?? "",
    ...metrics,
  };
}