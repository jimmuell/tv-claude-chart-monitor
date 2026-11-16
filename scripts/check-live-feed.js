#!/usr/bin/env node
/**
 * Is the live feed actually working on the AMP account?
 *
 *   npm run check:live-feed            one read
 *   npm run check:live-feed -- --watch re-read every 5s until Ctrl-C
 *
 * READ-ONLY. It evaluates exactly the expression the app's feed uses, which calls only
 * trading(), _activeBroker, orders(), ordersHistory(), allExecutions(), positions() and
 * currentAccount(). Nothing here can place, modify or cancel an order, and it never
 * clicks anything.
 *
 * It prints the three things that actually tell you whether to trust the number:
 *
 *   1. THE SOURCE. AMP keeps the current session in orders(); paper keeps it in
 *      allExecutions(). Reading the wrong one is how TVCM-28's blindness went unnoticed
 *      for fourteen hours, so the collection in use is named every time.
 *   2. THE SHAPE, and whether it was judged at all — a check run on zero rows proves
 *      nothing and now says so instead of printing "OK".
 *   3. THE CROSS-CHECK against the broker's own positions()[*].profit. If TVCM and the
 *      broker disagree, or TVCM finds nothing while the broker reports money or an open
 *      position, that is named here and in the menu bar.
 *
 * With --watch it re-reads every 5s: take one trade and watch "fills" rise WITHOUT
 * touching TradingView's bottom panel.
 */
const path = require('path');
const CDP  = require('chrome-remote-interface');

const liveFeed = require(path.join(__dirname, '..', 'src', 'shared', 'live-feed.js'));
const sessionClock = require(path.join(__dirname, '..', 'src', 'shared', 'session-clock.js'));
const { chicagoStamp } = liveFeed;

const PORT  = Number(process.env.CDP_PORT || 9222);
const WATCH = process.argv.includes('--watch');
const JSON_OUT = process.argv.includes('--json');

/** Reads once over CDP and returns the parsed payload. */
async function readOnce() {
  const targets = await CDP.List({ port: PORT });
  const page = targets.find(t => t.type === 'page' && /tradingview\.com\/chart/.test(t.url || ''));
  if (!page) throw new Error(`no TradingView chart tab on port ${PORT} — is TradingView running with --remote-debugging-port=${PORT}?`);
  const c = await CDP({ port: PORT, target: page });
  try {
    await c.Runtime.enable();
    const r = await c.Runtime.evaluate({
      expression: liveFeed.liveFeedExpression(), returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return JSON.parse(r.result.value);
  } finally {
    await c.close();
  }
}

/** Prints one reading in the few lines that actually answer the two questions. */
function report(p) {
  if (JSON_OUT) { console.log(JSON.stringify(p)); return; }

  const brokerId = p.brokerId == null ? '(none)' : p.brokerId;
  const label = brokerId === 'amp' ? 'AMP LIVE'
    : brokerId === 'paper' ? 'paper'
    : brokerId === 'replaybroker' ? 'BAR REPLAY — the feed does not read replay'
    : brokerId === '' ? 'no broker connected — press Connect in TradingView'
    : 'UNRECOGNISED — TVCM will not read this';
  console.log(`_brokerId        ${brokerId === '' ? '(empty)' : brokerId}   (${label})`);
  console.log(`account          ${p.account == null ? '(none)' : p.account}`);

  if (p.error) { console.log(`\nERROR            ${p.error}  ${p.message || ''}`); return; }

  // Which collection this broker's fills actually live in. AMP keeps the current
  // session in orders(); paper keeps it in allExecutions(). Reading the wrong one is
  // how TVCM-28's blindness went unnoticed for fourteen hours.
  const source = liveFeed.feedSourceFor(brokerId);
  const rows = source === 'orders'
    ? [...(p.orders || []), ...(p.ordersHistory || [])]
    : (p.executions || []);
  console.log(`source           ${source}()  ` + (source === 'orders'
    ? `— orders ${(p.orders || []).length}, history ${(p.ordersHistory || []).length}${p.historyTruncated ? ` of ${p.historyTotal} (capped)` : ''}`
    : `— executions ${(p.executions || []).length}`));

  const shape = source === 'orders' ? liveFeed.detectOrderShape(rows) : liveFeed.detectExecutionShape(rows);
  console.log(`shape            ${shape.ok ? (shape.empty ? 'NOT JUDGED — nothing was returned' : `OK (${shape.sampled} row(s) checked)`) : 'MISMATCH'}`);
  if (!shape.ok) {
    if (shape.notAnArray)      console.log('                 the reply was not a list');
    if (shape.missing.length)  console.log(`                 missing field(s): ${shape.missing.join(', ')}`);
    if (shape.badTypes.length) console.log(`                 wrong type(s):    ${shape.badTypes.join(', ')}`);
    console.log('                 >>> TVCM will refuse to read this and fall back to the CSV import.');
  }

  // Price it exactly as the app does, for the current session.
  const feed = liveFeed.analyseFeed(p, { perContractSideFee: 0.60 });
  const today = sessionClock.currentSessionDate(new Date());
  const s = (feed.result.sessions || []).find(x => x.sessionDate === today) || null;
  console.log(`session          ${today}`);
  console.log(`fills found      ${s ? s.fillCount : 0}${feed.skipped.length ? `  (${feed.skipped.length} unreadable)` : ''}`);
  if (s) {
    console.log(`  contracts      ${s.contractSides} sides (${s.contractSides / 2} RT)`);
    console.log(`  gross / fees   $${s.grossPnl.toFixed(2)} / $${s.fees.toFixed(2)}`);
    console.log(`  NET            $${s.netPnl.toFixed(2)}`);
  }

  const brokerProfit = liveFeed.sumBrokerProfit(p.positions);
  const openQty = liveFeed.sumOpenQty(p.positions);
  console.log(`open contracts   ${openQty == null ? '(unknown)' : openQty}`);
  const check = liveFeed.crossCheck({
    fillCount: s ? s.fillCount : 0,
    engineGross: s ? s.grossPnl : 0,
    brokerProfit, openQty,
    positionsAvailable: p.positionsAvailable !== false && Array.isArray(p.positions),
  });
  console.log(`broker says      ${brokerProfit == null ? '(no position rows)' : '$' + brokerProfit.toFixed(2) + ' realized'}`);
  console.log(`cross-check      ${check.state.toUpperCase()}${check.code ? '  ' + check.code : ''}`);
  if (check.message && check.state !== 'ok') console.log(`                 ${check.message}`);

  // Filled rows only: an unfilled order has qty 0 at price 0 and tells Jim nothing.
  const newest = rows.filter(filledRow).sort((a, b) => fillMs(b) - fillMs(a)).slice(0, 3);
  if (newest.length === 0) { console.log('\nnewest 3         (nothing on this account yet)'); return; }
  console.log('\nnewest 3         side  qty  price       time (CT)');
  for (const e of newest) {
    const side = e.side === 1 ? 'Buy ' : e.side === -1 ? 'Sell' : String(e.side);
    const qty = source === 'orders' ? e.filledQty : e.qty;
    const px  = source === 'orders' ? e.avgPrice : e.price;
    const ms  = fillMs(e);
    const when = Number.isFinite(ms) ? chicagoStamp(ms) : '(no time)';
    console.log(`                 ${side}  ${String(qty).padEnd(4)} ${String(px).padEnd(11)} ${when}`);
  }
}

/** True when a row actually filled something, whichever collection it came from. */
function filledRow(row) {
  if (!row) return false;
  const q = row.filledQty === undefined ? row.qty : row.filledQty;
  return Number(q) > 0;
}

/** When a row filled, whichever collection it came from. */
function fillMs(row) {
  if (!row) return NaN;
  if (row.statusTime) return Date.parse(row.statusTime);
  return Number(row.time);
}

(async () => {
  if (!WATCH) {
    try { report(await readOnce()); } catch (err) { console.error('check:live-feed failed —', err.message); process.exit(1); }
    return;
  }
  console.log('Watching every 5s. Take ONE trade and watch "fills" go up without');
  console.log('touching TradingView\'s bottom panel. Ctrl-C to stop.\n');
  let last = null;
  for (;;) {
    try {
      const p = await readOnce();
      // Count whichever collection this broker actually uses — counting executions on
      // AMP is exactly the mistake that hid the problem for fourteen hours.
      const rows = liveFeed.feedSourceFor(p.brokerId) === 'orders'
        ? [...(p.orders || []), ...(p.ordersHistory || [])]
        : (p.executions || []);
      const n = rows.filter(filledRow).length;
      const stamp = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour12: false });
      if (n !== last) {
        console.log(`\n=== ${stamp} CT — fills ${last == null ? 'first read' : `${last} -> ${n}`} ===`);
        report(p);
        last = n;
      } else {
        process.stdout.write(`\r${stamp} CT  fills ${n}  (no change)   `);
      }
    } catch (err) {
      console.log(`\n${new Date().toISOString()}  read failed — ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
})();
