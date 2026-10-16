/**
 * @fileoverview Provider quota window inspection for Antigravity CLI (`agy -p "/usage" --output-format json`).
 * Parses structured quota groups and buckets (5-hour and weekly limits across Gemini, Claude/GPT, and Argon)
 * as well as TSV fallback lines into Paperclip `ProviderQuotaResult` windows.
 *
 * @copyright Antigravity Adapter Contributors
 * @license MIT
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";
import { ensureAntigravityPathInEnv } from "./cli-capabilities.js";

const execFileAsync = promisify(execFile);

const AGY_QUOTA_TIMEOUT_MS = 15_000;

interface AgyUsageBucketRaw {
  id?: string;
  name?: string;
  description?: string;
  window?: string;
  remaining_fraction?: number;
  reset_time?: string;
}

interface AgyUsageGroupRaw {
  name?: string;
  description?: string;
  buckets?: AgyUsageBucketRaw[];
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeIsoTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function parseUsageTsvLines(text: string): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const lines = (text || "").split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !line.includes("\t")) continue;
    const parts = line.split("\t").map((part) => part.trim());
    if (parts.length < 3) continue;

    const [groupName, bucketName, remainingRaw, resetRaw] = parts;
    const pctMatch = (remainingRaw || "").match(/(\d+(?:\.\d+)?)\s*%/);
    if (!pctMatch) continue;

    const remainingPct = clampPercent(Number.parseFloat(pctMatch[1]));
    const usedPercent = clampPercent(100 - remainingPct);
    const resetsAt = normalizeIsoTimestamp(resetRaw);
    const windowTag = /five\s*hour|5\s*h/i.test(bucketName)
      ? "5h"
      : /weekly|7\s*d/i.test(bucketName)
        ? "weekly"
        : bucketName;

    windows.push({
      label: groupName ? `${groupName} (${windowTag})` : bucketName,
      usedPercent,
      resetsAt,
      valueLabel: `${remainingPct}% remaining`,
      detail: bucketName || null,
    });
  }

  return windows;
}

/**
 * Parses stdout from `agy -p "/usage" --output-format json` into Paperclip `QuotaWindow[]`.
 *
 * @param stdout - Raw stdout from `agy -p "/usage" --output-format json`.
 * @returns Array of parsed quota windows.
 */
export function parseAgyUsageQuotaOutput(stdout: string): QuotaWindow[] {
  const trimmed = (stdout || "").trim();
  if (!trimmed) return [];

  const jsonLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"));

  for (let i = jsonLines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(jsonLines[i]) as Record<string, unknown>;
      const commandObj =
        typeof parsed.command === "object" && parsed.command !== null
          ? (parsed.command as Record<string, unknown>)
          : null;
      const dataObj =
        commandObj && typeof commandObj.data === "object" && commandObj.data !== null
          ? (commandObj.data as Record<string, unknown>)
          : null;
      const groups = Array.isArray(dataObj?.groups) ? (dataObj.groups as AgyUsageGroupRaw[]) : [];

      if (groups.length > 0) {
        const windows: QuotaWindow[] = [];
        for (const group of groups) {
          const groupName = typeof group.name === "string" ? group.name.trim() : "Antigravity";
          const buckets = Array.isArray(group.buckets) ? group.buckets : [];
          for (const bucket of buckets) {
            const rawFraction =
              typeof bucket.remaining_fraction === "number" && Number.isFinite(bucket.remaining_fraction)
                ? Math.max(0, Math.min(1, bucket.remaining_fraction))
                : null;
            const remainingPct = rawFraction !== null ? clampPercent(rawFraction * 100) : null;
            const usedPercent = rawFraction !== null ? clampPercent((1 - rawFraction) * 100) : null;
            const windowKey =
              typeof bucket.window === "string" && bucket.window.trim().length > 0
                ? bucket.window.trim()
                : typeof bucket.name === "string" && bucket.name.trim().length > 0
                  ? bucket.name.trim()
                  : "quota";
            const resetsAt = normalizeIsoTimestamp(bucket.reset_time);
            const detail =
              (typeof bucket.description === "string" && bucket.description.trim()) ||
              (typeof group.description === "string" && group.description.trim()) ||
              null;

            windows.push({
              label: `${groupName} (${windowKey})`,
              usedPercent,
              resetsAt,
              valueLabel: remainingPct !== null ? `${remainingPct}% remaining` : null,
              detail,
            });
          }
        }
        if (windows.length > 0) {
          return windows;
        }
      }

      if (typeof parsed.response === "string" && parsed.response.trim().length > 0) {
        const fromResponse = parseUsageTsvLines(parsed.response);
        if (fromResponse.length > 0) {
          return fromResponse;
        }
      }
    } catch {
      // Ignore malformed JSON line and try fallback
    }
  }

  return parseUsageTsvLines(trimmed);
}

/**
 * Fetches live quota windows from the local Antigravity CLI (`agy -p "/usage" --output-format json`).
 */
export async function getQuotaWindows(options?: {
  command?: string;
  env?: Record<string, string>;
}): Promise<ProviderQuotaResult> {
  const command = (options?.command || "agy").trim() || "agy";
  const env = ensureAntigravityPathInEnv(options?.env ?? (process.env as Record<string, string>));

  try {
    const { stdout } = await execFileAsync(command, ["-p", "/usage", "--output-format", "json"], {
      env,
      timeout: AGY_QUOTA_TIMEOUT_MS,
      encoding: "utf8",
    });
    const windows = parseAgyUsageQuotaOutput(stdout);
    return {
      provider: "antigravity",
      source: "agy-cli",
      ok: true,
      windows,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      provider: "antigravity",
      source: "agy-cli",
      ok: false,
      error: message,
      windows: [],
    };
  }
}
