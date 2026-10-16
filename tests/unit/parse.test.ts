import { describe, expect, it } from "vitest";
import {
  isAntigravityUnknownSessionError,
  extractAntigravityLoginUrl,
  detectAntigravityAuthRequired,
  detectAntigravityQuotaExhausted,
  isAntigravityProviderQuotaExhausted,
  isAntigravityTransientUpstreamError,
  isAntigravityModelNotFoundError,
  isAntigravityRefusalError,
  extractAntigravityRetryNotBefore,
  isAntigravityTurnLimitResult,
  describeAntigravityFailure,
  extractAntigravitySessionId,
  hasAntigravityTerminalResult,
  extractAntigravityExecutionMetrics,
  parseAntigravityStreamJson,
} from "../../src/server/parse.js";
import { parseAgyUsageQuotaOutput } from "../../src/server/quota.js";

/**
 * Unit test suite for Antigravity stdout/stderr telemetry and error parsers.
 * Validates extraction of authentication needs, quota status, turn limits, and failure reasons.
 */
describe("parse server helpers", () => {
  
  /**
   * Tests for session resume failure detection.
   * Assures that unknown conversation patterns in logs trigger a session clear fallback.
   */
  describe("isAntigravityUnknownSessionError", () => {
    it("detects unknown conversation error messages", () => {
      expect(isAntigravityUnknownSessionError("", "unknown conversation")).toBe(true);
      expect(isAntigravityUnknownSessionError("failed to resume conversation", "")).toBe(true);
      expect(isAntigravityUnknownSessionError("some other error", "")).toBe(false);
    });

    it("handles complex case-insensitive, spacing, and corrupted media/step variations", () => {
      expect(isAntigravityUnknownSessionError("", "UNKNOWN   CONVERSATION")).toBe(true);
      expect(isAntigravityUnknownSessionError("CONVERSATION  some-id-123   NOT   FOUND", "")).toBe(true);
      expect(isAntigravityUnknownSessionError("", "cannot\nresume\n")).toBe(true);
      expect(isAntigravityUnknownSessionError("", "Error: could not process video attachment (truncated webm)")).toBe(true);
      expect(isAntigravityUnknownSessionError("", "missing step in conversation history")).toBe(true);
    });
  });

  /**
   * Tests for authentication requirement detection.
   * Asserts the identification of credentials missing or login required errors in logs.
   */
  describe("detectAntigravityAuthRequired", () => {
    it("detects when authentication is required", () => {
      expect(detectAntigravityAuthRequired({ stdout: "", stderr: "please authenticate first" })).toEqual({ requiresAuth: true });
      expect(detectAntigravityAuthRequired({ stdout: "not authenticated", stderr: "" })).toEqual({ requiresAuth: true });
      expect(detectAntigravityAuthRequired({ stdout: "success", stderr: "" })).toEqual({ requiresAuth: false });
    });

    it("matches advanced credential missing messages including ADC and extracts login/verification URLs", () => {
      expect(detectAntigravityAuthRequired({ stdout: "", stderr: "api_key required" })).toEqual({ requiresAuth: true });
      expect(detectAntigravityAuthRequired({ stdout: "unauthorized request", stderr: "" })).toEqual({ requiresAuth: true });
      expect(detectAntigravityAuthRequired({ stdout: "", stderr: "please run `agy auth login` first" })).toEqual({ requiresAuth: true });
      expect(detectAntigravityAuthRequired({ stdout: "", stderr: "could not find default credentials. Run gcloud auth application-default login" })).toEqual({ requiresAuth: true });
      expect(
        detectAntigravityAuthRequired({
          stdout: "",
          stderr: "Account verification required. Complete verification at https://accounts.google.com/verify/agy-123.",
        }),
      ).toEqual({
        requiresAuth: true,
        loginUrl: "https://accounts.google.com/verify/agy-123",
      });
      expect(extractAntigravityLoginUrl("Visit https://antigravity.google/auth?code=abc!", "")).toBe(
        "https://antigravity.google/auth?code=abc",
      );
    });
  });

  /**
   * Tests for API quota exhaustion detection and transient upstream classification.
   */
  describe("detectAntigravityQuotaExhausted & transient upstream classification", () => {
    it("detects quota errors", () => {
      expect(detectAntigravityQuotaExhausted({ stdout: "", stderr: "quota exceeded" })).toEqual({ exhausted: true });
      expect(detectAntigravityQuotaExhausted({ stdout: "resource_exhausted", stderr: "" })).toEqual({ exhausted: true });
      expect(detectAntigravityQuotaExhausted({ stdout: "normal text", stderr: "" })).toEqual({ exhausted: false });
    });

    it("matches rate limits, AI credits, quota exhaustions and HTTP 429 errors", () => {
      expect(detectAntigravityQuotaExhausted({ stdout: "rate-limit exceeded", stderr: "" })).toEqual({ exhausted: true });
      expect(detectAntigravityQuotaExhausted({ stdout: "", stderr: "Error 429: Too Many Requests" })).toEqual({ exhausted: true });
      expect(detectAntigravityQuotaExhausted({ stdout: "please update your billing details", stderr: "" })).toEqual({ exhausted: true });
      expect(detectAntigravityQuotaExhausted({ stdout: "Your AI credits balance is too low to continue.", stderr: "" })).toEqual({ exhausted: true });
    });

    it("distinguishes hard provider quota from transient upstream errors", () => {
      expect(
        isAntigravityProviderQuotaExhausted({
          stdout: "Your AI credits balance is too low to continue.",
          stderr: "",
        }),
      ).toBe(true);
      expect(
        isAntigravityTransientUpstreamError({
          stdout: "Your AI credits balance is too low to continue.",
          stderr: "",
        }),
      ).toBe(false);

      expect(
        isAntigravityTransientUpstreamError({
          stdout: "",
          stderr: "HTTP 503 Service Unavailable: upstream overloaded",
        }),
      ).toBe(true);
      expect(
        isAntigravityTransientUpstreamError({
          stdout: "",
          stderr: "Error 429: Too Many Requests (per-minute rate limit)",
        }),
      ).toBe(true);
    });

    it("extracts retryNotBefore timestamps from ISO strings and relative durations", () => {
      const refNow = new Date("2026-10-16T04:00:00.000Z");
      expect(
        extractAntigravityRetryNotBefore(
          { stdout: '{"reset_time":"2026-10-23T04:15:53Z"}', stderr: "" },
          refNow,
        ),
      ).toBe("2026-10-23T04:15:53.000Z");

      expect(
        extractAntigravityRetryNotBefore(
          { stdout: "", stderr: "You have used your 5-hour limit, it will fully refresh in 2 hours, 30 minutes." },
          refNow,
        ),
      ).toBe("2026-10-16T06:30:00.000Z");

      expect(
        extractAntigravityRetryNotBefore(
          { stdout: "", stderr: "Rate limited, please retry after 45s" },
          refNow,
        ),
      ).toBe("2026-10-16T04:00:45.000Z");
    });
  });

  /**
   * Tests for model not found and refusal detection.
   */
  describe("isAntigravityModelNotFoundError & isAntigravityRefusalError", () => {
    it("detects unknown or unsupported model errors", () => {
      expect(isAntigravityModelNotFoundError({ stdout: "", stderr: "Error: model 'gemini-99' not found" })).toBe(true);
      expect(isAntigravityModelNotFoundError({ stdout: "unknown model: foo-bar", stderr: "" })).toBe(true);
      expect(isAntigravityModelNotFoundError({ stdout: "normal output", stderr: "" })).toBe(false);
    });

    it("detects structured model refusal events", () => {
      expect(
        isAntigravityRefusalError({
          stdout: '{"event":"result","subtype":"model_refusal","result":{"stop_reason":"refusal"}}',
          stderr: "",
        }),
      ).toBe(true);
      expect(isAntigravityRefusalError({ stdout: '{"event":"result","status":"SUCCESS"}', stderr: "" })).toBe(false);
    });
  });

  /**
   * Tests for agent turn limit detections.
   * Checks for specific process exit codes (53) or max turn limits exceeded messages.
   */
  describe("isAntigravityTurnLimitResult", () => {
    it("detects turn limit", () => {
      expect(isAntigravityTurnLimitResult(53, "")).toBe(true);
      expect(isAntigravityTurnLimitResult(0, "max_turns reached")).toBe(true);
      expect(isAntigravityTurnLimitResult(1, "some error")).toBe(false);
    });

    it("handles undefined or null exitCode and stderr boundaries gracefully", () => {
      expect(isAntigravityTurnLimitResult(undefined, "turn_limit_exceeded")).toBe(true);
      expect(isAntigravityTurnLimitResult(null, "Max turns hit")).toBe(false);
      expect(isAntigravityTurnLimitResult(null, undefined)).toBe(false);
      expect(isAntigravityTurnLimitResult(undefined, undefined)).toBe(false);
    });
  });

  /**
   * Tests for failure descriptions formatting.
   * Verifies the clean output of failure messages extracted from stderr logs.
   */
  describe("describeAntigravityFailure", () => {
    it("describes failures correctly", () => {
      expect(describeAntigravityFailure("stdout", "stderr error")).toBe("Antigravity run failed: stderr error");
      expect(describeAntigravityFailure("", "")).toBeNull();
    });

    it("filters out empty lines and returns the first meaningful failure line", () => {
      const complexStderr = "\n\n  \nActual error message here \nAnother trace line";
      expect(describeAntigravityFailure("", complexStderr)).toBe("Antigravity run failed: Actual error message here");
    });
  });

  /**
   * Tests for session ID extraction from NDJSON events and text fallbacks.
   */
  describe("extractAntigravitySessionId", () => {
    it("extracts session ID from NDJSON init event", () => {
      const ndjson = '{"event":"init","conversation_id":"39d9bdfe-3618-4d2d-ae5d-deee2e075ee2"}\n';
      expect(extractAntigravitySessionId(ndjson, "")).toBe("39d9bdfe-3618-4d2d-ae5d-deee2e075ee2");
    });

    it("extracts session ID from plain text fallback", () => {
      expect(extractAntigravitySessionId("Conversation ID: sess-abc-12345", "")).toBe("sess-abc-12345");
      expect(extractAntigravitySessionId("", "resume with: agy -c conv-xyz-67890")).toBe("conv-xyz-67890");
    });

    it("returns null if no session ID is found", () => {
      expect(extractAntigravitySessionId("random output", "")).toBeNull();
    });
  });

  /**
   * Tests for token metrics, terminal result detection, and quota window parsing.
   */
  describe("extractAntigravityExecutionMetrics, hasAntigravityTerminalResult & parseAgyUsageQuotaOutput", () => {
    it("extracts token metrics, usageBasis, and cost from NDJSON result event", () => {
      const ndjson = '{"event":"result","result":{"conversation_id":"conv-1","response":"Done!","usage":{"input_tokens":100,"output_tokens":50,"cache_read_tokens":10},"cost_usd":0.002}}\n';
      const metrics = extractAntigravityExecutionMetrics(ndjson, "");
      expect(metrics.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 10,
      });
      expect(metrics.usageBasis).toBe("per_run");
      expect(metrics.costUsd).toBe(0.002);
      expect(metrics.response).toBe("Done!");
      expect(hasAntigravityTerminalResult({ stdout: ndjson, stderr: "" })).toBe(true);
      expect(parseAntigravityStreamJson(ndjson).sessionId).toBe("conv-1");
    });

    it("parses agy -p '/usage' --output-format json quota groups and buckets", () => {
      const sampleUsageJson = JSON.stringify({
        conversation_id: "",
        status: "SUCCESS",
        response:
          "Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-23T04:15:53Z\nGemini 4 Argon\tGemini 4 Argon Weekly Limit\t80%\t2026-10-23T03:43:13Z\n",
        command: {
          name: "usage",
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    id: "gemini-weekly",
                    name: "Weekly Limit Remaining",
                    description: "Refreshes in 6 days",
                    window: "weekly",
                    remaining_fraction: 0.998,
                    reset_time: "2026-10-23T04:15:53Z",
                  },
                ],
              },
              {
                name: "Gemini 4 Argon",
                buckets: [
                  {
                    id: "gemini-argon-wtu-weekly",
                    name: "Gemini 4 Argon Weekly Limit",
                    window: "weekly",
                    remaining_fraction: 0.8,
                    reset_time: "2026-10-23T03:43:13Z",
                  },
                ],
              },
            ],
          },
        },
      });

      const windows = parseAgyUsageQuotaOutput(sampleUsageJson);
      expect(windows).toEqual([
        {
          label: "Gemini Models (weekly)",
          usedPercent: 0,
          resetsAt: "2026-10-23T04:15:53.000Z",
          valueLabel: "100% remaining",
          detail: "Refreshes in 6 days",
        },
        {
          label: "Gemini 4 Argon (weekly)",
          usedPercent: 20,
          resetsAt: "2026-10-23T03:43:13.000Z",
          valueLabel: "80% remaining",
          detail: null,
        },
      ]);
    });
  });
});
