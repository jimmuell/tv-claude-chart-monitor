#!/usr/bin/env node
'use strict';

// check-live-safety.js — `npm run check:safety`
//
// Prints the handful of settings that decide whether the app can place an order,
// and nothing else. Run it before any live session.
//
// It reads settings.json directly but prints ONLY an allow-list of fields. The
// settings file can contain an API key override, so nothing outside that list is
// ever read into the output — no dumping the object, no iterating its keys.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const SETTINGS_PATH = path.join(
  os.homedir(), 'Library/Application Support/trading-analyzer/settings.json');
const DB_PATH = path.join(
  os.homedir(), 'Library/Application Support/trading-analyzer/trades.db');

/** Read settings, returning {} when absent so defaults apply. */
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { return {}; }
}

/** Most recent account type the app recorded, or null when unknown. */
function readAccountType() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const row = db.prepare(
      'SELECT account_type FROM recommendations WHERE account_type IS NOT NULL ORDER BY id DESC LIMIT 1').get();
    db.close();
    return row ? row.account_type : null;
  } catch { return null; }
}

/** true/false with a clear marker when the answer is dangerous. */
function flag(name, value, dangerousWhen) {
  const bad = value === dangerousWhen;
  return `  ${name.padEnd(20)} ${String(value).padEnd(6)} ${bad ? '  <<< MUST BE ' + !dangerousWhen : ''}`;
}

function main() {
  const s = readSettings();
  // Defaults mirror src/main/settings.ts so a missing key reads as the default.
  const autoTrade         = s.autoTrade === true;
  const autoTradeTestMode = s.autoTradeTestMode === true;
  const notifications     = s.notifications !== false;
  const r = s.rules || {};
  const account = readAccountType();

  console.log('TV Chart Monitor — live safety check');
  console.log('');
  console.log('Order paths (both must be false before a live session):');
  console.log(flag('autoTrade', autoTrade, true));
  console.log(flag('autoTradeTestMode', autoTradeTestMode, true));
  console.log('');
  console.log('Other:');
  console.log(`  notifications        ${notifications}`);
  console.log(`  account (last seen)  ${account === null ? 'unknown' : account}`);
  console.log('');
  console.log('Rules lever:');
  console.log(`  enabled              ${r.enabled !== false}`);
  console.log(`  windowStart          ${r.windowStart ?? '08:30'} CT`);
  console.log(`  windowEnd            ${r.windowEnd ?? '11:00'} CT`);
  console.log(`  minConfidence        ${r.minConfidence ?? 0}`);
  console.log(`  blockedSetupKeys     ${JSON.stringify(r.blockedSetupKeys ?? [])}`);
  console.log('');

  const unsafe = autoTrade || autoTradeTestMode;
  console.log(unsafe
    ? 'RESULT: UNSAFE — an order can be placed. Turn both flags off before trading.'
    : 'RESULT: SAFE — the app cannot place an order.');
  process.exitCode = unsafe ? 1 : 0;
}

if (require.main === module) main();
module.exports = { readSettings, readAccountType };
