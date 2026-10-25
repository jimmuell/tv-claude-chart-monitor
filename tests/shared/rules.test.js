'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateRules, rulesVersion, DEFAULT_RULES } = require('../../src/shared/rules');

// 2026-10-20 is a Tuesday. Times below are America/Chicago.
const at = (hh, mm) => Math.floor(Date.UTC(2026, 9, 20, hh + 5, mm, 0) / 1000); // CDT = UTC-5
const call = (over = {}) => ({
  setup_key: 'hammer', confidence: 0.8, verdict: 'valid_long',
  bar_time: at(9, 0), ...over,
});

test('a clean call inside the window is allowed', () => {
  const v = evaluateRules(call(), DEFAULT_RULES);
  assert.strictEqual(v.blocked, false);
  assert.strictEqual(v.reason, null);
});

test('a blocked setup_key is blocked, and the reason names the setup', () => {
  const rules = { ...DEFAULT_RULES, blockedSetupKeys: ['hammer'] };
  const v = evaluateRules(call({ setup_key: 'hammer' }), rules);

  assert.strictEqual(v.blocked, true);
  assert.match(v.reason, /hammer/, 'the reason must name the rule that fired');
  assert.match(v.reason, /setup/i);
});

test('confidence below the minimum is blocked', () => {
  const rules = { ...DEFAULT_RULES, minConfidence: 0.7 };
  assert.strictEqual(evaluateRules(call({ confidence: 0.69 }), rules).blocked, true);
  assert.strictEqual(evaluateRules(call({ confidence: 0.70 }), rules).blocked, false,
    'exactly at the minimum is allowed');
  assert.match(evaluateRules(call({ confidence: 0.4 }), rules).reason, /confidence/i);
});

test('a call outside the Chicago window is blocked at both ends', () => {
  // default window 08:30-11:00 CT
  assert.strictEqual(evaluateRules(call({ bar_time: at(8, 29) }), DEFAULT_RULES).blocked, true);
  assert.strictEqual(evaluateRules(call({ bar_time: at(8, 30) }), DEFAULT_RULES).blocked, false);
  assert.strictEqual(evaluateRules(call({ bar_time: at(10, 59) }), DEFAULT_RULES).blocked, false);
  assert.strictEqual(evaluateRules(call({ bar_time: at(11, 0) }), DEFAULT_RULES).blocked, true,
    'the window end is exclusive');
  assert.match(evaluateRules(call({ bar_time: at(14, 0) }), DEFAULT_RULES).reason, /window|time/i);
});

test('the window is evaluated in Chicago time, not the machine timezone', () => {
  // 14:00 UTC on this date is 09:00 CT — inside the window wherever this runs.
  const nineCt = Math.floor(Date.UTC(2026, 9, 20, 14, 0, 0) / 1000);
  assert.strictEqual(evaluateRules(call({ bar_time: nineCt }), DEFAULT_RULES).blocked, false);
});

test('only the first failing rule is reported, in a stable order', () => {
  const rules = { ...DEFAULT_RULES, blockedSetupKeys: ['hammer'], minConfidence: 0.9 };
  // Breaks setup AND confidence AND window.
  const v = evaluateRules(call({ confidence: 0.1, bar_time: at(15, 0) }), rules);
  assert.strictEqual(v.blocked, true);
  assert.match(v.reason, /setup/i, 'setup is checked first so the reason is predictable');
});

test('rules can be turned off entirely', () => {
  const rules = { ...DEFAULT_RULES, enabled: false, blockedSetupKeys: ['hammer'], minConfidence: 0.99 };
  const v = evaluateRules(call({ confidence: 0.1, bar_time: at(23, 0) }), rules);
  assert.strictEqual(v.blocked, false, 'disabled rules block nothing');
});

test('a missing setup_key or confidence does not crash or silently pass a block', () => {
  const rules = { ...DEFAULT_RULES, minConfidence: 0.5 };
  assert.strictEqual(evaluateRules(call({ confidence: null }), rules).blocked, true,
    'an unknown confidence cannot satisfy a minimum');
  assert.strictEqual(evaluateRules(call({ setup_key: null }), DEFAULT_RULES).blocked, false);
});

// ── rules_version ────────────────────────────────────────────────────────────

test('rules_version is short, stable and deterministic', () => {
  const a = rulesVersion(DEFAULT_RULES, '0.1.0');
  const b = rulesVersion(DEFAULT_RULES, '0.1.0');
  assert.strictEqual(a, b, 'same input must always give the same version');
  assert.match(a, /^[0-9a-f]{8}$/, 'short hex hash');
});

test('rules_version changes when any rule changes', () => {
  const base = rulesVersion(DEFAULT_RULES, '0.1.0');
  const variants = [
    { ...DEFAULT_RULES, blockedSetupKeys: ['hammer'] },
    { ...DEFAULT_RULES, minConfidence: 0.75 },
    { ...DEFAULT_RULES, windowStart: '09:00' },
    { ...DEFAULT_RULES, windowEnd: '12:00' },
    { ...DEFAULT_RULES, enabled: false },
  ];
  for (const v of variants) {
    assert.notStrictEqual(rulesVersion(v, '0.1.0'), base,
      `version must move for ${JSON.stringify(v)}`);
  }
});

test('rules_version changes when the app version changes', () => {
  assert.notStrictEqual(rulesVersion(DEFAULT_RULES, '0.1.0'), rulesVersion(DEFAULT_RULES, '0.2.0'));
});

test('rules_version ignores key order and blocked-list order', () => {
  const a = rulesVersion({ ...DEFAULT_RULES, blockedSetupKeys: ['doji', 'hammer'] }, '0.1.0');
  const b = rulesVersion({ blockedSetupKeys: ['hammer', 'doji'], ...DEFAULT_RULES,
                           blockedSetupKeys2: undefined, ...{ blockedSetupKeys: ['hammer', 'doji'] } }, '0.1.0');
  assert.strictEqual(a, b, 'the same rules written differently must hash the same');
});
