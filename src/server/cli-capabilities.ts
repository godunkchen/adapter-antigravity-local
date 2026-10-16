/**
 * @fileoverview Antigravity CLI version and capability probing (`agy --version`, `agy --help`).
 * Aligned with `claude-local/src/server/cli-capabilities.ts` while detecting `agy` v1.3.4–v1.3.6
 * capabilities (`--mode auto`, `--agent`, `--effort`, `--json-schema`, `plugin` subcommand, and ADC auth).
 *
 * @copyright Antigravity Adapter Contributors
 * @license MIT
 */

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ensurePathInEnv } from "@paperclipai/adapter-utils/server-utils";

const execFileAsync = promisify(execFile);

const AGY_CAPABILITIES_TIMEOUT_MS = 10_000;
const AGY_CAPABILITIES_CACHE_TTL_MS = 60_000;

export interface AgyCliVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export interface AgyCliCapabilities {
  version: AgyCliVersion | null;
  supportsModeFlag: boolean;
  supportsAutoMode: boolean;
  supportsAgentFlag: boolean;
  supportsEffortFlag: boolean;
  supportsJsonSchemaFlag: boolean;
  supportsBaseModelDefaultEffort: boolean;
  supportsPluginSubcommand: boolean;
  supportsAdcAuth: boolean;
}

let cachedCapabilities: {
  key: string;
  expiresAt: number;
  capabilities: AgyCliCapabilities;
} | null = null;

/**
 * Ensures standard system paths AND `~/.local/bin` (where `https://antigravity.google/install.sh`
 * installs the `agy` Go binary by default) are present in the environment's `PATH`.
 *
 * @param baseEnv - Input environment dictionary.
 * @returns Copy of the environment with `PATH` enriched.
 */
export function ensureAntigravityPathInEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string> = process.env,
): Record<string, string> {
  const normalized = ensurePathInEnv({ ...baseEnv }) as Record<string, string>;
  const delimiter = process.platform === "win32" ? ";" : ":";
  const currentPath = normalized.PATH || normalized.Path || "";
  const segments = currentPath
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const candidateDirs: string[] = [];
  const envHome = typeof normalized.HOME === "string" ? normalized.HOME.trim() : "";
  if (envHome) {
    candidateDirs.push(path.join(envHome, ".local", "bin"));
  }
  try {
    const sysHome = os.homedir()?.trim();
    if (sysHome) {
      candidateDirs.push(path.join(sysHome, ".local", "bin"));
    }
  } catch {
    // Ignore homedir lookup errors in restricted environments
  }

  for (const dir of candidateDirs) {
    if (dir && !segments.includes(dir)) {
      segments.unshift(dir);
    }
  }

  normalized.PATH = segments.join(delimiter);
  return normalized;
}

/**
 * Parses a semantic version string from `agy --version` output (e.g., `"1.3.6"` or `"agy version 1.3.6"`).
 *
 * @param raw - Raw stdout or stderr from `agy --version`.
 * @returns Parsed version structure or null if no semantic version was found.
 */
export function parseAgyCliVersion(raw: string): AgyCliVersion | null {
  const text = (raw || "").trim();
  if (!text) return null;
  const match = text.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return {
    major,
    minor,
    patch,
    raw: `${major}.${minor}.${patch}`,
  };
}

/**
 * Checks whether a parsed or raw `agy` CLI version is at least `major.minor.patch`.
 */
export function isAgyVersionAtLeast(
  version: AgyCliVersion | string | null | undefined,
  major: number,
  minor: number,
  patch: number,
): boolean {
  const parsed = typeof version === "string" ? parseAgyCliVersion(version) : version ?? null;
  if (!parsed) return false;
  if (parsed.major !== major) return parsed.major > major;
  if (parsed.minor !== minor) return parsed.minor > minor;
  return parsed.patch >= patch;
}

/**
 * Pure parser that derives `AgyCliCapabilities` from `agy --help` and `agy --version` output.
 *
 * @param helpText - Output from `agy --help`.
 * @param versionText - Output from `agy --version`.
 * @returns Resolved CLI capability flags.
 */
export function detectAgyCliCapabilities(helpText: string, versionText = ""): AgyCliCapabilities {
  const version = parseAgyCliVersion(versionText) ?? parseAgyCliVersion(helpText);
  const help = helpText || "";

  const supportsModeFlag = /(?:^|\s)--mode\b/m.test(help) || isAgyVersionAtLeast(version, 1, 3, 3);
  const supportsAutoMode =
    /--mode\b[^\n]*\bauto\b/i.test(help) || isAgyVersionAtLeast(version, 1, 3, 5);
  const supportsAgentFlag =
    /(?:^|\s)--agent\b/m.test(help) || isAgyVersionAtLeast(version, 1, 3, 4);
  const supportsEffortFlag =
    /(?:^|\s)--effort\b/m.test(help) || isAgyVersionAtLeast(version, 1, 3, 3);
  const supportsJsonSchemaFlag =
    /(?:^|\s)--json-schema\b/m.test(help) || isAgyVersionAtLeast(version, 1, 3, 3);
  const supportsBaseModelDefaultEffort = isAgyVersionAtLeast(version, 1, 3, 4);
  const supportsPluginSubcommand =
    /^\s*plugins?\b/m.test(help) || isAgyVersionAtLeast(version, 1, 3, 4);
  const supportsAdcAuth = isAgyVersionAtLeast(version, 1, 3, 6);

  return {
    version,
    supportsModeFlag,
    supportsAutoMode,
    supportsAgentFlag,
    supportsEffortFlag,
    supportsJsonSchemaFlag,
    supportsBaseModelDefaultEffort,
    supportsPluginSubcommand,
    supportsAdcAuth,
  };
}

/**
 * Probes the local `agy` binary for version and CLI flag capabilities with a 60s TTL cache.
 */
export async function probeAgyCliCapabilities(options?: {
  command?: string;
  env?: Record<string, string>;
  forceRefresh?: boolean;
}): Promise<AgyCliCapabilities> {
  const command = (options?.command || "agy").trim() || "agy";
  const now = Date.now();
  if (
    options?.forceRefresh !== true &&
    cachedCapabilities &&
    cachedCapabilities.key === command &&
    cachedCapabilities.expiresAt > now
  ) {
    return cachedCapabilities.capabilities;
  }

  const env = ensureAntigravityPathInEnv(options?.env ?? (process.env as Record<string, string>));
  let versionText = "";
  let helpText = "";

  try {
    const { stdout, stderr } = await execFileAsync(command, ["--version"], {
      env,
      timeout: AGY_CAPABILITIES_TIMEOUT_MS,
      encoding: "utf8",
    });
    versionText = `${stdout || ""}\n${stderr || ""}`.trim();
  } catch {
    // Ignore version failure and continue to --help
  }

  try {
    const { stdout, stderr } = await execFileAsync(command, ["--help"], {
      env,
      timeout: AGY_CAPABILITIES_TIMEOUT_MS,
      encoding: "utf8",
    });
    helpText = `${stdout || ""}\n${stderr || ""}`.trim();
  } catch {
    // Ignore help failure
  }

  const capabilities = detectAgyCliCapabilities(helpText, versionText);
  cachedCapabilities = {
    key: command,
    expiresAt: now + AGY_CAPABILITIES_CACHE_TTL_MS,
    capabilities,
  };
  return capabilities;
}

/**
 * Resets the in-memory CLI capabilities cache. Used in unit tests.
 */
export function resetAgyCliCapabilitiesCacheForTests(): void {
  cachedCapabilities = null;
}
