/**
 * @fileoverview Server entry point and session codec for the Antigravity local CLI adapter.
 * Handles module exports and serializes/deserializes session parameters according to Paperclip specifications.
 * 
 * @copyright Antigravity Adapter Contributors
 * @license MIT
 */

export {
  execute,
  compileAgyArguments,
  computeAntigravityPromptBundleKey,
  resolveAntigravityBillingType,
  agySessionCwdMatchesExecutionTarget,
} from "./execute.js";
export {
  createAntigravityLiveEventBridge,
  DEFAULT_ANTIGRAVITY_DELTA_THROTTLE_MS,
  type AdapterExecutionPhase,
  type AdapterRuntimeProgressUpdate,
  type AdapterProviderStoppedEvent,
  type AdapterRuntimeEvent,
  type AntigravityExecutionContext,
  type AntigravityLiveEventBridge,
  type AntigravityLiveEventBridgeOptions,
} from "./live-events.js";
export { listAntigravitySkills, syncAntigravitySkills } from "./skills.js";
export { testEnvironment, probeAntigravityPlugins } from "./test.js";
export { getConfigSchema } from "./config-schema.js";
export { getQuotaWindows, parseAgyUsageQuotaOutput } from "./quota.js";
export {
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
} from "./parse.js";
export {
  ensureAntigravityPathInEnv,
  parseAgyCliVersion,
  isAgyVersionAtLeast,
  detectAgyCliCapabilities,
  probeAgyCliCapabilities,
  resetAgyCliCapabilitiesCacheForTests,
} from "./cli-capabilities.js";
export {
  listModels,
  refreshModels,
  parseAgyModelsOutput,
  loadAntigravityModels,
  dedupeModels,
  resetAntigravityModelsCacheForTests,
} from "./models.js";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import type { AntigravitySessionParams } from "../types.js";
import { isNonEmptyString } from "../utils.js";

/**
 * Trims and returns a string if it is a non-empty string, or returns null otherwise.
 *
 * @param value - The value to inspect.
 * @returns The trimmed string or null.
 */
function readNonEmptyString(value: unknown): string | null {
  return isNonEmptyString(value) ? value.trim() : null;
}

/**
 * Parses and extracts normalized session parameters from a raw dictionary object.
 * Applies fallback resolution for various naming patterns (e.g., snake_case, camelCase).
 *
 * @param record - The raw record containing potential session parameters.
 * @returns The normalized session parameters, or null if a session ID could not be resolved.
 */
export function parseSessionParams(record: Record<string, unknown>): AntigravitySessionParams | null {
  const sessionId =
    readNonEmptyString(record.sessionId) ??
    readNonEmptyString(record.session_id) ??
    readNonEmptyString(record.sessionID);

  if (!sessionId) {
    return null;
  }

  const cwd =
    readNonEmptyString(record.cwd) ??
    readNonEmptyString(record.workdir) ??
    readNonEmptyString(record.folder);

  const workspaceId =
    readNonEmptyString(record.workspaceId) ??
    readNonEmptyString(record.workspace_id);

  const repoUrl =
    readNonEmptyString(record.repoUrl) ??
    readNonEmptyString(record.repo_url);

  const repoRef =
    readNonEmptyString(record.repoRef) ??
    readNonEmptyString(record.repo_ref);

  const promptBundleKey =
    readNonEmptyString(record.promptBundleKey) ??
    readNonEmptyString(record.prompt_bundle_key);

  const rawRemoteExecution = record.remoteExecution ?? record.remote_execution;
  const remoteExecution =
    typeof rawRemoteExecution === "object" &&
    rawRemoteExecution !== null &&
    !Array.isArray(rawRemoteExecution)
      ? (rawRemoteExecution as Record<string, unknown>)
      : undefined;

  return {
    sessionId,
    ...(cwd ? { cwd } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(repoRef ? { repoRef } : {}),
    ...(promptBundleKey ? { promptBundleKey } : {}),
    ...(remoteExecution ? { remoteExecution } : {}),
  };
}

/**
 * Strongly-typed adapter session codec.
 * Encapsulates the serialization, deserialization, and identification logics
 * required by the Paperclip platform to resume agent conversations.
 */
export const sessionCodec: AdapterSessionCodec = {
  /**
   * Deserializes a raw session parameter payload back into a strongly-typed session structure.
   *
   * @param raw - The raw unknown configuration/session object.
   * @returns Strongly-typed session params or null.
   */
  deserialize(raw: unknown): AntigravitySessionParams | null {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return null;
    }
    return parseSessionParams(raw as Record<string, unknown>);
  },

  /**
   * Serializes session parameters dictionary to persist or display.
   *
   * @param params - The input dictionary of session properties.
   * @returns Serialized session record or null.
   */
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!params) {
      return null;
    }
    const parsed = parseSessionParams(params);
    return parsed ? (parsed as unknown as Record<string, unknown>) : null;
  },

  /**
   * Resolves a human-readable unique key/identifier for session display.
   *
   * @param params - The raw parameters record.
   * @returns Unique string ID or null if unresolvable.
   */
  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (!params) {
      return null;
    }
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID)
    );
  },
};