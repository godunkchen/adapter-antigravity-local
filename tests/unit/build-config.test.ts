import { describe, expect, it } from "vitest";
import { buildAntigravityLocalConfig } from "../../src/ui/build-config.js";
import { DEFAULT_ANTIGRAVITY_LOCAL_MODEL } from "../../src/index.js";

/**
 * Unit test suite for the UI configuration builder.
 * Assures accurate parsing of legacy variables strings, structured bindings, secret references, sandboxing flags, and fallback rules.
 */
describe("UI build-config mapper", () => {
  
  /**
   * Scenario: Basic configuration building and fallback resolutions.
   */
  it("builds the configuration with default values when provided with minimal parameters", () => {
    const result = buildAntigravityLocalConfig({});
    
    expect(result).toEqual({
      model: DEFAULT_ANTIGRAVITY_LOCAL_MODEL,
      timeoutSec: 0,
      graceSec: 15,
      sandbox: true, // defaults to true unless dangerouslyBypassSandbox is true
    });
  });

  /**
   * Scenario: Working directories and instructions file paths mapping.
   */
  it("maps cwd, instructionsFilePath, and custom command properties directly", () => {
    const result = buildAntigravityLocalConfig({
      cwd: "/home/developer/workspace",
      instructionsFilePath: "/home/developer/instructions.md",
      command: "/usr/bin/agy-custom",
    });

    expect(result.cwd).toBe("/home/developer/workspace");
    expect(result.instructionsFilePath).toBe("/home/developer/instructions.md");
    expect(result.command).toBe("/usr/bin/agy-custom");
  });

  /**
   * Scenario: Prompt templates mapping (promptTemplate and bootstrapPromptTemplate).
   */
  it("maps promptTemplate and bootstrapPromptTemplate properties cleanly", () => {
    const result = buildAntigravityLocalConfig({
      promptTemplate: "Continue with task: {{context.task}}",
      bootstrapPromptTemplate: "Initialize session for {{agent.name}}",
    } as any);

    expect(result.promptTemplate).toBe("Continue with task: {{context.task}}");
    expect(result.bootstrapPromptTemplate).toBe("Initialize session for {{agent.name}}");
  });

  /**
   * Scenario: Legacy plain text envVars formatting.
   * Tests multi-line KEY=VALUE resolution, skipping invalid key structures and ignores comment lines.
   */
  it("correctly parses legacy plain text envVars variables", () => {
    const envVars = `
      # A comment line to skip
      PORT=8080
      HOST=127.0.0.1
      1INVALID=should-be-ignored
      VALID_VAR=hello=world
    `;

    const result = buildAntigravityLocalConfig({ envVars });

    expect(result.env).toEqual({
      PORT: { type: "plain", value: "8080" },
      HOST: { type: "plain", value: "127.0.0.1" },
      VALID_VAR: { type: "plain", value: "hello=world" },
    });
  });

  /**
   * Scenario: Structured envBindings mapper.
   * Assures plain string bindings and secret references map cleanly according to types schemas.
   */
  it("parses structured envBindings plain text and secret_ref references", () => {
    const envBindings = {
      API_KEY: "plain-text-key",
      DB_PASSWORD: {
        type: "secret_ref",
        secretId: "sec-db-pass",
        version: "latest",
      },
      API_PORT: {
        type: "plain",
        value: "3000",
      },
      INVALID_BINDING: {
        type: "invalid_type",
        value: "ignored",
      },
    };

    const result = buildAntigravityLocalConfig({ envBindings });

    expect(result.env).toEqual({
      API_KEY: { type: "plain", value: "plain-text-key" },
      DB_PASSWORD: {
        type: "secret_ref",
        secretId: "sec-db-pass",
        version: "latest",
      },
      API_PORT: {
        type: "plain",
        value: "3000",
      },
    });
  });

  /**
   * Scenario: Precedence and Variable merges.
   * Validates that structured envBindings take precedence over legacy envVars on keys collisions.
   */
  it("resolves key collisions by prioritizing envBindings over legacy envVars", () => {
    const envVars = `
      PORT=8080
      TIMEOUT=30
    `;
    const envBindings = {
      PORT: "9000", // Collision!
      ENV_NAME: "production",
    };

    const result = buildAntigravityLocalConfig({ envVars, envBindings });

    expect(result.env).toEqual({
      PORT: { type: "plain", value: "9000" }, // Wins from envBindings
      TIMEOUT: { type: "plain", value: "30" }, // Merged from envVars
      ENV_NAME: { type: "plain", value: "production" }, // Merged from envBindings
    });
  });

  /**
   * Scenario: Sandboxing bypass setups.
   */
  it("correctly triggers sandbox flag based on dangerouslyBypassSandbox UI values", () => {
    const withSandbox = buildAntigravityLocalConfig({ dangerouslyBypassSandbox: false });
    expect(withSandbox.sandbox).toBe(true);

    const bypassed = buildAntigravityLocalConfig({ dangerouslyBypassSandbox: true });
    expect(bypassed.sandbox).toBe(false);
  });

  /**
   * Scenario: Commas delimited arguments parsing.
   */
  it("parses comma-separated extraArgs into an array list of string arguments", () => {
    const result = buildAntigravityLocalConfig({
      extraArgs: "--verbose, --debug, --model-fallback=none",
    } as any);

    expect(result.extraArgs).toEqual(["--verbose", "--debug", "--model-fallback=none"]);
  });

  /**
   * Scenario: claude-local UI parity fields (thinkingEffort, dangerouslySkipPermissions, maxTurnsPerRun, workspaceStrategy, workspaceRuntime, adapterSchemaValues).
   */
  it("maps thinkingEffort, dangerouslySkipPermissions, maxTurnsPerRun, workspaceStrategy, workspaceRuntime, and adapterSchemaValues", () => {
    const result = buildAntigravityLocalConfig({
      model: "gemini-4-argon",
      thinkingEffort: "high",
      dangerouslySkipPermissions: false,
      maxTurnsPerRun: 25,
      workspaceStrategyType: "git_worktree",
      workspaceBaseRef: "origin/main",
      workspaceBranchTemplate: "agent/{{issue.identifier}}",
      worktreeParentDir: "/tmp/worktrees",
      runtimeServicesJson: JSON.stringify({
        services: [{ serviceName: "web", port: 3000 }],
      }),
      adapterSchemaValues: {
        mode: "auto",
        agent: "code-reviewer",
        jsonSchema: '{"type":"object"}',
      },
    } as any);

    expect(result.model).toBe("gemini-4-argon");
    expect(result.effort).toBe("high");
    expect(result.dangerouslySkipPermissions).toBe(false);
    expect(result.maxTurnsPerRun).toBe(25);
    expect(result.mode).toBe("auto");
    expect(result.agent).toBe("code-reviewer");
    expect(result.jsonSchema).toBe('{"type":"object"}');
    expect(result.workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "origin/main",
      branchTemplate: "agent/{{issue.identifier}}",
      worktreeParentDir: "/tmp/worktrees",
    });
    expect(result.workspaceRuntime).toEqual({
      services: [{ serviceName: "web", port: 3000 }],
    });
  });

  /**
   * Scenario: compileAgyArguments CLI flag generation for agy v1.3.4-v1.3.6.
   */
  it("compiles --mode, --agent, --json-schema, and configurable --dangerously-skip-permissions flags", async () => {
    const { compileAgyArguments } = await import("../../src/server/execute.js");
    const args = compileAgyArguments(
      "Review repository",
      "conv-123",
      [{ cwd: "/workspace/sub" }],
      true,
      ["--disable-slash-commands"],
      "gemini-4-argon",
      "high",
      120,
      {
        mode: "auto",
        agent: "security-auditor",
        jsonSchema: '{"type":"object"}',
        dangerouslySkipPermissions: false,
      },
    );

    expect(args).toEqual([
      "--print",
      "Review repository",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-4-argon",
      "--effort",
      "high",
      "--mode",
      "auto",
      "--agent",
      "security-auditor",
      "--json-schema",
      '{"type":"object"}',
      "--print-timeout",
      "120s",
      "--conversation",
      "conv-123",
      "--add-dir",
      "/workspace/sub",
      "--sandbox",
      "--disable-slash-commands",
    ]);
  });

  /**
   * Scenario: CLI version and capability detection (agy v1.3.6).
   */
  it("detects agy v1.3.6 CLI capabilities and enriches PATH with ~/.local/bin", async () => {
    const {
      parseAgyCliVersion,
      isAgyVersionAtLeast,
      detectAgyCliCapabilities,
      ensureAntigravityPathInEnv,
    } = await import("../../src/server/cli-capabilities.js");

    const parsed = parseAgyCliVersion("1.3.6\n");
    expect(parsed).toEqual({ major: 1, minor: 3, patch: 6, raw: "1.3.6" });
    expect(isAgyVersionAtLeast(parsed, 1, 3, 6)).toBe(true);
    expect(isAgyVersionAtLeast(parsed, 1, 3, 7)).toBe(false);

    const caps = detectAgyCliCapabilities(
      `Usage of agy:\n  --agent Agent for the current CLI session\n  --effort Reasoning effort\n  --json-schema Optional JSON schema\n  --mode Set the agent execution mode for this session (accept-edits, auto, plan)\nAvailable subcommands:\n  plugin Manage plugins`,
      "1.3.6",
    );
    expect(caps).toEqual({
      version: { major: 1, minor: 3, patch: 6, raw: "1.3.6" },
      supportsModeFlag: true,
      supportsAutoMode: true,
      supportsAgentFlag: true,
      supportsEffortFlag: true,
      supportsJsonSchemaFlag: true,
      supportsBaseModelDefaultEffort: true,
      supportsPluginSubcommand: true,
      supportsAdcAuth: true,
    });

    const enrichedEnv = ensureAntigravityPathInEnv({ HOME: "/home/ubuntu", PATH: "/usr/bin:/bin" });
    expect(enrichedEnv.PATH.split(":")).toContain("/home/ubuntu/.local/bin");
  });

  /**
   * Scenario: Server adapter capability contract exports.
   */
  it("exports complete ServerAdapterModule capabilities including supportsLocalAgentJwt and getConfigSchema", async () => {
    const { createServerAdapter, type, label } = await import("../../src/index.js");
    const adapter = createServerAdapter();

    expect(type).toBe("antigravity_local");
    expect(label).toBe("Antigravity CLI (local)");
    expect(adapter.type).toBe("antigravity_local");
    expect(adapter.supportsLocalAgentJwt).toBe(true);
    expect(adapter.supportsInstructionsBundle).toBe(true);
    expect(adapter.instructionsPathKey).toBe("instructionsFilePath");
    expect(adapter.requiresMaterializedRuntimeSkills).toBe(true);
    expect(typeof adapter.getConfigSchema).toBe("function");
    const schema = await adapter.getConfigSchema!();
    expect(schema.fields.map((f) => f.key)).toEqual(["mode", "agent", "effort", "jsonSchema"]);
    expect(typeof adapter.listSkills).toBe("function");
    expect(typeof adapter.syncSkills).toBe("function");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.testEnvironment).toBe("function");
  });
});
