#!/usr/bin/env node
/**
 * Is the live feed actually working on the AMP account?
 *
 *   npm run check:live-feed            one read
 *   npm run check:live-feed -- --watch re-read every 5s until Ctrl-C
 *
 * READ-ONLY. It evaluates exactly the expression the app's feed uses, which calls only
 * trading(), _activeBroker, allExecutions(), positions() and currentAccount(). Nothing
 * here can place, modify or cancel an order, and it never clicks anything.
 *
 * Two things were never provable before a live session, and this is how to settle them:
 *
 *   1. THE AMP SHAPE. Everything was measured on the paper broker. If AMP's adapter
 *      returns different fields, the "shape" line below says so by name, and the app
 *      shows "can't read this TradingView version" rather than inventing a number.
 *   2. THAT A NEW FILL APPEARS BY ITSELF. Run with --watch, take one trade, and watch
 *      the execution count go up WITHOUT touching TradingView's bottom panel. If it
 *      does not move, the feed cannot drive the current session and the CSV import has
 *      to stay the source of truth.
 */
const path = require('path');
const CDP  = require('chrome-remote-interface');

const liveFeed = require(path.join(__dirname, '..', 'src', 'shared', 'live-feed.js'));
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
    : 'UNRECOGNISED — TVCM will not read this';
  console.log(`_brokerId        ${brokerId}   (${label})`);
  console.log(`account          ${p.account == null ? '(none)' : p.account}`);

  if (p.error) { console.log(`\nERROR            ${p.error}  ${p.message || ''}`); return; }

  const execs = Array.isArray(p.executions) ? p.executions : [];
  console.log(`executions       ${execs.length}`);
  console.log(`open positions   ${p.openPositionCount == null ? '(unknown)' : p.openPositionCount}`);

  const shape = liveFeed.detectExecutionShape(execs);
  console.log(`shape            ${shape.ok ? 'OK — matches what TVCM-25 measured on paper' : 'MISMATCH'}`);
  if (!shape.ok) {
    if (shape.notAnArray)        console.log('                 the reply was not a list of executions');
    if (shape.missing.length)    console.log(`                 missing field(s): ${shape.missing.join(', ')}`);
    if (shape.badTypes.length)   console.log(`                 wrong type(s):    ${shape.badTypes.join(', ')}`);
    console.log('                 >>> TVCM will refuse to read this and fall back to the CSV import.');
  }
  if (shape.pointValueMissing)   console.log('                 note: no pointValue — the fee model supplies one, so this is survivable');

  const newest = execs.slice().sort((a, b) => Number(b.time) - Number(a.time)).slice(0, 3);
  if (newest.length === 0) {
    console.log('\nnewest 3         (no executions on this account yet)');
    return;
  }
  console.log('\nnewest 3         side  qty  price       time (CT)');
  for (const e of newest) {
    const side = e.side === 1 ? 'Buy ' : e.side === -1 ? 'Sell' : String(e.side);
    const when = Number.isFinite(Number(e.time)) ? chicagoStamp(Number(e.time)) : String(e.time);
    console.log(`                 ${side}  ${String(e.qty).padEnd(4)} ${String(e.price).padEnd(11)} ${when}`);
  }
}

(async () => {
  if (!WATCH) {
    try { report(await readOnce()); } catch (err) { console.error('check:live-feed failed —', err.message); process.exit(1); }
    return;
  }
  console.log('Watching every 5s. Take ONE trade and watch "executions" go up without');
  console.log('touching TradingView\'s bottom panel. Ctrl-C to stop.\n');
  let last = null;
  for (;;) {
    try {
      const p = await readOnce();
      const n = Array.isArray(p.executions) ? p.executions.length : null;
      const stamp = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour12: false });
      if (n !== last) {
        console.log(`\n=== ${stamp} CT — executions ${last == null ? 'first read' : `${last} -> ${n}`} ===`);
        report(p);
        last = n;
      } else {
        process.stdout.write(`\r${stamp} CT  executions ${n}  (no change)   `);
      }
    } catch (err) {
      console.log(`\n${new Date().toISOString()}  read failed — ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
})();
