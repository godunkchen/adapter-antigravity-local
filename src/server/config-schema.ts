/**
 * @fileoverview Declarative configuration schema for `antigravity_local` adapter.
 * Enables Paperclip's Web UI to render Antigravity-specific controls (such as `--mode auto`
 * from agy v1.3.5/v1.3.6, `--agent` from agy v1.3.4, reasoning effort, and JSON schema).
 *
 * @copyright Antigravity Adapter Contributors
 * @license MIT
 */

import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

/**
 * Returns the declarative configuration schema for the Antigravity local adapter.
 */
export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "mode",
        label: "Execution mode",
        type: "select",
        default: "",
        options: [
          { value: "", label: "Default (Headless auto-approve)" },
          { value: "auto", label: "Auto (Workspace command safety inspection)" },
          { value: "accept-edits", label: "Accept edits" },
          { value: "plan", label: "Plan only" },
        ],
        hint: "Sets `--mode` on the Antigravity CLI (v1.3.5+ `auto` inspects workspace command safety; default headless runs use `--dangerously-skip-permissions`).",
      },
      {
        key: "agent",
        label: "Custom agent",
        type: "text",
        hint: "Optional agent or subagent identifier passed to `--agent <name>` (requires `agy` v1.3.4+).",
      },
      {
        key: "effort",
        label: "Reasoning effort",
        type: "select",
        default: "",
        options: [
          { value: "", label: "Model default" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra High (xhigh)" },
          { value: "max", label: "Maximum (max)" },
        ],
        hint: "Optional `--effort` override for models that support configurable reasoning depth.",
      },
      {
        key: "jsonSchema",
        label: "Output JSON schema",
        type: "text",
        hint: "Optional JSON schema string or file path passed to `--json-schema` to enforce structured final output.",
      },
    ],
  };
}
