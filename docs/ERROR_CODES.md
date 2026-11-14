# Error codes

Coded errors the app raises when something is wrong in a way that would otherwise be silent.

**Format:** `TVCM-<AREA>-<WHAT>` — `AREA` is the subsystem (`READ`, `ALERT`, `PNL`, …), `WHAT` is the
condition. Codes are stable identifiers: once shipped, don't reword one, add a new one.

**Why these exist.** The chart reader talks to TradingView over CDP, where a failed read usually
looks like an *empty* read rather than an error. An empty read that is reported as success produces
confident, wrong output — or no output at all — with nothing in the logs to chase. A code turns that
into something you can search for.

## Registry

| Code | Plain-English meaning | What the user sees | Where it is raised | What to check |
|---|---|---|---|---|
| **`TVCM-READ-EMPTY-BARS`** | TradingView reported its chart data as loaded (`dataReady: true`), but the reader got **zero bars** back. A read fault, not an empty chart. | **Manual refresh:** the panel body shows `TVCM-READ-EMPTY-BARS: TradingView reported its data as loaded but no bars could be read`.<br>**Scheduled (bar-close) run:** only the red status dot — the code goes to the terminal / dev log, not the panel. See *Known gap* below. | Detected and logged in `src/shared/tv-reader.js` (`readSnapshot`, lines 657-667); attached to the snapshot as `readError`. Re-raised for the user by `src/main/bridge.ts` `runAnalysis` (lines 274-283). | 1. Is the chart in **Bar Replay**? This was the original cause (see `TVCM-2-REPLAY`).<br>2. Is the symbol actually loaded, with history? A brand-new or illiquid symbol can report ready with nothing to read.<br>3. Is this build **older than `c678b5e`**? Before that commit `m_bars` was read with a 0-based loop and returned 0 or partial bars in replay.<br>4. Does this TradingView version still expose `m_bars.first()` / `.last()`? Without them `readBars` falls back to `0..size-1`, which is the old broken behaviour. |
| **`TVCM-ALERT-NO-BAR`** | The price-crossing alert poller (every 5 s) reached the chart but could **not read the newest bar**, so there was no price to test armed alerts against. Alerts are not being checked. | **Nothing in the UI.** One line in the terminal / dev log:<br>`[alert-poller] TVCM-ALERT-NO-BAR: chart is readable but no bar could be read — price-crossing alerts are not being checked`<br>Latched: logged once per fault episode, re-armed on recovery, so it will not repeat every 5 s. | Returned by the poll expression `PRICE_POLL_EXPR` in `src/shared/tv-reader.js` (line 129, `{ error: "TVCM-ALERT-NO-BAR" }`); logged by the poller in `src/main/index.ts` (lines 599-620). | 1. Same four bar-read causes as `TVCM-READ-EMPTY-BARS` — both read bars through the same `readBars` helper.<br>2. Confirm armed alerts actually matter right now; the code means they are *unchecked*, not that they failed.<br>3. **If TradingView is closed entirely you get no message at all** — that is the deliberate quiet-skip path, not this code. |
| **`TVCM-REC-SAVE-FAILED`** | Saving a recommendation at bar close threw. The analysis itself still completed — bookkeeping must never break the pipeline. | **Nothing in the UI**; the analysis card appears as normal. One line in the terminal / dev log with the underlying error. The call is simply missing from the scorecard. | `src/main/index.ts`, `saveRecommendation()` catch block. | 1. Is `trades.db` writable, and is another process holding a write lock?<br>2. Did the DB file move or get replaced underneath the running app?<br>3. A dedup skip is **not** this error — that logs `bar <t> already saved — skipped (dedup)` and is normal. |
| **`TVCM-GRADE-NO-BARS`** | The grader ran but could not read any bars, so it graded nothing this cycle. Not a grading fault — the chart was unreadable. | **Nothing in the UI.** One latched log line; re-arms once bars return. Calls stay ungraded and are retried next bar. | `src/main/grade-runner.ts`, `run()`. | 1. Same bar-read causes as `TVCM-READ-EMPTY-BARS` — both go through `readBars`.<br>2. Is TradingView running and on a chart with history?<br>3. Persisting while the chart looks fine points at the bar reader, not the grader. |
| **`TVCM-REC-BACKFILL-FAILED`** | Filling `setup_key` on rows written before that column existed threw at startup. Saving and grading continue normally; only the backfill was skipped. | **Nothing in the UI.** One line in the terminal / dev log. Affected rows keep a NULL `setup_key` and fall into the scorecard's `other` bucket until the next successful start. | `src/main/index.ts`, startup backfill block. | 1. Is `trades.db` writable?<br>2. Is the `recommendations` table present — a very old DB may predate it.<br>3. The backfill is idempotent, so a restart retries it safely. |
| **`TVCM-START-SCHEMA`** | Preparing the journal database threw while the app was starting. | Panel shows the coded line **and** a macOS notification fires. Startup continues so the rest of the app still works. | `src/main/index.ts` startup steps via `src/main/startup-guard.ts`. | 1. Restore the newest `trades.db.backup-*` beside the database.<br>2. Check for duplicate rows blocking a unique index. |
| **`TVCM-START-STORE`** | The journal database could not be opened at startup. | Panel line + macOS notification. | `src/main/index.ts` / `startup-guard.ts`. | 1. Is `trades.db` present and unlocked?<br>2. Is another copy of the app running? |
| **`TVCM-START-SCHEDULER`** | The scheduler failed to start, so no analysis will run on its own. | Panel line + macOS notification. | `startSchedulerOnce()` in `src/main/index.ts`. | 1. Restart the app.<br>2. Check TradingView is open on `--remote-debugging-port=9222`. |
| **`TVCM-START-UNKNOWN`** | A startup step failed that has no specific code yet. | Panel line + macOS notification. | `describeStartupFailure()` fallback. | Read the message; add a specific code for the step if it recurs. |
| **`TVCM-TRAIN-NO-CHART`** | The training runner could not read the chart (no `TradingViewApi`, or an unsupported timeframe). | Runner exits with the message; nothing is written. | `scripts/train-replay.js`, `readChart()` / timeframe check. | 1. Is TradingView running with `--remote-debugging-port=9222`?<br>2. Is a chart open on a minute/hour/day timeframe (months are not supported)? |
| **`TVCM-TRAIN-NO-REPLAY`** | Replay did not start after seeking, so there is nothing to step. | Runner exits before stepping. | `scripts/train-replay.js`, after the seek. | 1. Mid-history replay is flaky (TVCM-4/6/7) — retry.<br>2. Check the replay toolbar actually appeared. |
| **`TVCM-TRAIN-SEEK-FAILED`** | `selectDate` threw while seeking to a day's window start. | Runner exits naming the day. | `scripts/train-replay.js`, seek step. | 1. Is the date a trading day with data?<br>2. Is it inside the symbol's replay depth? |
| **`TVCM-TRAIN-STALLED`** | The replay cursor stopped advancing — usually the end of available data. | Runner ends that day early and reports it. | `scripts/train-replay.js`, `stepAndWait()`. | 1. Expected at the end of a session.<br>2. If mid-session, check replay is still active. |
| **`TVCM-TRAIN-BARS-SKIPPED`** | Replay advanced more than one bar between analyses, so a bar produced no call. | Panel toast with the measured analysis time and a safe pace; one log line. | `src/main/index.ts` via `src/shared/pacing.js`. | 1. Stepping replay by hand too fast — slow to the suggested interval.<br>2. The runner never causes this; it waits for each save. |
| **`TVCM-GRADE-FAILED`** | The grading pass threw. Already-settled grades are unaffected; ungraded calls are retried on the next bar. | **Nothing in the UI.** One line in the terminal / dev log with the underlying error. | `src/main/index.ts`, `recordAndGrade()` catch block. | 1. Read the attached error — it is the real cause.<br>2. Grades are idempotent, so a transient failure costs nothing but a cycle. |
| **`TVCM-UI-RENDER`** | A React render threw inside the panel. The boundary caught it, so one section shows an error card instead of the whole panel going blank. | The failing section is replaced by a card reading **`TVCM-UI-RENDER`**, the time it failed, the error message, and **Try again** / **Reload panel** buttons. Everything outside that section keeps working. | `src/renderer/ErrorBoundary.tsx`, `componentDidCatch()`. Wrapped around the whole panel in `src/renderer/main.tsx` and around the settings, P&L and analysis-card sections in `src/renderer/App.tsx`. | 1. The log line carries the error **and the component stack** — the last named component in the stack is where it threw.<br>2. Most likely a field the LLM omitted: an unguarded `.toFixed()` / `.map()` on an optional commentary field (see the throw-path list in the TVCM-11B report).<br>3. **Try again** re-renders with the same data and usually fails again; **Reload panel** refetches. |
| **`TVCM-UI-GONE`** | The renderer process died (crash, OOM, killed). | The panel is auto-reloaded unless the app is quitting, so the window comes back by itself. One log line with `reason` and `exitCode`. | `attachRendererWatchdogs()` in `src/main/index.ts`, `render-process-gone`. | 1. `reason=crashed` with no pattern points at memory — check how long the app had been up.<br>2. `reason=oom` means the panel grew unbounded; look for an accumulating array in the renderer.<br>3. If the reload itself fails, a second line says so. |
| **`TVCM-UI-UNRESPONSIVE`** | The renderer stopped answering — its main thread is blocked. | **Nothing in the UI** (the UI is the thing that is stuck). One log line. **Not** auto-recovered: a forced reload would discard whatever the panel was mid-way through. | `attachRendererWatchdogs()`, `unresponsive`. | 1. Look for the matching `TVCM-UI-RESPONSIVE` line — the gap between them is how long it hung.<br>2. A hang at bar close points at render work on a large analysis payload. |
| **`TVCM-UI-RESPONSIVE`** | The renderer recovered on its own after a hang. | Nothing. One log line, which closes a `TVCM-UI-UNRESPONSIVE` episode. | `attachRendererWatchdogs()`, `responsive`. | Informational — it is the "all clear" for the code above. |
| **`TVCM-UI-LOADFAIL`** | The panel's HTML/bundle failed to load. | The window stays empty. One log line with the Chromium error code, description and URL. | `attachRendererWatchdogs()`, `did-fail-load`. | 1. In dev: is Vite up on `localhost:5173`?<br>2. Packaged: is `dist/renderer/index.html` present — did `npm run build` run?<br>3. `-6 ERR_FILE_NOT_FOUND` means the bundle path is wrong, not that the panel crashed. |
| **`TVCM-UI-RELOAD`** | The panel reloaded when nobody asked it to. | Nothing visible beyond a brief flicker. One log line with the load count. | `attachRendererWatchdogs()`, `did-finish-load` past the first load. | 1. A reload nobody triggered is itself a symptom — check for a `TVCM-UI-GONE` line just before it.<br>2. In dev, Vite HMR causes these legitimately; in a packaged build it should never happen. |
| **`TVCM-UI-WINDOW`** | An error escaped React entirely and reached `window.onerror`. | Nothing — no boundary can catch this one. One log line with file and line. | `forwardConsoleToLog()` in `src/renderer/main.tsx`. | 1. Usually an event handler or a timer callback, which boundaries do not cover.<br>2. The file:line in the message is in the bundled output; check the sourcemap. |
| **`TVCM-UI-REJECTION`** | An unhandled promise rejection in the renderer. | Nothing. One log line with the rejection reason. | `forwardConsoleToLog()` in `src/renderer/main.tsx`. | 1. Most often an `await window.api.*` call with no catch.<br>2. The reason is the real error — a bare `undefined` means something rejected with no value. |
| **`TVCM-PNL-FEE-ESTIMATE`** | The live P&L bar's fee total is an **estimate**. Fees are charged per contract *per side*, but the trading panel's DOM reports only a round-trip count, never contract size — so the bar assumes **1 contract per round trip**. Trading 5-lots understates fees 5×. | **Nothing in the UI** — the bar shows a number that is simply low. One log line, latched to once per session (re-arms on the 17:00 CT rollover). | `warnFeeEstimateOnce()` in `src/main/pnl-tracker.ts`, called from the snapshot build. | 1. This is expected, not a fault — the DOM genuinely does not carry contract size.<br>2. For exact fees use the Order History import (`scripts/reconcile-session.js`), which counts real contract-sides per fill.<br>3. If the bar and the import disagree, this is why; trust the import. |
| **`TVCM-OH-EMPTY-FILE`** | An Order history export had no lines at all — not even a header. Nothing was imported. | Returned in `errors[]` by the import; the reconcile script prints it and exits with no sessions. | `parseOrderHistoryCsv()` in `src/shared/order-history.js`. | 1. Did the download finish? A 0-byte file is the usual cause.<br>2. Re-export from TradingView's account manager (**Download data**). |
| **`TVCM-OH-BAD-HEADER`** | The file's header is missing a column the engine needs (`Side`, `Fill quantity`, `Avg fill price`, `Status time`, `Order ID`). The message names the missing ones. Nothing is imported — better than importing a wrong number. | Returned in `errors[]`; the reconcile script prints the code and the missing columns. | `parseOrderHistoryCsv()` in `src/shared/order-history.js`. | 1. Is this an **Order history** export, not Positions or balance history?<br>2. Did TradingView rename a column? Update `REQUIRED_COLUMNS` and the field readers together. |
| **`TVCM-OH-BAD-ROW`** | One row reported a fill (`Fill quantity > 0`) but could not be read — unusable `Avg fill price`, unparseable `Status time`, an unrecognised `Side`, or no `Order ID` to dedupe on. That row is dropped; the rest import normally. | Collected in `skipped[]` with the line number and reason; the reconcile script prints a count and the first few. | `parseOrderHistoryCsv()` in `src/shared/order-history.js`. | 1. Open that line — a stray comma in an unquoted field shifts every column.<br>2. **A dropped row means the session's totals are incomplete.** Any non-zero count here should be read before trusting the P&L.<br>3. An order that filled nothing is *not* this code; it is skipped silently and correctly. |
| **`TVCM-OH-NO-ROWS`** | The file parsed, but nothing in it actually filled, so there are no sessions to report. | Returned as `warning`; the reconcile script says the session has no fills. | `analyseOrderHistory()` in `src/shared/order-history.js`. | 1. Normal for a header-only export or a date range with no trading.<br>2. If you expected fills, check the export's own date range — the engine only sees what the file contains. |
| **`TVCM-OH-TRADE-UNEXPLAINED`** | A session's flat-to-flat trades do not add up to its session total, and the gap is **not** accounted for by boundary-crossing trades or per-trade cent rounding. Session totals are still correct — they are the statement-matching FIFO figures — but the **trade split is wrong**, so the per-trade P&L shown to the user cannot be trusted. | Returned as `warning` on that session's `tradeReconciliation`; `scripts/reconcile-session.js --trades` prints `fully explained  NO — TVCM-OH-TRADE-UNEXPLAINED`. | `reconcileTrades()` in `src/shared/order-history.js`. | 1. Compare `outbound`/`inbound` against the trades the session actually lists — a trade spanning 17:00 should appear in exactly one of them.<br>2. A gap that is a clean multiple of $0.60 points at fee/side accounting; one that is a multiple of the point value points at FIFO pairing.<br>3. `roundingDelta` above a few cents for a session with few trades is itself the bug. |
| **`TVCM-OI-UNREADABLE`** | The watcher found an export, waited for it to stop changing, and then could not read the file (permissions, or it was moved between the stat and the read). **The previous good numbers are kept** — a failed import never blanks the P&L. | Nothing changes in the menu bar or the panel; the panel's P&L bar shows a small 'last import failed' note with this code. One log line. | `importFile()` in `src/main/order-import.ts`. | 1. Did the file get moved or deleted mid-scan? The next scan picks up whatever is newest.<br>2. Check read permission on the watch folder. |
| **`TVCM-OI-PARSE-FAILED`** | The order-history engine threw while parsing an export. Distinct from a *recognised* bad file (`TVCM-OH-BAD-HEADER`): this is an unexpected crash, not a known-shape rejection. **Previous good numbers are kept.** | Same as above — the bar keeps the old numbers and notes the failure. | `importFile()` in `src/main/order-import.ts`. | 1. The attached message is the real error; the file named in the log is the input that caused it.<br>2. Reproduce offline with `node scripts/reconcile-session.js <that file> --all`. |
| **`TVCM-OI-SKIPPED-ROWS`** | An export imported successfully, but some rows reported a fill and could not be read (see `TVCM-OH-BAD-ROW`). **The session totals are therefore incomplete.** | The numbers still display; one log line gives the count and the file. | `importFile()` in `src/main/order-import.ts`. | 1. Any non-zero count here means the displayed P&L is missing fills — read the per-row reasons before trusting it.<br>2. Re-export from TradingView; a truncated download is the usual cause. |
| **`TVCM-OI-CACHE-WRITE`** | The last good import could not be cached to `userData/order-import.json`. Everything works for this run; the next start just won't show numbers until its first scan finishes. | Nothing visible. One log line. | `persist()` in `src/main/order-import.ts`. | 1. Is `userData` writable?<br>2. Harmless in isolation — only worth chasing if it repeats. |
| **`TVCM-LESSON-NO-KEY`** | Lesson extraction was asked for, but the active LLM provider has no API key (or `config.json` has no `llm` block). Nothing was extracted and nothing was written. | The Lessons tab shows the message beside the Extract button; one log line. | `extractLessons()` in `src/main/lesson-extractor.ts`. | 1. Is the env var named by `llm.apiKeyEnv` set in `.env` for the provider `llm.provider` selects?<br>2. The analyzer uses the same provider — if analyses work, this is a config block problem, not a key problem. |
| **`TVCM-LESSON-EXTRACT-FAILED`** | One trade's lesson could not be extracted — the model call threw, timed out, or returned something that is not the expected JSON. **Other trades in the same run still succeed**; the failure is per-trade. | The Lessons tab reports the first error beside the counts; one log line per failed trade, naming the trade id. | `extractLessons()` in `src/main/lesson-extractor.ts`. | 1. The trade id in the message is the input — check its `critique_json` is real prose and not empty.<br>2. A JSON parse error means the model ignored the schema; it is retried next time Extract is pressed, so nothing is lost.<br>3. No lesson row is written on failure, so a retry cannot duplicate. |
| **`TVCM-SECOND-INSTANCE`** | Someone launched TVCM while a copy was already running for the same profile. The second copy **quits immediately**, before it can create a tray, start the order-history watcher, start the scheduler or open a CDP connection to TradingView. The running copy brings its Order History & P&L window forward so it is obvious which one is live. | Nothing fails. The second launch simply ends; the first window appears. Two log lines — one in the copy that quit, one in the copy that stayed. | `acquireSingleInstanceLock()` and `revealRunningInstance()` in `src/main/index.ts`, the first statements the main process runs. | 1. This is the designed behaviour, not a fault — two TVCMs would mean two trays showing the same number and two processes polling the live account.<br>2. **The lock is per userData profile**, so a `--user-data-dir` test profile is deliberately allowed alongside the everyday one.<br>3. If a launch is refused and no window appears, the running copy is wedged — find it with `ps -ax \| grep tv-claude-chart-monitor` and quit it from the tray. |

## Reading the three poll outcomes

`PRICE_POLL_EXPR` distinguishes three cases on purpose, because the poller runs every 5 seconds and
must not confuse "TradingView isn't running" with a real fault:

| Returned | Means | Logged? |
|---|---|---|
| `{ price, symbol }` | read succeeded | no |
| `{ error: 'TVCM-ALERT-NO-BAR' }` | chart reachable, bar unreadable — a real fault | yes, once per episode |
| `null` | chart / API not reachable at all (TradingView closed, CDP down) | no — expected, stays quiet |

## Closed gap (TVCM-7)

`TVCM-READ-EMPTY-BARS` used to reach the panel only on a **manual** refresh — a scheduled
bar-close failure sent the status but not the message, so the user saw a red dot and the code went
to the console, where nobody running a menubar app will look. The scheduler now sends the message
too (`analysisErrorPayload()` in `src/main/status-payload.ts`), and the renderer displays it. Since
almost every run is a scheduled one, this was the common case, not the edge case.

## Why grading has its own codes

Grading is bookkeeping that runs behind a trading app. It must never take the
analysis down with it, so every grading failure is caught and logged rather than
thrown. That makes silence ambiguous — these codes are what distinguish "nothing
to do" from "something broke". Grades are idempotent, so losing a cycle costs
nothing; losing them *silently* would cost the scorecard its credibility.

## The always-on log file (TVCM-11B)

Every `TVCM-UI-*` code above is written to a log file that exists on **every** start, with no env
var to remember:

```
~/Library/Application Support/trading-analyzer/logs/main.log
```

Tray → **Open Log Folder** opens it. Lines are stamped in ISO-8601 **America/Chicago**
(`2026-10-27T07:30:12.345-05:00`), the file rotates at 1 MB, and five files are kept
(`main.log` plus `main.1.log`…`main.4.log`).

Renderer `console.error` / `console.warn` are forwarded over the `log:renderer` IPC channel into the
same file, which is how a `TVCM-UI-RENDER` component stack from the panel ends up next to the main
process's own lines.

**Nothing sensitive is written.** `redact()` in `src/main/logger.ts` strips provider-key shapes
(`sk-ant-…`, `sk-…`, `AIza…`), bearer tokens, `apiKey`/`token`/`secret`/`password` values in both
JSON and `KEY=value` form, and account **numbers**. The account **type** (`amp_live`, `amp_demo`) is
deliberately left readable, because it is a safety flag Jim needs to be able to see. This is covered
by tests in `tests/main/logger.test.js` — if you add a log line that could carry a credential, add a
redaction case there in the same commit.

**Why this exists.** Before TVCM-11B, console output was mirrored to a file only when
`TVCM_LOG_FILE` was set, and the normal start never set it. A panel that went blank during a live
session left no evidence at all, so the cause could not be investigated after the fact. The log is
now unconditional. `TVCM_LOG_FILE` is still honoured as a *second* destination for training runs
that want their own file.

## Adding a code

1. Pick `TVCM-<AREA>-<WHAT>`; keep `AREA` consistent with the table above.
2. Raise it where the fault is *detected*, not where it is noticed — include the context that makes
   it diagnosable (symbol, timeframe, mode).
3. Decide, explicitly, whether the user should see it or only the log. A code nobody surfaces is only
   half a fix.
4. If it can repeat on a timer, latch it so a persistent fault logs once rather than flooding.
5. Add a row here in the same commit.
