'use strict';

// Always-on log file: redaction, rotation and Chicago timestamps.
// The redaction tests are the important ones — a log that leaks a key is worse
// than no log at all.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tvcm-log-'));

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return originalLoad.apply(this, arguments);
};

const logger = require(path.join(__dirname, '../../dist/main/main/logger'));
const { redact, chicagoStamp, logLine, logFilePath, logDir } = logger;

// ── Redaction ─────────────────────────────────────────────────────────────

const FAKE_ANTHROPIC = 'sk-ant-api03-FAKEKEYFAKEKEYFAKEKEY1234567890abcdef';
const FAKE_GEMINI    = 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345';

test('an Anthropic-shaped key never survives redaction', () => {
  const out = redact(`calling provider with key ${FAKE_ANTHROPIC} ok`);
  assert.ok(!out.includes(FAKE_ANTHROPIC), 'the key is still in the text');
  assert.ok(out.includes('[REDACTED]'));
});

test('a Gemini-shaped key never survives redaction', () => {
  const out = redact(`GEMINI_API_KEY=${FAKE_GEMINI}`);
  assert.ok(!out.includes(FAKE_GEMINI));
  assert.ok(out.includes('[REDACTED]'));
});

test('json and bearer forms are redacted', () => {
  assert.ok(!redact('{"apiKey":"hunter2secretvalue"}').includes('hunter2secretvalue'));
  assert.ok(!redact('authorization: Bearer abcdef1234567890').includes('abcdef1234567890'));
  assert.ok(!redact("{ token: 'tok_live_9999' }").includes('tok_live_9999'));
});

test('account numbers are redacted but the account TYPE is kept', () => {
  const out = redact('accountNumber=APEX-558821 accountType=amp_live');
  assert.ok(!out.includes('APEX-558821'), 'account number leaked');
  assert.ok(out.includes('amp_live'), 'the safety-relevant account type must stay readable');
});

test('ordinary analysis text is left alone', () => {
  const line = '[analysis] ES 6012.25 verdict=valid_long rr=2.1R rules_version=b33231d8';
  assert.strictEqual(redact(line), line);
});

// ── The end-to-end promise: a fake key cannot reach the file ──────────────

test('a fake key written through logLine never reaches the log file', () => {
  logLine('error', `provider failed, key was ${FAKE_ANTHROPIC}`);
  const text = fs.readFileSync(logFilePath(), 'utf8');
  assert.ok(!text.includes(FAKE_ANTHROPIC), 'the key reached the log file');
  assert.ok(text.includes('[REDACTED]'));
});

// ── Timestamps ────────────────────────────────────────────────────────────

test('timestamps are ISO-8601 in America/Chicago', () => {
  // 2026-10-27T12:30:00Z is 07:30 CDT (-05:00).
  const stamp = chicagoStamp(new Date('2026-10-27T12:30:00.123Z'));
  assert.strictEqual(stamp, '2026-10-27T07:30:00.123-05:00');
});

test('timestamps follow the DST change into CST', () => {
  // 2026-12-15T12:30:00Z is 06:30 CST (-06:00).
  const stamp = chicagoStamp(new Date('2026-12-15T12:30:00.000Z'));
  assert.strictEqual(stamp, '2026-12-15T06:30:00.000-06:00');
});

// ── Rotation ──────────────────────────────────────────────────────────────

test('the live file rotates once it passes the size cap and keeps 5 files', () => {
  fs.mkdirSync(logDir(), { recursive: true });
  // Four rotations, each preceded by an over-cap file.
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(logFilePath(), 'x'.repeat(1024 * 1024 + 1));
    logger.rotateIfNeeded();
    logLine('log', `after rotation ${i}`);
  }
  const files = fs.readdirSync(logDir()).filter(f => f.startsWith('main') && f.endsWith('.log'));
  assert.ok(files.includes('main.log'), 'the live file must exist');
  assert.ok(files.length <= 5, `kept ${files.length} files: ${files.join(', ')}`);
  assert.ok(!files.includes('main.5.log'), 'rotation must not grow past main.4.log');
});

test('logging never throws even when the folder cannot be written', () => {
  assert.doesNotThrow(() => logLine('error', 'still fine'));
});

// ── Every console line carries the Chicago clock (TVCM-47) ──────────────
//
// TVCM-45 §4.4 complained that log lines had no times. That was only half right: the
// app's OWN log file has carried full ISO CT stamps since logger.ts was written — what
// had none was stdout, which is what a `npm run dev` run captures and what the report was
// actually reading. initLogger() now stamps both.

test('the stamp is the Chicago wall clock, in 24-hour form', () => {
  const { logStamp } = require(path.join(__dirname, '../../dist/main/main/logger.js'));
  // 2026-11-18T13:36:19Z is 07:36:19 CT (CST, UTC-6).
  assert.strictEqual(logStamp(Date.parse('2026-11-18T13:36:19Z')), '07:36:19');
  // And in July it is CDT (UTC-5), so the same UTC instant is an hour later.
  assert.strictEqual(logStamp(Date.parse('2026-07-15T13:36:19Z')), '08:36:19');
});

test('initLogger prefixes stdout as well as the file', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/logger.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export function initLogger'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /original\(`\$\{logStamp\(\)\} CT`, \.\.\.args\)/,
    'the console line must carry the time');
  assert.match(body, /logLine\(level, formatArgs\(args\)\)/,
    'and the file still gets the full ISO stamp from logLine');
});
