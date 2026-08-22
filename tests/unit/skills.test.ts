import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveAntigravitySkillsHome,
  buildAntigravitySkillSnapshot,
  listAntigravitySkills,
  syncAntigravitySkills,
  ensureAntigravitySkillsInjected,
  resolveAntigravityDesiredSkillNames,
} from "../../src/server/skills.js";

describe("Antigravity Skills Management", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-skills-test-home-"));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  it("resolves skills home using config.env.HOME override and defaults to user homedir", () => {
    const customHome = resolveAntigravitySkillsHome({
      env: { HOME: tmpHome },
    });
    expect(customHome).toBe(path.join(tmpHome, ".gemini", "skills"));

    const defaultHome = resolveAntigravitySkillsHome({});
    expect(defaultHome).toBe(path.join(os.homedir(), ".gemini", "skills"));
  });

  it("resolves desired skill names correctly from config", () => {
    const config = {
      paperclipSkillSync: {
        desiredSkills: ["paperclip", "custom-skill"],
      },
    };
    const available = [{ key: "paperclip" }, { key: "custom-skill" }, { key: "other-skill" }];
    const resolved = resolveAntigravityDesiredSkillNames(config, available);
    expect(resolved).toEqual(["paperclip", "custom-skill"]);
  });

  it("materializes selected skills via ensureAntigravitySkillsInjected", async () => {
    const skillSrcDir = path.join(tmpHome, "source-skills", "skill-a");
    await fs.mkdir(skillSrcDir, { recursive: true });
    await fs.writeFile(path.join(skillSrcDir, "SKILL.md"), "# Skill A", "utf8");

    const targetSkillsHome = path.join(tmpHome, "skills-home");
    const logs: string[] = [];

    await ensureAntigravitySkillsInjected(
      async (stream, chunk) => {
        logs.push(chunk);
      },
      [
        {
          key: "company/skill-a",
          runtimeName: "skill-a",
          source: skillSrcDir,
        },
      ],
      ["company/skill-a"],
      targetSkillsHome,
    );

    const targetLink = path.join(targetSkillsHome, "skill-a");
    const stat = await fs.lstat(targetLink);
    expect(stat.isSymbolicLink()).toBe(true);

    const linkedContent = await fs.readFile(path.join(targetLink, "SKILL.md"), "utf8");
    expect(linkedContent).toBe("# Skill A");
  });

  it("synchronizes desired skills and cleans up unselected skills via syncAntigravitySkills", async () => {
    const skillSrcA = path.join(tmpHome, "source-skills", "skill-a");
    const skillSrcB = path.join(tmpHome, "source-skills", "skill-b");
    await fs.mkdir(skillSrcA, { recursive: true });
    await fs.mkdir(skillSrcB, { recursive: true });
    await fs.writeFile(path.join(skillSrcA, "SKILL.md"), "# Skill A", "utf8");
    await fs.writeFile(path.join(skillSrcB, "SKILL.md"), "# Skill B", "utf8");

    const ctx = {
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      config: {
        env: { HOME: tmpHome },
      },
    } as any;

    const skillsHome = path.join(tmpHome, ".gemini", "skills");
    await fs.mkdir(skillsHome, { recursive: true });

    // Initial manual link
    await fs.symlink(skillSrcA, path.join(skillsHome, "skill-a"));

    // Sync with desired = [] (should remove skill-a if managed)
    const snapshot = await listAntigravitySkills(ctx);
    expect(snapshot.adapterType).toBe("antigravity_local");
    expect(snapshot.skillsHome).toBe(skillsHome);
  });
});
