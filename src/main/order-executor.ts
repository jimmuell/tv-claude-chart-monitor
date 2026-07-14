/**
 * order-executor.ts
 *
 * Places a bracketed 1-contract market order when a setup fires.
 *
 * Flow:
 *  1. Verify qty from [data-name="qtyEl"] is "1" — abort + notify if not.
 *  2. Read market price from the compact buy/sell button text.
 *  3. Compute TP and SL in ticks from the supplied absolute stop/target prices.
 *  4. Open the Trade panel if it isn't already open (click the Trade BUTTON).
 *  5. Select Buy or Sell side via [data-name="side-control-buy/sell"].
 *  6. Enable TP checkbox (data-qa-id="order-ticket-take-profit-checkbox-bracket").
 *  7. Set TP tick value after readonly is lifted by React re-render.
 *  8. Enable SL checkbox and set SL tick value.
 *  9. Click [data-name="place-and-modify-button"] — the panel's submit button.
 * 10. Close the panel if we opened it.
 *
 * Guards:
 *  1. Cooldown (5 min, persisted to disk across restarts)
 *  2. Open-position check via pnl-reader (null = SKIPPED — fail-closed)
 *  3. Qty check: abort + notify if qty ≠ 1
 */

import * as fs   from 'fs';
import * as path from 'path';
import { app, Notification } from 'electron';
import { evalPage }          from './bridge';
import { readAccountData }   from './pnl-reader';
import { getSettings }       from './settings';

// ---------------------------------------------------------------------------
// Cooldown — persisted so server restarts don't reset the window
// ---------------------------------------------------------------------------

const COOLDOWN_MS   = 5 * 60 * 1000;
const COOLDOWN_FILE = path.join(app.getPath('userData'), 'order-cooldown.json');

function readLastSubmittedAt(): number {
  try {
    const raw = fs.readFileSync(COOLDOWN_FILE, 'utf8');
    return (JSON.parse(raw) as { ts: number }).ts ?? 0;
  } catch { return 0; }
}

function writeLastSubmittedAt(ts: number): void {
  try { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify({ ts }), 'utf8'); }
  catch (err) { console.warn('[order-executor] could not persist cooldown:', (err as Error).message); }
}

function notifyWarn(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
  console.warn(`[order-executor] ⚠ ${title}: ${body}`);
}

// ---------------------------------------------------------------------------
// CDP expression
// ---------------------------------------------------------------------------

function buildOrderExpr(direction: 'long' | 'short', stop: number, target: number, entry: number, trailingStop: boolean): string {
  const isBuy = direction === 'long';
  return `
  (async () => {
    try {
      const isBuy        = ${isBuy};
      const stopPrice    = ${JSON.stringify(stop)};
      const targetPrice  = ${JSON.stringify(target)};
      const claudeEntry  = ${JSON.stringify(entry)};   // 0 = test mode: fall back to live DOM price
      const trailingStop = ${trailingStop};
      const TICK_SIZE    = 0.25;

      function setReactInput(el, val) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, String(val));
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // ── Guard: verify qty is 1 ─────────────────────────────────────────────
      const qtyEl  = document.querySelector('[data-name="qtyEl"]');
      const qtyTxt = (qtyEl?.textContent || '').trim();
      if (qtyTxt !== '1') {
        return JSON.stringify({ ok: false, error: 'wrong-qty', qty: qtyTxt });
      }

      // ── Read live market price for logging (and as fallback for test mode) ─
      const compactBtn = document.querySelector(
        isBuy ? '[data-name="buy-order-button"]' : '[data-name="sell-order-button"]'
      );
      const btnText    = compactBtn?.textContent || '';
      const priceMatch = btnText.match(/(\\d[\\d,]*\\.\\d+)/);
      const livePrice  = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : NaN;

      // Use Claude's entry for tick math (prevents stale-price mismatch).
      // Fall back to live DOM price only in test mode (claudeEntry === 0).
      const entryPrice = claudeEntry > 0 ? claudeEntry : livePrice;
      if (!Number.isFinite(entryPrice)) {
        return JSON.stringify({ ok: false, error: 'no-entry-price', btnText });
      }

      // ── Compute tick distances (must be positive) ──────────────────────────
      const stopTicks   = isBuy
        ? Math.round((entryPrice - stopPrice)  / TICK_SIZE)
        : Math.round((stopPrice  - entryPrice) / TICK_SIZE);
      const targetTicks = isBuy
        ? Math.round((targetPrice - entryPrice) / TICK_SIZE)
        : Math.round((entryPrice  - targetPrice) / TICK_SIZE);

      if (stopTicks <= 0 || targetTicks <= 0) {
        return JSON.stringify({ ok: false, error: 'invalid-ticks', entryPrice, livePrice, stopTicks, targetTicks });
      }

      // ── Open Trade panel if not already open ──────────────────────────────
      const isPanelOpen = () => !!document.querySelector('[data-name="order-panel"]');
      let panelOpened = false;
      if (!isPanelOpen()) {
        // The Trade button is a <button> whose text is "Trade" and has class activeArea-*
        const tradeBtn = [...document.querySelectorAll('button')].find(btn =>
          (btn.textContent || '').trim() === 'Trade' && (btn.className || '').includes('activeArea-')
        );
        if (!tradeBtn) {
          return JSON.stringify({ ok: false, error: 'trade-button-not-found' });
        }
        tradeBtn.click();
        await new Promise(r => setTimeout(r, 800));
        panelOpened = true;
      }

      if (!isPanelOpen()) {
        return JSON.stringify({ ok: false, error: 'panel-did-not-open' });
      }

      // ── Select Buy / Sell side ─────────────────────────────────────────────
      const sideDn   = isBuy ? 'side-control-buy' : 'side-control-sell';
      const sideEl   = document.querySelector('[data-name="' + sideDn + '"]');
      if (sideEl) {
        sideEl.click();
        await new Promise(r => setTimeout(r, 250));
      }
      // Verify the correct side is active via aria attributes (class names are obfuscated/unstable)
      function isSideActive(el) {
        if (!el) return false;
        return el.getAttribute('aria-checked')  === 'true' ||
               el.getAttribute('aria-selected') === 'true' ||
               el.getAttribute('aria-pressed')  === 'true';
      }
      const buyCtrl  = document.querySelector('[data-name="side-control-buy"]');
      const sellCtrl = document.querySelector('[data-name="side-control-sell"]');
      const intendedActive = isSideActive(isBuy ? buyCtrl : sellCtrl);
      const oppositeActive = isSideActive(isBuy ? sellCtrl : buyCtrl);
      if (!intendedActive || oppositeActive) {
        if (panelOpened && isPanelOpen()) {
          const closeTrade = [...document.querySelectorAll('button')].find(b =>
            (b.textContent || '').trim() === 'Trade' && (b.className || '').includes('activeArea-')
          );
          if (closeTrade) closeTrade.click();
        }
        return JSON.stringify({ ok: false, error: 'side-not-confirmed', isBuy, intendedActive, oppositeActive, panelOpened });
      }

      // Helper: force-reset a bracket checkbox so React reinitialises the input
      // to a clean state before we write our value.
      async function resetBracket(cb) {
        if (cb.checked) {
          cb.click();                              // uncheck
          await new Promise(r => setTimeout(r, 250));
        }
        cb.click();                                // re-check → fresh default value
        await new Promise(r => setTimeout(r, 400));
      }

      // ── TP bracket: reset → set value ─────────────────────────────────────
      let tpSet = false;
      const tpCheckbox = document.querySelector('[data-qa-id="order-ticket-take-profit-checkbox-bracket"]');
      if (tpCheckbox) {
        await resetBracket(tpCheckbox);
        const tpInput = document.querySelector('[data-qa-id="ui-lib-Input-input order-ticket-take-profit-input"]');
        if (tpInput) {
          if (tpInput.hasAttribute('readonly')) tpInput.removeAttribute('readonly');
          tpInput.focus();
          setReactInput(tpInput, String(targetTicks));
          await new Promise(r => setTimeout(r, 150));
          // Write a second time in case React re-renders on blur resets the value
          setReactInput(tpInput, String(targetTicks));
          tpInput.blur();
          tpSet = true;
        }
      }
      await new Promise(r => setTimeout(r, 200));

      // ── SL bracket: reset → set value ─────────────────────────────────────
      let slSet = false;
      const slCheckbox = document.querySelector('[data-qa-id="order-ticket-stop-loss-checkbox-bracket"]');
      if (slCheckbox) {
        await resetBracket(slCheckbox);
      }

      if (trailingStop) {
        // Switch to trailing-stop mode: find the type toggle near the SL section
        const trailToggle =
          document.querySelector('[data-qa-id*="trailing"]') ||
          [...document.querySelectorAll('[data-name="order-panel"] button, [data-name="order-panel"] [role="radio"]')]
            .find(el => (el.textContent || '').toLowerCase().includes('trail'));
        if (trailToggle) {
          trailToggle.click();
          await new Promise(r => setTimeout(r, 350));
        }
        // Set trailing distance in ticks (same value as static SL)
        const trailInput =
          document.querySelector('[data-qa-id*="trailing"][data-qa-id*="input"]') ||
          document.querySelector('[data-qa-id="ui-lib-Input-input order-ticket-stop-loss-input"]');
        if (trailInput) {
          if (trailInput.hasAttribute('readonly')) trailInput.removeAttribute('readonly');
          trailInput.focus();
          setReactInput(trailInput, String(stopTicks));
          await new Promise(r => setTimeout(r, 150));
          setReactInput(trailInput, String(stopTicks));
          trailInput.blur();
          slSet = true;
        }
      } else {
        // Static stop loss
        const slInput = document.querySelector('[data-qa-id="ui-lib-Input-input order-ticket-stop-loss-input"]');
        if (slInput) {
          if (slInput.hasAttribute('readonly')) slInput.removeAttribute('readonly');
          slInput.focus();
          setReactInput(slInput, String(stopTicks));
          await new Promise(r => setTimeout(r, 150));
          setReactInput(slInput, String(stopTicks));
          slInput.blur();
          slSet = true;
        }
      }
      await new Promise(r => setTimeout(r, 300));

      // ── Verify bracket values took before submitting ───────────────────────
      const tpCheckEl = document.querySelector('[data-qa-id="ui-lib-Input-input order-ticket-take-profit-input"]');
      const tpRead    = tpCheckEl ? parseFloat(tpCheckEl.value) : NaN;
      const tpOk      = Number.isFinite(tpRead) && Math.round(tpRead) === targetTicks;

      const slCheckEl = trailingStop
        ? (document.querySelector('[data-qa-id*="trailing"][data-qa-id*="input"]') ||
           document.querySelector('[data-qa-id="ui-lib-Input-input order-ticket-stop-loss-input"]'))
        : document.querySelector('[data-qa-id="ui-lib-Input-input order-ticket-stop-loss-input"]');
      const slRead    = slCheckEl ? parseFloat(slCheckEl.value) : NaN;
      const slOk      = Number.isFinite(slRead) && Math.round(slRead) === stopTicks;

      if (!tpOk || !slOk) {
        if (panelOpened && isPanelOpen()) {
          const closeTrade = [...document.querySelectorAll('button')].find(b =>
            (b.textContent || '').trim() === 'Trade' && (b.className || '').includes('activeArea-')
          );
          if (closeTrade) closeTrade.click();
        }
        return JSON.stringify({ ok: false, error: 'bracket-not-confirmed', tpRead, slRead, targetTicks, stopTicks, panelOpened });
      }

      // ── Submit via the ORDER PANEL button (not the compact header button) ──
      const placeBtn = document.querySelector('[data-name="place-and-modify-button"]');
      if (!placeBtn) {
        return JSON.stringify({ ok: false, error: 'place-button-not-found', tpSet, slSet });
      }
      placeBtn.click();
      await new Promise(r => setTimeout(r, 500));

      // ── Dismiss any floating chart order widget left by TradingView ────────
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 100));

      // ── Close the panel if we opened it ───────────────────────────────────
      if (panelOpened && isPanelOpen()) {
        const tradeBtn = [...document.querySelectorAll('button')].find(btn =>
          (btn.textContent || '').trim() === 'Trade' && (btn.className || '').includes('activeArea-')
        );
        if (tradeBtn) tradeBtn.click();
      }

      return JSON.stringify({ ok: true, entryPrice, livePrice, stopTicks, targetTicks, tpSet, slSet, panelOpened });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e), stack: (e.stack || '').slice(0, 300) });
    }
  })()
  `;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function sessionBounds(): { openSecs: number; closeSecs: number | null } {
  const session = getSettings().tradeSession ?? 'number';
  if (session === 'all') return { openSecs: 0, closeSecs: null };
  const openSecs  = 8 * 3600 + 45 * 60;
  const closeSecs = session === 'full' ? 15 * 3600 : 11 * 3600 + 30 * 60;
  return { openSecs, closeSecs };
}

function isAutoTradeWindow(): boolean {
  const { openSecs, closeSecs } = sessionBounds();
  if (closeSecs === null) return true;
  const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const totalSecs = ct.getHours() * 3600 + ct.getMinutes() * 60 + ct.getSeconds();
  return totalSecs >= openSecs && totalSecs < closeSecs;
}

export function getTradeWindowStatus(): { inWindow: boolean; remainingSecs: number; opensInSecs: number } {
  const { openSecs, closeSecs } = sessionBounds();
  if (closeSecs === null) return { inWindow: true, remainingSecs: 0, opensInSecs: 0 };
  const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const totalSecs = ct.getHours() * 3600 + ct.getMinutes() * 60 + ct.getSeconds();
  if (totalSecs >= openSecs && totalSecs < closeSecs) {
    return { inWindow: true,  remainingSecs: closeSecs - totalSecs, opensInSecs: 0 };
  }
  const opensInSecs = totalSecs < openSecs ? openSecs - totalSecs : openSecs + 86400 - totalSecs;
  return { inWindow: false, remainingSecs: 0, opensInSecs };
}

export function getCooldownStatus(): { active: boolean; remainingMs: number } {
  const msSinceLast = Date.now() - readLastSubmittedAt();
  const remainingMs = Math.max(0, COOLDOWN_MS - msSinceLast);
  return { active: remainingMs > 0, remainingMs };
}

export async function submitMarketOrder(
  direction: 'long' | 'short',
  stop: number,
  target: number,
  entry = 0,           // Claude's intended entry price; 0 = test mode (fall back to live DOM price)
  trailingStop = false,
  ignoreWindow = false, // true for manual test buttons — bypasses the time window guard
): Promise<'submitted' | 'skipped' | 'error'> {
  console.log(`[order-executor] ▶ direction=${direction} entry=${entry || 'live'} stop=${stop} target=${target}`);

  // Guard 0: non-finite prices
  if (!Number.isFinite(stop) || !Number.isFinite(target)) {
    console.error('[order-executor] ✗ guard-0: invalid prices');
    return 'error';
  }

  // Guard 0b: trading window — skipped for manual test buttons
  if (!ignoreWindow && !isAutoTradeWindow()) {
    console.log('[order-executor] ✗ outside trading window');
    return 'skipped';
  }

  // Guard 1: cooldown
  const lastAt      = readLastSubmittedAt();
  const msSinceLast = Date.now() - lastAt;
  if (msSinceLast < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - msSinceLast) / 1000);
    console.log(`[order-executor] ✗ guard-1: cooldown (${remaining}s remaining)`);
    return 'skipped';
  }
  console.log('[order-executor] ✓ guard-1: cooldown clear');

  // Guard 2: open position check — fails CLOSED.
  // null (panel unreadable) = do not trade blind.
  try {
    const acct = await readAccountData();
    if (!acct) {
      console.log('[order-executor] ✗ guard-2: panel unreadable — skipping (fail-closed)');
      return 'skipped';
    }
    console.log('[order-executor] guard-2: OTE =', acct.unrealizedPnl ?? 'null', 'posTab =', acct.positionsTabCount ?? 'null', 'openPos =', JSON.stringify(acct.openPosition));
    const hasOpenPos =
      acct.openPosition !== null ||
      (acct.positionsTabCount ?? 0) > 0 ||
      (acct.unrealizedPnl !== null && acct.unrealizedPnl !== 0);
    if (hasOpenPos) {
      console.log('[order-executor] ✗ guard-2: position already open — skipping');
      return 'skipped';
    }
  } catch (err) {
    console.warn('[order-executor] guard-2: pnl read failed — skipping (fail-closed):', (err as Error).message);
    return 'skipped';
  }

  // CDP interaction
  let raw: unknown;
  try {
    raw = await evalPage(buildOrderExpr(direction, stop, target, entry, trailingStop));
  } catch (err) {
    console.error('[order-executor] ✗ evalPage threw:', (err as Error).message);
    return 'error';
  }
  console.log('[order-executor] CDP result:', raw);

  let result: {
    ok: boolean;
    error?: string;
    qty?: string;
    entryPrice?: number;
    stopTicks?: number;
    targetTicks?: number;
    tpRead?: number;
    slRead?: number;
    tpSet?: boolean;
    slSet?: boolean;
    panelOpened?: boolean;
    isBuy?: boolean;
    intendedActive?: boolean;
    oppositeActive?: boolean;
  };
  try {
    result = typeof raw === 'string' ? JSON.parse(raw) : { ok: false, error: 'non-string result' };
  } catch {
    result = { ok: false, error: `JSON parse failed: ${String(raw).slice(0, 100)}` };
  }

  // Qty guard failure → notify user
  if (!result.ok && result.error === 'wrong-qty') {
    const msg = `Chart qty is ${result.qty || '?'} — set to 1 before auto-trading`;
    notifyWarn('Auto-trade aborted', msg);
    return 'skipped';
  }

  // Side did not confirm → hard abort, no order placed
  if (!result.ok && result.error === 'side-not-confirmed') {
    notifyWarn('Auto-trade ABORTED', 'Side control did not set — no order was placed');
    return 'error';
  }

  // Bracket did not confirm → hard abort, no order placed
  if (!result.ok && result.error === 'bracket-not-confirmed') {
    notifyWarn('Auto-trade ABORTED', 'Stop/target did not set — no order was placed');
    return 'error';
  }

  if (!result.ok) {
    console.error('[order-executor] ✗ CDP error:', result.error);
    return 'error';
  }

  writeLastSubmittedAt(Date.now());
  const summary = `${direction.toUpperCase()} @ ~${result.entryPrice}  SL ${result.stopTicks}t  TP ${result.targetTicks}t`;
  console.log(`[order-executor] ✓ submitted ${summary}` + (result.panelOpened ? ' [panel auto-opened+closed]' : ' [panel was open]'));
  if (Notification.isSupported()) {
    new Notification({ title: '🟢 Order submitted', body: summary, silent: false }).show();
  }
  return 'submitted';
}
