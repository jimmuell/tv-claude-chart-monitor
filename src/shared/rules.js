'use strict';
// rules.js
//
// The lever. Analysis produces a call; these rules decide whether the app would
// have ACTED on it. A blocked call is still saved and still graded — "shadow
// grading" — so the scorecard can answer the only question that matters when
// tightening rules: would blocking this have helped or hurt?
//
// Rules are applied AFTER analysis, never before. The model is not told about
// them, so blocking cannot change what it says — which keeps allowed and
// blocked calls comparable.
//
// rules_version ties every saved call to the exact rules in force when it was
// made. It is part of the dedup key, so re-running the same replay day under new
// rules is a fair re-test rather than a silent no-op, while re-running it under
// the SAME rules still cannot double count.

const crypto = require('crypto');

/** Default lever: the 08:30–11:00 Chicago window only, nothing blocked. */
const DEFAULT_RULES = {
  enabled:          true,
  blockedSetupKeys: [],
  minConfidence:    0,
  windowStart:      '08:30',   // America/Chicago, inclusive
  windowEnd:        '11:00',   // America/Chicago, exclusive
};

/** Minutes past midnight for "HH:MM", or null when unparseable. */
function parseHhMm(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Minutes past midnight of an epoch-seconds timestamp, in America/Chicago.
 * Uses Intl so DST is handled by the platform rather than guessed.
 */
function chicagoMinutes(epochSeconds) {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(epochSeconds * 1000));
  const h = Number(parts.find((p) => p.type === 'hour')?.value);
  const m = Number(parts.find((p) => p.type === 'minute')?.value);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return (h % 24) * 60 + m;
}

/**
 * Decide whether a call breaks the rules. Returns { blocked, reason }.
 * Checks run in a fixed order so the reason is predictable when several fail.
 */
function evaluateRules(call, rules) {
  const r = { ...DEFAULT_RULES, ...(rules || {}) };
  if (r.enabled === false) return { blocked: false, reason: null };

  // 1. blocked setups
  const blockedKeys = Array.isArray(r.blockedSetupKeys) ? r.blockedSetupKeys : [];
  if (call && call.setup_key && blockedKeys.includes(call.setup_key)) {
    return { blocked: true, reason: `setup "${call.setup_key}" is blocked` };
  }

  // 2. minimum confidence — an unknown confidence cannot satisfy a minimum
  const min = typeof r.minConfidence === 'number' ? r.minConfidence : 0;
  if (min > 0) {
    const c = call ? call.confidence : null;
    if (typeof c !== 'number' || !Number.isFinite(c)) {
      return { blocked: true, reason: `confidence unknown, minimum is ${min}` };
    }
    if (c < min) {
      return { blocked: true, reason: `confidence ${c.toFixed(2)} below minimum ${min}` };
    }
  }

  // 3. trading window, in Chicago time
  const start = parseHhMm(r.windowStart);
  const end   = parseHhMm(r.windowEnd);
  if (start !== null && end !== null) {
    const mins = chicagoMinutes(call ? call.bar_time : null);
    if (mins !== null && (mins < start || mins >= end)) {
      const hh = String(Math.floor(mins / 60)).padStart(2, '0');
      const mm = String(mins % 60).padStart(2, '0');
      return {
        blocked: true,
        reason: `outside window ${r.windowStart}–${r.windowEnd} CT (bar at ${hh}:${mm} CT)`,
      };
    }
  }

  return { blocked: false, reason: null };
}

/**
 * Short stable hash of the rules plus the app version. Key order and the order
 * of the blocked list are irrelevant — the same rules always hash the same.
 */
function rulesVersion(rules, appVersion) {
  const r = { ...DEFAULT_RULES, ...(rules || {}) };
  const canonical = JSON.stringify({
    enabled:          r.enabled !== false,
    blockedSetupKeys: (Array.isArray(r.blockedSetupKeys) ? [...r.blockedSetupKeys] : []).map(String).sort(),
    minConfidence:    Number(r.minConfidence) || 0,
    windowStart:      String(r.windowStart ?? ''),
    windowEnd:        String(r.windowEnd ?? ''),
    appVersion:       String(appVersion ?? ''),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

module.exports = { evaluateRules, rulesVersion, DEFAULT_RULES, chicagoMinutes, parseHhMm };
