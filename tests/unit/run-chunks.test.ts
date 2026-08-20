import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { createStdoutParser } from "../../src/ui-parser.js";

describe("run cb8af9ad log chunks evaluation", () => {
  it("parses actual NDJSON lines from run cb8af9ad", () => {
    const uiParserPath = path.resolve(process.cwd(), "dist/ui-parser.js");
    const source = fs.readFileSync(uiParserPath, "utf-8");

    const exports: Record<string, unknown> = {};
    const module = { exports };

    const factory = new Function(
      "exports", "module", "self", "globalThis",
      '"use strict";\n{\n' + source + "\n}"
    );

    factory(exports, module, undefined, undefined);

    const resolved = (module.exports && typeof module.exports === "object" && Object.keys(module.exports).length > 0
      ? module.exports
      : exports) as Record<string, any>;

    const testLines = [
      '{"event":"init","conversation_id":"7c24150d-0e36-422a-99da-2d836e5abb5e","init":{"model":"gemini-3.6-flash","cwd":"/home/ubuntu"}}',
      '{"event":"step_update","step_update":{"conversation_id":"7c24150d","step_index":2,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":15690,"output_tokens":240,"total_tokens":15930}}}',
      '{"event":"step_update","step_update":{"conversation_id":"7c24150d","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"pwd && ls -la"}}}}',
      '{"event":"step_update","step_update":{"conversation_id":"7c24150d","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.08,"tool_info":{"name":"run_command","parameters":{"CommandLine":"pwd && ls -la"},"output":"/home/ubuntu\\ntotal 464"}}}',
    ];

    for (const line of testLines) {
      const entries = resolved.parseStdoutLine(line, "2026-08-20T00:00:00Z");
      expect(entries.length).toBeGreaterThan(0);
    }
  });

  it("handles multi-line split JSON tool calls cleanly across line chunks", () => {
    const parser = createStdoutParser();

    const chunkPart1 = '{"event":"step_update","step_update":{"conversation_id":"db9a8914","step_index":93,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello';
    const chunkPart2 = '\\nworld"}}}}';

    const res1 = parser.parseLine(chunkPart1, "2026-08-20T00:00:00Z");
    expect(res1).toHaveLength(0); // Accumulated in buffer

    const res2 = parser.parseLine(chunkPart2, "2026-08-20T00:00:01Z");
    expect(res2).toHaveLength(1); // Full JSON payload completed and parsed!
    expect(res2[0]).toEqual({
      kind: "tool_call",
      ts: "2026-08-20T00:00:01Z",
      name: "run_command",
      input: {
        CommandLine: "echo hello\n\nworld",
      },
      toolUseId: "agy-tool-93-run_command",
    });
  });
});

