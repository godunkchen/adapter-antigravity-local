# Adapter Developer Guide: Model Lifecycle, Discovery & Execution Architecture

This guide provides a generic, provider-agnostic manual for maintaining and extending AI model support in the **Antigravity Local Adapter** for the **Paperclip AI** platform. It documents the core design rationale, model resolution strategies, dynamic discovery mechanisms, and cross-environment verification workflows.

---

## 1. System Architecture Overview

The adapter functions as a typed, resilient bridge between Paperclip's orchestration server and the local Antigravity runtime engine (`agy` CLI).

```
┌─────────────────────────────────────────────────────────────┐
│                       Paperclip AI                          │
│  - Agent Web UI / REST API                                  │
│  - Settings & Model Profiles (cheap, smart, etc.)           │
│  - Adapter Registry (`ServerAdapterModule`)                 │
└──────────────┬───────────────────────────────▲──────────────┘
               │ Invokes `execute()`           │ Queries `listModels()`
               │ Passes `adapterConfig`        │ `refreshModels()`
               ▼                               │
┌──────────────────────────────────────────────┴──────────────┐
│            adapter-antigravity-local Module                 │
│  - Static Fallback Model Definitions                        │
│  - Dynamic CLI Model Discovery & TTL Caching                │
│  - Model & Reasoning Effort Resolution Engine               │
│  - Stream-JSON Event Parser & Telemetry Probes              │
└──────────────┬──────────────────────────────────────────────┘
               │ Spawns Child Process
               │ `agy --model <resolved> [--effort <level>]`
               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Antigravity Runtime Engine                  │
│  - CLI Binary (`agy`)                                       │
│  - Sandboxed Filesystem / Process Execution                 │
│  - Upstream Model Routing & Inference                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Paperclip Adapter Framework Contract

Paperclip interacts with the adapter through the `ServerAdapterModule` interface defined in `@paperclipai/adapter-utils`:

| Contract Element | Purpose | Implementation Pattern |
|---|---|---|
| `models` | Static baseline array of model definitions | Fallback model list bundled with the adapter release. |
| `listModels()` | Dynamic model discovery hook | Queries live runtime engine (`agy models --output-format json`) with TTL caching and plain-text fallback. |
| `refreshModels()` | Cache-bypassing discovery hook | Forces immediate live query to register newly released models. |
| `modelProfiles` | Pre-configured cost/tier lanes | Defines default assignments for standard profiles (`cheap: gemini-3-flash-agent`). |
| `getConfigSchema()` | Declarative configuration schema | Exposes structured `AdapterConfigSchema` fields (model, effort, mode, agent, jsonSchema, sandbox, timeoutSec). |
| `sessionCodec` | Session state serializer/deserializer | Serializes `sessionId`, `cwd`, `workspaceId`, `repoUrl`, `repoRef`, `promptBundleKey`, and `remoteExecution`. |
| `getQuotaWindows()` | Live quota & AI credits polling | Executes `agy -p "/usage" --output-format json` and returns `ProviderQuotaResult` windows. |
| `execute(ctx)` | Main agent heartbeat execution | Compiles prompt, workspace bindings, model, effort, session recovery, and structured error taxonomy. |
| `testEnvironment(ctx)` | Diagnostic self-test probe | Validates command path, permissions, model flags, API/ADC keys, optional plugins, and `stream-json` hello probe. |
| `listSkills(ctx)` | Skill discovery hook | Lists available and linked Paperclip skills in `~/.gemini/skills`. |
| `syncSkills(ctx, skills)` | Skill synchronization hook | Creates/prunes persistent symlinks to Paperclip company catalog skills. |
| `supportsInstructionsBundle` | Managed instructions capability flag | Enables Paperclip instructions bundle generation and Web UI editor. |
| `requiresMaterializedRuntimeSkills` | Skill materialization flag | Instructs Paperclip to synchronize skills on disk prior to run. |
| `supportsLocalAgentJwt` | Local Agent JWT capability flag | Enables Paperclip Server to mint and inject signed `PAPERCLIP_API_KEY` JWT tokens for REST API access. |

### Canonical Prompt Handling Pipeline (v2.x)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Canonical Paperclip Prompt Pipeline                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Runtime Skills Note: Materialized skill root + selected skills directive │
│ 2. Instructions Bundle: Read config.instructionsFilePath + path directive   │
│ 3. Bootstrap Prompt:    renderTemplate(bootstrapPromptTemplate) [cold only] │
│ 4. Wake Prompt:         renderPaperclipWakePrompt(paperclipWake, {resumed}) │
│ 5. Session Handoff:     context.paperclipSessionHandoffMarkdown             │
│ 6. Runtime Env Note:    PAPERCLIP_* env keys summary + API curl guide       │
│ 7. Heartbeat Prompt:    renderTemplate(promptTemplate) [skipped on delta]   │
│ 8. Assembly:            joinPromptSections([...])                           │
│ 9. Telemetry:           Granular promptMetrics (incl. skillsChars) in onMeta│
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **Runtime Skills Integration**: Selected Paperclip catalog skills are materialized as symlinks into `~/.gemini/skills` and mounted to `agy` via `--add-dir`. An explicit root directive pointer (`Paperclip has materialized selected runtime skills...`) is injected at the very head of the prompt.
2. **Instructions Bundle Loading**: Asynchronously loads markdown system instructions from `config.instructionsFilePath` and appends relative path directives (`Resolve any relative file references from <dir>/`).
3. **Cold Start vs. Resumed Session**: Renders `bootstrapPromptTemplate` only on initial turns (`!sessionId`). On resumed sessions, delivers event-driven `renderPaperclipWakePrompt` delta prompts and suppresses redundant heartbeat instructions.
4. **Runtime & API Notes**: Formats active `PAPERCLIP_*` environment keys and Paperclip REST API curl guides.
5. **Assembly**: Combines sections using `@paperclipai/adapter-utils` `joinPromptSections` and calculates granular `promptMetrics` (`promptChars`, `instructionsChars`, `skillsChars`, `bootstrapPromptChars`, `wakePromptChars`, `sessionHandoffChars`, `runtimeNoteChars`, `heartbeatPromptChars`).

---

## 3. Model & Reasoning Effort Resolution Rationale

### The Model Taxonomy Problem
Modern AI CLI engines expose model choices through varying paradigms across different providers and releases:

1. **Flat Composite Model IDs**: Identifiers that embed the reasoning effort directly into the model slug (e.g. `<model-family>-<tier>-<effort-level>`).
   - *Risk*: Passing an explicit `--effort` flag alongside a flat composite ID often causes CLI argument validation failures (e.g., `--model ... conflicts with --effort=...`).
2. **Parameterized Models**: Base model slugs (e.g. `<model-family>-<tier>`) that accept or require decoupled effort flags (e.g. `--effort low|medium|high`).
3. **Fixed-Thinking Models**: Models with inherent thinking capabilities that do not accept external effort tuning flags.
4. **Auto-Routed Defaults**: Special identifiers (e.g. `auto`) where the engine determines the optimal underlying model, optionally accepting an effort bias.

### The Canonical Resolution Pipeline (`resolveAgyModelAndEffort`)
To ensure compatibility across all model types without brittle hardcoding, the resolution function follows a structured pipeline:

```
[Raw Model String] + [Raw Effort Input]
                   │
                   ▼
       Is model empty or "auto"?
        ├─► YES: Return { effort?: userEffort } (preserves engine auto-routing)
        └─► NO
                   │
                   ▼
     Does model have inherent reasoning (e.g. Claude family)?
        ├─► YES: Return exact model identifier without `--effort`
        └─► NO
                   │
                   ▼
     Is it a flat composite model (contains effort suffix like `-high`, `-low`)?
        ├─► YES:
        │     ├─► User provided conflicting effort override?
        │     │     └─► Adapt composite suffix to match override
        │     └─► No override?
        │           └─► Return composite model directly (no `--effort` flag)
        └─► NO
                   │
                   ▼
     Is it a base parameterized model?
        ├─► YES: Return base model with user effort or tier default effort
        └─► NO: Custom fallback passthrough with optional effort
```

### Backward Compatibility Guarantees
- **Legacy Aliases**: Historical model IDs (e.g. prior version naming conventions or shorthand names like `sonnet`, `smart`, `cheap`) must resolve gracefully to valid current targets.
- **Custom Passthrough**: If an operator inputs an experimental or unlisted model ID, the adapter passes it through directly without throwing errors.

---

## 4. Dynamic Discovery & Caching Architecture

### Why Dynamic Discovery is Essential
Static model lists quickly become outdated as model providers release new architectures or reasoning tiers. The dynamic discovery mechanism allows the Paperclip UI to display the latest models without requiring immediate adapter code redeployment.

### Discovery Implementation Pattern (`src/server/models.ts`)
1. **Output Parsing (`parseAgyModelsOutput`)**:
   - Parses line-oriented output from `agy models` (`<id>\t<label>` or `<id>\s{2,}<label>`).
   - Strips loading headers (`Fetching available models...`), usage hints, and blank lines.
   - Guarantees the baseline `auto` entry is positioned first.
2. **TTL In-Memory Cache**:
   - Caches discovered models for a bounded duration (`AGY_MODELS_CACHE_TTL_MS = 60s`).
   - Bypassed when `forceRefresh: true` is requested via `refreshModels()`.
3. **Graceful Fallback**:
   - If the CLI binary is not present, times out, or fails due to sandbox network isolation, the adapter falls back cleanly to the bundled `STATIC_MODELS` array without raising uncaught exceptions.
4. **Environment Path Hydration (`ensurePathInEnv`)**:
   - Always hydrides the child process `PATH` with standard locations (`~/.local/bin`, `~/.gemini/antigravity/bin`, `/usr/local/bin`) to ensure CLI resolution succeeds in non-login subprocess shells.

---

## 5. Cross-Environment Development & Testing Workflow

Development often occurs across heterogeneous environments:
- **Local Dev Workstation (e.g. macOS)**: Used for code editing, architecture study, and fast unit test execution.
- **Remote Host / Runtime Container (e.g. Linux `oci-sig-1`)**: Houses the native CLI binary (`agy`), active dependencies, Node.js toolchains, and live test credentials.

### Testing Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                        Unit Tests                           │
│  - Run hermetically using mocked process executors          │
│  - Sub-second execution time (<200ms)                       │
│  - Test parsing, deduplication, resolution edge cases       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Integration Tests                        │
│  - Verify command-line argument compilation                 │
│  - Verify environment variable propagation (ANTIGRAVITY_*)  │
│  - Verify session persistence & stream JSON parsing         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Live Remote Verification (Target Host)         │
│  - Full build: `npm run build`                              │
│  - Vitest suite: `npm test`                                 │
│  - Live CLI invocation tests on target environment          │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. Step-by-Step Model Update Checklist

When updating or adding model support to this adapter in the future, follow this streamlined checklist:

1. **Query Remote / Live Model List**:
   ```bash
   ssh <target-host> 'agy models'
   ```
2. **Create a Dedicated Branch**:
   ```bash
   git checkout -b feat/update-model-list
   ```
3. **Update Static Definitions (`src/index.ts`)**:
   - Update `models` array with the newly discovered models.
   - Update `modelProfiles` (e.g. `cheap`) if default tier recommendations change.
4. **Update Resolution Logic (`src/server/execute.ts`)**:
   - Add resolution rules for any newly introduced model families or tier naming schemes.
   - Ensure reasoning effort override adaptation handles new composite model suffixes.
5. **Update Unit & Integration Tests**:
   - Add test fixtures for new models in `tests/unit/models.test.ts`.
   - Verify CLI flag assertions in `tests/integration/execute.test.ts`.
6. **Build and Test on Remote Environment**:
   ```bash
   ssh <target-host> 'cd <repo-path> && git checkout <branch> && npm run build && npm test'
   ```
7. **Document & Push**:
   - Update `README.md` supported models table.
   - Push branch to remote repository tracking.
