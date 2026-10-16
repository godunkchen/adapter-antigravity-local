# Phase 4 Test & Validation Report: Environment Probe, ADC Diagnostics, Plugin Discovery & Documentation

- **Branch**: `feat/agy-1.3.6-phase4-probe` (stacked on `feat/agy-1.3.6-phase3-execute`)
- **Date**: 2026-10-16
- **Target CLI Version**: Google Antigravity CLI (`agy`) `v1.3.6`
- **Reference Alignment**: `@paperclipai/adapter-claude-local` (`packages/adapters/claude-local/src/server/test.ts`)

---

## 1. Summary of Changes

1. **Stream-JSON Hello Probe & Terminal Cleanup (`src/server/test.ts`)**:
   - Upgraded `performHelloTelemetryProbe()` to pass `--output-format stream-json` and parse structured NDJSON events via `parseAntigravityStreamJson(probe.stdout)` (while retaining plain-text fallback for mock/custom runners).
   - Wired `terminalResultCleanup: { hasTerminalResult: hasAntigravityTerminalResult }` so lingering child processes exit cleanly once a terminal result event arrives.
   - Removed the Claude-specific `--max-turns` flag after live `agy` v1.3.6 verification confirmed `agy` uses `--print-timeout` rather than `--max-turns`.

2. **GCP Application Default Credentials (`AGY_ADC_AUTH`) & API Credential Diagnostics (`src/server/test.ts`)**:
   - Extended `checkApiCredentials()` to detect:
     - `ANTIGRAVITY_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` (`antigravity_api_key_present`)
     - `AGY_ADC_AUTH=1` / `GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT` (`antigravity_adc_auth_configured`, added in `agy` v1.3.5)
     - Subscription login fallback guidance (`antigravity_api_key_missing`)

3. **Structured Probe Reason Codes & Upstream Failure Classification (`src/server/test.ts`)**:
   - Escalates missing authentication on remote execution targets to `level: "error"` with `reasonCode: "adapter_auth_missing"` and surfaces extracted OAuth `loginUrl` in `hint`.
   - Sets `reasonCode: "usage_limited"` on `antigravity_hello_probe_quota_exhausted` and includes `retryNotBefore` reset timestamp in `hint` when present.
   - Distinguishes transient upstream 502/503/504/529 failures as a warning (`antigravity_hello_probe_transient_upstream`) instead of a hard failure.

4. **Antigravity Plugin Inventory Probe (`src/server/test.ts`, `src/server/index.ts`)**:
   - Added `probeAntigravityPlugins()` (executing `agy plugin list --json`, introduced in `agy` v1.3.4) and wired optional `config.probePlugins` support into `testEnvironment()`.

5. **Documentation & Release Metadata (`package.json`, `README.md`, `DEVELOPER_GUIDE.md`)**:
   - Bumped package version to `2.6.0`.
   - Updated `README.md` and `DEVELOPER_GUIDE.md` with `agy` v1.3.6 capabilities, `ServerAdapterModule` hooks (`getConfigSchema`, `sessionCodec`, `getQuotaWindows`), new CLI flags (`--mode`, `--agent`, `--json-schema`), and `AGY_ADC_AUTH` documentation.

---

## 2. Local Validation (`vitest`)

- **Command**:
  ```bash
  npm run typecheck && ./node_modules/.bin/tsc && ./node_modules/.bin/tsc src/ui-parser.ts --outDir dist --target ES2020 --module CommonJS --declaration false && npm test
  ```
- **Results**:
  - `14 passed` test files (`126 passed` total tests, `0 failed`).
  - Added 5 new integration test scenarios in `tests/integration/test-environment.test.ts` (`13 tests` total in suite):
    - `stream-json` hello probe output parsing and `--output-format stream-json` flag verification
    - `AGY_ADC_AUTH=1` and `GOOGLE_CLOUD_PROJECT` credential check (`antigravity_adc_auth_configured`)
    - Remote target auth failure escalation (`level: "error"`, `reasonCode: "adapter_auth_missing"`, `loginUrl` hint)
    - Transient upstream 503 warning (`antigravity_hello_probe_transient_upstream`)
    - Installed plugin discovery (`probePlugins: true` -> `antigravity_plugins_probed`)

---

## 3. Remote Validation on `oci-sig-1` (Zero-Touch Isolated Worktree)

- **Worktree**: `/tmp/agy-adapter-phase4-validate` (detached worktree from `feat/agy-1.3.6-phase4-probe`, removed immediately after verification; running Paperclip processes untouched).
- **Unit & Integration Test Suite on `oci-sig-1`**:
  - `npm run typecheck && npm run build && npm test` -> **14 test files passed, 126 tests passed**.
- **Live `testEnvironment()` End-to-End Probe against `agy` v1.3.6 (`/home/ubuntu/.local/bin/agy`)**:
  ```json
  {
    "adapterType": "antigravity_local",
    "status": "pass",
    "checks": [
      {
        "code": "antigravity_environment_target",
        "level": "info",
        "message": "Probing inside environment: local environment"
      },
      {
        "code": "antigravity_cwd_valid",
        "level": "info",
        "message": "Working directory is valid: /tmp/agy-adapter-phase4-validate"
      },
      {
        "code": "antigravity_command_resolvable",
        "level": "info",
        "message": "Command is executable: agy"
      },
      {
        "code": "antigravity_api_key_missing",
        "level": "info",
        "message": "No explicit ANTIGRAVITY_API_KEY or AGY_ADC_AUTH detected. Antigravity may still work via subscription login (`agy auth login`).",
        "hint": "If the hello probe fails with an auth error, set ANTIGRAVITY_API_KEY, enable AGY_ADC_AUTH=1, or run `agy auth login`."
      },
      {
        "code": "antigravity_model_configured",
        "level": "info",
        "message": "Configured execution model: \"gemini-3.8-flash-low\"",
        "detail": "Pinned model: gemini-3.8-flash-low"
      },
      {
        "code": "antigravity_plugins_probed",
        "level": "info",
        "message": "Detected 0 installed Antigravity plugin(s)."
      },
      {
        "code": "antigravity_hello_probe_passed",
        "level": "info",
        "message": "Antigravity hello probe succeeded.",
        "detail": "hello"
      }
    ],
    "testedAt": "2026-10-16T06:37:35.909Z"
  }
  ```
