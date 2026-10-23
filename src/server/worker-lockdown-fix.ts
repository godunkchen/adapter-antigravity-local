/**
 * @fileoverview Workaround for Paperclip upstream issues #16143 / #12223 / PR #8806:
 * "External adapter UI parsers never load: sandbox worker throws on `self.caches = undefined`"
 *
 * In Paperclip's `ui/src/adapters/sandboxed-parser-worker.ts` (and compiled `ui-dist/assets/index-*.js`),
 * `WORKER_BOOTSTRAP` runs under `"use strict";` and performs bare assignments to getter-only
 * `WorkerGlobalScope` properties (`self.caches = _undefined;`, `self.indexedDB = _undefined;`).
 * In modern browsers (Chrome 151+, Firefox 157+, Edge), this throws a `TypeError` before
 * `self.onmessage` is registered, causing all external adapter UI parsers to fail and fall back
 * to raw stdout in the Run Transcript view.
 *
 * This module automatically locates the running Paperclip host's `sandboxed-parser-worker.ts`
 * and/or compiled `ui-dist/assets/index-*.js` bundles when `createServerAdapter()` is loaded
 * (at server startup or via `POST /api/adapters/antigravity_local/reload`) and wraps bare
 * `self.<prop> = _undefined;` assignments in `try { self.<prop> = _undefined; } catch {}`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UNSAFE_WORKER_ASSIGNMENT_RE = /(?<!try\s*\{\s*)self\.(\w+)\s*=\s*_undefined\s*;/g;

/**
 * Patches a single JS/TS source string by wrapping bare `self.<prop> = _undefined;`
 * statements in `try { self.<prop> = _undefined; } catch {}`.
 * Idempotent: already-wrapped statements are untouched.
 */
export function patchWorkerLockdownSource(source: string): { content: string; patchedCount: number } {
  if (!source.includes("self.caches") && !source.includes("self.indexedDB")) {
    return { content: source, patchedCount: 0 };
  }

  let patchedCount = 0;
  const content = source.replace(UNSAFE_WORKER_ASSIGNMENT_RE, (_match, propName: string) => {
    patchedCount += 1;
    return `try { self.${propName} = _undefined; } catch {}`;
  });

  return { content, patchedCount };
}

/**
 * Patches a file on disk if it contains bare `self.caches = _undefined` or `self.indexedDB = _undefined`
 * assignments inside `WORKER_BOOTSTRAP`.
 */
export function patchWorkerLockdownFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const raw = fs.readFileSync(filePath, "utf8");
    const { content, patchedCount } = patchWorkerLockdownSource(raw);
    if (patchedCount === 0 || content === raw) return false;
    fs.writeFileSync(filePath, content, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Discovers candidate Paperclip UI roots from the current process (`process.cwd()`, `process.argv`,
 * `PAPERCLIP_ROOT`, standard `~/paperclip` checkouts, and `~/.npm/_npx` caches) and applies
 * the idempotent Web Worker lockdown fix.
 */
export function ensurePaperclipWorkerLockdownPatched(customRoots?: string[]): string[] {
  const patchedFiles: string[] = [];
  const candidateRoots = new Set<string>();

  if (Array.isArray(customRoots)) {
    for (const r of customRoots) {
      if (r) candidateRoots.add(path.resolve(r));
    }
  }

  try {
    candidateRoots.add(process.cwd());
  } catch {
    // ignore
  }

  if (process.env.PAPERCLIP_ROOT) {
    candidateRoots.add(path.resolve(process.env.PAPERCLIP_ROOT));
  }

  for (const arg of process.argv) {
    if (!arg || arg.startsWith("-")) continue;
    try {
      const resolved = path.resolve(arg);
      // Walk up a few parent directories to find the Paperclip root or @paperclipai/server package
      let curr = resolved;
      for (let i = 0; i < 6; i++) {
        candidateRoots.add(curr);
        const parent = path.dirname(curr);
        if (parent === curr) break;
        curr = parent;
      }
    } catch {
      // ignore
    }
  }

  try {
    const home = os.homedir();
    candidateRoots.add(path.join(home, "paperclip"));
    candidateRoots.add(path.join(home, "Documents", "paperclip"));

    // Check npx cache directories if present
    const npxCacheDirs = [
      path.join(home, ".npm", "_npx"),
      path.join(home, "AppData", "Local", "npm-cache", "_npx"),
    ];
    for (const npxDir of npxCacheDirs) {
      if (fs.existsSync(npxDir)) {
        try {
          for (const entry of fs.readdirSync(npxDir)) {
            candidateRoots.add(path.join(npxDir, entry, "node_modules", "@paperclipai", "server"));
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  for (const root of candidateRoots) {
    // 1. Source checkout: ui/src/adapters/sandboxed-parser-worker.ts
    const sourceWorkerPath = path.join(root, "ui", "src", "adapters", "sandboxed-parser-worker.ts");
    if (patchWorkerLockdownFile(sourceWorkerPath)) {
      patchedFiles.push(sourceWorkerPath);
    }

    // 2. Pre-built UI asset directories
    const assetDirs = [
      path.join(root, "ui", "dist", "assets"),
      path.join(root, "server", "ui-dist", "assets"),
      path.join(root, "ui-dist", "assets"),
    ];
    for (const assetDir of assetDirs) {
      try {
        if (!fs.existsSync(assetDir)) continue;
        for (const file of fs.readdirSync(assetDir)) {
          if (/^index-.*\.js$/.test(file) || (file.includes("worker") && file.endsWith(".js"))) {
            const fullPath = path.join(assetDir, file);
            if (patchWorkerLockdownFile(fullPath)) {
              patchedFiles.push(fullPath);
            }
          }
        }
      } catch {
        // ignore permission or read errors
      }
    }
  }

  return patchedFiles;
}
