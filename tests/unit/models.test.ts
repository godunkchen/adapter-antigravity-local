import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveAgyModelAndEffort } from "../../src/server/execute.js";
import { models as STATIC_MODELS, DEFAULT_ANTIGRAVITY_LOCAL_MODEL } from "../../src/index.js";

const SAMPLE_AGY_MODELS_OUTPUT = `
Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)
gemini-3.7-flash-low\tGemini 3.7 Flash (Low)
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)
gemini-3.6-flash-low\tGemini 3.6 Flash (Low)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-opus-5-5-low\tClaude Opus 5.5 (Low)
claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)
claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)
claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn((cmd: string, args: unknown, opts: unknown, callback?: unknown) => {
    const cb = (typeof opts === "function" ? opts : callback) as (err: Error | null, res?: { stdout: string; stderr: string }) => void;
    if (cmd === "non_existent_agy_binary") {
      cb(new Error("Command failed: ENOENT"), { stdout: "", stderr: "command not found" });
    } else {
      cb(null, { stdout: SAMPLE_AGY_MODELS_OUTPUT, stderr: "" });
    }
  }),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import {
  dedupeModels,
  parseAgyModelsOutput,
  loadAntigravityModels,
  listModels,
  refreshModels,
  resetAntigravityModelsCacheForTests,
} from "../../src/server/models.js";

describe("Antigravity Models Discovery & Parsing", () => {
  beforeEach(() => {
    resetAntigravityModelsCacheForTests();
    mockExecFile.mockClear();
  });

  it("parses agy models output into structured model definitions", () => {
    const parsed = parseAgyModelsOutput(SAMPLE_AGY_MODELS_OUTPUT);

    expect(parsed.length).toBe(19); // Auto + 18 models
    expect(parsed[0]).toEqual({
      id: DEFAULT_ANTIGRAVITY_LOCAL_MODEL,
      label: "Auto (Use global configured default)",
    });
    expect(parsed[1]).toEqual({
      id: "gemini-3.8-flash-high",
      label: "Gemini 3.8 Flash (High)",
    });
    expect(parsed.find((m) => m.id === "claude-sonnet-5-5-high")).toEqual({
      id: "claude-sonnet-5-5-high",
      label: "Claude Sonnet 5.5 (High)",
    });
    expect(parsed.find((m) => m.id === "gpt-oss-120b-medium")).toEqual({
      id: "gpt-oss-120b-medium",
      label: "GPT-OSS 120B (Medium)",
    });
  });

  it("deduplicates model list", () => {
    const list = [
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (Duplicate)" },
      { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
    ];
    const deduped = dedupeModels(list);
    expect(deduped.length).toBe(2);
    expect(deduped[0].label).toBe("Gemini 3.8 Flash (High)");
  });

  it("returns fallback static models when CLI is unavailable", async () => {
    const models = await loadAntigravityModels({ command: "non_existent_agy_binary" });
    expect(models).toEqual(STATIC_MODELS);
  });

  it("exports listModels and refreshModels", async () => {
    const list = await listModels();
    expect(list.length).toBe(19);
    expect(list[0].id).toBe(DEFAULT_ANTIGRAVITY_LOCAL_MODEL);
    expect(list[1].id).toBe("gemini-3.8-flash-high");

    const refreshed = await refreshModels();
    expect(refreshed.length).toBe(19);
    expect(refreshed[0].id).toBe(DEFAULT_ANTIGRAVITY_LOCAL_MODEL);
  });
});

describe("resolveAgyModelAndEffort Resolution Rules", () => {
  it("resolves auto models cleanly", () => {
    expect(resolveAgyModelAndEffort("auto")).toEqual({});
    expect(resolveAgyModelAndEffort("")).toEqual({});
    expect(resolveAgyModelAndEffort("auto", "high")).toEqual({ effort: "high" });
    expect(resolveAgyModelAndEffort("auto", "xhigh")).toEqual({ effort: "xhigh" });
    expect(resolveAgyModelAndEffort("auto", "max")).toEqual({ effort: "max" });
    expect(resolveAgyModelAndEffort(undefined, "low")).toEqual({ effort: "low" });
  });

  it("resolves Gemini 4 Argon models (agy v1.3.6) directly or adapts to effort overrides", () => {
    expect(resolveAgyModelAndEffort("gemini-4-argon-high")).toEqual({
      model: "gemini-4-argon-high",
    });
    expect(resolveAgyModelAndEffort("gemini-4-argon-medium")).toEqual({
      model: "gemini-4-argon-medium",
    });
    expect(resolveAgyModelAndEffort("gemini-4-argon-low")).toEqual({
      model: "gemini-4-argon-low",
    });
    expect(resolveAgyModelAndEffort("gemini-4-argon-high", "low")).toEqual({
      model: "gemini-4-argon-low",
    });
    expect(resolveAgyModelAndEffort("gemini-4-argon-low", "xhigh")).toEqual({
      model: "gemini-4-argon-high",
    });
    // Base model ID omits --effort when not specified (v1.3.4+ / ADC v1.3.6)
    expect(resolveAgyModelAndEffort("gemini-4-argon")).toEqual({
      model: "gemini-4-argon",
    });
    expect(resolveAgyModelAndEffort("gemini-4-argon", "medium")).toEqual({
      model: "gemini-4-argon",
      effort: "medium",
    });
  });

  it("resolves Gemini 3.8 models directly or adapts to effort overrides", () => {
    expect(resolveAgyModelAndEffort("gemini-3.8-flash-high")).toEqual({
      model: "gemini-3.8-flash-high",
    });
    expect(resolveAgyModelAndEffort("gemini-3.8-flash-medium")).toEqual({
      model: "gemini-3.8-flash-medium",
    });
    expect(resolveAgyModelAndEffort("gemini-3.8-flash-low")).toEqual({
      model: "gemini-3.8-flash-low",
    });
    // Effort override adapts composite model suffix
    expect(resolveAgyModelAndEffort("gemini-3.8-flash-high", "low")).toEqual({
      model: "gemini-3.8-flash-low",
    });
    expect(resolveAgyModelAndEffort("gemini-3.8-flash-low", "xhigh")).toEqual({
      model: "gemini-3.8-flash-high",
    });
    // Base model ID omits --effort by default (agy v1.3.4+), or passes explicit effort
    expect(resolveAgyModelAndEffort("gemini-3.8-flash")).toEqual({
      model: "gemini-3.8-flash",
    });
    expect(resolveAgyModelAndEffort("gemini-3.8-flash", "medium")).toEqual({
      model: "gemini-3.8-flash",
      effort: "medium",
    });
  });

  it("resolves flat Gemini 3.7 models directly or adapts to effort overrides", () => {
    expect(resolveAgyModelAndEffort("gemini-3.7-flash-high")).toEqual({
      model: "gemini-3.7-flash-high",
    });
    expect(resolveAgyModelAndEffort("gemini-3.7-flash-medium")).toEqual({
      model: "gemini-3.7-flash-medium",
    });
    expect(resolveAgyModelAndEffort("gemini-3.7-flash-low")).toEqual({
      model: "gemini-3.7-flash-low",
    });
    // Effort override adapts composite model suffix
    expect(resolveAgyModelAndEffort("gemini-3.7-flash-high", "low")).toEqual({
      model: "gemini-3.7-flash-low",
    });
    // Base model ID
    expect(resolveAgyModelAndEffort("gemini-3.7-flash")).toEqual({
      model: "gemini-3.7-flash",
    });
    expect(resolveAgyModelAndEffort("gemini-3.7-flash", "medium")).toEqual({
      model: "gemini-3.7-flash",
      effort: "medium",
    });
  });

  it("resolves Gemini 3.6 and 3.5 models and cheap alias", () => {
    expect(resolveAgyModelAndEffort("gemini-3.6-flash-high")).toEqual({
      model: "gemini-3.6-flash-high",
    });
    expect(resolveAgyModelAndEffort("gemini-3.6-flash")).toEqual({
      model: "gemini-3.6-flash",
    });
    expect(resolveAgyModelAndEffort("gemini-3.6-flash", "low")).toEqual({
      model: "gemini-3.6-flash",
      effort: "low",
    });
    expect(resolveAgyModelAndEffort("gemini-3.5-flash-medium")).toEqual({
      model: "gemini-3.5-flash-medium",
    });
    expect(resolveAgyModelAndEffort("cheap")).toEqual({
      model: "gemini-3.8-flash-low",
    });
    expect(resolveAgyModelAndEffort("cheap", "high")).toEqual({
      model: "gemini-3.8-flash-high",
    });
    expect(resolveAgyModelAndEffort("gemini-3.5-flash", "high")).toEqual({
      model: "gemini-3.5-flash",
      effort: "high",
    });
  });

  it("resolves Claude 5.5 composite and base/ADC models directly or adapts to effort", () => {
    expect(resolveAgyModelAndEffort("claude-sonnet-5-5-high")).toEqual({
      model: "claude-sonnet-5-5-high",
    });
    expect(resolveAgyModelAndEffort("claude-sonnet-5-5-medium")).toEqual({
      model: "claude-sonnet-5-5-medium",
    });
    expect(resolveAgyModelAndEffort("claude-sonnet-5-5-low")).toEqual({
      model: "claude-sonnet-5-5-low",
    });
    expect(resolveAgyModelAndEffort("claude-sonnet-5-5-high", "low")).toEqual({
      model: "claude-sonnet-5-5-low",
    });
    expect(resolveAgyModelAndEffort("claude-sonnet-5-5")).toEqual({
      model: "claude-sonnet-5-5",
    });
    expect(resolveAgyModelAndEffort("claude-sonnet-5-5", "medium")).toEqual({
      model: "claude-sonnet-5-5",
      effort: "medium",
    });
    expect(resolveAgyModelAndEffort("claude-opus-5-5-high")).toEqual({
      model: "claude-opus-5-5-high",
    });
    expect(resolveAgyModelAndEffort("claude-opus-5-5-low", "medium")).toEqual({
      model: "claude-opus-5-5-medium",
    });
    expect(resolveAgyModelAndEffort("claude-opus-5-5")).toEqual({
      model: "claude-opus-5-5",
    });
    expect(resolveAgyModelAndEffort("claude-opus-5-5", "high")).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
    });
  });

  it("resolves legacy Claude models and aliases", () => {
    expect(resolveAgyModelAndEffort("claude-sonnet-4-6")).toEqual({
      model: "claude-sonnet-4-6",
    });
    expect(resolveAgyModelAndEffort("claude-sonnet-4.6-thinking")).toEqual({
      model: "claude-sonnet-4-6",
    });
    expect(resolveAgyModelAndEffort("claude-opus-4-6-thinking")).toEqual({
      model: "claude-opus-4-6-thinking",
    });
    expect(resolveAgyModelAndEffort("smart")).toEqual({
      model: "claude-sonnet-5-5-high",
    });
  });

  it("resolves Gemini 3.1 Pro models", () => {
    expect(resolveAgyModelAndEffort("gemini-3.1-pro-high")).toEqual({
      model: "gemini-3.1-pro-high",
    });
    expect(resolveAgyModelAndEffort("gemini-3.1-pro-low")).toEqual({
      model: "gemini-3.1-pro-low",
    });
    expect(resolveAgyModelAndEffort("gemini-3.1-pro")).toEqual({
      model: "gemini-3.1-pro",
    });
    expect(resolveAgyModelAndEffort("gemini-3.1-pro", "low")).toEqual({
      model: "gemini-3.1-pro",
      effort: "low",
    });
    expect(resolveAgyModelAndEffort("gemini-3.1-pro-high", "low")).toEqual({
      model: "gemini-3.1-pro-low",
    });
  });

  it("resolves GPT-OSS 120B models", () => {
    expect(resolveAgyModelAndEffort("gpt-oss-120b-medium")).toEqual({
      model: "gpt-oss-120b-medium",
    });
    expect(resolveAgyModelAndEffort("gpt-oss-120b")).toEqual({
      model: "gpt-oss-120b",
    });
    expect(resolveAgyModelAndEffort("gpt-oss-120b", "low")).toEqual({
      model: "gpt-oss-120b",
      effort: "low",
    });
  });

  it("passes custom models through with optional effort", () => {
    expect(resolveAgyModelAndEffort("custom-experimental-model")).toEqual({
      model: "custom-experimental-model",
    });
    expect(resolveAgyModelAndEffort("custom-experimental-model", "high")).toEqual({
      model: "custom-experimental-model",
      effort: "high",
    });
  });
});
