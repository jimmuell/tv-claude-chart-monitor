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

## Reading the three poll outcomes

`PRICE_POLL_EXPR` distinguishes three cases on purpose, because the poller runs every 5 seconds and
must not confuse "TradingView isn't running" with a real fault:

| Returned | Means | Logged? |
|---|---|---|
| `{ price, symbol }` | read succeeded | no |
| `{ error: 'TVCM-ALERT-NO-BAR' }` | chart reachable, bar unreadable — a real fault | yes, once per episode |
| `null` | chart / API not reachable at all (TradingView closed, CDP down) | no — expected, stays quiet |

## Known gap

`TVCM-READ-EMPTY-BARS` only reaches the panel on a **manual** refresh. The scheduler's error
callback sends the status but not the message (`src/main/index.ts:439-443`), so a background
bar-close failure shows a red dot while the code appears only on the console. Worth closing if this
code is ever seen in practice.

## Adding a code

1. Pick `TVCM-<AREA>-<WHAT>`; keep `AREA` consistent with the table above.
2. Raise it where the fault is *detected*, not where it is noticed — include the context that makes
   it diagnosable (symbol, timeframe, mode).
3. Decide, explicitly, whether the user should see it or only the log. A code nobody surfaces is only
   half a fix.
4. If it can repeat on a timer, latch it so a persistent fault logs once rather than flooding.
5. Add a row here in the same commit.
