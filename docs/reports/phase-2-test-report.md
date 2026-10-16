# Phase 2 Validation & Test Report: Session Codec, Live Quota Windows (`getQuotaWindows`) & Error Taxonomy

- **Branch**: `feat/agy-1.3.6-phase2-parser-session`
- **Date**: 2026-10-16
- **Target CLI Version**: Google Antigravity CLI (`agy`) `v1.3.6`
- **Reference Adapter**: `@paperclipai/adapter-claude-local`

---

## 1. Summary of Changes

1. **Server Module & Session Codec Registration (`src/index.ts`, `src/server/index.ts`)**:
   - Fixed the missing `sessionCodec` registration on `createServerAdapter()` in `src/index.ts`.
   - Extended `parseSessionParams()` in `src/server/index.ts` to preserve `promptBundleKey` and `remoteExecution` across serialize/deserialize round-trips.
2. **Live Provider Quota Polling (`src/server/quota.ts`)**:
   - Implemented `getQuotaWindows()` and `parseAgyUsageQuotaOutput()` using `agy -p "/usage" --output-format json` (and TSV fallback), mapping `command.data.groups[].buckets[]` into Paperclip's `ProviderQuotaResult` (`QuotaWindow[]` with `usedPercent`, `resetsAt`, `valueLabel`, and `detail`).
   - Registered `getQuotaWindows` on `createServerAdapter()`.
3. **`claude-local`-Aligned Error Taxonomy & Stream-JSON Helpers (`src/server/parse.ts`)**:
   - Expanded `isAntigravityUnknownSessionError()` to match corrupted media attachments (`truncated webm/mp4/mov`, `could not process image/video/audio/media`) and missing history steps (`agy` v1.3.4).
   - Added `extractAntigravityLoginUrl()` and updated `detectAntigravityAuthRequired()` to recognise GCP ADC (`AGY_ADC_AUTH`) credential failures and surface verification/appeal URLs (`loginUrl`).
   - Added `isAntigravityProviderQuotaExhausted()` vs. `isAntigravityTransientUpstreamError()` to distinguish hard billing/AI credits/weekly limits from transient 429/502/503/504/529 upstream failures.
   - Added `extractAntigravityRetryNotBefore()` to parse ISO-8601 `reset_time` timestamps and relative refresh durations (`refresh in X hours, Y minutes`, `retry after Ns`).
   - Added `isAntigravityModelNotFoundError()`, `isAntigravityRefusalError()`, `hasAntigravityTerminalResult()`, `parseAntigravityStreamJson()`, and `usageBasis: "per_run"`.

---

## 2. Local Validation Results (macOS `v26.8.2`)

- **Command**: `npm run typecheck && ./node_modules/.bin/tsc && ./node_modules/.bin/tsc src/ui-parser.ts --outDir dist --target ES2020 --module CommonJS --declaration false && npm test`
- **Status**: **PASS**
- **Test Files**: `14 passed (14)`
- **Total Assertions / Tests**: `117 passed (117)` (up from 111 in Phase 1)

---

## 3. Remote Validation Results (`oci-sig-1` — Ubuntu / `agy` v1.3.6)

- **Isolation Method**: Executed in isolated temporary Git worktree `/tmp/agy-adapter-phase2-validate` (cleaned up immediately after completion) without touching `/home/ubuntu/adapter-antigravity-local` or the running Paperclip server process.
- **Build & Test Suite (`npm run typecheck && npm run build && npm test`)**:
  - **Status**: **PASS**
  - **Test Files**: `14 passed (14)`
  - **Tests**: `117 passed (117)` in `1.29s`
- **Live `getQuotaWindows()` Verification on `oci-sig-1`**:
  ```json
  {
    "provider": "antigravity",
    "source": "agy-cli",
    "ok": true,
    "windows": [
      {
        "label": "Gemini Models (weekly)",
        "usedPercent": 1,
        "resetsAt": "2026-10-23T04:15:53.000Z",
        "valueLabel": "99% remaining",
        "detail": "You have used some of your weekly limit, it will fully refresh in 6 days, 23 hours."
      },
      {
        "label": "Gemini Models (5h)",
        "usedPercent": 3,
        "resetsAt": "2026-10-16T09:15:53.000Z",
        "valueLabel": "97% remaining",
        "detail": "You have used some of your 5-hour limit, it will fully refresh in 4 hours, 22 minutes."
      },
      {
        "label": "Claude and GPT models (weekly)",
        "usedPercent": 19,
        "resetsAt": "2026-10-18T01:12:07.000Z",
        "valueLabel": "81% remaining",
        "detail": "You have used some of your weekly limit, it will fully refresh in 1 day, 20 hours."
      },
      {
        "label": "Claude and GPT models (5h)",
        "usedPercent": 0,
        "resetsAt": "2026-10-16T09:53:47.000Z",
        "valueLabel": "100% remaining",
        "detail": "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS"
      },
      {
        "label": "Gemini 4 Argon (weekly)",
        "usedPercent": 42,
        "resetsAt": "2026-10-23T03:43:13.000Z",
        "valueLabel": "58% remaining",
        "detail": "You have used some of your weekly limit, it will fully refresh in 6 days, 22 hours."
      }
    ]
  }
  ```
