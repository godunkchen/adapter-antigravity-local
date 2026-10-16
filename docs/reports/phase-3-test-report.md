# Phase 3 Test & Validation Report: Execution Lifecycle, Session Recovery, Error Taxonomy & Environment Hardening

- **Branch**: `feat/agy-1.3.6-phase3-execute` (stacked on `feat/agy-1.3.6-phase2-parser-session`)
- **Date**: 2026-10-16
- **Target CLI Version**: Google Antigravity CLI (`agy`) `v1.3.6`
- **Reference Alignment**: `@paperclipai/adapter-claude-local` (`packages/adapters/claude-local/src/server/execute.ts`)

---

## 1. Summary of Changes

1. **Automatic Fresh-Session Retry on Unknown or Corrupted Sessions (`src/server/execute.ts`)**:
   - When resuming a conversation (`--conversation <sessionId>`) fails with `isAntigravityUnknownSessionError(stdout, stderr)` (including deleted sessions, missing conversation steps, or `agy` v1.3.4 truncated WebM/MP4/MOV attachment errors), `execute()` automatically logs a system notice and retries once with a fresh session (`runAttempt(null)`).
   - Prevents re-persisting a dead `sessionId` if the fresh retry fails (`clearSession: true`), while cleanly persisting the newly created `sessionId` and `sessionParams` when the fresh retry succeeds.

2. **Session Workspace (`cwd`) & `promptBundleKey` Validation + Resume Token Optimization (`src/server/execute.ts`)**:
   - Added `computeAntigravityPromptBundleKey()` (SHA-256 over `instructionsContents`, `bootstrapPromptTemplate`, and `skillEntryKeys`) and `agySessionCwdMatchesExecutionTarget()`.
   - When resuming a session where `cwd` and `promptBundleKey` match the previous turn, `execute()` skips re-injecting `instructionsPrefix` and `runtimeSkillsNote` into the prompt payload, saving significant input tokens on every resumed turn and recording `"Skipped re-injecting agent instructions on resumed session (promptBundleKey unchanged)."` in `commandNotes`.
   - When `cwd` or `promptBundleKey` changes between turns, `execute()` automatically starts a fresh session and logs the reason.

3. **Structured Error Classification & Retry Metadata (`src/server/execute.ts`, `src/server/parse.ts`)**:
   - Full parity with `claude-local` error taxonomy:
     - `timeout` (`timedOut: true`, `errorMessage: "Timed out after <N>s"`)
     - `antigravity_auth_required` (with `errorMeta: { loginUrl }` when a login/verification URL is present)
     - `model_not_found` (when `agy` reports an unknown/unavailable model)
     - `max_turns_exhausted` (sets `clearSession: true`)
     - `antigravity_refusal` (when model stops with `subtype: "refusal"` or `stop_reason: "refusal"`)
     - `provider_quota` (sets `clearSession: true` and extracts `retryNotBefore` ISO-8601 timestamp when present)
     - `antigravity_transient_upstream` (sets `errorFamily: "transient_upstream"` and extracts `retryNotBefore` ISO-8601 timestamp when present)

4. **Security, Headless VCS Environment Defaults & Billing Type (`src/server/execute.ts`)**:
   - `enforceProtectedPaperclipRuntimeEnv()` prevents `config.env` from spoofing `PAPERCLIP_API_KEY` (when `authToken` is minted), `PAPERCLIP_RUN_ID`, `PAPERCLIP_AGENT_ID`, or `PAPERCLIP_COMPANY_ID`.
   - `applyAntigravityHeadlessEnv()` injects headless-safe defaults (`NO_BROWSER=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=false`, `HGEDITOR=false`, `JJ_EDITOR=false`, `PAGER=cat`, `GIT_PAGER=cat`, `JJ_PAGER=cat`).
   - Propagates `runtimeEnv.PATH` (including `~/.local/bin`) into local process `env.PATH` so non-login SSH shells and background services resolve `agy` reliably.
   - `resolveAntigravityBillingType()` dynamically resolves `"subscription"` (default OAuth), `"api"` (`ANTIGRAVITY_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY`), or `"metered_api"` (`AGY_ADC_AUTH` / `GOOGLE_APPLICATION_CREDENTIALS`).
   - Passes `terminalResultCleanup: { hasTerminalResult: hasAntigravityTerminalResult }` to `runAdapterExecutionTargetProcess`.

---

## 2. Local Validation (`vitest`)

- **Command**:
  ```bash
  npm run typecheck && ./node_modules/.bin/tsc && ./node_modules/.bin/tsc src/ui-parser.ts --outDir dist --target ES2020 --module CommonJS --declaration false && npm test
  ```
- **Results**:
  - `14 passed` test files (`121 passed` total tests, `0 failed`).
  - Added 4 comprehensive multi-assertion integration tests in `tests/integration/execute.test.ts` covering:
    - Automatic fresh-session retry on corrupt/truncated WebM media conversation error
    - `promptBundleKey` resume token optimization, `promptBundleKey` invalidation on change, and workspace `cwd` mismatch session reset
    - All 7 structured error classifications (`antigravity_auth_required` + `errorMeta.loginUrl`, `provider_quota` + `clearSession`, `antigravity_transient_upstream` + `errorFamily` + `retryNotBefore`, `model_not_found`, `max_turns_exhausted`, `antigravity_refusal`, `timeout`)
    - Protected Paperclip runtime environment enforcement, headless VCS environment defaults, `terminalResultCleanup` hook wiring, and `resolveAntigravityBillingType`

---

## 3. Remote Validation on `oci-sig-1` (Zero-Touch Isolated Worktree)

- **Worktree**: `/tmp/agy-adapter-phase3-validate` (detached worktree from `feat/agy-1.3.6-phase3-execute`, cleaned up immediately after verification; running Paperclip processes untouched).
- **Unit & Integration Test Suite on `oci-sig-1`**:
  - `npm run typecheck && npm run build && npm test` -> **14 test files passed, 121 tests passed**.
- **Live `execute()` Smoke Verification against `agy` v1.3.6 (`/home/ubuntu/.local/bin/agy`)**:
  - Verified non-login SSH shell `PATH` resolution (`~/.local/bin/agy` resolved and spawned automatically without manual `PATH` export).
  - Live `execute()` call with unavailable legacy model ID `"gemini-3-flash"` returned structured classification:
    ```json
    {
      "exitCode": 1,
      "sessionId": null,
      "summary": "",
      "billingType": "subscription",
      "errorCode": "model_not_found",
      "usage": {
        "inputTokens": 0,
        "outputTokens": 0,
        "cachedInputTokens": 0
      }
    }
    ```
