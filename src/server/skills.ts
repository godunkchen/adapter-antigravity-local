import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterExecutionContext,
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  removeMaintainerOnlySkillSymlinks,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolves the absolute directory path where Antigravity skills are stored.
 * Checks for HOME overrides in config.env, falling back to os.homedir().
 *
 * @param config - Raw adapter configuration dictionary.
 * @returns Absolute path to ~/.gemini/skills.
 */
export function resolveAntigravitySkillsHome(config: Record<string, unknown>): string {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".gemini", "skills");
}

/**
 * Builds a structured snapshot of available and installed Paperclip skills
 * for Antigravity, including target paths, origin metadata, and sync status.
 *
 * @param config - Raw adapter configuration dictionary.
 * @returns An AdapterSkillSnapshot object.
 */
export async function buildAntigravitySkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveAntigravitySkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "antigravity_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.gemini/skills",
    missingDetail: "Configured but not currently linked into the Antigravity skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

/**
 * Lists the current skill status and synchronization snapshot for the Paperclip Web UI.
 *
 * @param ctx - The adapter skill context containing agent configuration.
 * @returns An AdapterSkillSnapshot object.
 */
export async function listAntigravitySkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildAntigravitySkillSnapshot(ctx.config);
}

/**
 * Synchronizes the desired skills on disk, creating necessary symlinks in ~/.gemini/skills
 * and removing decommissioned Paperclip-managed links.
 *
 * @param ctx - The adapter skill context.
 * @param desiredSkills - Array of skill keys to ensure are installed.
 * @returns The updated AdapterSkillSnapshot object.
 */
export async function syncAntigravitySkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = resolveAntigravitySkillsHome(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildAntigravitySkillSnapshot(ctx.config);
}

/**
 * Resolves the desired skill names from adapter configuration and available catalog entries.
 */
export function resolveAntigravityDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
): string[] {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}

/**
 * Ensures that selected skills are materialized as symlinks in the target skills directory
 * prior to executing an Antigravity agent run.
 *
 * @param onLog - Adapter logging callback.
 * @param skillsEntries - Array of available runtime skill entries.
 * @param desiredSkillNames - Optional explicit list of desired skill keys.
 * @param customSkillsHome - Optional explicit path to skills home directory.
 */
export async function ensureAntigravitySkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
  customSkillsHome?: string,
): Promise<void> {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;

  const skillsHome = customSkillsHome ?? path.join(os.homedir(), ".gemini", "skills");
  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Failed to prepare Antigravity skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }

  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Antigravity skill "${skillName}" from ${skillsHome}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Linked"} Antigravity skill: ${entry.key}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to link Antigravity skill "${entry.key}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}