# Level Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bell icon to each level card in the "Watch These Levels" panel that creates a TradingView native price-crossing alert via a same-origin `fetch()` injected through CDP `evalPage()`.

**Architecture:** The renderer sends `{ price, label }` over a new `ALERT_CREATE` IPC channel. The main process reads the current TV symbol + resolution via `evalPage()`, then calls `reader.createAlert()` which injects a `fetch()` POST into TradingView's page context — same-origin so session cookies are auto-included. Alert state (which prices have been alerted) lives in renderer as `Set<number>`, keyed by price, and resets on symbol change.

**Tech Stack:** Electron IPC, CDP `evalPage()`, TradingView price-alert REST API (`pricealert.tradingview.com`), React state, inline SVG

---

## File Map

| File | Change |
|------|--------|
| `scripts/probe-alerts.js` | **Create** — probe TV's alert API surface before implementing |
| `src/shared/types.ts` | **Modify** — add `ALERT_CREATE` IPC constant, `AlertCreatePayload`, `AlertCreateResult`, extend `ElectronAPI` |
| `src/shared/tv-reader.js` | **Modify** — add `createAlert(price, label, symbol, resolution)` to `TvReader` class |
| `src/main/bridge.ts` | **Modify** — export `createLevelAlert(price, label)` wrapper |
| `src/main/index.ts` | **Modify** — add `ALERT_CREATE` IPC handler; import `createLevelAlert` + `AlertCreatePayload` |
| `src/main/preload.ts` | **Modify** — expose `createAlert` via `contextBridge`; import `AlertCreatePayload` |
| `src/renderer/App.tsx` | **Modify** — add `BellIcon`, alert state, `handleAlertToggle`, bell button in level card |
| `src/renderer/styles.css` | **Modify** — add `.bell-btn` rules (mirrors `.eye-btn` geometry) |

---

## Task 1: Probe TradingView's alert API

**Files:**
- Create: `scripts/probe-alerts.js`

Run this **before implementing Task 3** to confirm the endpoint URL, CSRF auth, and response shape while TradingView Desktop is running with `--remote-debugging-port=9222`.

- [ ] **Step 1: Create probe script**

Create `scripts/probe-alerts.js`:

```javascript
#!/usr/bin/env node
'use strict';

const CDP = require('../node_modules/chrome-remote-interface');

const PORT = parseInt(process.env.CDP_PORT || '9222', 10);

const PROBE = `
(async () => {
  const findings = {};

  findings.origin = window.location.origin;
  findings.href   = window.location.href.slice(0, 100);

  findings.alertGlobals = Object.keys(window).filter(function(k) {
    return /alert|alarm|notify/i.test(k);
  }).slice(0, 20);

  const csrfCookie = (document.cookie.split(';').map(function(c) { return c.trim(); })
    .find(function(c) { return c.startsWith('csrftoken='); }) || '');
  findings.hasCsrf     = csrfCookie.length > 0;
  findings.csrfPreview = csrfCookie.slice(0, 40);

  try {
    const csrf = csrfCookie.split('=')[1] || '';
    const r = await fetch('https://pricealert.tradingview.com/api/v2/alerts/', {
      credentials: 'include',
      headers: { 'X-CSRFToken': csrf },
    });
    findings.getAlertsStatus  = r.status;
    findings.getAlertsHeaders = Object.fromEntries(Array.from(r.headers).slice(0, 10));
    if (r.ok) {
      const data = await r.json();
      findings.existingAlertCount = Array.isArray(data) ? data.length
        : (data.alerts ? data.alerts.length : 'unknown shape');
      findings.alertSample = JSON.stringify(data).slice(0, 400);
    } else {
      findings.getAlertsBody = (await r.text()).slice(0, 300);
    }
  } catch (e) {
    findings.getAlertsError = String(e);
  }

  try {
    const chart = window.TradingViewApi.activeChart();
    findings.symbol     = chart.symbol();
    findings.resolution = chart.resolution();
  } catch (e) {
    findings.chartError = String(e);
  }

  return findings;
})()
`;

async function main() {
  let client;
  try {
    const targets = await CDP.List({ port: PORT });
    const page = targets.find(function(t) {
      return t.type === 'page' &&
        (t.url.includes('tradingview') || t.title.toLowerCase().includes('tradingview'));
    });
    if (!page) {
      console.error('No TradingView page target found on port', PORT);
      process.exit(1);
    }
    client = await CDP({ port: PORT, target: page });
    await client.Runtime.enable();
    const { result, exceptionDetails } = await client.Runtime.evaluate({
      expression: PROBE,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      console.error('CDP eval failed:', exceptionDetails.text);
      process.exit(1);
    }
    console.log(JSON.stringify(result.value, null, 2));
  } finally {
    if (client) await client.close();
  }
}

main().catch(function(err) { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run probe with TradingView Desktop open**

```bash
node scripts/probe-alerts.js
```

Expected output shape (200 status means endpoint is reachable):
```json
{
  "origin": "https://www.tradingview.com",
  "hasCsrf": true,
  "getAlertsStatus": 200,
  "existingAlertCount": 3,
  "symbol": "CME_MINI:MES1!",
  "resolution": "5"
}
```

**If `getAlertsStatus` is 403/404:** Check `getAlertsBody` — the endpoint or path may differ. Update the `fetch` URL in Task 3 accordingly before continuing.

- [ ] **Step 3: Commit probe script**

```bash
git add scripts/probe-alerts.js
git commit -m "feat(alerts): add probe-alerts.js to discover TV alert API surface"
```

---

## Task 2: Add types

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add `ALERT_CREATE` IPC channel**

In `src/shared/types.ts`, find `ANNOTATE_PATTERN_MARKERS` on line 34 and add the new channel on the line after it, before `} as const`:

```typescript
  ANNOTATE_PATTERN_MARKERS:  'annotate:patternMarkers',
  ALERT_CREATE:              'alert:create',
} as const;
```

- [ ] **Step 2: Add payload and result types**

After the `LevelAnnotation` interface (after line 202), add:

```typescript
export interface AlertCreatePayload {
  price: number;
  label: string;
}

export type AlertCreateResult =
  | { ok: true;  alertId: string }
  | { ok: false; error: string };
```

- [ ] **Step 3: Extend ElectronAPI**

In the `ElectronAPI` interface, after the `writePatternMarkers` line (line 254), add:

```typescript
  createAlert(payload: AlertCreatePayload): Promise<AlertCreateResult>;
```

- [ ] **Step 4: Verify renderer type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(alerts): add ALERT_CREATE IPC channel, AlertCreatePayload and AlertCreateResult types"
```

---

## Task 3: Add `createAlert()` to tv-reader.js

**Files:**
- Modify: `src/shared/tv-reader.js` (add method to `TvReader` class)

> **Note:** The endpoint `https://pricealert.tradingview.com/api/v2/alerts/` is the standard TV Desktop alert creation URL. If Task 1 showed a different endpoint in `getAlertsBody`, update the `fetch` URL before committing.

- [ ] **Step 1: Add `createAlert` method to TvReader**

In `src/shared/tv-reader.js`, find the end of the `TvReader` class (the closing `}` of the class, before the `MockTvReader` class starts — look for `// Mock reader` or similar comment). Add the following method inside the class, after `setStudyInputs`:

```javascript
  async createAlert(price, label, symbol, resolution) {
    if (!this.client) throw new Error("Not connected. Call connect() first.");
    const name   = label + ' @ ' + price.toFixed(2);
    // Embed all params as a JSON literal to avoid string-escaping issues inside
    // the injected script.
    const params = JSON.stringify({ name: name, price: price, symbol: symbol, resolution: String(resolution) });
    const expr = `
      (async () => {
        const p = ${params};
        try {
          const csrfCookie = document.cookie.split(';').map(function(c) { return c.trim(); })
            .find(function(c) { return c.startsWith('csrftoken='); });
          const csrf = csrfCookie ? csrfCookie.split('=')[1] : '';
          const resp = await fetch('https://pricealert.tradingview.com/api/v2/alerts/', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRFToken': csrf,
              'Referer': window.location.href,
            },
            body: JSON.stringify({
              name: p.name,
              conditions: [["crossing", p.symbol, p.price]],
              resolution: p.resolution,
              notify_options: {
                notify_on_popup: true,
                notify_on_sound: false,
                notify_on_push: false,
                notify_on_email: false,
              },
              frequency: "once",
              message: p.name,
              expiration: null,
            }),
          });
          if (!resp.ok) {
            var txt = '';
            try { txt = await resp.text(); } catch (_e) {}
            return { ok: false, error: 'HTTP ' + resp.status + ': ' + txt.slice(0, 200) };
          }
          const data = await resp.json();
          return { ok: true, alertId: String(data.id || data.alert_id || '') };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }
      })()
    `;
    return await this.evalPage(expr);
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/tv-reader.js
git commit -m "feat(alerts): add createAlert() to TvReader — same-origin fetch to TV alert API"
```

---

## Task 4: Export `createLevelAlert` from bridge.ts

**Files:**
- Modify: `src/main/bridge.ts`

- [ ] **Step 1: Add `AlertCreateResult` to the types import**

In `src/main/bridge.ts` line 12, add `AlertCreateResult` to the import:

```typescript
import type { AnalysisResult, KeyStatus, AlertCreateResult } from '../shared/types';
```

- [ ] **Step 2: Add `createLevelAlert` export**

In `src/main/bridge.ts`, after the `evalPage` export function (after line 293), add:

```typescript
export async function createLevelAlert(
  price: number,
  label: string,
): Promise<AlertCreateResult> {
  try {
    await ensureConnected();
  } catch (err: unknown) {
    connected = false;
    reader    = null;
    throw err;
  }
  const symbol     = await reader!.evalPage("window.TradingViewApi.activeChart().symbol()") as string;
  const resolution = await reader!.evalPage("window.TradingViewApi.activeChart().resolution()") as string;
  return reader!.createAlert(price, label, symbol, resolution) as Promise<AlertCreateResult>;
}
```

- [ ] **Step 3: Verify main-process type-check**

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/bridge.ts
git commit -m "feat(alerts): export createLevelAlert from bridge.ts"
```

---

## Task 5: Add IPC handler in index.ts

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add `createLevelAlert` to bridge import**

In `src/main/index.ts` line 5, add `createLevelAlert` to the bridge import:

```typescript
import { runAnalysis, getSnapshot, disconnect, setStatusCallback, setCdpPort, setApiKeyOverride, resetConnection, getKeyStatus, createLevelAlert } from './bridge';
```

- [ ] **Step 2: Add `AlertCreatePayload` to types import**

In `src/main/index.ts` line 11, add `AlertCreatePayload`:

```typescript
import type { AnalysisResult, PatternMarker, AlertCreatePayload } from '../shared/types';
```

- [ ] **Step 3: Add IPC handler**

In `src/main/index.ts`, after the `ANNOTATE_PATTERN_MARKERS` handler (around line 392), add:

```typescript
  // IPC: create TradingView native price-crossing alert for a level
  ipcMain.handle(IPC.ALERT_CREATE, async (_e, payload: AlertCreatePayload) => {
    try {
      return await createLevelAlert(payload.price, payload.label);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
```

- [ ] **Step 4: Verify main-process type-check**

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(alerts): add ALERT_CREATE IPC handler in main process"
```

---

## Task 6: Expose createAlert through preload.ts

**Files:**
- Modify: `src/main/preload.ts`

- [ ] **Step 1: Add `AlertCreatePayload` to preload import**

In `src/main/preload.ts` line 2, add `AlertCreatePayload`:

```typescript
import { IPC, AnalysisResult, LevelAnnotation, AppSettings, KeyStatus, PnlSnapshot, PatternMarker, AlertCreatePayload } from '../shared/types';
```

- [ ] **Step 2: Expose `createAlert`**

In `src/main/preload.ts`, after the `writePatternMarkers` line (line 56), add:

```typescript
  createAlert: (payload: AlertCreatePayload) =>
    ipcRenderer.invoke(IPC.ALERT_CREATE, payload),
```

- [ ] **Step 3: Verify renderer type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/preload.ts
git commit -m "feat(alerts): expose createAlert via contextBridge preload"
```

---

## Task 7: Add bell icon UI to renderer

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Add `BellIcon` SVG component**

In `src/renderer/App.tsx`, after the `EyeOffIcon` component (after line 105), add:

```tsx
const BellIcon: React.FC<{ filled?: boolean }> = ({ filled = false }) => (
  <svg width="13" height="13" viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);
```

- [ ] **Step 2: Add `AlertCreatePayload` and `AlertCreateResult` to renderer types import**

In `src/renderer/App.tsx` line 1, add the two new types:

```typescript
import type { AnalysisResult, CommentaryResult, SetupVerdict, KeyLevel, LevelAnnotation, HighestProbabilityTrade, PnlSnapshot, CandlestickPattern, AlertCreatePayload, AlertCreateResult } from '../shared/types';
```

- [ ] **Step 3: Add alert state declarations**

In the `App` component, after `drawnSlotsRef` (around line 693), add:

```tsx
  const [alertedPrices, setAlertedPrices]           = useState<Set<number>>(new Set());
  const [pendingAlertPrices, setPendingAlertPrices] = useState<Set<number>>(new Set());
  const [alertErrorPrices, setAlertErrorPrices]     = useState<Map<number, string>>(new Map());
  const prevSymbolRef                               = useRef<string | null>(null);
```

- [ ] **Step 4: Reset alert state on symbol change**

In the `onAnalysis` handler inside the `useEffect` (around line 738), add a symbol-change guard at the very top of the callback, before `setResult(pushed)`:

```tsx
    const unsubAnalysis = window.api.onAnalysis((pushed) => {
      if (!pushed || typeof pushed !== 'object' || !('commentary' in pushed)) return;
      if (pushed.symbol !== prevSymbolRef.current) {
        setAlertedPrices(new Set());
        setAlertErrorPrices(new Map());
        prevSymbolRef.current = pushed.symbol;
      }
      setResult(pushed);
      // ... rest of handler unchanged
```

- [ ] **Step 5: Add `handleAlertToggle` handler**

In `src/renderer/App.tsx`, after `handleClearAll` (after line 905), add:

```tsx
  const handleAlertToggle = async (price: number, label: string) => {
    if (alertedPrices.has(price)) return;
    setPendingAlertPrices(prev => { const s = new Set(prev); s.add(price); return s; });
    setAlertErrorPrices(prev => { const m = new Map(prev); m.delete(price); return m; });
    try {
      const result: AlertCreateResult = await window.api.createAlert({ price, label });
      if (result.ok) {
        setAlertedPrices(prev => { const s = new Set(prev); s.add(price); return s; });
      } else {
        setAlertErrorPrices(prev => { const m = new Map(prev); m.set(price, result.error); return m; });
      }
    } catch (err) {
      setAlertErrorPrices(prev => {
        const m = new Map(prev);
        m.set(price, err instanceof Error ? err.message : 'Unknown error');
        return m;
      });
    } finally {
      setPendingAlertPrices(prev => { const s = new Set(prev); s.delete(price); return s; });
    }
  };
```

- [ ] **Step 6: Add bell button to level card JSX**

In `src/renderer/App.tsx`, in the level card render (around lines 497–515), add the bell button after the eye button. Replace the existing `<div key={i} className={...}>` block with:

```tsx
                <div
                  key={i}
                  className={`level-card${isSecondary ? ' level-card-secondary' : ''}`}
                  style={{ borderLeftColor: primary }}
                >
                  <button
                    className={`eye-btn${isDrawn ? ' eye-on' : ''}${isPending ? ' eye-pending' : ''}`}
                    onClick={() => annotation.onToggle(i, lvl)}
                    disabled={isPending}
                    aria-label={isDrawn ? 'Hide level on chart' : 'Draw level on chart'}
                    style={{ color: isDrawn ? primary : 'var(--text-secondary)' }}
                  >
                    {isDrawn ? <EyeOnIcon /> : <EyeOffIcon />}
                  </button>
                  {(() => {
                    const isBellPending = pendingAlertPrices.has(lvl.price);
                    const isBellActive  = alertedPrices.has(lvl.price);
                    const bellError     = alertErrorPrices.get(lvl.price);
                    return (
                      <button
                        className={`bell-btn${isBellActive ? ' bell-on' : ''}${isBellPending ? ' bell-pending' : ''}${bellError ? ' bell-error' : ''}`}
                        onClick={() => handleAlertToggle(lvl.price, lvl.label)}
                        disabled={isBellPending || isBellActive}
                        aria-label="Create TradingView alert for this level"
                        title={
                          bellError    ? `Alert failed: ${bellError}` :
                          isBellActive ? 'Alert set in TradingView — manage in TV Alerts panel' :
                                         'Create TradingView alert when price crosses this level'
                        }
                        style={{
                          color: isBellActive  ? 'var(--accent)'   :
                                 bellError      ? 'var(--bearish)'  :
                                                  'var(--text-secondary)',
                        }}
                      >
                        {isBellPending
                          ? <span className="bell-spinner" />
                          : <BellIcon filled={isBellActive} />
                        }
                      </button>
                    );
                  })()}
                  <span className="level-price" style={{ color: primary }}>{lvl.price.toFixed(2)}</span>
                  <span className="level-label" style={{ color: secondary }}>{lvl.label}</span>
                  <span className="level-action">{lvl.action}</span>
                </div>
```

- [ ] **Step 7: Add `.bell-btn` CSS rules**

In `src/renderer/styles.css`, after the `.eye-btn.eye-pending` rule (after line 523), add:

```css
/* ── Bell alert button (mirrors .eye-btn geometry) ── */
.bell-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  border-radius: 2px;
  opacity: 0.55;
  transition: opacity 0.12s;
  -webkit-app-region: no-drag;
}

.bell-btn:hover      { opacity: 1; }
.bell-btn.bell-on    { opacity: 1; }
.bell-btn.bell-error { opacity: 1; }
.bell-btn.bell-pending { opacity: 0.3; cursor: not-allowed; }

.bell-spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: gdrive-spin 0.7s linear infinite;
}
```

- [ ] **Step 8: Final type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(alerts): add bell icon to level cards — click to create TV price-crossing alert"
```

---

## Task 8: End-to-end verification

- [ ] **Step 1: Launch the app**

Make sure TradingView Desktop is running with `--remote-debugging-port=9222`, then:

```bash
npm run dev
```

- [ ] **Step 2: Run an analysis**

Click Refresh in the app panel. Wait for "Watch These Levels" to populate with level cards.

- [ ] **Step 3: Click a bell icon — success path**

Click the outline bell on any level card. Expected:
1. Bell shows a spinner briefly
2. Bell turns filled and teal (`var(--accent)`)
3. Tooltip reads: "Alert set in TradingView — manage in TV Alerts panel"

- [ ] **Step 4: Verify alert appeared in TradingView**

In TradingView Desktop, open the Alerts panel (clock icon in the right toolbar). Expected: a new alert named `"{label} @ {price}"` appears with a "crossing" condition.

- [ ] **Step 5: Test error state**

Quit TradingView Desktop (or set `cdpPort` to a wrong value in settings). Click a fresh bell. Expected:
- Bell turns red (`var(--bearish)`)
- Hovering shows an error tooltip with the failure reason

- [ ] **Step 6: Test symbol-change reset**

With the app connected, run analysis on one symbol, then change the TradingView chart to a different symbol and run analysis again. Expected: previously-active (teal) bells reset to outline state for the new symbol's levels.
