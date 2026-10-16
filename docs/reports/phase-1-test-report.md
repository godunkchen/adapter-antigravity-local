# Phase 1 Validation & Test Report: `agy` v1.3.6 Models, CLI Capabilities, Config Schema & UI Builder

- **Branch**: `feat/agy-1.3.6-phase1-models-config`
- **Date**: 2026-10-16
- **Target CLI Version**: Google Antigravity CLI (`agy`) `v1.3.6`
- **Reference Adapter**: `@paperclipai/adapter-claude-local`

---

## 1. Summary of Changes

1. **Models & Reasoning Effort Resolution (`src/index.ts`, `src/server/execute.ts`, `src/server/models.ts`)**:
   - Added `gemini-4-argon` family (`gemini-4-argon-high`, `gemini-4-argon-medium`, `gemini-4-argon-low`, `gemini-4-argon`) introduced in `agy` v1.3.6.
   - Added base model entries (`gemini-4-argon`, `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b`) and updated `resolveAgyModelAndEffort()` to omit forced `--effort` when no explicit effort is configured (supporting `agy` v1.3.4+ server-default reasoning effort and `agy` v1.3.6 `AGY_ADC_AUTH` base model IDs).
   - Updated `fetchAgyCliModels()` in `src/server/models.ts` to use `ensureAntigravityPathInEnv()` so `~/.local/bin/agy` is discoverable in non-login shells.
2. **CLI Capabilities & Version Probing (`src/server/cli-capabilities.ts`)**:
   - Added `parseAgyCliVersion()`, `isAgyVersionAtLeast()`, `detectAgyCliCapabilities()`, `probeAgyCliCapabilities()`, and `ensureAntigravityPathInEnv()`.
3. **Declarative Config Schema (`src/server/config-schema.ts`)**:
   - Implemented `getConfigSchema()` exposing `mode` (`auto`, `accept-edits`, `plan`), `agent` (`--agent`), `effort` (`--effort`), and `jsonSchema` (`--json-schema`) to Paperclip's UI and wired it into `createServerAdapter()`.
4. **CLI Arguments & UI Config Builder Parity (`src/server/execute.ts`, `src/ui/build-config.ts`)**:
   - Updated `compileAgyArguments()` to emit `--mode`, `--agent`, `--json-schema`, and configurable `--dangerously-skip-permissions`.
   - Aligned `buildAntigravityLocalConfig()` with `claude-local`'s `buildClaudeLocalConfig()` to map `thinkingEffort`, `dangerouslySkipPermissions`, `maxTurnsPerRun`, `workspaceStrategy` (`git_worktree`), `workspaceRuntime` (`runtimeServicesJson`), and `adapterSchemaValues`.

---

## 2. Local Validation Results (macOS `v26.8.2`)

- **Command**: `npm run typecheck && ./node_modules/.bin/tsc && ./node_modules/.bin/tsc src/ui-parser.ts --outDir dist --target ES2020 --module CommonJS --declaration false && npm test`
- **Status**: **PASS**
- **Test Files**: `14 passed (14)`
- **Total Assertions / Tests**: `111 passed (111)` (up from 107 baseline tests)

---

## 3. Remote Validation Results (`oci-sig-1` — Ubuntu / `agy` v1.3.6)

- **Isolation Method**: Executed in isolated temporary Git worktree `/tmp/agy-adapter-phase1-validate` (cleaned up immediately after completion) without modifying `/home/ubuntu/adapter-antigravity-local` or the running Paperclip server process.
- **Build & Test Suite (`npm run typecheck && npm run build && npm test`)**:
  - **Status**: **PASS**
  - **Test Files**: `14 passed (14)`
  - **Tests**: `111 passed (111)` in `1.43s`
- **Live `agy` v1.3.6 CLI Probing**:
  - `probeAgyCliCapabilities({ forceRefresh: true })`:
    ```json
    {
      "version": { "major": 1, "minor": 3, "patch": 6, "raw": "1.3.6" },
      "supportsModeFlag": true,
      "supportsAutoMode": true,
      "supportsAgentFlag": true,
      "supportsEffortFlag": true,
      "supportsJsonSchemaFlag": true,
      "supportsBaseModelDefaultEffort": true,
      "supportsPluginSubcommand": true,
      "supportsAdcAuth": true
    }
    ```
  - `loadAntigravityModels({ forceRefresh: true })`:
    - Discovered **14 live models** (`auto` + 13 CLI models), starting with `gemini-4-argon-medium`, `gemini-4-argon-high`, `gemini-4-argon-low`.
