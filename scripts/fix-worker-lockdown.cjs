#!/usr/bin/env node
"use strict";

/**
 * Standalone & postinstall script to apply the Web Worker lockdown fix
 * (Paperclip issues #16143 / #12223 / PR #8806) to local Paperclip source
 * checkouts and pre-built UI bundles.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const UNSAFE_WORKER_ASSIGNMENT_RE = /(?<!try\s*\{\s*)self\.(\w+)\s*=\s*_undefined\s*;/g;

function patchWorkerLockdownSource(source) {
  if (!source.includes("self.caches") && !source.includes("self.indexedDB")) {
    return { content: source, patchedCount: 0 };
  }
  let patchedCount = 0;
  const content = source.replace(UNSAFE_WORKER_ASSIGNMENT_RE, (_match, propName) => {
    patchedCount += 1;
    return `try { self.${propName} = _undefined; } catch {}`;
  });
  return { content, patchedCount };
}

function patchWorkerLockdownFile(filePath) {
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

function run() {
  const candidateRoots = new Set();
  const cliArgs = process.argv.slice(2);
  for (const arg of cliArgs) {
    if (arg) candidateRoots.add(path.resolve(arg));
  }

  try {
    candidateRoots.add(process.cwd());
  } catch {}

  if (process.env.PAPERCLIP_ROOT) {
    candidateRoots.add(path.resolve(process.env.PAPERCLIP_ROOT));
  }

  try {
    const home = os.homedir();
    candidateRoots.add(path.join(home, "paperclip"));
    candidateRoots.add(path.join(home, "Documents", "paperclip"));

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
        } catch {}
      }
    }
  } catch {}

  const patched = [];
  for (const root of candidateRoots) {
    const sourceWorkerPath = path.join(root, "ui", "src", "adapters", "sandboxed-parser-worker.ts");
    if (patchWorkerLockdownFile(sourceWorkerPath)) {
      patched.push(sourceWorkerPath);
    }

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
              patched.push(fullPath);
            }
          }
        }
      } catch {}
    }
  }

  if (patched.length > 0) {
    console.log(`[antigravity] Patched Paperclip Web Worker lockdown in ${patched.length} file(s):`);
    for (const f of patched) {
      console.log(`  - ${f}`);
    }
  } else {
    console.log("[antigravity] Paperclip Web Worker lockdown already patched or no unpatched bundles found.");
  }
}

run();
