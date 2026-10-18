# @weslleycapelari/adapter-antigravity-local

[![npm version](https://img.shields.io/npm/v/@weslleycapelari/adapter-antigravity-local.svg?style=flat-square)](https://www.npmjs.com/package/@weslleycapelari/adapter-antigravity-local)
[![Build & Test Status](https://img.shields.io/github/actions/workflow/status/weslleycapelari/adapter-antigravity-local/publish.yml?style=flat-square)](https://github.com/weslleycapelari/adapter-antigravity-local/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Tests Passed](https://img.shields.io/badge/Tests--Passed-135%20/%20135-brightgreen?style=flat-square)](tests)

An official-grade, high-performance **Paperclip AI** adapter designed for running **Google Antigravity** (`agy` CLI `v1.3.6+`) agents locally and on remote execution targets, with full lifecycle and telemetry parity with `@paperclipai/adapter-claude-local`.

This adapter acts as a drop-in, robust, and type-safe replacement for the deprecated Gemini CLI integrations. It allows Paperclip agents to execute prompts through the modern Google Antigravity engine while supporting workspace synchronization, dynamic model and quota discovery, session recovery, GCP Application Default Credentials (`AGY_ADC_AUTH`), and sandboxed execution.

---

## ⚡ Key Features

- **🚀 Native Go CLI Performance (`agy` v1.3.6)**: Spawns the `agy` binary with fast startup times, automatic `~/.local/bin` PATH resolution, and real-time `stream-json` event streaming.
- **📡 Dual-Channel Live Streaming Telemetry (`ctx.onEvent` + `ui-parser.ts`)**: Bridges real-time `agy` `stream-json` NDJSON events (`init`, `tool_call`, `step.completed`/`step.failed`, `thinking_delta`, `text_delta`, `step_update`, `result`) into both Paperclip's server-side `HeartbeatRunRuntimeStatus` (`1500ms` delta throttling, immediate tool state transitions) and the browser WebWorker transcript parser with stateful cumulative-text deduplication. See **[Design Specification: Live Interaction & Streaming](./docs/design-spec-live-interaction-and-streaming.md)**.
- **📊 Live Model & Quota Discovery**: Queries `agy models --output-format json` (with text fallback) for dynamic model discovery and `agy -p "/usage" --output-format json` via `getQuotaWindows()` for per-model quota & AI credit tracking.
- **🔄 Resilient Session Lifecycle (`sessionCodec`)**: Tracks `cwd`, `promptBundleKey` (SHA-256 fingerprint to skip redundant instructions/skills injection on resumed turns), and `remoteExecution` identity, with automatic fresh-session retry if a conversation is missing or contains corrupted media (`v1.3.4+`).
- **📂 Multi-Workspace Sync**: Automatically registers and mounts multiple active Paperclip workspaces into `agy` using repeatable `--add-dir <cwd>` arguments.
- **⚙️ Headless & Custom Agent Controls**: Supports `--dangerously-skip-permissions`, `--mode` (`agent`/`plan`/`ask`), `--agent <name>` (`v1.3.6`), `--json-schema` (`v1.3.4`), and headless VCS/editor environment defaults (`NO_BROWSER=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=false`, `PAGER=cat`).
- **🔐 Multi-Mode Authentication**: Supports Google OAuth subscription login (`agy auth login`), API keys (`ANTIGRAVITY_API_KEY`, `GEMINI_API_KEY`), Google Cloud Application Default Credentials (`AGY_ADC_AUTH=1`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT` in `v1.3.5+`), and protected Paperclip Local Agent JWTs (`supportsLocalAgentJwt`).
- **🧠 Paperclip Skills Materialization**: Automatically materializes configured company catalog skills into `~/.gemini/skills`, passes them via `--add-dir`, and injects canonical runtime skills directives into the prompt.
- **🛠️ Self-Testing Diagnostics**: Bundles the `testEnvironment` probe checking command availability, workspace permissions, API/ADC credentials, optional plugin inventory (`agy plugin list --json`), and live API reachability via a `stream-json` hello probe.
- **🛡️ Structured Error Taxonomy**: Distinguishes `antigravity_auth_required` (with `loginUrl` metadata), `provider_quota`, `antigravity_transient_upstream` (with `retryNotBefore` timestamps), `model_not_found`, `max_turns_exhausted`, `antigravity_refusal`, and `timeout`.

---

## 🤖 Supported Models

Models are passed directly to the `agy` CLI via `--model` and optionally `--effort`. The adapter also supports dynamic model discovery via `agy models --output-format json` with automatic TTL caching and fallback.

| Model Family | Model Identifiers | Label / Description |
|---|---|---|
| **Auto** | `auto` | Global default routed automatically by Antigravity |
| **Gemini 3.1 Pro** | `gemini-3.1-pro-high`, `gemini-3.1-pro-low` | Gemini 3.1 Pro with High / Low reasoning effort (`agy v1.3.6`) |
| **Gemini 3 Flash** | `gemini-3-flash-agent` *(alias: `gemini-3-flash`, `cheap`)* | Gemini 3 Flash optimized for fast agentic execution (`agy v1.3.6` default cheap profile) |
| **Claude Sonnet 4.6** | `claude-sonnet-4-6` *(alias: `claude-sonnet-4.6-thinking`)* | Claude Sonnet 4.6 (Thinking) (`agy v1.3.6`) |
| **Claude Opus 4.6** | `claude-opus-4-6-thinking` *(alias: `claude-opus-4.6`)* | Claude Opus 4.6 (Thinking) (`agy v1.3.6`) |
| **GPT-OSS 120B** | `gpt-oss-120b-medium` *(alias: `gpt-oss-120b`)* | GPT-OSS 120B (Medium) (`agy v1.3.6`) |
| **Gemini 3.8 / 3.7 / 3.6 Flash** | `gemini-3.8-flash-high/medium/low`, `gemini-3.7-flash-*`, `gemini-3.6-flash-*` | Extended Gemini Flash flat composite tiers |
| **Claude 5.5 (Preview)** | `claude-opus-5-5-high/medium/low`, `claude-sonnet-5-5-high/medium/low` | Extended Claude 5.5 flat composite tiers |

> *Note: Model availability depends on your local Antigravity installation (`agy 1.3.6+`) and dynamic `agy models --output-format json` discovery.*

---

## 📦 Quick Installation

Install the adapter globally or within your Paperclip workspace scope via NPM:

```bash
npm install @weslleycapelari/adapter-antigravity-local

```

For complete installation and configuration instructions, please refer to the full setup guide:
👉 **[SETUP.md](./SETUP.md)**

---

## 🔌 Linking in the Paperclip Web UI

1. Open your **Paperclip Web Console**.
2. Navigate to **Settings** ➔ **Adapters** ➔ **Install Custom Adapter**.
3. Choose the **Local Path** method.
4. Select the absolute path to this project's root folder:
`/home/<user>/projects/adapter-antigravity-local`
5. Click **Install**. The adapter will automatically load the compiled JavaScript bundle from `./dist/index.js`.

### Configuration Schema

When configuring a Paperclip Agent, define the following variables in the settings panel:

| Option Key | Type | Description | Default |
| --- | --- | --- | --- |
| `command` | `string` | Binary command executable path or system command name. | `"agy"` |
| `model` | `string` | Target model profile or custom model name. | `"auto"` |
| `thinkingEffort` | `string` | Reasoning effort (`""`, `"low"`, `"medium"`, `"high"`, `"max"`). | `""` |
| `mode` | `string` | Execution mode (`""`, `"agent"`, `"plan"`, `"ask"`). | `""` |
| `agent` | `string` | Custom subagent profile (`--agent <name>`, `agy v1.3.6+`). | `""` |
| `jsonSchema` | `string` | JSON Schema string for structured output validation (`--json-schema`, `agy v1.3.4+`). | `""` |
| `instructionsFilePath` | `string` | Absolute path to markdown instructions file prepended to prompt. | `""` |
| `promptTemplate` | `string` | Standard run prompt execution template with dynamic variable substitution. | `""` |
| `bootstrapPromptTemplate` | `string` | Cold-start initial prompt template used only without existing session. | `""` |
| `dangerouslySkipPermissions` | `boolean` | Pass `--dangerously-skip-permissions` for headless runs. | `true` |
| `sandbox` | `boolean` | Enforces strict OS/Terminal sandbox jail isolation (`--sandbox`). | `false` |
| `cwd` | `string` | Absolute working directory context path fallback. | `process.cwd()` |
| `timeoutSec` | `number` | Inactivity/run timeout duration in seconds (`--print-timeout`). | `0` (Disabled) |
| `extraArgs` | `string` | Comma-separated list of custom CLI parameters. | `""` |
| `envVars` | `string` | Multi-line `KEY=VALUE` environment variables (e.g. `AGY_ADC_AUTH=1`). | `""` |
| `envBindings` | `object` | Structured credentials mappings and secrets references. | `{}` |

---

## 🛠️ Development

For in-depth architectural design, model lifecycle rules, and dynamic discovery guidelines, see the **[Developer Guide](./DEVELOPER_GUIDE.md)**.

To work on modifications, clone the repository and build the distribution assets:

```bash
# Clone and enter the repository
git clone https://github.com/weslleycapelari/adapter-antigravity-local.git
cd adapter-antigravity-local

# Install developer dependencies
npm install

# Compile TypeScript production files
npm run build

# Validate types
npm run typecheck

```

---

## 🧪 Architecture Quality & Testing (TDD)

We maintain a senior-grade quality gate enforced by **126 unit & integration tests** across 14 test suites running on **Vitest**. The test suite is isolated from production compilation bundles.

Execute the Test Suite:

```bash
npm test

```

*Runs 126 tests across model resolution engines, dynamic CLI capability & quota parsers, CLI color event formatters, UI config builders, session serializers, skills symlink managers, execution recovery flows, and environment probes.*

---

## 🚀 DevOps & CI/CD Pipeline

We bundle a production-ready GitHub Action (`publish.yml`) that automates releases.

Whenever you push a version tag starting with `v` (e.g., `v1.0.0`), the pipeline will automatically:

1. Setup Node 20 and install clean dependencies (`npm ci`).
2. Run strict compiler typechecks (`npm run typecheck`).
3. Run all **62 quality tests**. *Any failure aborts publication.*
4. Compile production assets.
5. Publish to the public npm registry.
6. Create a formal **GitHub Release** with automated notes.

> **Note:** Configure a secret named `NPM_TOKEN` in your GitHub Repository settings with an npm Access Token to allow automated publishing.

---

## 📖 Documentation

* **[SETUP.md](./SETUP.md)** — Detailed installation, configuration guide, and troubleshooting.

---

## 🙌 Acknowledgements

Special thanks to **Ryan Lee** for testing the Paperclip integration, documenting the installation process, and providing vital feedback on adapter registration and model configuration.

---

## 👥 Authors & Maintainers

* Designed, built, and maintained by **Weslley Capelari**.
* Open-source repository: [GitHub: weslleycapelari/adapter-antigravity-local](https://github.com/weslleycapelari/adapter-antigravity-local).

License: **[MIT](LICENSE)** — Feel free to use, modify, and distribute.
