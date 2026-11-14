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
  const files = [], dates = [], opts = { all: false, verbose: false, fee: null };
  for (const a of argv) {
    if (a === '--all') opts.all = true;
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

/** Prints one session as a labelled block plus a single comparable summary line. */
function printSession(date, s) {
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
}

function main() {
  const { files, dates, opts } = parseArgs(process.argv.slice(2));

  if (files.length === 0 || (dates.length === 0 && !opts.all)) {
    console.error('usage: node scripts/reconcile-session.js <csv-path> <YYYY-MM-DD> [more dates...] [--all] [--fee=0.60] [--verbose]');
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
  for (const d of wanted) printSession(d, oh.sessionSummary(result, d));

  if (opts.verbose) {
    console.log(`\nposition at end of file: ${result.positionAtEnd}`);
    console.log(`open lots at end: ${result.openLotsAtEnd.length ? JSON.stringify(result.openLotsAtEnd) : 'none'}`);
  }
}

main();
