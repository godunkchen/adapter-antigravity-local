/**
 * @fileoverview Environment connection probe and diagnostic checks for Antigravity local executions.
 * Performs deep, step-by-step diagnostic checks validating filesystem permissions, CLI presence,
 * credentials (API key, Gemini API key, GCP Application Default Credentials), sandboxing triggers,
 * optional v1.3.4+ plugin inventory, and live API connectivity through a stream-json hello probe.
 * Aligned with `@paperclipai/adapter-claude-local`.
 *
 * @copyright Antigravity Adapter Contributors
 * @license MIT
 */

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { DEFAULT_ANTIGRAVITY_LOCAL_MODEL, SANDBOX_INSTALL_COMMAND } from "../index.js";
import { ensureAntigravityPathInEnv } from "./cli-capabilities.js";
import {
  detectAntigravityAuthRequired,
  detectAntigravityQuotaExhausted,
  extractAntigravityRetryNotBefore,
  hasAntigravityTerminalResult,
  isAntigravityProviderQuotaExhausted,
  isAntigravityTransientUpstreamError,
  parseAntigravityStreamJson,
} from "./parse.js";
import { firstNonEmptyLine, commandLooksLike, isNonEmptyString } from "../utils.js";
import { resolveAgyModelAndEffort } from "./execute.js";

/**
 * Summarizes the combined status from a list of environmental diagnostic checks.
 *
 * @param checks - The array of diagnostic checks performed.
 * @returns 'fail' if any error exists, 'warn' if warnings exist, otherwise 'pass'.
 */
function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) {
    return "fail";
  }
  if (checks.some((check) => check.level === "warn")) {
    return "warn";
  }
  return "pass";
}

/**
 * Summarizes process stdout/stderr into a single cleaned, length-bounded line.
 *
 * @param stdout - Process stdout stream string.
 * @param stderr - Process stderr stream string.
 * @returns Cleaned and truncated log details snippet, or null.
 */
function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const parsed = parseAntigravityStreamJson(stdout);
  const raw =
    firstNonEmptyLine(stderr) ||
    firstNonEmptyLine(parsed.summary) ||
    firstNonEmptyLine(stdout);
  if (!raw) {
    return null;
  }
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Validates whether the configured target execution directory exists or is mountable.
 *
 * @param runId - Unique check run identifier.
 * @param target - The execution target location metadata.
 * @param cwd - The working directory absolute path.
 * @returns A diagnostic check object.
 */
async function checkWorkingDirectory(
  runId: string,
  target: AdapterExecutionTarget | null,
  cwd: string,
): Promise<AdapterEnvironmentCheck> {
  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    return {
      code: "antigravity_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    };
  } catch (err) {
    return {
      code: "antigravity_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    };
  }
}

/**
 * Builds and resolves execution target environment variables from adapter configuration.
 * Automatically maps standard config.model selections into the model environment key.
 *
 * @param config - The parsed adapter configuration dictionary.
 * @returns Object mapping env key-value pairs.
 */
function resolveExecutionEnvironment(config: Record<string, unknown>): Record<string, string> {
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  const model = asString(config.model, DEFAULT_ANTIGRAVITY_LOCAL_MODEL).trim();
  if (model && model !== DEFAULT_ANTIGRAVITY_LOCAL_MODEL) {
    env.ANTIGRAVITY_MODEL = model;
  }

  return env;
}

/**
 * Diagnoses the availability of API key or GCP Application Default Credentials (`AGY_ADC_AUTH` in v1.3.5+)
 * within local configuration or host context.
 *
 * @param env - The parsed execution environment mapping.
 * @param targetIsRemote - True if execution occurs in a remote container/SSH system.
 * @returns A diagnostic check object.
 */
function checkApiCredentials(
  env: Record<string, string>,
  targetIsRemote: boolean,
): AdapterEnvironmentCheck {
  const configApiKey = env.ANTIGRAVITY_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  const hostApiKey = targetIsRemote
    ? undefined
    : process.env.ANTIGRAVITY_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

  if (isNonEmptyString(configApiKey) || isNonEmptyString(hostApiKey)) {
    return {
      code: "antigravity_api_key_present",
      level: "info",
      message: "Antigravity API credentials are set for API-key authentication.",
      detail: isNonEmptyString(configApiKey)
        ? "Detected in adapter config.env."
        : "Detected in host environment variables.",
    };
  }

  const adcFlag = (
    env.AGY_ADC_AUTH ||
    (targetIsRemote ? "" : process.env.AGY_ADC_AUTH || "")
  )
    .trim()
    .toLowerCase();
  const adcCredsPath =
    env.GOOGLE_APPLICATION_CREDENTIALS ||
    (targetIsRemote ? "" : process.env.GOOGLE_APPLICATION_CREDENTIALS || "");
  const gcpProject =
    env.GOOGLE_CLOUD_PROJECT ||
    (targetIsRemote ? "" : process.env.GOOGLE_CLOUD_PROJECT || "");

  if (
    adcFlag === "1" ||
    adcFlag === "true" ||
    adcFlag === "yes" ||
    isNonEmptyString(adcCredsPath)
  ) {
    return {
      code: "antigravity_adc_auth_configured",
      level: "info",
      message: "Google Cloud Application Default Credentials (ADC) authentication is enabled.",
      detail: isNonEmptyString(gcpProject)
        ? `AGY_ADC_AUTH enabled with GOOGLE_CLOUD_PROJECT="${gcpProject.trim()}".`
        : "AGY_ADC_AUTH / GOOGLE_APPLICATION_CREDENTIALS detected.",
    };
  }

  return {
    code: "antigravity_api_key_missing",
    level: "info",
    message: "No explicit ANTIGRAVITY_API_KEY or AGY_ADC_AUTH detected. Antigravity may still work via subscription login (`agy auth login`).",
    hint: "If the hello probe fails with an auth error, set ANTIGRAVITY_API_KEY, enable AGY_ADC_AUTH=1, or run `agy auth login`.",
  };
}

/**
 * Probes installed Antigravity plugins (`agy plugin list --json`, added in `agy` v1.3.4).
 *
 * @param runId - Unique check run identifier.
 * @param target - Execution target metadata.
 * @param command - Executable command name or path.
 * @param cwd - Working directory path.
 * @param env - Execution environment variables.
 * @returns An `AdapterEnvironmentCheck` describing installed plugins.
 */
export async function probeAntigravityPlugins(
  runId: string,
  target: AdapterExecutionTarget | null,
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<AdapterEnvironmentCheck> {
  try {
    const proc = await runAdapterExecutionTargetProcess(
      runId,
      target,
      command,
      ["plugin", "list", "--json"],
      {
        cwd,
        env,
        timeoutSec: 15,
        graceSec: 3,
        onLog: async () => {},
      },
    );
    if ((proc.exitCode ?? 1) === 0 && proc.stdout.trim().length > 0) {
      try {
        const parsed = JSON.parse(proc.stdout.trim()) as unknown;
        const count = Array.isArray(parsed)
          ? parsed.length
          : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as any).plugins)
            ? (parsed as any).plugins.length
            : 0;
        return {
          code: "antigravity_plugins_probed",
          level: "info",
          message: `Detected ${count} installed Antigravity plugin(s).`,
        };
      } catch {
        return {
          code: "antigravity_plugins_probed",
          level: "info",
          message: "Antigravity plugin subcommand is available.",
          detail: firstNonEmptyLine(proc.stdout),
        };
      }
    }
    return {
      code: "antigravity_plugins_unavailable",
      level: "info",
      message: "Antigravity plugin list returned no active plugins.",
    };
  } catch (err) {
    return {
      code: "antigravity_plugins_unavailable",
      level: "info",
      message: "Skipped Antigravity plugin inspection.",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Performs a live telemetry "hello" probe calling the executable with basic prompts
 * to confirm API reachability, sandbox limits, turn safety, and license status.
 *
 * @param runId - Unique check run identifier.
 * @param target - The execution target location metadata.
 * @param command - Fully qualified executable path or command name.
 * @param cwd - Absolute working directory context path.
 * @param env - Loaded environment bindings dictionary.
 * @param config - The raw adapter configuration dictionary.
 * @param checks - Accumulator array to push results into.
 */
async function performHelloTelemetryProbe(
  runId: string,
  target: AdapterExecutionTarget | null,
  command: string,
  cwd: string,
  env: Record<string, string>,
  config: Record<string, unknown>,
  checks: AdapterEnvironmentCheck[],
): Promise<void> {
  if (!commandLooksLike(command, "agy")) {
    checks.push({
      code: "antigravity_hello_probe_skipped_custom_command",
      level: "info",
      message: "Skipped hello probe because command is not `agy`.",
      detail: command,
    });
    return;
  }

  const targetIsRemote = target?.kind === "remote";
  const sandbox = asBoolean(config.sandbox, false);
  const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 60));

  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const model = asString(config.model, DEFAULT_ANTIGRAVITY_LOCAL_MODEL).trim();
  const rawEffort = (
    asString(config.thinkingEffort, "") ||
    asString(config.effort, "") ||
    asString(config.modelReasoningEffort, "") ||
    asString(config.reasoningEffort, "")
  ).trim();
  const timeoutSecConfig = asNumber(config.timeoutSec, 0) || asNumber(config.timeout, 0);
  const resolved = resolveAgyModelAndEffort(model, rawEffort);

  const args = [
    "--print",
    "Respond with hello.",
    "--output-format",
    "stream-json",
  ];
  if (resolved.model) {
    args.push("--model", resolved.model);
  }
  if (resolved.effort) {
    args.push("--effort", resolved.effort);
  }
  if (timeoutSecConfig > 0) {
    args.push("--print-timeout", `${timeoutSecConfig}s`);
  }
  args.push("--dangerously-skip-permissions");
  if (sandbox) {
    args.push("--sandbox");
  }
  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  console.log(`[antigravity] Telemetry probe executing agy CLI: ${command} ${args.join(" ")}`);

  const probe = await runAdapterExecutionTargetProcess(
    runId,
    target,
    command,
    args,
    {
      cwd,
      env,
      timeoutSec: helloProbeTimeoutSec,
      graceSec: 5,
      onLog: async () => {},
      terminalResultCleanup: {
        hasTerminalResult: hasAntigravityTerminalResult,
      },
    },
  );

  const parsedStream = parseAntigravityStreamJson(probe.stdout);
  const detail = summarizeProbeDetail(probe.stdout, probe.stderr);

  const authMeta = detectAntigravityAuthRequired({
    stdout: probe.stdout,
    stderr: probe.stderr,
  });

  const quotaMeta = detectAntigravityQuotaExhausted({
    stdout: probe.stdout,
    stderr: probe.stderr,
  });
  const hardQuota = isAntigravityProviderQuotaExhausted({
    stdout: probe.stdout,
    stderr: probe.stderr,
  });
  const transientUpstream = isAntigravityTransientUpstreamError({
    stdout: probe.stdout,
    stderr: probe.stderr,
  });

  if (probe.timedOut) {
    checks.push({
      code: "antigravity_hello_probe_timed_out",
      level: "warn",
      message: "Antigravity hello probe timed out.",
      hint: "Retry the probe. If this persists, verify Antigravity can run `agy --print \"Respond with hello.\"` manually.",
    });
    return;
  }

  if (authMeta.requiresAuth) {
    checks.push({
      code: "antigravity_hello_probe_auth_required",
      level: targetIsRemote ? "error" : "warn",
      ...(targetIsRemote ? { reasonCode: "adapter_auth_missing" as const } : {}),
      message: "Antigravity CLI is installed, but authentication is not ready.",
      ...(detail ? { detail } : {}),
      hint: authMeta.loginUrl
        ? `Complete authentication at ${authMeta.loginUrl} or configure ANTIGRAVITY_API_KEY / AGY_ADC_AUTH=1.`
        : "Run `agy auth login` or configure ANTIGRAVITY_API_KEY / AGY_ADC_AUTH=1, then retry the probe.",
    });
    return;
  }

  if (hardQuota || quotaMeta.exhausted) {
    const retryNotBefore = extractAntigravityRetryNotBefore({
      stdout: probe.stdout,
      stderr: probe.stderr,
    });
    checks.push({
      code: "antigravity_hello_probe_quota_exhausted",
      level: "warn",
      ...({ reasonCode: "usage_limited" } as Record<string, unknown>),
      message: "Antigravity CLI is authenticated, but usage quota or AI credits are currently exhausted.",
      ...(detail ? { detail } : {}),
      hint: retryNotBefore
        ? `Quota resets after ${retryNotBefore}. Check usage/billing or switch models, then retry.`
        : "Check usage/billing (`agy -p \"/usage\" --output-format json`), then retry the probe.",
    });
    return;
  }

  if ((probe.exitCode ?? 1) !== 0 && transientUpstream) {
    checks.push({
      code: "antigravity_hello_probe_transient_upstream",
      level: "warn",
      message: "Antigravity hello probe encountered a transient upstream service error.",
      ...(detail ? { detail } : {}),
      hint: "The upstream model service is temporarily overloaded or unreachable. Retry shortly.",
    });
    return;
  }

  if ((probe.exitCode ?? 1) === 0) {
    const candidateText = (parsedStream.summary || probe.stdout).trim();
    const summaryLower = candidateText.toLowerCase();
    const hasHello = /\bhello\b|\bol[áa]\b/.test(summaryLower);

    checks.push({
      code: hasHello ? "antigravity_hello_probe_passed" : "antigravity_hello_probe_unexpected_output",
      level: hasHello ? "info" : "warn",
      message: hasHello
        ? "Antigravity hello probe succeeded."
        : "Antigravity probe ran but did not return `hello` as expected.",
      ...(candidateText ? { detail: candidateText.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
    });
    return;
  }

  checks.push({
    code: "antigravity_hello_probe_failed",
    level: "error",
    message: "Antigravity hello probe failed.",
    ...(detail ? { detail } : {}),
    hint: "Run `agy --print \"Respond with hello.\"` manually in this working directory to inspect the full error.",
  });
}

/**
 * Diagnostic pipeline testing the Antigravity installation and credentials environment.
 * Validates executable presence, path resolution, keyring/ADC keys, and live API connectivity.
 *
 * @param ctx - The environment validation context provided by Paperclip.
 * @returns Formatted environment probe results summary.
 */
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "agy");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = ctx.environmentName ?? describeAdapterExecutionTarget(target);

  const runId = `antigravity-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "antigravity_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  // Step 1: Validate local or remote working directory
  const cwdCheck = await checkWorkingDirectory(runId, target, cwd);
  checks.push(cwdCheck);

  // Step 2: Build execution environment variable mappings (including ~/.local/bin in PATH)
  const env = resolveExecutionEnvironment(config);
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensureAntigravityPathInEnv(effectiveEnv)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (!targetIsRemote && runtimeEnv.PATH) {
    env.PATH = runtimeEnv.PATH;
  }

  // Step 3: Handle sandbox execution installs if sandbox configurations are active
  const installCheck = await maybeRunSandboxInstallCommand({
    runId,
    target,
    adapterKey: "antigravity",
    installCommand: SANDBOX_INSTALL_COMMAND,
    detectCommand: command,
    env,
  });
  if (installCheck) {
    checks.push(installCheck);
  }

  // Step 4: Verify that the main command executable is resolvable and accessible in PATH
  let commandResolvable = false;
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "antigravity_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
    commandResolvable = true;
  } catch (err) {
    checks.push({
      code: "antigravity_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  // Step 5: Check configured API keys and ADC authentication contexts
  const selectedModel = asString(config.model, DEFAULT_ANTIGRAVITY_LOCAL_MODEL).trim();
  const selectedEffort = (
    asString(config.thinkingEffort, "") ||
    asString(config.effort, "") ||
    asString(config.modelReasoningEffort, "") ||
    asString(config.reasoningEffort, "")
  ).trim();
  const selectedTimeout = asNumber(config.timeoutSec, 0) || asNumber(config.timeout, 0);
  const credsCheck = checkApiCredentials(env, targetIsRemote);
  checks.push(credsCheck);

  // Step 6: Report configured model selection diagnostic check
  console.log(`[antigravity] testEnvironment() called: model="${selectedModel}", effort="${selectedEffort}", timeoutSec=${selectedTimeout}, command="${command}"`);
  checks.push({
    code: "antigravity_model_configured",
    level: "info",
    message: `Configured execution model: "${selectedModel}"`,
    detail: selectedModel === DEFAULT_ANTIGRAVITY_LOCAL_MODEL
      ? "Auto (Uses agy internal auto-routing default)"
      : `Pinned model: ${selectedModel}`,
  });

  // Step 7: Optional plugin inspection (`agy plugin list --json`, added in v1.3.4) when config.probePlugins is enabled
  const canRunProbe = cwdCheck.code === "antigravity_cwd_valid" && commandResolvable;
  if (canRunProbe && asBoolean(config.probePlugins, false) && commandLooksLike(command, "agy")) {
    const pluginCheck = await probeAntigravityPlugins(runId, target, command, cwd, env);
    checks.push(pluginCheck);
  }

  // Step 8: Spawn live "hello" telemetry probe if directories and executables resolved correctly
  if (canRunProbe) {
    await performHelloTelemetryProbe(runId, target, command, cwd, env, config, checks);
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}