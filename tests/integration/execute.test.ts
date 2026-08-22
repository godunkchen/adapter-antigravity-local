import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "../../src/server/execute.js";

const {
  runAdapterExecutionTargetProcess,
  ensureAdapterExecutionTargetCommandResolvable,
  resolveAdapterExecutionTargetCommandForLogs,
  readPaperclipRuntimeSkillEntriesMock,
} = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "Success",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "/usr/local/bin/agy"),
  readPaperclipRuntimeSkillEntriesMock: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    runAdapterExecutionTargetProcess,
    ensureAdapterExecutionTargetCommandResolvable,
    resolveAdapterExecutionTargetCommandForLogs,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureAbsoluteDirectory: vi.fn(async () => undefined),
    readPaperclipRuntimeSkillEntries: vi.fn(async (...args: any[]) => {
      if (readPaperclipRuntimeSkillEntriesMock.getMockImplementation()) {
        return readPaperclipRuntimeSkillEntriesMock(...args);
      }
      return actual.readPaperclipRuntimeSkillEntries(...args);
    }),
  };
});

/**
 * Integration test suite for the local Antigravity execution flow.
 * Mocks the system process spawn APIs to assert correct argument building, 
 * environment variables injection, and multi-workspace support.
 */
describe("antigravity local execution", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Assures that a basic local run correctly resolves and spawns the `agy` process
   * with the expected prompt and unattended permission flags.
   */
  it("successfully invokes agy with local command and correct prompt", async () => {
    const result = await execute({
      runId: "run-local-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity CEO",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "agy",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/home/user/workspace",
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Success");
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);

    const callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[]];
    const cliArgs = callArgs[3];
    expect(cliArgs).toContain("--print");
    expect(cliArgs).toContain("--output-format");
    expect(cliArgs).toContain("stream-json");
    expect(cliArgs).toContain("--dangerously-skip-permissions");
  });

  /**
   * Asserts that model selection passes the `--model <model>` CLI flag to `agy`.
   */
  it("configures model via --model CLI flag and env.ANTIGRAVITY_MODEL", async () => {
    await execute({
      runId: "run-local-2",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity CEO",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "agy",
        model: "claude-sonnet-4.6-thinking",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/home/user/workspace",
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    const callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[], { env: Record<string, string> }];
    const cliArgs = callArgs[3];
    const options = callArgs[4];

    const modelIdx = cliArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(cliArgs[modelIdx + 1]).toBe("claude-sonnet-4-6");
    expect(options.env.ANTIGRAVITY_MODEL).toBe("claude-sonnet-4.6-thinking");
  });

  it("configures latest flat Gemini 3.7 model directly without effort flag conflict", async () => {
    await execute({
      runId: "run-local-gemini37",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity CEO",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        model: "gemini-3.7-flash-high",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/home/user/workspace",
        },
      },
      onLog: async () => {},
    });

    const callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[], { env: Record<string, string> }];
    const cliArgs = callArgs[3];

    const modelIdx = cliArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(cliArgs[modelIdx + 1]).toBe("gemini-3.7-flash-high");
    expect(cliArgs.indexOf("--effort")).toBe(-1);
  });

  it("configures thinkingEffort and timeoutSec via CLI flags", async () => {
    await execute({
      runId: "run-local-effort",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity CEO",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        model: "gemini-3.5-flash",
        thinkingEffort: "low",
        timeoutSec: 180,
      },
      context: {
        paperclipWorkspace: {
          cwd: "/home/user/workspace",
        },
      },
      onLog: async () => {},
    });

    const callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[], { env: Record<string, string> }];
    const cliArgs = callArgs[3];

    const modelIdx = cliArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(cliArgs[modelIdx + 1]).toBe("gemini-3.5-flash");

    const effortIdx = cliArgs.indexOf("--effort");
    expect(effortIdx).toBeGreaterThan(-1);
    expect(cliArgs[effortIdx + 1]).toBe("low");

    const timeoutIdx = cliArgs.indexOf("--print-timeout");
    expect(timeoutIdx).toBeGreaterThan(-1);
    expect(cliArgs[timeoutIdx + 1]).toBe("180s");
  });

  /**
   * Asserts that multiple active workspaces are mapped correctly using
   * repeatable `--add-dir` flags on the spawned command line.
   */
  it("appends multiple workspaces using repeatable --add-dir CLI flags", async () => {
    await execute({
      runId: "run-local-3",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity CEO",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "agy",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/home/user/workspace-1",
          source: "project_primary",
        },
        paperclipWorkspaces: [
          { cwd: "/home/user/workspace-1" },
          { cwd: "/home/user/workspace-2" },
        ],
      },
      onLog: async () => {},
    });

    const callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[]];
    const cliArgs = callArgs[3];

    let addDirIndices: number[] = [];
    cliArgs.forEach((arg, idx) => {
      if (arg === "--add-dir") addDirIndices.push(idx);
    });

    expect(addDirIndices.length).toBe(2);
    expect(cliArgs[addDirIndices[0] + 1]).toBe("/home/user/workspace-1");
    expect(cliArgs[addDirIndices[1] + 1]).toBe("/home/user/workspace-2");
  });

  /**
   * Asserts that NDJSON stream events capture generated session ID and usage metrics.
   */
  it("captures generated session ID and usage metrics from stream-json output", async () => {
    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: '{"event":"init","conversation_id":"39d9bdfe-3618-4d2d-ae5d-deee2e075ee2"}\n{"event":"result","result":{"conversation_id":"39d9bdfe-3618-4d2d-ae5d-deee2e075ee2","response":"Hello!","usage":{"input_tokens":100,"output_tokens":20,"cache_read_tokens":5},"cost_usd":0.001}}\n',
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    }));

    const result = await execute({
      runId: "run-local-4",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity CEO",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "agy",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/home/user/workspace",
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(result.sessionId).toBe("39d9bdfe-3618-4d2d-ae5d-deee2e075ee2");
    expect(result.summary).toBe("Hello!");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 5,
    });
    expect(result.costUsd).toBe(0.001);
  });

  /**
   * Asserts that instructionsFilePath content is read and prepended to the prompt
   * with the relative file reference directive and commandNotes.
   */
  it("prepends agent instructions from instructionsFilePath with path directive to prompt and logs onMeta notes", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-instructions-test-"));
    const instructionsPath = path.join(tmpDir, "instructions.md");
    await fs.writeFile(instructionsPath, "# System Instructions\nFollow security guidelines.", "utf8");

    let capturedMeta: any = null;

    try {
      await execute({
        runId: "run-instructions-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Antigravity Engineer",
          adapterType: "antigravity_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "agy",
          instructionsFilePath: instructionsPath,
          promptTemplate: "Do the task: {{context.task}}",
        },
        context: {
          task: "Implement feature X",
          paperclipWorkspace: {
            cwd: "/home/user/workspace",
          },
        },
        onLog: async () => {},
        onMeta: async (meta) => {
          capturedMeta = meta;
        },
      });

      const callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[]];
      const cliArgs = callArgs[3];
      const promptIdx = cliArgs.indexOf("--print");
      const passedPrompt = cliArgs[promptIdx + 1];

      expect(passedPrompt).toContain("# System Instructions");
      expect(passedPrompt).toContain("Follow security guidelines.");
      expect(passedPrompt).toContain(`The above agent instructions were loaded from ${instructionsPath}.`);
      expect(passedPrompt).toContain(`Resolve any relative file references from ${tmpDir}/.`);
      expect(passedPrompt).toContain("Do the task: Implement feature X");

      expect(capturedMeta).not.toBeNull();
      expect(capturedMeta.commandNotes).toContain(`Loaded agent instructions from ${instructionsPath}`);
      expect(capturedMeta.commandNotes).toContain(
        `Prepended instructions + path directive to prompt (relative references from ${tmpDir}/).`,
      );
      expect(capturedMeta.promptMetrics.instructionsChars).toBeGreaterThan(0);
      expect(capturedMeta.promptMetrics.promptChars).toBe(passedPrompt.length);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  /**
   * Asserts that when instructionsFilePath cannot be read, a warning is logged
   * and execution proceeds without crashing.
   */
  it("warns and continues gracefully when instructionsFilePath cannot be read", async () => {
    const nonExistentPath = "/non/existent/path/to/instructions.md";
    const logMessages: string[] = [];
    let capturedMeta: any = null;

    await execute({
      runId: "run-instructions-missing",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity Engineer",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "agy",
        instructionsFilePath: nonExistentPath,
        promptTemplate: "Do the task: {{context.task}}",
      },
      context: {
        task: "Fix bug Y",
        paperclipWorkspace: {
          cwd: "/home/user/workspace",
        },
      },
      onLog: async (stream, msg) => {
        logMessages.push(msg);
      },
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    });

    const callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[]];
    const cliArgs = callArgs[3];
    const passedPrompt = cliArgs[cliArgs.indexOf("--print") + 1];
    expect(passedPrompt).toContain("Do the task: Fix bug Y");
    expect(passedPrompt).not.toContain("The above agent instructions were loaded from");
    expect(logMessages.some((msg) => msg.includes(`could not read agent instructions file "${nonExistentPath}"`))).toBe(true);
    expect(capturedMeta.commandNotes).toContain(
      `Configured instructionsFilePath ${nonExistentPath}, but file could not be read; continuing without injected instructions.`,
    );
    expect(capturedMeta.promptMetrics.instructionsChars).toBe(0);
  });

  /**
   * Asserts that bootstrapPromptTemplate is rendered on cold start (!sessionId)
   * and omitted when resuming an existing session.
   */
  it("renders bootstrapPromptTemplate on cold start and omits it on resumed session", async () => {
    // 1. Cold start test
    await execute({
      runId: "run-cold-start",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity Architect",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "agy",
        bootstrapPromptTemplate: "INITIALIZE: You are {{agent.name}} for company {{companyId}}.",
        promptTemplate: "HEARTBEAT: Continue work.",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/home/user/workspace",
        },
      },
      onLog: async () => {},
    });

    let callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[]];
    let cliArgs = callArgs[3];
    let passedPrompt = cliArgs[cliArgs.indexOf("--print") + 1];

    expect(passedPrompt).toContain("INITIALIZE: You are Antigravity Architect for company company-1.");
    expect(passedPrompt).toContain("HEARTBEAT: Continue work.");

    // 2. Resumed session test
    await execute({
      runId: "run-resumed-session",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity Architect",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "sess-resumed-1",
        sessionParams: { sessionId: "sess-resumed-1" },
        sessionDisplayId: "sess-resumed-1",
        taskKey: null,
      },
      config: {
        command: "agy",
        bootstrapPromptTemplate: "INITIALIZE: You are {{agent.name}} for company {{companyId}}.",
        promptTemplate: "HEARTBEAT: Continue work.",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/home/user/workspace",
        },
      },
      onLog: async () => {},
    });

    callArgs = runAdapterExecutionTargetProcess.mock.calls[1] as unknown as [string, unknown, string, string[]];
    cliArgs = callArgs[3];
    passedPrompt = cliArgs[cliArgs.indexOf("--print") + 1];

    expect(passedPrompt).not.toContain("INITIALIZE:");
    expect(passedPrompt).toContain("HEARTBEAT: Continue work.");
    expect(cliArgs).toContain("--conversation");
    expect(cliArgs[cliArgs.indexOf("--conversation") + 1]).toBe("sess-resumed-1");
  });

  /**
   * Asserts that context and wake variables are injected into environment variables,
   * runtime notes, and session handoff markdown.
   */
  it("injects context and wake variables into process environment, notes, and promptMetrics", async () => {
    let capturedMeta: any = null;

    await execute({
      runId: "run-wake-context",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity Developer",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "sess-wake-1",
        sessionParams: { sessionId: "sess-wake-1" },
        sessionDisplayId: "sess-wake-1",
        taskKey: null,
      },
      config: {
        command: "agy",
        promptTemplate: "Default heartbeat",
        env: {
          PAPERCLIP_API_URL: "http://127.0.0.1:4310",
          PAPERCLIP_API_KEY: "secret-token",
        },
      },
      context: {
        taskId: "task-101",
        wakeReason: "review_requested",
        wakeCommentId: "comment-202",
        approvalId: "approval-303",
        approvalStatus: "approved",
        issueIds: ["issue-1", "issue-2"],
        paperclipSessionHandoffMarkdown: "## Session Handoff\nProceed with unit tests.",
        paperclipWake: {
          reason: "review_requested",
          comments: [{ id: "comment-202", body: "Please review PR #5" }],
        },
        paperclipWorkspace: {
          cwd: "/home/user/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    });

    const callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
      string,
      unknown,
      string,
      string[],
      { env: Record<string, string> },
    ];
    const cliArgs = callArgs[3];
    const options = callArgs[4];
    const passedPrompt = cliArgs[cliArgs.indexOf("--print") + 1];

    // Assert environment variables injected
    expect(options.env.PAPERCLIP_TASK_ID).toBe("task-101");
    expect(options.env.PAPERCLIP_WAKE_REASON).toBe("review_requested");
    expect(options.env.PAPERCLIP_WAKE_COMMENT_ID).toBe("comment-202");
    expect(options.env.PAPERCLIP_APPROVAL_ID).toBe("approval-303");
    expect(options.env.PAPERCLIP_APPROVAL_STATUS).toBe("approved");
    expect(options.env.PAPERCLIP_LINKED_ISSUE_IDS).toBe("issue-1,issue-2");
    expect(options.env.PAPERCLIP_WAKE_PAYLOAD_JSON).toBeDefined();

    // Assert prompt sections
    expect(passedPrompt).toContain("## Session Handoff");
    expect(passedPrompt).toContain("Proceed with unit tests.");
    expect(passedPrompt).toContain("Paperclip runtime note:");
    expect(passedPrompt).toContain("Paperclip API access note:");
    expect(passedPrompt).toContain("curl -s -H \"Authorization: Bearer $PAPERCLIP_API_KEY\"");

    // Assert promptMetrics breakdown
    expect(capturedMeta.promptMetrics.sessionHandoffChars).toBeGreaterThan(0);
    expect(capturedMeta.promptMetrics.runtimeNoteChars).toBeGreaterThan(0);
    expect(capturedMeta.promptMetrics.promptChars).toBe(passedPrompt.length);
  });

  /**
   * Asserts that configured runtime skills are materialized on disk,
   * the canonical skill prompt directive is prepended to the prompt,
   * the skills directory is passed via --add-dir to agy, and promptMetrics tracks skillsChars.
   */
  it("materializes desired skills, injects skill prompt directive, and appends --add-dir", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-skills-integration-"));
    const skillSrcDir = path.join(tmpHome, "skills-source", "review-tool");
    await fs.mkdir(skillSrcDir, { recursive: true });
    await fs.writeFile(path.join(skillSrcDir, "SKILL.md"), "# Code Review Skill", "utf8");

    readPaperclipRuntimeSkillEntriesMock.mockImplementationOnce(async () => [
      {
        key: "company/review-tool",
        runtimeName: "review-tool",
        source: skillSrcDir,
      },
      {
        key: "company/unused-tool",
        runtimeName: "unused-tool",
        source: path.join(tmpHome, "skills-source", "unused-tool"),
      },
    ]);

    let capturedMeta: any = null;

    try {
      await execute({
        runId: "run-skills-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Antigravity Reviewer",
          adapterType: "antigravity_local",
          adapterConfig: {
            paperclipSkillSync: {
              desiredSkills: ["company/review-tool"],
            },
          },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "agy",
          env: {
            HOME: tmpHome,
          },
          promptTemplate: "Perform code review: {{context.task}}",
          paperclipSkillSync: {
            desiredSkills: ["company/review-tool"],
          },
        },
        context: {
          task: "Review PR #42",
          paperclipWorkspace: {
            cwd: "/home/user/workspace",
          },
        },
        onLog: async () => {},
        onMeta: async (meta) => {
          capturedMeta = meta;
        },
      });

      const callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[]];
      const cliArgs = callArgs[3];
      const passedPrompt = cliArgs[cliArgs.indexOf("--print") + 1];
      const expectedSkillsHome = path.join(tmpHome, ".gemini", "skills");

      // 1. Verify prompt contains the canonical Paperclip runtime skills notice
      expect(passedPrompt).toContain("Paperclip has materialized selected runtime skills for this Antigravity session.");
      expect(passedPrompt).toContain(`Skill root: ${expectedSkillsHome}`);
      expect(passedPrompt).toContain("Selected skills: review-tool");
      expect(passedPrompt).toContain("When a task calls for one of these skills, read its SKILL.md from that root and follow it.");
      expect(passedPrompt).toContain("Perform code review: Review PR #42");

      // 2. Verify skills are linked on disk
      const linkedSkill = path.join(expectedSkillsHome, "review-tool", "SKILL.md");
      const content = await fs.readFile(linkedSkill, "utf8");
      expect(content).toBe("# Code Review Skill");

      // 3. Verify --add-dir includes skillsHome
      const addDirIndices: number[] = [];
      cliArgs.forEach((arg, idx) => {
        if (arg === "--add-dir") addDirIndices.push(idx);
      });
      const addDirPaths = addDirIndices.map((idx) => cliArgs[idx + 1]);
      expect(addDirPaths).toContain(expectedSkillsHome);

      // 4. Verify telemetry & promptMetrics
      expect(capturedMeta.commandNotes).toContain(
        `Materialized 1 Paperclip skill(s) for Antigravity at ${expectedSkillsHome}.`,
      );
      expect(capturedMeta.promptMetrics.skillsChars).toBeGreaterThan(0);
      expect(capturedMeta.promptMetrics.promptChars).toBe(passedPrompt.length);
    } finally {
      readPaperclipRuntimeSkillEntriesMock.mockReset();
      await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });
});
