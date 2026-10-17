# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # compile main process, start Vite + Electron
npm run build    # compile main + Vite production build
npm run package  # build then package with electron-builder (macOS DMG)
```

Type-check renderer only (Vite handles this at build time):
```bash
npx tsc --noEmit
```

Type-check main process:
```bash
npx tsc -p tsconfig.main.json --noEmit
```

CDP probe scripts (run directly with Node, no build needed):
```bash
node scripts/probe-account.js         # introspects TradingView globals/APIs
node scripts/probe-account-fields.js  # reads accountSummaryField DOM selectors
node scripts/test-llm-provider.js     # smoke-tests the configured LLM provider
```

## Prerequisites

**TradingView Desktop** must be launched with the CDP debugging port enabled:
```
open -a "TradingView" --args --remote-debugging-port=9222
```

**Environment:** copy `.env.example` to `.env` and set the API key for the active LLM provider. The provider is chosen by `llm.provider` in `config/config.json`, and the env var name by `llm.apiKeyEnv`:

| `llm.provider` | Key | Where to get it |
|---|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY` | console.anthropic.com — paid credits |
| `gemini` | `GEMINI_API_KEY` | https://aistudio.google.com/apikey — free tier, **20 requests/day/model** |

For Google Drive export also set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (key names configurable under `config.google`).

Smoke-test the active provider without launching Electron:
```bash
node scripts/test-llm-provider.js                      # synthetic context → real card
node scripts/test-llm-provider.js --models             # list models the Gemini key can see
node scripts/test-llm-provider.js --provider anthropic # test the other block
```

## Architecture

Two-process Electron app with no dock icon (macOS menubar only).

**Main process** (`src/main/index.ts`) — compiled via `tsconfig.main.json` → `dist/main/index.js`. Owns the `BrowserWindow`, Tray, right-click context menu, window-state persistence, and all IPC handlers. Does not use the `menubar` npm package — manages tray + window directly.

**Renderer process** (`src/renderer/`) — React + TypeScript, bundled by Vite. `index.html` is the Vite root entry; `main.tsx` mounts the React tree; `App.tsx` is the top-level component. Dark theme via CSS variables in `styles.css`.

**Shared types** (`src/shared/types.ts`) — TypeScript types and IPC channel constants used by both processes.

**Shared JS modules** (`src/shared/*.js`) — CommonJS modules **not compiled by tsc**. They are loaded at runtime in the main process via `require()` in `bridge.ts`. Never import them as ES modules.

## Key config details

- `tsconfig.json` — renderer only (`noEmit: true`, targets Vite/bundler moduleResolution)
- `tsconfig.main.json` — main process only (`module: CommonJS`, emits to `dist/main/`)
- `vite.config.ts` — root is `src/renderer/`, output is `dist/renderer/`
- `electron-builder.yml` — packaging config; not wired into CI
- `config/config.json` — runtime config (CDP host/port, LLM provider/model, filter thresholds, annotator settings). Hot-reloaded on each analysis run. Key sections:
  - `llm` — the **active** LLM backend: `provider` (`'gemini'` | `'anthropic'`), `apiKeyEnv`, `model`, `fastModel` (cheap model for high-volume journal lesson extraction; defaults to `model`), `maxOutputTokens`, `enabled`. Currently **`anthropic` / `claude-haiku-4-5`**.
    - Switched away from the Gemini free tier because its cap is **20 requests/day/model** — a per-bar monitor exhausts a 3-model chain in ~20 minutes of live use, and every bar past that stubs the card. Measured cost per commentary call is ~1,611 input + ~800 output tokens: ~$5.61 per 1,000 calls on Haiku 4.5, vs ~$4.21 on paid Gemini Flash until its promotional rate ends 2026-12-31 and ~$8.42 after. Flat pricing won.
    - Gemini-only fields, live only while the `gemini` block is the active one: `fallbackModels`, `maxPasses`, `thinkingBudget`, `temperature`, `timeoutMs`. The notes below apply when you swap back.
    - **`fallbackModels` is load-bearing on the free tier.** Gemini free-tier 503s ("experiencing high demand") are per-model and frequent: measured over 4 real commentary calls, `gemini-3.8-flash` answered 0/4, `gemini-3.6-flash` 2/4, `gemini-3-flash-preview` 4/4. The provider walks `[model, ...fallbackModels]` on every pass, failing over in ~500ms, and only backs off (2s, 4s) once every candidate has been tried. `maxPasses` bounds the passes.
    - **`thinkingBudget: 0`** stops flash models spending the whole `maxOutputTokens` allowance on thinking and returning an empty `MAX_TOKENS` candidate. Support is not uniform — the `flash-lite` family rejects the field with a 400, so a 400 on a request that carried `thinkingConfig` is retried once without it, and the rejection is remembered per model. That matters because `fastModel` is typically a lite model sharing this one config block.
    - **`timeoutMs` is per request, and failover multiplies it.** `fetch` *rejects* on a transport failure (the `AbortSignal.timeout` firing, `ECONNRESET`, DNS) instead of resolving with a non-ok response, so transport errors are caught explicitly and rejoin the model walk — a single hung request used to escape the retry loops and stub the card with `api-error: The operation was aborted due to timeout`, discarding every fallback. The consequence is that worst-case wall time is `timeoutMs x candidates x maxPasses`, so keep `timeoutMs` low (20s; flash normally answers in 2-5s, so 20s already means hung). At 60s a full outage hung one analysis for ~9 minutes, and since the scheduler runs analyses sequentially that silently skipped bars.
    - Model ids churn fast (`gemini-2.5-flash` is already 404 for new keys). `node scripts/test-llm-provider.js --models` lists what your key can actually reach.
  - `gemini` — a parked provider block kept so `llm` can be swapped back by copying it over. `node scripts/test-llm-provider.js --provider gemini` exercises it in place without editing `llm`.
  - `resolveLlm()` in `bridge.ts` still falls back to an `anthropic` block when `llm` is absent — that path is back-compat for pre-provider configs only, and `config.json` no longer carries such a block.
  - `google` — `clientIdEnv`, `clientSecretEnv` for OAuth
  - `annotator` — `ttlMinutes`, `cleanupIntervalSeconds`
  - `filter.fireOn` — boolean gates: `notablePatterns`, `zoneInteractions`, `trendOrMaEvents`, `everyCandleIfActionable`
  - `detectors.lifecycle` — thresholds for invalidate/refine/recategorize logic
- `sandbox: false` in `BrowserWindow.webPreferences` — required so the preload script can `require()` local CommonJS modules.

## Main-process module map

| Module | Role |
|---|---|
| `bridge.ts` | CDP connection singleton, `runAnalysis()` pipeline (connect → snapshot → context → Claude) |
| `capture.ts` | `captureTradingView()` — captures TradingView window as PNG base64; falls back to primary screen |
| `scheduler.ts` | Timed polling; aligns next run to bar close time (`barCloseMs + 2s`); retries on error |
| `annotator.ts` | Writes key levels and trade-plan brackets to the "TA Levels" Pine indicator via CDP `setStudyInputs` |
| `pnl-reader.ts` | Reads account data from the TradingView DOM via CDP `evalPage()` |
| `pnl-tracker.ts` | Polls P&L every 10s, tracks trade count and fees, pushes `PnlSnapshot` snapshots to renderer |
| `fee-calculator.ts` | Computes variable + daily-fixed fees from `FeeConfig` |
| `notifier.ts` | macOS desktop notifications for analysis verdicts |
| `settings.ts` | Loads/saves `AppSettings` to `userData/settings.json`; merges with defaults |
| `analyzer.ts` | Standalone Claude API caller — takes base64 PNG, POST to Anthropic messages API directly, returns parsed `AnalysisResult` (no CDP dependency). **Dead code** — nothing imports it, and it still calls Anthropic directly rather than going through `llm-providers.js` |
| `google-auth.ts` | OAuth2 PKCE flow via `google-auth-library`; persists tokens to `userData/google-auth.json` — exists but not wired to active export path |
| `google-drive.ts` | Drive API upload; exists but bypassed — `GDRIVE_EXPORT` IPC handler in `index.ts` uses `dialog.showSaveDialog` + `fs.writeFile` for local HTML save instead |
| `google-doc-formatter.ts` | Converts `AnalysisResult` → styled HTML (tables for trade plans, lists for key levels) |

## Shared JS module map

| Module | Role |
|---|---|
| `tv-reader.js` | CDP client; connects to TradingView, reads bar snapshots, exposes `setStudyInputs` and `evalPage` |
| `context.js` | Converts raw bar snapshot to structured context for the LLM |
| `commentary.js` | `CommentaryEngine` — calls the configured provider, returns `CommentaryResult` |
| `llm-providers.js` | Pluggable LLM backends (`anthropic`, `gemini`). `createProvider(cfg)` → `{ name, hasKey, model, fastModel, complete(system, user, opts) }`. `opts` is `{ json?, maxOutputTokens?, model? }` |
| `patterns.js` | Price-action pattern detectors |
| `filter.js` | Cooldown / zone-proximity filter; `fireOn` gates control which event types trigger |
| `detectors/swing-pivots.js` | 3-bar pivot cluster detector; returns `SuggestedLevel[]` with `touchCount`, `strength`, etc. |
| `strategies/orb.js` | Opening Range Breakout strategy; `computeOrbState()` returns phase, breakouts, signal, levels, zones |
| `utils.ts` | `parsePrice()` — extracts first numeric value from a free-text price string |

## Annotator: Pine indicator slot layout

The "TA Levels" Pine indicator (`tv-pine/trading-analyzer-levels.pine`) receives inputs via `setStudyInputs`. Layout:

- **Levels** — 8 slots × 5 inputs each = inputs `in_0` through `in_39`
  - Each slot: `in_{base}` = price, `in_{base+1}` = kind, `in_{base+2}` = label (≤20 chars), `in_{base+3}` = visible (0/1), `in_{base+4}` = priority (`'primary'`/`'secondary'`)
- **ORB** — `in_40` = ORB high, `in_41` = ORB low, `in_42` = ORB state flag
- **Trade plan bracket** — `in_43` = entry, `in_44` = stop, `in_45` = target

The Pine indicator also natively computes ORB from the 8:30–8:45 AM CST session and draws zone fills (green above high, red below low, gray inside). ORB rendering is suppressed on timeframes ≥ 30m. The study ID is looked up by name and cached; invalidated on reconnect.

## CommentaryResult special kinds

`CommentaryResult.kind` discriminates special analysis cards:

- `'suggest_level'` — carries `suggested_level: SuggestedLevel` (from swing-pivot detector)
- `'lifecycle'` — carries `lifecycle_event: LifecycleEvent` (invalidate/refine/recategorize a tracked level)
- Absent/undefined — standard analysis card

## Scheduler behaviour

- Starts only when the panel is first shown (not at app launch)
- After each successful analysis, aligns the next run to `barCloseMs + 2000ms`; falls back to timeframe-based interval if `barCloseMs` is stale
- On error, reschedules using the last known interval
- Daily/weekly charts (`'1D'`, `'D'`) fire once only (no reschedule)
- `autoRefresh: false` in settings stops the scheduler without clearing its state; `resume()` restarts it without an immediate trigger

## Dark theme tokens

`--bg` `#1e222d` · `--surface` `#262b3d` · `--text-primary` `#d1d4dc` · `--text-secondary` `#787b86` · `--accent` `#26a69a` · `--bearish` `#ef5350` · `--border` `#363a45`
