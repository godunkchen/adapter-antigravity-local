/**
 * @fileoverview Stdout stream line parser mapping CLI print messages into UI transcripts.
 * Analyzes logs and constructs typed conversational transcripts displayed to the user.
 * 
 * @copyright Antigravity Adapter Contributors
 * @license MIT
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import {
  createStdoutParser as createAntigravityStdoutParser,
  parseStdoutLine as parseAntigravityStdoutLine,
} from "./parser-core.js";

export { createAntigravityStdoutParser, parseAntigravityStdoutLine };
export type { TranscriptEntry };
