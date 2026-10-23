# AGENTS.md

Instructions and operational constraints for AI agents working in `adapter-antigravity-local`.

---

## What This Project Is

A high-performance **Paperclip AI** server adapter (`@weslleycapelari/adapter-antigravity-local`) bridging Paperclip's orchestration engine with the local **Google Antigravity CLI** (`agy` binary). Implements `ServerAdapterModule` from `@paperclipai/adapter-utils`, aligned to Paperclip's golden `claude-local` adapter contract.

---

## Verification & Commands

Required verification pipeline before finishing any task:
```bash
npm run typecheck    # tsc --noEmit (strict checks against src/)
npm run build        # tsc + esbuild server bundle + esbuild CJS ui-parser + dist/package.json rewrite
npm test             # vitest run (16 test files, 145+ unit/integration tests)
```

### Running Targeted Tests
Vitest is configured at the root. Run a single file or filtered suite:
```bash
npx vitest run tests/unit/paperclip-ui-compat.test.ts
npx vitest run tests/unit/ui-parser.test.ts
npx vitest run -t "dedupeModels"
```

### Build Architecture Gotchas
`npm run build` performs five critical steps:
1. `tsc` — emits declarations and ESM files under `dist/`, including `dist/ui/parser-core.js` so `dist/ui/index.js` imports cleanly in ESM.
2. `npx esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.js --external:@paperclipai/adapter-utils --external:picocolors --external:node:*` — bundles server code into ESM.
3. `npx esbuild src/ui-parser.ts --bundle --platform=neutral --target=es2020 --format=cjs --outfile=dist/ui-parser.js` — bundles `src/ui/parser-core.ts` into a zero-import CommonJS module (`dist/ui-parser.js`) and copies it to `dist/ui-parser.cjs`.
4. Rewrites `dist/package.json` with `./dist/` prefixes stripped so Paperclip's `plugin-loader.ts` resolves entrypoints whether `localPath` points to the repo root or `dist/`.

**Never** revert `dist/ui-parser.js` to raw `tsc --module CommonJS`: `tsc` emits `exports.parseStdoutLine = void 0;` at the top and relies on function hoisting, which leaves `exports.parseStdoutLine === undefined` when evaluated inside Paperclip's `sandboxed-parser-worker.ts` strict-mode block (`"use strict";\n{\n...}`). Always use `esbuild --format=cjs`.

---

## Architectural Conventions & Boundaries

### 1. UI Parser Architecture (`src/ui/parser-core.ts` & `src/ui-parser.ts`)
- `src/ui/parser-core.ts`: Single source of truth for transcript parsing. **MUST HAVE ZERO RUNTIME IMPORTS** (only `import type` is allowed).
- `src/ui/parse-stdout.ts`: ESM wrapper importing from `./parser-core.js` for static ESM consumers (`./ui` export).
- `src/ui-parser.ts`: Entrypoint bundled by `esbuild` into `dist/ui-parser.js` and `dist/ui-parser.cjs` for Paperclip's dynamic Web Worker (`GET /api/adapters/antigravity_local/ui-parser.js`).
- **Singleton Worker Safety**: Paperclip's `sandboxed-parser-worker.ts` evaluates `ui-parser.js` once per session and calls `parseStdoutLine(line, ts)` across multiple turns. When a tool or step reaches `DONE`/`COMPLETED`/`ERROR`, clean up its step ID from `emittedActiveToolIds`, `streamedAssistantStepIds`, and `streamedThinkingStepIds` so subsequent turns reusing step indices (`1`, `2`, ...) are never dropped.
- **Paperclip Worker Lockdown Auto-Patcher (`src/server/worker-lockdown-fix.ts`, `scripts/fix-worker-lockdown.cjs`)**: Paperclip `v2026.1012.0` has an upstream bug ([#16143](https://github.com/paperclipai/paperclip/issues/16143) / [#12223](https://github.com/paperclipai/paperclip/issues/12223)) where `self.caches = _undefined;` throws in strict-mode Web Workers. `createServerAdapter()` automatically runs `ensurePaperclipWorkerLockdownPatched()` on startup and adapter reload (`POST /api/adapters/antigravity_local/reload`), and `npm run fix-worker` can be run manually.

### 2. Subprocess & Environment Sanitization
- `src/server/execute.ts` spawns `agy` using `runAdapterExecutionTargetProcess` from `@paperclipai/adapter-utils`.
- Subprocess shells need PATH hydration via `ensureAntigravityPathInEnv()` (`~/.local/bin`, `~/.gemini/antigravity/bin`, `/usr/local/bin`).
- Headless runs pass default flags: `--dangerously-skip-permissions`, `NO_BROWSER=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=false`, `PAGER=cat`.

### 3. Model & Effort Resolution
- Flat composite models (e.g. `gemini-3.1-pro-high`, `gemini-3.8-flash-low`) encode effort in the model ID. Do **NOT** pass `--effort` when using composite IDs or models with inherent reasoning (e.g. `claude-*`), as the `agy` CLI will fail argument validation.
- Auto-routing (`auto`) passes `--effort` only if explicitly requested.
- Dynamic models query `agy models --output-format json` (cached in-memory for 60s via `AGY_MODELS_CACHE_TTL_MS`). When extending or testing models, use `resetAntigravityModelsCacheForTests()` to avoid cache bleed.

### 4. Live Event Bridge & Telemetry
- `src/server/live-events.ts`: Bridges `agy` `stream-json` NDJSON events (`init`, `tool_call`, `step.completed`, `step.failed`, `thinking_delta`, `text_delta`, `step_update`, `result`).
- Progress throttling defaults to `1500ms` (`DEFAULT_ANTIGRAVITY_DELTA_THROTTLE_MS`), while tool call transitions emit immediately.
- Resumed turns use SHA-256 fingerprinting (`computeAntigravityPromptBundleKey`) to skip re-injecting static instruction bundles and skills.

### 5. Local Development & Docker Validation
- All development, unit/integration testing, and container validation should be done locally (do not rely on remote hosts like `oci-sig-1`).
- Target Paperclip source reference is located locally at `/Users/dunk/Documents/paperclip`.
- Validate full isolated execution using the local `node:20-alpine` Docker image mounting the workspace (`docker run --rm -v "$(pwd):/app" -w /app node:20-alpine ...`).
