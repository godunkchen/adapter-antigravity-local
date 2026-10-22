import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { createStdoutParser, parseStdoutLine } from "../../src/ui-parser.js";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * Exact replica of Paperclip's `appendTranscriptEntry` and `buildTranscript`
 * from `/Users/dunk/Documents/paperclip/ui/src/adapters/transcript.ts`.
 */
type RunLogChunk = { ts: string; stream: "stdout" | "stderr" | "system"; chunk: string; seq?: number };

function appendTranscriptEntry(entries: TranscriptEntry[], entry: TranscriptEntry) {
  if ((entry.kind === "thinking" || entry.kind === "assistant") && entry.delta) {
    const last = entries[entries.length - 1];
    if (
      last &&
      last.kind === entry.kind &&
      last.delta &&
      last.channel === entry.channel
    ) {
      last.text += entry.text;
      last.ts = entry.ts;
      return;
    }
  }
  entries.push(entry);
}

function buildPaperclipTranscript(
  chunks: RunLogChunk[],
  parseLine: (line: string, ts: string) => TranscriptEntry[],
  reset?: (() => void) | null,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let stdoutBuffer = "";

  for (const chunk of chunks) {
    if (chunk.stream === "stderr") {
      entries.push({ kind: "stderr", ts: chunk.ts, text: chunk.chunk });
      continue;
    }
    if (chunk.stream === "system") {
      entries.push({ kind: "system", ts: chunk.ts, text: chunk.chunk });
      continue;
    }

    const combined = stdoutBuffer + chunk.chunk;
    const lines = combined.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      for (const entry of parseLine(trimmed, chunk.ts)) {
        appendTranscriptEntry(entries, entry);
      }
    }
  }

  const trailing = stdoutBuffer.trim();
  if (trailing) {
    const ts = chunks.length > 0 ? chunks[chunks.length - 1]!.ts : new Date().toISOString();
    for (const entry of parseLine(trailing, ts)) {
      appendTranscriptEntry(entries, entry);
    }
  }

  reset?.();
  return entries;
}

describe("Paperclip UI Compatibility (RunTranscriptView & TaskChatThread)", () => {
  it("loads dist/ui-parser.cjs and dist/ui-parser.js in both CommonJS require and Web Worker sandboxed eval", () => {
    for (const relPath of ["dist/ui-parser.js", "dist/ui-parser.cjs"]) {
      const fullPath = path.resolve(process.cwd(), relPath);
      const source = fs.readFileSync(fullPath, "utf-8");

      const exportsObj: Record<string, unknown> = {};
      const moduleObj = { exports: exportsObj };

      const factory = new Function(
        "exports",
        "module",
        "self",
        "globalThis",
        '"use strict";\n{\n' + source + "\n}",
      );

      factory(exportsObj, moduleObj, undefined, undefined);

      const resolved = (
        moduleObj.exports &&
        typeof moduleObj.exports === "object" &&
        Object.keys(moduleObj.exports).length > 0
          ? moduleObj.exports
          : exportsObj
      ) as Record<string, any>;

      expect(typeof resolved.parseStdoutLine).toBe("function");
      expect(typeof resolved.createStdoutParser).toBe("function");
    }
  });

  it("validates plugin-loader resolution from both repo root and dist/ directory", async () => {
    for (const dir of [process.cwd(), path.join(process.cwd(), "dist")]) {
      const pkgJsonPath = path.join(dir, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

      expect(pkg.paperclip?.adapterUiParser).toBe("1.0.0");

      const exp = pkg.exports["."];
      const entryPoint = typeof exp === "string" ? exp : (exp.import ?? exp.default ?? "index.js");
      const modulePath = path.resolve(dir, entryPoint);
      expect(fs.existsSync(modulePath)).toBe(true);

      const uiParserExp = pkg.exports["./ui-parser"];
      const uiParserFile = typeof uiParserExp === "string" ? uiParserExp : (uiParserExp.import ?? uiParserExp.default);
      const uiParserPath = path.resolve(dir, uiParserFile);
      expect(fs.existsSync(uiParserPath)).toBe(true);

      const mod = await import(pathToFileURL(modulePath).href);
      expect(typeof mod.createServerAdapter).toBe("function");
      const adapter = mod.createServerAdapter();
      expect(adapter.type).toBe("antigravity_local");
    }
  });

  it("coallesces streaming thinking_delta, tool calls, and text_delta across live chunks like claude-local", () => {
    const parser = createStdoutParser();
    const chunks: RunLogChunk[] = [
      {
        ts: "2026-10-22T10:00:00Z",
        stream: "stdout",
        chunk: '[antigravity] Executing agy CLI (model: "gemini-3.8-flash-low", session: new)\n',
      },
      {
        ts: "2026-10-22T10:00:01Z",
        stream: "stdout",
        chunk:
          JSON.stringify({
            event: "init",
            conversation_id: "conv-live-1",
            init: { model: "gemini-3.8-flash-low", cwd: "/workspace" },
          }) + "\n",
      },
      {
        ts: "2026-10-22T10:00:02Z",
        stream: "stdout",
        chunk:
          JSON.stringify({
            event: "step_update",
            step_update: { step_index: 1, step_type: "thinking", thinking_delta: "Let me inspect " },
          }) +
          "\n" +
          JSON.stringify({
            event: "step_update",
            step_update: { step_index: 1, step_type: "thinking", thinking_delta: "the workspace files." },
          }) +
          "\n",
      },
      {
        ts: "2026-10-22T10:00:03Z",
        stream: "stdout",
        chunk:
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 2,
              step_type: "tool",
              state: "ACTIVE",
              tool_name: "run_command",
              tool_info: { name: "run_command", parameters: { CommandLine: "ls -la" } },
            },
          }) + "\n",
      },
      {
        ts: "2026-10-22T10:00:04Z",
        stream: "stdout",
        chunk:
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 2,
              step_type: "tool",
              state: "DONE",
              tool_name: "run_command",
              tool_info: { name: "run_command", output: "README.md\nsrc\npackage.json" },
            },
          }) + "\n",
      },
      {
        ts: "2026-10-22T10:00:05Z",
        stream: "stdout",
        chunk:
          JSON.stringify({
            event: "step_update",
            step_update: { step_index: 3, step_type: "agent_response", text_delta: "Found 3 items " },
          }) +
          "\n" +
          JSON.stringify({
            event: "step_update",
            step_update: { step_index: 3, step_type: "agent_response", text_delta: "in the workspace." },
          }) +
          "\n" +
          JSON.stringify({
            event: "step_update",
            step_update: { step_index: 3, step_type: "agent_response", state: "DONE", text: "Found 3 items in the workspace." },
          }) +
          "\n",
      },
      {
        ts: "2026-10-22T10:00:06Z",
        stream: "stdout",
        chunk:
          JSON.stringify({
            event: "result",
            result: {
              status: "SUCCESS",
              response: "Found 3 items in the workspace.",
              usage: { input_tokens: 150, output_tokens: 30, cache_read_tokens: 20 },
              cost_usd: 0.001,
            },
          }) + "\n",
      },
    ];

    const entries = buildPaperclipTranscript(chunks, parser.parseLine, parser.reset);

    expect(entries).toEqual([
      {
        kind: "system",
        ts: "2026-10-22T10:00:00Z",
        text: '[antigravity] Executing agy CLI (model: "gemini-3.8-flash-low", session: new)',
      },
      {
        kind: "init",
        ts: "2026-10-22T10:00:01Z",
        model: "gemini-3.8-flash-low",
        sessionId: "conv-live-1",
      },
      {
        kind: "thinking",
        ts: "2026-10-22T10:00:02Z",
        text: "Let me inspect the workspace files.",
        delta: true,
      },
      {
        kind: "tool_call",
        ts: "2026-10-22T10:00:03Z",
        name: "run_command",
        toolUseId: "agy-tool-2-run_command",
        input: { CommandLine: "ls -la", command: "ls -la" },
      },
      {
        kind: "tool_result",
        ts: "2026-10-22T10:00:04Z",
        toolUseId: "agy-tool-2-run_command",
        toolName: "run_command",
        content: "README.md\nsrc\npackage.json",
        isError: false,
      },
      {
        kind: "assistant",
        ts: "2026-10-22T10:00:05Z",
        text: "Found 3 items in the workspace.",
        delta: true,
      },
      {
        kind: "result",
        ts: "2026-10-22T10:00:06Z",
        text: "Completed",
        inputTokens: 150,
        outputTokens: 30,
        cachedTokens: 20,
        costUsd: 0.001,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("supports multiple sequential turns in the shared singleton Web Worker parseStdoutLine without dropping repeated step indices", () => {
    const activeToolLine = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        step_type: "tool",
        state: "ACTIVE",
        tool_name: "view_file",
        tool_info: { name: "view_file", parameters: { AbsolutePath: "/workspace/README.md" } },
      },
    });
    const doneToolLine = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        step_type: "tool",
        state: "DONE",
        tool_name: "view_file",
        tool_info: { name: "view_file", output: "# Readme" },
      },
    });

    // Turn 1
    const turn1Call = parseStdoutLine(activeToolLine, "2026-10-22T10:00:01Z");
    const turn1Result = parseStdoutLine(doneToolLine, "2026-10-22T10:00:02Z");
    expect(turn1Call).toHaveLength(1);
    expect(turn1Call[0]?.kind).toBe("tool_call");
    expect(turn1Result).toHaveLength(1);
    expect(turn1Result[0]?.kind).toBe("tool_result");

    // Turn 2 (even without an init event in between, e.g. partial log window)
    const turn2Call = parseStdoutLine(activeToolLine, "2026-10-22T10:01:01Z");
    const turn2Result = parseStdoutLine(doneToolLine, "2026-10-22T10:01:02Z");
    expect(turn2Call).toHaveLength(1);
    expect(turn2Call[0]?.kind).toBe("tool_call");
    expect(turn2Result).toHaveLength(1);
    expect(turn2Result[0]?.kind).toBe("tool_result");
  });
});
