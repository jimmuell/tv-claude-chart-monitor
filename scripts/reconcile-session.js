#!/usr/bin/env node
'use strict';

/**
 * Prints one trading session's P&L from a TradingView Order history export, so the
 * numbers can be put next to a broker statement and compared line by line.
 *
 * Usage:
 *   node scripts/reconcile-session.js <csv-path> <YYYY-MM-DD> [more dates...]
 *   node scripts/reconcile-session.js <csv-path> --all
 *
 * Options:
 *   --trades    list every flat-to-flat trade in the session, with its own net
 *   --fee=<n>   $ per contract per side (default 0.60, AMP's rate)
 *   --verbose   also list skipped rows and the position carried in/out
 *
 * Several exports can be passed before the dates, oldest first; a repeated
 * Order ID is taken from the later file. Reads only — nothing is written.
 */

const fs   = require('fs');
const path = require('path');
const oh   = require(path.join(__dirname, '..', 'src', 'shared', 'order-history.js'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Splits argv into csv paths, session dates and flags. */
function parseArgs(argv) {
  const files = [], dates = [], opts = { all: false, verbose: false, fee: null, trades: false };
  for (const a of argv) {
    if (a === '--all') opts.all = true;
    else if (a === '--trades') opts.trades = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a.startsWith('--fee=')) opts.fee = Number(a.slice(6));
    else if (DATE_RE.test(a)) dates.push(a);
    else files.push(a);
  }
  return { files, dates, opts };
}

/** Money with an explicit sign, so +1296.25 never reads as 1296.25 by accident. */
const signed = (n) => (n < 0 ? '-' : '+') + Math.abs(n).toFixed(2);
/** Prices to 4 decimals, which is where an average fill price stops being noise. */
const px = (n) => (n == null ? 'n/a' : n.toFixed(4));

/** The calendar day a session opens on — the day before the one it is named for. */
function priorDay(dateText) {
  const [y, m, d] = dateText.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

/** A fill time trimmed to HH:MM:SS, since the date is already the session heading. */
const clock = (t) => (t ? String(t).slice(11) : '—');

/**
 * Prints every flat-to-flat trade in a session, then reconciles the sum of their nets
 * against the session total. The two agree unless a trade spans the 17:00 boundary,
 * and the difference is spelled out rather than hidden.
 */
function printTrades(result, date, session) {
  const trades = oh.sessionTrades(result, date, { includeOpen: true });
  if (trades.length === 0) { console.log('\n  (no trades closed in this session)'); return; }

  console.log(`\n  ${trades.length} trade(s)  —  a trade is flat-to-flat; it belongs to the session it CLOSED in`);
  console.log('   #   dir    open      close     size  sides   avg entry    avg exit      gross      fees        net  flags');
  for (const t of trades) {
    const flags = [t.status === 'OPEN' ? 'OPEN' : '', t.crossesBoundary ? `CROSSES from ${t.openSessionDate}` : '']
      .filter(Boolean).join(' ');
    console.log(
      `${String(t.id).padStart(4)}  ${t.direction.padEnd(5)}  ${clock(t.openTime)}  ${clock(t.closeTime)}` +
      `  ${String(t.maxPositionSize).padStart(4)}  ${String(t.contractSides).padStart(5)}` +
      `  ${px(t.avgEntry).padStart(10)}  ${px(t.avgExit).padStart(10)}` +
      `  ${(t.gross == null ? '—' : signed(t.gross)).padStart(9)}  ${t.fees.toFixed(2).padStart(8)}` +
      `  ${(t.net == null ? '—' : signed(t.net)).padStart(9)}  ${flags}`);
  }

  const x = session.tradeReconciliation;
  console.log(`\n  ── trades vs session ──`);
  console.log(`  closed trades            ${x.tradeCount}${x.openTradeIds.length ? `  (+${x.openTradeIds.length} still open: #${x.openTradeIds.join(', #')})` : ''}`);
  console.log(`  sum of trade gross       ${signed(x.tradesGross)}     session gross  ${signed(x.sessionGross)}`);
  console.log(`  sum of trade fees        ${x.tradesFees.toFixed(2)}     session fees   ${x.sessionFees.toFixed(2)}`);
  console.log(`  sum of trade net         ${signed(x.tradesNet)}     session net    ${signed(x.sessionNet)}`);
  if (x.balanced) {
    console.log(`  difference               none — the two views agree to the cent`);
  } else {
    console.log(`  difference               ${signed(x.netDelta)}`);
    if (x.outbound.tradeIds.length) {
      console.log(`    outbound  ${signed(x.outbound.gross)} gross / ${x.outbound.sides} sides — counted here, realized in an earlier session (trade #${x.outbound.tradeIds.join(', #')})`);
    }
    if (x.inbound.tradeIds.length) {
      console.log(`    inbound   ${signed(x.inbound.gross)} gross / ${x.inbound.sides} sides — realized here, counted in a later session (trade #${x.inbound.tradeIds.join(', #')})`);
    }
    console.log(`    boundary accounts for  ${signed(x.boundaryNet)}`);
    console.log(`    per-trade rounding     ${signed(x.roundingDelta)}`);
    console.log(`    fully explained        ${x.explained ? 'yes' : `NO — ${x.warning}`}`);
  }

  const best  = trades.filter(t => t.net != null).reduce((a, t) => (a && a.net >= t.net ? a : t), null);
  const worst = trades.filter(t => t.net != null).reduce((a, t) => (a && a.net <= t.net ? a : t), null);
  if (best)  console.log(`  best trade               #${best.id} ${signed(best.net)} (${best.direction})`);
  if (worst) console.log(`  worst trade              #${worst.id} ${signed(worst.net)} (${worst.direction})`);
}

/** Prints one session as a labelled block plus a single comparable summary line. */
function printSession(date, s, result, opts) {
  if (!s) {
    console.log(`\n${date}  — no fills in this session (TVCM-OH-NO-ROWS)`);
    return;
  }
  console.log(`\n── session ${date}  (17:00 CT ${priorDay(date)} → 17:00 CT ${date}) ──`);
  console.log(`  fills            ${s.fillCount}`);
  console.log(`  buys             ${s.buys}`);
  console.log(`  sells            ${s.sells}`);
  console.log(`  avg buy          ${px(s.avgBuy)}`);
  console.log(`  avg sell         ${px(s.avgSell)}`);
  console.log(`  gross realized   ${signed(s.grossPnl)}`);
  console.log(`  contract-sides   ${s.contractSides}`);
  console.log(`  fees             ${s.fees.toFixed(2)}`);
  console.log(`  net              ${signed(s.netPnl)}`);
  console.log(`  open position    ${s.openPositionAtEnd}`);
  console.log(
    `  SUMMARY: buys ${s.buys}, sells ${s.sells}, avg buy ${px(s.avgBuy)}, ` +
    `avg sell ${px(s.avgSell)}, gross ${signed(s.grossPnl)}, fees ${s.fees.toFixed(2)}, ` +
    `net ${signed(s.netPnl)}, open position ${s.openPositionAtEnd}`
  );
  if (opts && opts.trades) printTrades(result, date, s);
}

function main() {
  const { files, dates, opts } = parseArgs(process.argv.slice(2));

  if (files.length === 0 || (dates.length === 0 && !opts.all)) {
    console.error('usage: node scripts/reconcile-session.js <csv-path> <YYYY-MM-DD> [more dates...] [--all] [--trades] [--fee=0.60] [--verbose]');
    process.exit(2);
  }

  const texts = [];
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error(`no such file: ${f}`); process.exit(2); }
    texts.push(fs.readFileSync(f, 'utf8'));
  }

  const rate = opts.fee == null ? oh.DEFAULT_PER_CONTRACT_SIDE_FEE : opts.fee;
  const result = oh.analyseOrderHistory(texts, { perContractSideFee: rate, sourceNames: files.map(f => path.basename(f)) });

  console.log(`source${files.length > 1 ? 's' : ''}: ${files.map(f => path.basename(f)).join(', ')}`);
  console.log(`fills: ${result.fills.length}   fee rate: $${rate.toFixed(2)}/contract/side   sessions: ${result.sessions.length}`);

  for (const e of result.errors) console.error(`  ERROR ${e}`);
  if (result.skipped.length > 0) {
    console.error(`  WARNING ${result.skipped.length} row(s) reported a fill but could not be read — totals are incomplete:`);
    result.skipped.slice(0, 5).forEach(s => console.error(`    line ${s.line} (${s.source}): ${s.reason}`));
    if (result.skipped.length > 5) console.error(`    ... and ${result.skipped.length - 5} more`);
  }
  if (result.replaced.length > 0) {
    console.log(`  ${result.replaced.length} duplicate Order ID(s) replaced by a later export`);
  }

  const wanted = opts.all ? result.sessions.map(s => s.sessionDate) : dates;
  for (const d of wanted) printSession(d, oh.sessionSummary(result, d), result, opts);

  if (opts.verbose) {
    console.log(`\nposition at end of file: ${result.positionAtEnd}`);
    console.log(`open lots at end: ${result.openLotsAtEnd.length ? JSON.stringify(result.openLotsAtEnd) : 'none'}`);
  }
}

main();
