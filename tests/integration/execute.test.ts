import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  execute,
  computeAntigravityPromptBundleKey,
  resolveAntigravityBillingType,
} from "../../src/server/execute.js";

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

  it("configures latest flat Gemini 3.8 model and Claude 5.5 directly", async () => {
    await execute({
      runId: "run-local-gemini38",
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
        model: "gemini-3.8-flash-high",
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
    expect(cliArgs[modelIdx + 1]).toBe("gemini-3.8-flash-high");
    expect(cliArgs.indexOf("--effort")).toBe(-1);

    runAdapterExecutionTargetProcess.mockClear();

    await execute({
      runId: "run-local-claude55",
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
        model: "claude-sonnet-5-5-high",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/home/user/workspace",
        },
      },
      onLog: async () => {},
    });

    const callArgs2 = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[], { env: Record<string, string> }];
    const cliArgs2 = callArgs2[3];

    const modelIdx2 = cliArgs2.indexOf("--model");
    expect(modelIdx2).toBeGreaterThan(-1);
    expect(cliArgs2[modelIdx2 + 1]).toBe("claude-sonnet-5-5-high");
    expect(cliArgs2.indexOf("--effort")).toBe(-1);
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

  /**
   * Phase 3: Automatic fresh-session retry when resuming a session fails with
   * an unknown/corrupt conversation error (including v1.3.4 truncated media error).
   */
  it("retries automatically with a fresh session when resumed conversation is missing or has corrupt media", async () => {
    runAdapterExecutionTargetProcess
      .mockImplementationOnce(async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Error: Failed to load conversation: truncated WebM media in step 14",
        pid: 101,
        startedAt: new Date().toISOString(),
      }))
      .mockImplementationOnce(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout:
          '{"event":"init","conversation_id":"fresh-conv-999"}\n{"event":"result","result":{"conversation_id":"fresh-conv-999","response":"Recovered on fresh session"}}\n',
        stderr: "",
        pid: 102,
        startedAt: new Date().toISOString(),
      }));

    const logMessages: string[] = [];
    const result = await execute({
      runId: "run-retry-fresh-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity Engineer",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "stale-conv-111",
        sessionParams: {
          sessionId: "stale-conv-111",
          cwd: "/home/user/workspace",
        },
        sessionDisplayId: "stale-conv-111",
        taskKey: null,
      },
      config: {
        command: "agy",
        bootstrapPromptTemplate: "BOOTSTRAP: Cold start setup",
        promptTemplate: "Continue task",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/home/user/workspace",
        },
      },
      onLog: async (_stream, chunk) => {
        logMessages.push(chunk);
      },
    });

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);

    // First attempt used --conversation stale-conv-111 and omitted bootstrap
    const firstArgs = (runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[]])[3];
    expect(firstArgs).toContain("--conversation");
    expect(firstArgs[firstArgs.indexOf("--conversation") + 1]).toBe("stale-conv-111");
    expect(firstArgs[firstArgs.indexOf("--print") + 1]).not.toContain("BOOTSTRAP:");

    // Second attempt omitted --conversation and included bootstrap
    const secondArgs = (runAdapterExecutionTargetProcess.mock.calls[1] as unknown as [string, unknown, string, string[]])[3];
    expect(secondArgs).not.toContain("--conversation");
    expect(secondArgs[secondArgs.indexOf("--print") + 1]).toContain("BOOTSTRAP: Cold start setup");

    expect(logMessages.some((m) => m.includes('retrying with a fresh session'))).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("fresh-conv-999");
    expect(result.sessionParams?.sessionId).toBe("fresh-conv-999");
    expect(result.clearSession).toBeUndefined();
  });

  /**
   * Phase 3: Resets session to fresh when CWD changes or promptBundleKey changes,
   * and skips re-injecting instructions on resumed turns when promptBundleKey matches.
   */
  it("skips re-injecting instructions on resumed turn when promptBundleKey matches and resets session when promptBundleKey or cwd changes", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-bundle-test-"));
    const instructionsPath = path.join(tmpDir, "AGENTS.md");
    const instructionsContent = "# System Rules\nAlways write tests.";
    await fs.writeFile(instructionsPath, instructionsContent, "utf8");

    try {
      const matchingKey = computeAntigravityPromptBundleKey({
        instructionsContents: instructionsContent,
        bootstrapPromptTemplate: "BOOTSTRAP",
        skillEntryKeys: [],
      });

      // 1. Matching promptBundleKey + matching cwd -> resumes session AND omits instructionsPrefix
      let capturedMeta1: any = null;
      await execute({
        runId: "run-bundle-match",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Antigravity Engineer",
          adapterType: "antigravity_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "sess-bundle-1",
          sessionParams: {
            sessionId: "sess-bundle-1",
            cwd: "/home/user/workspace",
            promptBundleKey: matchingKey,
          },
          sessionDisplayId: "sess-bundle-1",
          taskKey: null,
        },
        config: {
          command: "agy",
          instructionsFilePath: instructionsPath,
          bootstrapPromptTemplate: "BOOTSTRAP",
          promptTemplate: "Turn 2 work",
        },
        context: {
          paperclipWorkspace: {
            cwd: "/home/user/workspace",
          },
        },
        onLog: async () => {},
        onMeta: async (meta) => {
          capturedMeta1 = meta;
        },
      });

      const call1Args = (runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[]])[3];
      const prompt1 = call1Args[call1Args.indexOf("--print") + 1];
      expect(call1Args).toContain("--conversation");
      expect(prompt1).not.toContain("# System Rules");
      expect(prompt1).toContain("Turn 2 work");
      expect(capturedMeta1.commandNotes).toContain(
        "Skipped re-injecting agent instructions on resumed session (promptBundleKey unchanged).",
      );

      // 2. Changed promptBundleKey -> resets session to fresh and injects instructionsPrefix
      const logMessages: string[] = [];
      await execute({
        runId: "run-bundle-mismatch",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Antigravity Engineer",
          adapterType: "antigravity_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "sess-bundle-1",
          sessionParams: {
            sessionId: "sess-bundle-1",
            cwd: "/home/user/workspace",
            promptBundleKey: "outdated-bundle-hash",
          },
          sessionDisplayId: "sess-bundle-1",
          taskKey: null,
        },
        config: {
          command: "agy",
          instructionsFilePath: instructionsPath,
          bootstrapPromptTemplate: "BOOTSTRAP",
          promptTemplate: "Turn after bundle change",
        },
        context: {
          paperclipWorkspace: {
            cwd: "/home/user/workspace",
          },
        },
        onLog: async (_s, msg) => {
          logMessages.push(msg);
        },
      });

      const call2Args = (runAdapterExecutionTargetProcess.mock.calls[1] as unknown as [string, unknown, string, string[]])[3];
      const prompt2 = call2Args[call2Args.indexOf("--print") + 1];
      expect(call2Args).not.toContain("--conversation");
      expect(prompt2).toContain("# System Rules");
      expect(prompt2).toContain("BOOTSTRAP");
      expect(logMessages.some((m) => m.includes("Antigravity prompt bundle changed since the last turn"))).toBe(true);

      // 3. Mismatched CWD -> resets session to fresh
      const cwdLogMessages: string[] = [];
      await execute({
        runId: "run-cwd-mismatch",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Antigravity Engineer",
          adapterType: "antigravity_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "sess-cwd-1",
          sessionParams: {
            sessionId: "sess-cwd-1",
            cwd: "/home/user/old-workspace",
            promptBundleKey: matchingKey,
          },
          sessionDisplayId: "sess-cwd-1",
          taskKey: null,
        },
        config: {
          command: "agy",
          instructionsFilePath: instructionsPath,
          bootstrapPromptTemplate: "BOOTSTRAP",
          promptTemplate: "Turn in new workspace",
        },
        context: {
          paperclipWorkspace: {
            cwd: "/home/user/new-workspace",
          },
        },
        onLog: async (_s, msg) => {
          cwdLogMessages.push(msg);
        },
      });

      const call3Args = (runAdapterExecutionTargetProcess.mock.calls[2] as unknown as [string, unknown, string, string[]])[3];
      expect(call3Args).not.toContain("--conversation");
      expect(cwdLogMessages.some((m) => m.includes("was saved for a different workspace"))).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  /**
   * Phase 3: Structured error taxonomy (timeout, auth required with loginUrl,
   * provider_quota, antigravity_transient_upstream with retryNotBefore, model_not_found,
   * max_turns_exhausted, antigravity_refusal).
   */
  it("classifies execution errors with structured errorCode, errorFamily, retryNotBefore, and errorMeta", async () => {
    const baseInput = {
      runId: "run-err",
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
      config: { command: "agy" },
      context: { paperclipWorkspace: { cwd: "/home/user/workspace" } },
      onLog: async () => {},
    };

    // 1. Auth required with loginUrl
    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Not logged in. Please sign in at https://accounts.google.com/o/oauth2/auth?client_id=agy",
      pid: 201,
      startedAt: new Date().toISOString(),
    }));
    const authRes = await execute(baseInput);
    expect(authRes.errorCode).toBe("antigravity_auth_required");
    expect(authRes.errorMeta).toEqual({
      loginUrl: "https://accounts.google.com/o/oauth2/auth?client_id=agy",
    });

    // 2. Provider quota exhausted
    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Error: Quota exhausted for gemini-3.8-pro-high. Resets in 2h.",
      pid: 202,
      startedAt: new Date().toISOString(),
    }));
    const quotaRes = await execute(baseInput);
    expect(quotaRes.errorCode).toBe("provider_quota");
    expect(quotaRes.clearSession).toBe(true);

    // 3. Transient upstream error with retryNotBefore
    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "503 Service Unavailable: upstream overloaded. Retry after 45s.",
      pid: 203,
      startedAt: new Date().toISOString(),
    }));
    const transientRes = await execute(baseInput);
    expect(transientRes.errorCode).toBe("antigravity_transient_upstream");
    expect(transientRes.errorFamily).toBe("transient_upstream");
    expect(transientRes.retryNotBefore).toBeDefined();

    // 4. Model not found
    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Error: Model 'gemini-9.9-ultra' is not available",
      pid: 204,
      startedAt: new Date().toISOString(),
    }));
    const modelRes = await execute(baseInput);
    expect(modelRes.errorCode).toBe("model_not_found");

    // 5. Max turns exhausted
    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: '{"type":"result","subtype":"error_max_turns","result":"Reached maximum turns"}',
      stderr: "",
      pid: 205,
      startedAt: new Date().toISOString(),
    }));
    const turnsRes = await execute(baseInput);
    expect(turnsRes.errorCode).toBe("max_turns_exhausted");
    expect(turnsRes.clearSession).toBe(true);

    // 6. Safety refusal
    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: '{"type":"result","subtype":"refusal","stop_reason":"safety_refusal","error":"Blocked by safety policy"}',
      stderr: "",
      pid: 206,
      startedAt: new Date().toISOString(),
    }));
    const refusalRes = await execute(baseInput);
    expect(refusalRes.errorCode).toBe("antigravity_refusal");

    // 7. Timeout
    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "",
      pid: 207,
      startedAt: new Date().toISOString(),
    }));
    const timeoutRes = await execute({
      ...baseInput,
      config: { command: "agy", timeoutSec: 30 },
    });
    expect(timeoutRes.timedOut).toBe(true);
    expect(timeoutRes.errorCode).toBe("timeout");
    expect(timeoutRes.errorMessage).toBe("Timed out after 30s");
  });

  /**
   * Phase 3: Protected Paperclip runtime environment variables, headless VCS/editor
   * environment defaults, and dynamic billingType resolution.
   */
  it("enforces protected Paperclip runtime env vars, injects headless VCS defaults, and resolves billingType", async () => {
    const res = await execute({
      runId: "true-run-id",
      agent: {
        id: "true-agent-id",
        companyId: "true-company-id",
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
        env: {
          PAPERCLIP_API_KEY: "spoofed-api-key",
          PAPERCLIP_RUN_ID: "spoofed-run-id",
          PAPERCLIP_AGENT_ID: "spoofed-agent-id",
          PAPERCLIP_COMPANY_ID: "spoofed-company-id",
          AGY_ADC_AUTH: "1",
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: "/home/user/workspace",
        },
      },
      authToken: "minted-jwt-token",
      onLog: async () => {},
    });

    const callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
      string,
      unknown,
      string,
      string[],
      { env: Record<string, string>; terminalResultCleanup?: { hasTerminalResult: (s: string) => boolean } },
    ];
    const options = callArgs[4];

    // Protected runtime identity variables cannot be spoofed by config.env
    expect(options.env.PAPERCLIP_API_KEY).toBe("minted-jwt-token");
    expect(options.env.PAPERCLIP_RUN_ID).toBe("true-run-id");
    expect(options.env.PAPERCLIP_AGENT_ID).toBe("true-agent-id");
    expect(options.env.PAPERCLIP_COMPANY_ID).toBe("true-company-id");

    // Headless VCS & editor defaults injected
    expect(options.env.NO_BROWSER).toBe("1");
    expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(options.env.GIT_EDITOR).toBe("false");
    expect(options.env.HGEDITOR).toBe("false");
    expect(options.env.JJ_EDITOR).toBe("false");
    expect(options.env.PAGER).toBe("cat");
    expect(options.env.GIT_PAGER).toBe("cat");
    expect(options.env.JJ_PAGER).toBe("cat");

    // Terminal result cleanup hook passed to execution target runner
    expect(typeof options.terminalResultCleanup?.hasTerminalResult).toBe("function");

    // Billing type resolved to metered_api when AGY_ADC_AUTH=1
    expect(res.billingType).toBe("metered_api");
    expect(resolveAntigravityBillingType({})).toBe("subscription");
    expect(resolveAntigravityBillingType({ ANTIGRAVITY_API_KEY: "sk-123" })).toBe("api");
    expect(resolveAntigravityBillingType({ GOOGLE_APPLICATION_CREDENTIALS: "/path/adc.json" })).toBe("metered_api");
  });
});

