/**
 * @fileoverview Configuration builder mapping Web UI settings into strongly-typed Antigravity configs.
 * Parses raw text-based envs, process variables bindings, custom flags, and model preferences.
 * 
 * @copyright Antigravity Adapter Contributors
 * @license MIT
 */

import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_ANTIGRAVITY_LOCAL_MODEL } from "../index.js";
import type { AntigravityAdapterConfig, EnvBindings } from "../types.js";
import { parseCommaArgs, parseMultilineLines } from "../utils.js";

/** Regex pattern validating compliance with standard POSIX environment variable name specifications. */
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates whether a given key conforms to standard POSIX environment variable naming rules.
 * Reusable validator applying DRY principle.
 *
 * @param name - The key name string to inspect.
 * @returns True if valid POSIX format.
 */
function isValidEnvVariableName(name: string): boolean {
  return ENV_VAR_NAME_RE.test(name);
}

/**
 * Parses raw multilines text variables definitions (e.g., KEY=VALUE) into a plain dictionary.
 * Ignores comments starting with # and trims/sanitizes names.
 *
 * @param text - The raw multiline string text.
 * @returns Parsed flat environment dictionary.
 */
function parseEnvVars(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of parseMultilineLines(text)) {
    if (line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    
    if (!isValidEnvVariableName(key)) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

/**
 * Validates and maps structured Paperclip variable bindings (plain or secret references).
 *
 * @param bindings - The raw bindings unknown payload.
 * @returns Cleaned environment bindings dictionary.
 */
function parseEnvBindings(bindings: unknown): Record<string, unknown> {
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) {
    return {};
  }
  const env: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(bindings)) {
    if (!isValidEnvVariableName(key)) {
      continue;
    }
    if (typeof raw === "string") {
      env[key] = { type: "plain", value: raw };
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      continue;
    }
    const rec = raw as Record<string, unknown>;
    if (rec.type === "plain" && typeof rec.value === "string") {
      env[key] = { type: "plain", value: rec.value };
      continue;
    }
    if (rec.type === "secret_ref" && typeof rec.secretId === "string") {
      env[key] = {
        type: "secret_ref",
        secretId: rec.secretId,
        ...(typeof rec.version === "number" || rec.version === "latest"
          ? { version: rec.version }
          : {}),
      };
    }
  }
  return env;
}

/**
 * Safely parses a JSON object string into a plain dictionary, returning null on invalid input.
 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Builds the strongly-typed Antigravity local config structure from Web UI values.
 * Applies model fallbacks, sandboxing bypass, extra args parsing, merges legacy env vars,
 * and maps `claude-local` parity fields (`thinkingEffort`, `dangerouslySkipPermissions`,
 * `maxTurnsPerRun`, `workspaceStrategy`, `workspaceRuntime`, `mode`, `agent`, `jsonSchema`).
 *
 * @param v - Raw configuration values captured by Paperclip's Web UI.
 * @returns A validated, fully-typed Antigravity configuration structure.
 */
export function buildAntigravityLocalConfig(v: CreateConfigValues): AntigravityAdapterConfig {
  const ac: AntigravityAdapterConfig = {
    model: v.model || DEFAULT_ANTIGRAVITY_LOCAL_MODEL,
    timeoutSec: 0,
    graceSec: 15,
  };
  if (v.cwd) {
    ac.cwd = v.cwd;
  }
  if (v.instructionsFilePath) {
    ac.instructionsFilePath = v.instructionsFilePath;
  }
  const rawRecord = v as unknown as Record<string, unknown>;
  const schemaValues =
    typeof v.adapterSchemaValues === "object" &&
    v.adapterSchemaValues !== null &&
    !Array.isArray(v.adapterSchemaValues)
      ? v.adapterSchemaValues
      : {};

  if (typeof rawRecord.bootstrapPromptTemplate === "string" && rawRecord.bootstrapPromptTemplate.trim().length > 0) {
    ac.bootstrapPromptTemplate = rawRecord.bootstrapPromptTemplate.trim();
  } else if (typeof v.bootstrapPrompt === "string" && v.bootstrapPrompt.trim().length > 0) {
    ac.bootstrapPromptTemplate = v.bootstrapPrompt.trim();
  }
  if (typeof rawRecord.promptTemplate === "string" && rawRecord.promptTemplate.trim().length > 0) {
    ac.promptTemplate = rawRecord.promptTemplate.trim();
  }

  const resolvedEffort =
    (typeof v.thinkingEffort === "string" && v.thinkingEffort.trim()) ||
    (typeof schemaValues.effort === "string" && schemaValues.effort.trim()) ||
    (typeof rawRecord.effort === "string" && rawRecord.effort.trim()) ||
    "";
  if (resolvedEffort) {
    ac.effort = resolvedEffort;
  }

  const resolvedMode =
    (typeof schemaValues.mode === "string" && schemaValues.mode.trim()) ||
    (typeof rawRecord.mode === "string" && rawRecord.mode.trim()) ||
    "";
  if (resolvedMode) {
    ac.mode = resolvedMode;
  }

  const resolvedAgent =
    (typeof schemaValues.agent === "string" && schemaValues.agent.trim()) ||
    (typeof rawRecord.agent === "string" && rawRecord.agent.trim()) ||
    "";
  if (resolvedAgent) {
    ac.agent = resolvedAgent;
  }

  const resolvedJsonSchema =
    (typeof schemaValues.jsonSchema === "string" && schemaValues.jsonSchema.trim()) ||
    (typeof rawRecord.jsonSchema === "string" && rawRecord.jsonSchema.trim()) ||
    "";
  if (resolvedJsonSchema) {
    ac.jsonSchema = resolvedJsonSchema;
  }

  const env = parseEnvBindings(v.envBindings) as EnvBindings;
  const legacy = parseEnvVars(v.envVars);
  for (const [key, value] of Object.entries(legacy)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      env[key] = { type: "plain", value };
    }
  }
  if (Object.keys(env).length > 0) {
    ac.env = env;
  }
  ac.sandbox = !v.dangerouslyBypassSandbox;

  if (typeof v.dangerouslySkipPermissions === "boolean") {
    ac.dangerouslySkipPermissions = v.dangerouslySkipPermissions;
  }
  if (typeof v.maxTurnsPerRun === "number") {
    ac.maxTurnsPerRun = v.maxTurnsPerRun;
  }
  if (v.workspaceStrategyType === "git_worktree") {
    ac.workspaceStrategy = {
      type: "git_worktree",
      ...(v.workspaceBaseRef ? { baseRef: v.workspaceBaseRef } : {}),
      ...(v.workspaceBranchTemplate ? { branchTemplate: v.workspaceBranchTemplate } : {}),
      ...(v.worktreeParentDir ? { worktreeParentDir: v.worktreeParentDir } : {}),
    };
  }
  const runtimeServices = parseJsonObject(v.runtimeServicesJson ?? "");
  if (runtimeServices && Array.isArray(runtimeServices.services)) {
    ac.workspaceRuntime = runtimeServices;
  }

  if (v.command) {
    ac.command = v.command;
  }
  if (v.extraArgs) {
    ac.extraArgs = parseCommaArgs(v.extraArgs);
  }
  return ac;
}