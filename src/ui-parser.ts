/**
 * @fileoverview Standalone UI stdout parser module for Antigravity local CLI execution.
 * Converts raw agy stream-json events into structured Paperclip TranscriptEntry objects.
 *
 * Rules:
 * 1. ZERO runtime external dependencies (loaded dynamically in browser sandbox).
 * 2. Error tolerant - never throws, falls back gracefully.
 * 3. Export createStdoutParser and parseStdoutLine.
 */

export type {
  TranscriptEntry,
  TranscriptInitEntry,
  TranscriptAssistantEntry,
  TranscriptThinkingEntry,
  TranscriptUserEntry,
  TranscriptToolCallEntry,
  TranscriptToolResultEntry,
  TranscriptResultEntry,
  TranscriptSystemEntry,
  TranscriptStderrEntry,
  TranscriptStdoutEntry,
} from "./ui/parser-core.js";

export {
  parseStdoutLine,
  createStdoutParser,
  formatToolOutput,
  normalizeToolInput,
  isLikelyJsonFragment,
} from "./ui/parser-core.js";
