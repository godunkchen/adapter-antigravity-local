import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

describe("sandboxed-parser-worker evaluation test", () => {
  it("evaluates compiled dist/ui-parser.js using new Function(...) CommonJS shim as done by Paperclip UI sandboxed-parser-worker.ts", () => {
    const uiParserPath = path.resolve(process.cwd(), "dist/ui-parser.js");
    const source = fs.readFileSync(uiParserPath, "utf-8");

    const exports: Record<string, unknown> = {};
    const module = { exports };

    // Paperclip's exact worker evaluation code:
    const factory = new Function(
      "exports", "module", "self", "globalThis",
      '"use strict";\n{\n' + source + "\n}"
    );

    factory(exports, module, undefined, undefined);

    const resolved = (module.exports && typeof module.exports === "object" && Object.keys(module.exports).length > 0
      ? module.exports
      : exports) as Record<string, any>;

    expect(typeof resolved.parseStdoutLine).toBe("function");

    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        step_type: "agent_response",
        text_delta: "Hello from dynamic parser",
      },
    });

    const entries = resolved.parseStdoutLine(line, "2026-08-20T00:00:00Z");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("assistant");
    expect(entries[0].text).toBe("Hello from dynamic parser");
  });
});
