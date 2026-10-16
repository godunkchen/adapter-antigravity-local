import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterAgent,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  joinPromptSections,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  readPaperclipIssueWorkModeFromContext,
  readPaperclipRuntimeSkillEntries,
  stringifyPaperclipWakePayload,
  parseObject,
  renderTemplate,
  renderPaperclipWakePrompt,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import {
  resolveAntigravitySkillsHome,
  ensureAntigravitySkillsInjected,
  resolveAntigravityDesiredSkillNames,
} from "./skills.js";
import { DEFAULT_ANTIGRAVITY_LOCAL_MODEL, SANDBOX_INSTALL_COMMAND } from "../index.js";
import {
  extractAntigravityExecutionMetrics,
  extractAntigravitySessionId,
  isAntigravityUnknownSessionError,
} from "./parse.js";
import { firstNonEmptyLine } from "../utils.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the effective working directory (CWD) paths based on agent instructions, 
 * configuration fallbacks, and local strategy configurations.
 * 
 * @param config - The raw adapter configuration dictionary.
 * @param workspaceContext - Parsed workspace settings from Paperclip context.
 * @returns Resolves the target CWD and the effective workspace fallback CWD.
 */
async function resolveEffectiveCwd(
  config: Record<string, unknown>,
  workspaceContext: Record<string, unknown>
): Promise<{ cwd: string; effectiveWorkspaceCwd: string }> {
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const configuredCwd = asString(config.cwd, "");
  
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  return { cwd, effectiveWorkspaceCwd };
}

/**
 * Formats a concise runtime note listing all active PAPERCLIP_* environment variables.
 * 
 * @param env - The merged environment mapping.
 * @returns A formatted markdown string or empty string.
 */
function renderPaperclipEnvNote(env: Record<string, string>): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (paperclipKeys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "",
    "",
  ].join("\n");
}

/**
 * Formats a helper note demonstrating how to query the Paperclip REST API via curl.
 * 
 * @param env - The merged environment mapping.
 * @returns A formatted curl example markdown string or empty string.
 */
function renderApiAccessNote(env: Record<string, string>): string {
  const apiUrl = env.PAPERCLIP_API_URL?.trim();
  const apiKey = env.PAPERCLIP_API_KEY?.trim();
  if (!apiUrl || !apiKey) return "";
  return [
    "Paperclip API access note:",
    "Use run_command / bash with curl to make Paperclip API requests.",
    "GET example:",
    `  curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_URL/api/agents/me"`,
    "POST/PATCH example:",
    `  curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H 'Content-Type: application/json' -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -d '{...}' "$PAPERCLIP_API_URL/api/issues/{id}/checkout"`,
    "",
    "",
  ].join("\n");
}

/**
 * Builds the comprehensive environment variables mapping for process spawning, 
 * injecting Antigravity specific selectors and Paperclip framework environment bindings.
 * 
 * @param runId - The unique sequence run identifier.
 * @param agent - The executing Paperclip Agent structure.
 * @param config - The raw adapter configuration dictionary.
 * @param model - The resolved Antigravity model name.
 * @param authToken - Optional authentication bearer token.
 * @returns An environment mapping ready for process injection.
 */
function buildExecutionEnvironment(
  runId: string,
  agent: AdapterAgent,
  config: Record<string, unknown>,
  model: string,
  authToken: string | null | undefined
): { env: Record<string, string>; envConfig: Record<string, unknown> } {
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  if (model && model !== DEFAULT_ANTIGRAVITY_LOCAL_MODEL) {
    env.ANTIGRAVITY_MODEL = model;
  }

  if (authToken && typeof envConfig.PAPERCLIP_API_KEY !== "string") {
    env.PAPERCLIP_API_KEY = authToken;
  }

  return { env, envConfig };
}

/**
 * Generates the clean CLI argument list for spawning the `agy` process.
 * Maps session IDs, prompts, models, and active workspaces to repeatable arguments.
 * 
 * @param prompt - The compiled orchestrator prompt payload.
 * @param resumeSessionId - Optional session ID to resume (resets turn contexts).
 * @param workspaces - Active Paperclip workspace mappings to register.
 * @param sandbox - Indicates whether OS and terminal sandboxing is enabled.
 * @param extraArgs - Structured list of user-defined CLI arguments to append.
 * @param model - Optional model selection identifier.
 * @returns An array representing the formatted CLI arguments list.
 */
export interface AgyModelResolution {
  model?: string;
  effort?: string;
}

export interface CompileAgyArgumentsOptions {
  mode?: string;
  agent?: string;
  jsonSchema?: string;
  dangerouslySkipPermissions?: boolean;
}

/**
 * Resolves Paperclip model selections to exact agy CLI model flags and reasoning effort settings.
 *
 * Rules (agy v1.3.4–v1.3.6):
 * 1. Flat composite model IDs (e.g. gemini-4-argon-high, gemini-3.8-flash-high, claude-sonnet-5-5-high, gpt-oss-120b-medium)
 *    are supported directly. If an explicit thinkingEffort is supplied on a composite model, its effort suffix is adapted.
 * 2. Base model IDs (e.g. gemini-4-argon, gemini-3.8-flash, claude-opus-5-5, claude-sonnet-5-5, gpt-oss-120b)
 *    omit `--effort` when no explicit effort is provided so `agy` v1.3.4+ uses the server's default reasoning effort
 *    (and `AGY_ADC_AUTH` base model IDs work natively in v1.3.6). When an explicit effort is provided on a base model,
 *    `--effort <level>` is passed alongside `--model <base-id>`.
 * 3. Legacy Claude models map to exact agy CLI identifiers (e.g. claude-sonnet-4-6, claude-opus-4-6-thinking).
 * 4. "auto" returns empty object or `{ effort: userEffort }` to allow agy native auto-routing defaults.
 */
export function resolveAgyModelAndEffort(rawModel?: string, rawEffort?: string): AgyModelResolution {
  const modelStr = (rawModel || "").trim();
  const normalizedEffortInput = (rawEffort || "").trim().toLowerCase();

  const userEffort =
    normalizedEffortInput === "low" || normalizedEffortInput === "minimal"
      ? "low"
      : normalizedEffortInput === "medium"
        ? "medium"
        : normalizedEffortInput === "high"
          ? "high"
          : normalizedEffortInput === "xhigh" || normalizedEffortInput === "extra-high"
            ? "xhigh"
            : normalizedEffortInput === "max" || normalizedEffortInput === "maximum"
              ? "max"
              : undefined;

  if (!modelStr || modelStr.toLowerCase() === "auto") {
    return userEffort ? { effort: userEffort } : {};
  }

  const lower = modelStr.toLowerCase();

  // 1. Gemini 4 Argon models (agy 1.3.6)
  if (lower.startsWith("gemini-4-argon") || lower.includes("argon")) {
    const isBaseArgon = lower === "gemini-4-argon";
    if (!userEffort) {
      if (lower.includes("-low")) return { model: "gemini-4-argon-low" };
      if (lower.includes("-medium")) return { model: "gemini-4-argon-medium" };
      if (lower.includes("-high")) return { model: "gemini-4-argon-high" };
      return { model: "gemini-4-argon" };
    }
    if (isBaseArgon) {
      return { model: "gemini-4-argon", effort: userEffort };
    }
    const targetEffort = userEffort === "xhigh" || userEffort === "max" ? "high" : userEffort;
    return { model: `gemini-4-argon-${targetEffort}` };
  }

  // 2. Claude 5.5 models (agy 1.3.3–1.3.6, including base model & ADC support)
  if (lower.startsWith("claude-sonnet-5-5") || lower.startsWith("claude-sonnet-5.5")) {
    const isBaseSonnet55 = lower === "claude-sonnet-5-5" || lower === "claude-sonnet-5.5";
    if (!userEffort) {
      if (lower.includes("-low")) return { model: "claude-sonnet-5-5-low" };
      if (lower.includes("-medium")) return { model: "claude-sonnet-5-5-medium" };
      if (lower.includes("-high")) return { model: "claude-sonnet-5-5-high" };
      return { model: "claude-sonnet-5-5" };
    }
    if (isBaseSonnet55) {
      return { model: "claude-sonnet-5-5", effort: userEffort };
    }
    const targetEffort = userEffort === "xhigh" || userEffort === "max" ? "high" : userEffort;
    return { model: `claude-sonnet-5-5-${targetEffort}` };
  }

  if (lower.startsWith("claude-opus-5-5") || lower.startsWith("claude-opus-5.5")) {
    const isBaseOpus55 = lower === "claude-opus-5-5" || lower === "claude-opus-5.5";
    if (!userEffort) {
      if (lower.includes("-low")) return { model: "claude-opus-5-5-low" };
      if (lower.includes("-medium")) return { model: "claude-opus-5-5-medium" };
      if (lower.includes("-high")) return { model: "claude-opus-5-5-high" };
      return { model: "claude-opus-5-5" };
    }
    if (isBaseOpus55) {
      return { model: "claude-opus-5-5", effort: userEffort };
    }
    const targetEffort = userEffort === "xhigh" || userEffort === "max" ? "high" : userEffort;
    return { model: `claude-opus-5-5-${targetEffort}` };
  }

  // 3. Legacy Claude models & general aliases
  if (lower === "claude-sonnet-4-6" || lower === "claude-sonnet-4.6-thinking") {
    return { model: "claude-sonnet-4-6" };
  }
  if (lower === "claude-opus-4-6-thinking" || lower === "claude-opus-4-6") {
    return { model: "claude-opus-4-6-thinking" };
  }
  if (lower.includes("sonnet") || lower === "smart") {
    return { model: "claude-sonnet-5-5-high" };
  }
  if (lower.includes("opus")) {
    return { model: "claude-opus-5-5-high" };
  }

  // 4. GPT-OSS 120B (agy 1.3.4+ base model default effort support)
  if (lower.includes("gpt-oss-120b")) {
    if (lower === "gpt-oss-120b-medium" && !userEffort) {
      return { model: "gpt-oss-120b-medium" };
    }
    if (userEffort) {
      return { model: "gpt-oss-120b", effort: userEffort };
    }
    if (lower === "gpt-oss-120b") {
      return { model: "gpt-oss-120b" };
    }
    return { model: "gpt-oss-120b-medium" };
  }

  // 5. Gemini 3.8 Flash (agy 1.3.3–1.3.6)
  if (lower.includes("gemini-3.8-flash") || lower.includes("gemini-3.8")) {
    if (!userEffort) {
      if (lower.includes("-high")) return { model: "gemini-3.8-flash-high" };
      if (lower.includes("-medium")) return { model: "gemini-3.8-flash-medium" };
      if (lower.includes("-low")) return { model: "gemini-3.8-flash-low" };
      return { model: "gemini-3.8-flash" };
    }
    if (lower === "gemini-3.8-flash") {
      return { model: "gemini-3.8-flash", effort: userEffort };
    }
    const targetEffort = userEffort === "xhigh" || userEffort === "max" ? "high" : userEffort;
    return { model: `gemini-3.8-flash-${targetEffort}` };
  }

  // 6. Gemini 3.7 Flash
  if (lower.includes("gemini-3.7-flash") || lower.includes("gemini-3.7")) {
    if (!userEffort) {
      if (lower.includes("-high")) return { model: "gemini-3.7-flash-high" };
      if (lower.includes("-medium")) return { model: "gemini-3.7-flash-medium" };
      if (lower.includes("-low")) return { model: "gemini-3.7-flash-low" };
      return { model: "gemini-3.7-flash" };
    }
    if (lower === "gemini-3.7-flash") {
      return { model: "gemini-3.7-flash", effort: userEffort };
    }
    const targetEffort = userEffort === "xhigh" || userEffort === "max" ? "high" : userEffort;
    return { model: `gemini-3.7-flash-${targetEffort}` };
  }

  // 7. Gemini 3.6 Flash
  if (lower.includes("gemini-3.6-flash") || lower.includes("gemini-3.6")) {
    if (!userEffort) {
      if (lower.includes("-high")) return { model: "gemini-3.6-flash-high" };
      if (lower.includes("-medium")) return { model: "gemini-3.6-flash-medium" };
      if (lower.includes("-low")) return { model: "gemini-3.6-flash-low" };
      return { model: "gemini-3.6-flash" };
    }
    if (lower === "gemini-3.6-flash") {
      return { model: "gemini-3.6-flash", effort: userEffort };
    }
    const targetEffort = userEffort === "xhigh" || userEffort === "max" ? "high" : userEffort;
    return { model: `gemini-3.6-flash-${targetEffort}` };
  }

  // 8. Gemini 3.5 Flash / Cheap / Fast
  if (lower === "cheap" || lower === "fast" || lower.includes("gemini-3.5-flash") || lower.includes("gemini-3.5")) {
    if (lower === "cheap" || lower === "fast") {
      const targetEffort = userEffort === "xhigh" || userEffort === "max" ? "high" : userEffort || "low";
      return { model: `gemini-3.8-flash-${targetEffort}` };
    }
    if (!userEffort) {
      if (lower.includes("-high")) return { model: "gemini-3.5-flash-high" };
      if (lower.includes("-medium")) return { model: "gemini-3.5-flash-medium" };
      if (lower.includes("-low")) return { model: "gemini-3.5-flash-low" };
      return { model: "gemini-3.5-flash" };
    }
    if (lower === "gemini-3.5-flash") {
      return { model: "gemini-3.5-flash", effort: userEffort };
    }
    const targetEffort = userEffort === "xhigh" || userEffort === "max" ? "high" : userEffort;
    return { model: `gemini-3.5-flash-${targetEffort}` };
  }

  // 9. Gemini 3.1 Pro
  if (lower.includes("gemini-3.1-pro") || lower.includes("gemini-3.1")) {
    if (!userEffort) {
      if (lower.includes("-low")) return { model: "gemini-3.1-pro-low" };
      if (lower.includes("-high")) return { model: "gemini-3.1-pro-high" };
      return { model: "gemini-3.1-pro" };
    }
    if (lower === "gemini-3.1-pro") {
      return { model: "gemini-3.1-pro", effort: userEffort };
    }
    return { model: `gemini-3.1-pro-${userEffort === "low" ? "low" : "high"}` };
  }

  // Fallback: Custom model string passed by user
  return { model: modelStr, ...(userEffort ? { effort: userEffort } : {}) };
}

export function compileAgyArguments(
  prompt: string,
  resumeSessionId: string | null,
  workspaces: unknown[],
  sandbox: boolean,
  extraArgs: string[],
  model?: string,
  effort?: string,
  timeoutSec?: number,
  options?: CompileAgyArgumentsOptions,
): string[] {
  const args = ["--print", prompt, "--output-format", "stream-json"];
  const resolved = resolveAgyModelAndEffort(model, effort);
  if (resolved.model) {
    args.push("--model", resolved.model);
  }
  if (resolved.effort) {
    args.push("--effort", resolved.effort);
  }
  const mode = (options?.mode || "").trim();
  if (mode) {
    args.push("--mode", mode);
  }
  const agentName = (options?.agent || "").trim();
  if (agentName) {
    args.push("--agent", agentName);
  }
  const jsonSchema = (options?.jsonSchema || "").trim();
  if (jsonSchema) {
    args.push("--json-schema", jsonSchema);
  }
  if (timeoutSec && timeoutSec > 0) {
    args.push("--print-timeout", `${timeoutSec}s`);
  }
  if (resumeSessionId) {
    args.push("--conversation", resumeSessionId);
  }
  
  for (const ws of workspaces) {
    const wsObj = parseObject(ws);
    const wsCwd = asString(wsObj.cwd, "");
    if (wsCwd.length > 0) {
      args.push("--add-dir", wsCwd);
    }
  }

  if (options?.dangerouslySkipPermissions !== false) {
    args.push("--dangerously-skip-permissions");
  }
  if (sandbox) {
    args.push("--sandbox");
  }
  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }
  return args;
}

function isRecoveryWakePayload(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return Boolean(rec.recovery || rec.reason === "source_scoped_recovery_action");
}

/**
 * Core execution engine function for Google Antigravity local CLI integrations.
 * Decomposes process preparation, remote SSH workspace syncs, Paperclip bridge handshakes, 
 * and command invocation into a robust, strongly-typed pipeline.
 * 
 * @param ctx - The unified adapter execution context containing metadata, configurations, and logs handlers.
 * @returns A promise resolving to the final adapter execution output structure.
 */
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const command = asString(config.command, "agy");
  const model = asString(config.model, DEFAULT_ANTIGRAVITY_LOCAL_MODEL).trim();
  const rawEffort = (
    asString(config.thinkingEffort, "") ||
    asString(config.effort, "") ||
    asString(config.modelReasoningEffort, "") ||
    asString(config.reasoningEffort, "")
  ).trim();
  const mode = asString(config.mode, "").trim();
  const customAgent = asString(config.agent, "").trim();
  const jsonSchema = asString(config.jsonSchema, "").trim();
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const configuredTimeoutSec = asNumber(config.timeoutSec, 0) || asNumber(config.timeout, 0);
  const sandbox = asBoolean(config.sandbox, false);

  console.log(`[antigravity] execute() called: runId="${runId}", command="${command}", model="${model}", effort="${rawEffort}", timeoutSec=${configuredTimeoutSec}, sandbox=${sandbox}`);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const { cwd, effectiveWorkspaceCwd } = await resolveEffectiveCwd(config, workspaceContext);
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);

  const { env, envConfig } = buildExecutionEnvironment(runId, agent, config, model, authToken);

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource: asString(workspaceContext.source, ""),
    workspaceId: asString(workspaceContext.workspaceId, ""),
    workspaceRepoUrl: asString(workspaceContext.repoUrl, ""),
    workspaceRepoRef: asString(workspaceContext.repoRef, ""),
    workspaceHints: [],
    agentHome: asString(workspaceContext.agentHome, ""),
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv(effectiveEnv)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  const processTimeoutSec = resolveAdapterExecutionTargetTimeoutSec(executionTarget, configuredTimeoutSec);
  const graceSec = asNumber(config.graceSec, 20);

  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
    installCommand: SANDBOX_INSTALL_COMMAND,
    timeoutSec: processTimeoutSec,
  });

  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  let preparedExecutionTargetRuntime: Awaited<ReturnType<typeof prepareAdapterExecutionTargetRuntime>> | null = null;

  if (executionTargetIsRemote) {
    try {
      await onLog("stdout", `[paperclip] Preparing remote execution target ${describeAdapterExecutionTarget(executionTarget)}...\n`);
      preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "antigravity",
        timeoutSec: processTimeoutSec,
        workspaceLocalDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        assets: [],
      });
      restoreRemoteWorkspace = () => preparedExecutionTargetRuntime!.restoreWorkspace();
      effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
    } catch (error) {
      await restoreRemoteWorkspace?.();
      throw error;
    }
  }

  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
  
  if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(executionTarget)) {
    paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId,
      target: runtimeExecutionTarget,
      runtimeRootDir: preparedExecutionTargetRuntime?.runtimeRootDir ?? null,
      adapterKey: "antigravity",
      timeoutSec: processTimeoutSec,
      hostApiToken: env.PAPERCLIP_API_KEY,
      onLog,
    });
    if (paperclipBridge) {
      Object.assign(env, paperclipBridge.env);
    }
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
  const sessionId = canResumeSession ? runtimeSessionId : null;

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const antigravitySkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredAntigravitySkillNames = resolveAntigravityDesiredSkillNames(config, antigravitySkillEntries);
  const desiredSkillSet = new Set(desiredAntigravitySkillNames);
  const selectedSkillEntries = antigravitySkillEntries.filter((entry) => desiredSkillSet.has(entry.key));
  const selectedSkillNames = selectedSkillEntries.map((entry) => entry.runtimeName).sort();

  let skillsHome: string | null = null;
  if (!executionTargetIsRemote && selectedSkillEntries.length > 0) {
    skillsHome = resolveAntigravitySkillsHome(config);
    await ensureAntigravitySkillsInjected(onLog, antigravitySkillEntries, desiredAntigravitySkillNames, skillsHome);
  }

  const runtimeSkillsNote =
    selectedSkillEntries.length > 0 && skillsHome
      ? [
          "Paperclip has materialized selected runtime skills for this Antigravity session.",
          `Skill root: ${skillsHome}`,
          selectedSkillNames.length > 0 ? `Selected skills: ${selectedSkillNames.join(", ")}` : "",
          "When a task calls for one of these skills, read its SKILL.md from that root and follow it.",
          "",
          "",
        ].filter(Boolean).join("\n")
      : "";

  const commandNotes = (() => {
    const notes: string[] = [
      "Running Antigravity CLI in headless print mode",
      `Effective model: "${model}"`,
    ];
    if (selectedSkillEntries.length > 0 && skillsHome) {
      notes.push(
        `Materialized ${selectedSkillEntries.length} Paperclip skill(s) for Antigravity at ${skillsHome}.`,
      );
    }
    if (instructionsPrefix.length > 0) {
      notes.push(
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to prompt (relative references from ${instructionsDir}).`,
      );
    } else if (instructionsFilePath) {
      notes.push(
        `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      );
    }
    return notes;
  })();

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt || isRecoveryWakePayload(context.paperclipWake)
    ? ""
    : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const paperclipEnvNote = renderPaperclipEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);
  const prompt = joinPromptSections([
    runtimeSkillsNote,
    instructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    paperclipEnvNote,
    apiAccessNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    skillsChars: runtimeSkillsNote.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const rawWorkspaces = Array.isArray(context.paperclipWorkspaces) ? context.paperclipWorkspaces : [];
    const workspaces = [...rawWorkspaces];
    if (skillsHome && selectedSkillEntries.length > 0) {
      const alreadyIncluded = workspaces.some(
        (ws) => typeof ws === "object" && ws !== null && (ws as any).cwd === skillsHome,
      );
      if (!alreadyIncluded) {
        workspaces.push({ cwd: skillsHome });
      }
    }
    const args = compileAgyArguments(
      prompt,
      resumeSessionId,
      workspaces,
      sandbox,
      extraArgs,
      model,
      rawEffort,
      configuredTimeoutSec,
      {
        mode,
        agent: customAgent,
        jsonSchema,
        dangerouslySkipPermissions,
      },
    );
    
    console.log(`[antigravity] Executing agy CLI: ${command} ${args.join(" ")}`);
    await onLog("stdout", `[antigravity] Executing agy CLI (model: "${model}", session: ${resumeSessionId ?? "new"})\n`);

    if (onMeta) {
      await onMeta({
        adapterType: "antigravity_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandNotes,
        commandArgs: args.map((val, idx) => (idx === 1 ? `<prompt ${prompt.length} chars>` : val)),
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    return await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
      cwd,
      env,
      timeoutSec: processTimeoutSec,
      graceSec,
      onSpawn,
      onLog,
    });
  };

  try {
    const proc = await runAttempt(sessionId);
    
    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${processTimeoutSec}s`,
        errorCode: null,
        clearSession: false,
      };
    }

    const failed = (proc.exitCode ?? 0) !== 0;
    const rawStdout = proc.stdout.trim();
    const rawStderr = proc.stderr.trim();
    const unknownSession = failed && isAntigravityUnknownSessionError(rawStdout, rawStderr);
    const fallbackErrorMessage = firstNonEmptyLine(rawStderr) || `Antigravity exited with code ${proc.exitCode ?? -1}`;

    const extractedSessionId = extractAntigravitySessionId(rawStdout, rawStderr);
    const finalSessionId = sessionId || extractedSessionId;

    const metrics = extractAntigravityExecutionMetrics(rawStdout, rawStderr);
    const summaryText = metrics.response ?? rawStdout;

    const resolvedSessionParams = finalSessionId
      ? {
          sessionId: finalSessionId,
          cwd: effectiveExecutionCwd,
          ...(asString(workspaceContext.workspaceId, "") ? { workspaceId: workspaceContext.workspaceId } : {}),
          ...(executionTargetIsRemote ? { remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget) } : {}),
        }
      : null;

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: failed ? fallbackErrorMessage : null,
      errorCode: null,
      usage: metrics.usage,
      sessionId: finalSessionId || null,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: finalSessionId || null,
      provider: "google",
      biller: "google",
      model,
      billingType: "api",
      costUsd: metrics.costUsd,
      resultJson: { raw: rawStdout },
      summary: failed ? "" : summaryText,
      question: null,
      clearSession: unknownSession,
    };
  } finally {
    await Promise.all([
      paperclipBridge?.stop(),
      restoreRemoteWorkspace?.(),
    ]);
  }
}