import { afterEach, describe, expect, it, vi } from "vitest";
import { testEnvironment } from "../../src/server/test.js";

const {
  runAdapterExecutionTargetProcess,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  maybeRunSandboxInstallCommand,
} = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "hello",
    stderr: "",
    pid: 999,
    startedAt: new Date().toISOString(),
  })),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetDirectory: vi.fn(async () => undefined),
  maybeRunSandboxInstallCommand: vi.fn(async () => null),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    runAdapterExecutionTargetProcess,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetDirectory,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureAbsoluteDirectory: vi.fn(async () => undefined),
  };
});

/**
 * Integration test suite for the environment connection probe pipeline.
 * Assures rigorous coverage across basic passes, missing credentials, quota limits, and timeouts.
 */
describe("testEnvironment probe pipeline", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Scenario: Basic passing flow.
   * Asserts status is "pass" and returns probe passed when agy prints "hello".
   */
  it("probes successfully and returns 'pass' status with hello output", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Hello from Antigravity!",
      stderr: "",
      pid: 111,
      startedAt: new Date().toISOString(),
    });

    const result = await testEnvironment({
      adapterType: "antigravity_local",
      config: {
        command: "agy",
      },
      onLog: async () => {},
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((c) => c.code === "antigravity_hello_probe_passed")).toBe(true);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
  });

  /**
   * Scenario: Custom non-agy command skip.
   * Proves that custom wrapper scripts skip direct hello telemetry probes.
   */
  it("skips hello probe when custom execution command is configured", async () => {
    const result = await testEnvironment({
      adapterType: "antigravity_local",
      config: {
        command: "custom-orchestrator.sh",
      },
      onLog: async () => {},
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((c) => c.code === "antigravity_hello_probe_skipped_custom_command")).toBe(true);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  /**
   * Scenario: Invalid working directory.
   * Emulates directory check failure and validates prompt aborts before launching probe.
   */
  it("fails immediately and sets status to 'fail' if working directory is invalid", async () => {
    ensureAdapterExecutionTargetDirectory.mockRejectedValueOnce(new Error("Directory invalid permission"));

    const result = await testEnvironment({
      adapterType: "antigravity_local",
      config: {
        command: "agy",
        cwd: "/root/protected",
      },
      onLog: async () => {},
    });

    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "antigravity_cwd_invalid")).toBe(true);
    // Probe execution MUST be aborted
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  /**
   * Scenario: Executable missing in PATH.
   * Asserts exit status is 'fail' when command target is not resolvable.
   */
  it("fails connection checks if the agy binary cannot be resolved in PATH", async () => {
    ensureAdapterExecutionTargetCommandResolvable.mockRejectedValueOnce(new Error("Command not found in PATH"));

    const result = await testEnvironment({
      adapterType: "antigravity_local",
      config: {
        command: "agy",
      },
      onLog: async () => {},
    });

    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "antigravity_command_unresolvable")).toBe(true);
    // Probe execution MUST be aborted
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  /**
   * Scenario: Missing Authentication Credentials.
   * Asserts status is 'warn' and sets auth required if exitCode is not 0 and messages match.
   */
  it("identifies lack of authentication and triggers warning status", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Run `agy auth login` first to authenticate",
      pid: 222,
      startedAt: new Date().toISOString(),
    });

    const result = await testEnvironment({
      adapterType: "antigravity_local",
      config: {
        command: "agy",
      },
      onLog: async () => {},
    });

    expect(result.status).toBe("warn");
    expect(result.checks.some((c) => c.code === "antigravity_hello_probe_auth_required")).toBe(true);
  });

  /**
   * Scenario: Quota Exhausted limits.
   * Asserts detection of quota exhaustion and marks warnings.
   */
  it("identifies rate limits or quota exhausted signatures and sets warnings", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Resource limits exhausted (429): Quota exceeded",
      pid: 333,
      startedAt: new Date().toISOString(),
    });

    const result = await testEnvironment({
      adapterType: "antigravity_local",
      config: {
        command: "agy",
      },
      onLog: async () => {},
    });

    expect(result.status).toBe("warn");
    expect(result.checks.some((c) => c.code === "antigravity_hello_probe_quota_exhausted")).toBe(true);
  });

  /**
   * Scenario: Telemetry timed out.
   * Validates robust warn handling when probes take longer than limits.
   */
  it("warns about timeouts if telemetry probe exceeds configured durations", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "",
      pid: 444,
      startedAt: new Date().toISOString(),
    });

    const result = await testEnvironment({
      adapterType: "antigravity_local",
      config: {
        command: "agy",
      },
      onLog: async () => {},
    });

    expect(result.status).toBe("warn");
    expect(result.checks.some((c) => c.code === "antigravity_hello_probe_timed_out")).toBe(true);
  });

  /**
   * Scenario: API key detection.
   * Verifies credentials info logs depend on configured API keys in environment.
   */
  it("flags api credentials as present when ANTIGRAVITY_API_KEY is supplied", async () => {
    const result = await testEnvironment({
      adapterType: "antigravity_local",
      config: {
        command: "agy",
        env: {
          ANTIGRAVITY_API_KEY: "test-sk-12345",
        },
      },
      onLog: async () => {},
    });

    expect(result.checks.some((c) => c.code === "antigravity_api_key_present")).toBe(true);
    expect(result.checks.some((c) => c.code === "antigravity_api_key_missing")).toBe(false);
  });

  /**
   * Scenario: Stream-JSON hello probe output & --max-turns 1 flags.
   */
  it("parses stream-json hello probe output and passes --output-format stream-json --max-turns 1", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout:
        '{"event":"init","conversation_id":"probe-1"}\n{"type":"result","result":"Hello, everything is ready!"}\n',
      stderr: "",
      pid: 501,
      startedAt: new Date().toISOString(),
    });

    const result = await testEnvironment({
      adapterType: "antigravity_local",
      config: {
        command: "agy",
      },
      onLog: async () => {},
    });

    expect(result.status).toBe("pass");
    const passedCheck = result.checks.find((c) => c.code === "antigravity_hello_probe_passed");
    expect(passedCheck).toBeDefined();
    expect(passedCheck?.detail).toContain("Hello, everything is ready!");

    const callArgs = (runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[]])[3];
    expect(callArgs).toContain("--output-format");
    expect(callArgs).toContain("stream-json");
    expect(callArgs).toContain("--max-turns");
    expect(callArgs).toContain("1");
  });

  /**
   * Scenario: Google Cloud ADC authentication detection (`AGY_ADC_AUTH=1` in v1.3.5+).
   */
  it("detects AGY_ADC_AUTH and GOOGLE_CLOUD_PROJECT credentials", async () => {
    const result = await testEnvironment({
      adapterType: "antigravity_local",
      config: {
        command: "agy",
        env: {
          AGY_ADC_AUTH: "1",
          GOOGLE_CLOUD_PROJECT: "my-gcp-project",
        },
      },
      onLog: async () => {},
    });

    const adcCheck = result.checks.find((c) => c.code === "antigravity_adc_auth_configured");
    expect(adcCheck).toBeDefined();
    expect(adcCheck?.detail).toContain('GOOGLE_CLOUD_PROJECT="my-gcp-project"');
  });

  /**
   * Scenario: Remote target auth missing escalates to error with adapter_auth_missing reasonCode and loginUrl hint.
   */
  it("escalates missing auth on remote execution target to error with adapter_auth_missing and loginUrl hint", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Not logged in. Authenticate at https://accounts.google.com/o/oauth2/auth?client_id=agy",
      pid: 502,
      startedAt: new Date().toISOString(),
    });

    const result = await testEnvironment({
      adapterType: "antigravity_local",
      executionTarget: {
        kind: "remote",
        provider: "ssh",
        host: "oci-sig-1",
      } as any,
      config: {
        command: "agy",
      },
      onLog: async () => {},
    });

    expect(result.status).toBe("fail");
    const authCheck = result.checks.find((c) => c.code === "antigravity_hello_probe_auth_required");
    expect(authCheck).toBeDefined();
    expect(authCheck?.level).toBe("error");
    expect(authCheck?.reasonCode).toBe("adapter_auth_missing");
    expect(authCheck?.hint).toContain("https://accounts.google.com/o/oauth2/auth?client_id=agy");
  });

  /**
   * Scenario: Transient upstream error (503) warns instead of failing hard.
   */
  it("warns with antigravity_hello_probe_transient_upstream on 503 service overload", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "503 Service Unavailable: upstream model server overloaded",
      pid: 503,
      startedAt: new Date().toISOString(),
    });

    const result = await testEnvironment({
      adapterType: "antigravity_local",
      config: {
        command: "agy",
      },
      onLog: async () => {},
    });

    expect(result.status).toBe("warn");
    const transientCheck = result.checks.find((c) => c.code === "antigravity_hello_probe_transient_upstream");
    expect(transientCheck).toBeDefined();
    expect(transientCheck?.level).toBe("warn");
  });

  /**
   * Scenario: Optional plugin inspection (`probePlugins: true`, `agy plugin list --json` in v1.3.4+).
   */
  it("probes installed Antigravity plugins when config.probePlugins is enabled", async () => {
    runAdapterExecutionTargetProcess
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: '[{"name":"github-pr-helper"},{"name":"bigquery-tools"}]',
        stderr: "",
        pid: 504,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: '{"type":"result","result":"Hello!"}',
        stderr: "",
        pid: 505,
        startedAt: new Date().toISOString(),
      });

    const result = await testEnvironment({
      adapterType: "antigravity_local",
      config: {
        command: "agy",
        probePlugins: true,
      },
      onLog: async () => {},
    });

    expect(result.status).toBe("pass");
    const pluginCheck = result.checks.find((c) => c.code === "antigravity_plugins_probed");
    expect(pluginCheck).toBeDefined();
    expect(pluginCheck?.message).toContain("Detected 2 installed Antigravity plugin(s).");
  });
});

