/**
 * @fileoverview Dynamic model discovery and parsing for Antigravity local CLI execution.
 * Interacts with `agy models` CLI command to retrieve live model capabilities,
 * providing TTL-based caching and graceful fallback to static definitions.
 *
 * @copyright Antigravity Adapter Contributors
 * @license MIT
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureAntigravityPathInEnv } from "./cli-capabilities.js";
import type { AntigravityModelDefinition } from "../types.js";
import { DEFAULT_ANTIGRAVITY_LOCAL_MODEL, models as STATIC_MODELS } from "../index.js";

const execFileAsync = promisify(execFile);

const AGY_MODELS_TIMEOUT_MS = 10_000;
const AGY_MODELS_CACHE_TTL_MS = 60_000;

let cached: { expiresAt: number; models: AntigravityModelDefinition[] } | null = null;

/**
 * Deduplicates model definitions preserving order and non-empty IDs.
 *
 * @param list - The list of model definitions to deduplicate.
 * @returns Deduplicated model list.
 */
export function dedupeModels(list: AntigravityModelDefinition[]): AntigravityModelDefinition[] {
  const seen = new Set<string>();
  const deduped: AntigravityModelDefinition[] = [];
  for (const m of list) {
    const id = (m.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({
      id,
      label: (m.label || "").trim() || id,
    });
  }
  return deduped;
}

/**
 * Parses raw stdout from `agy models` command into structured model definitions.
 *
 * @param stdout - Raw text output from `agy models`.
 * @returns Structured array of model definitions including the 'auto' default.
 */
export function parseAgyModelsOutput(stdout: string): AntigravityModelDefinition[] {
  const lines = stdout.split(/\r?\n/);
  const discovered: AntigravityModelDefinition[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (
      line.toLowerCase().startsWith("fetching") ||
      line.toLowerCase().startsWith("usage:") ||
      line.toLowerCase().startsWith("flags:")
    ) {
      continue;
    }

    // Split by tab or 2+ whitespace characters
    const parts = line.split(/\t+|\s{2,}/);
    if (parts.length >= 2) {
      const id = parts[0].trim();
      const label = parts.slice(1).join(" ").trim();
      if (id && label) {
        discovered.push({ id, label });
      }
    } else if (parts.length === 1 && parts[0].trim()) {
      const id = parts[0].trim();
      discovered.push({ id, label: id });
    }
  }

  if (discovered.length === 0) {
    return [];
  }

  return dedupeModels([
    { id: DEFAULT_ANTIGRAVITY_LOCAL_MODEL, label: "Auto (Use global configured default)" },
    ...discovered,
  ]);
}

/**
 * Executes `agy models` CLI command to retrieve dynamic model definitions.
 *
 * @param command - Optional binary command name (defaults to "agy").
 * @returns Parsed model definitions or empty list on failure.
 */
async function fetchAgyCliModels(command = "agy"): Promise<AntigravityModelDefinition[]> {
  try {
    const env = ensureAntigravityPathInEnv(process.env as Record<string, string>);
    const { stdout } = await execFileAsync(command, ["models"], {
      env,
      timeout: AGY_MODELS_TIMEOUT_MS,
      encoding: "utf8",
    });
    return parseAgyModelsOutput(stdout);
  } catch {
    return [];
  }
}

/**
 * Loads Antigravity models dynamically from CLI or cached snapshot,
 * falling back gracefully to static bundled model definitions.
 *
 * @param options - Cache control and command options.
 * @returns Model definitions.
 */
export async function loadAntigravityModels(options?: {
  forceRefresh?: boolean;
  command?: string;
}): Promise<AntigravityModelDefinition[]> {
  const now = Date.now();
  if (options?.forceRefresh !== true && cached && cached.expiresAt > now) {
    return cached.models;
  }

  const fetched = await fetchAgyCliModels(options?.command);
  if (fetched.length > 0) {
    cached = {
      expiresAt: now + AGY_MODELS_CACHE_TTL_MS,
      models: fetched,
    };
    return fetched;
  }

  if (cached && cached.models.length > 0) {
    return cached.models;
  }

  return dedupeModels(STATIC_MODELS);
}

/**
 * Lists available models for Paperclip adapter registration.
 */
export async function listModels(): Promise<AntigravityModelDefinition[]> {
  return loadAntigravityModels();
}

/**
 * Refreshes available models bypassing the internal TTL cache.
 */
export async function refreshModels(): Promise<AntigravityModelDefinition[]> {
  return loadAntigravityModels({ forceRefresh: true });
}

/**
 * Resets the in-memory cache. Used in testing.
 */
export function resetAntigravityModelsCacheForTests(): void {
  cached = null;
}
