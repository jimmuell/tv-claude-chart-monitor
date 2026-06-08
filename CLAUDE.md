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
```

## Prerequisites

**TradingView Desktop** must be launched with the CDP debugging port enabled:
```
open -a "TradingView" --args --remote-debugging-port=9222
```

**Environment:** copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. The key name is configurable in `config/config.json` (`anthropic.apiKeyEnv`). For Google Drive export also set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (key names configurable under `config.google`).

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
- `config/config.json` — runtime config (CDP host/port, Anthropic model, filter thresholds, annotator settings). Hot-reloaded on each analysis run. Key sections:
  - `anthropic` — model, `apiKeyEnv`
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
| `analyzer.ts` | Standalone Claude API caller — takes base64 PNG, POST to Anthropic messages API directly, returns parsed `AnalysisResult` (no CDP dependency) |
| `google-auth.ts` | OAuth2 PKCE flow via `google-auth-library`; persists tokens to `userData/google-auth.json` — exists but not wired to active export path |
| `google-drive.ts` | Drive API upload; exists but bypassed — `GDRIVE_EXPORT` IPC handler in `index.ts` uses `dialog.showSaveDialog` + `fs.writeFile` for local HTML save instead |
| `google-doc-formatter.ts` | Converts `AnalysisResult` → styled HTML (tables for trade plans, lists for key levels) |

## Shared JS module map

| Module | Role |
|---|---|
| `tv-reader.js` | CDP client; connects to TradingView, reads bar snapshots, exposes `setStudyInputs` and `evalPage` |
| `context.js` | Converts raw bar snapshot to structured context for the LLM |
| `commentary.js` | `CommentaryEngine` — calls Claude API, returns `CommentaryResult` |
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
