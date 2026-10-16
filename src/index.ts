import { type ServerAdapterModule } from "@paperclipai/adapter-utils";
import { execute, testEnvironment, listModels, refreshModels, getConfigSchema } from "./server/index.js";
import { listAntigravitySkills, syncAntigravitySkills } from "./server/skills.js";
import type { AntigravityModelDefinition, AntigravityModelProfileDefinition } from "./types.js";

export const type = "antigravity_local";
export const label = "Antigravity CLI (local)";

// O Antigravity usa scripts diretos de instalação (Go bin) em vez de NPM
export const SANDBOX_INSTALL_COMMAND = "curl -sSL https://antigravity.google/install.sh | bash";

export const DEFAULT_ANTIGRAVITY_LOCAL_MODEL = "auto";

export const models: AntigravityModelDefinition[] = [
  { id: DEFAULT_ANTIGRAVITY_LOCAL_MODEL, label: "Auto (Use global configured default)" },
  { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
  { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
  { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
  { id: "gemini-4-argon", label: "Gemini 4 Argon (Default effort)" },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (Default effort)" },
  { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
  { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
  { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
  { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
  { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
  { id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)" },
  { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (Default effort / ADC)" },
  { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
  { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium)" },
  { id: "claude-sonnet-5-5-low", label: "Claude Sonnet 5.5 (Low)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (Default effort / ADC)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
  { id: "gpt-oss-120b", label: "GPT-OSS 120B (Default effort)" },
];

export const modelProfiles: AntigravityModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Gemini 3.8 Flash (Low) for faster, cost-effective routing.",
    adapterConfig: {
      model: "gemini-3.8-flash-low",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# antigravity_local agent configuration

Adapter: antigravity_local

Use when:
- You want Paperclip to run the Antigravity CLI locally on the host machine
- You want to leverage native Go performance and improved startup times
- You want Paperclip skills injected locally via Antigravity plugin paths

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt
- promptTemplate (string, optional): run prompt template
- bootstrapPromptTemplate (string, optional): initial prompt template used only for cold start without an existing session
- model (string, optional): Antigravity model id. Defaults to auto.
- effort (string, optional): reasoning effort override (low | medium | high | xhigh | max)
- mode (string, optional): CLI execution mode (auto | accept-edits | plan)
- agent (string, optional): custom agent/subagent identifier (--agent)
- jsonSchema (string, optional): JSON schema string or file path for structured output (--json-schema)
- command (string, optional): defaults to "agy"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
- maxTurnsPerRun (number, optional): maximum turns per run

Notes:
- Runs use positional prompt arguments.
- Authentication utilizes the native OS keyring, ANTIGRAVITY_API_KEY, or GCP Application Default Credentials (AGY_ADC_AUTH).
- Supports local agent JWT minting; Paperclip Server automatically injects PAPERCLIP_API_KEY for agent API access.
`;

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    models,
    listModels,
    refreshModels,
    modelProfiles,
    getConfigSchema,
    listSkills: listAntigravitySkills,
    syncSkills: syncAntigravitySkills,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
    supportsLocalAgentJwt: true,
    agentConfigurationDoc,
  };
}