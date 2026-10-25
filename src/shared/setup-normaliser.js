'use strict';
// setup-normaliser.js
//
// Collapses the free-text setup labels the model writes into a small fixed set
// of keys, so the scorecard groups like with like.
//
// The problem it solves, observed verbatim in 17 real calls: "Bearish Outside
// Bar", "Bearish Outside-Bar" and "Bearish outside bar short at swing low
// break" are one idea written three ways. Grouped raw, they become three thin
// buckets that never reach significance and quietly hide a real edge — or a
// real leak. Model and prompt changes make the drift worse over time.
//
// Deterministic and pure: same label in, same key out, forever. The raw labels
// are never modified — `setups_json` keeps exactly what the model said, and
// `setup_key` is derived alongside it, so a better normaliser can be rerun later.
//
// Direction is deliberately NOT part of the key. "Bullish engulfing" and
// "bearish engulfing" are the same setup; the scorecard reports long versus
// short as its own breakdown, and folding direction in here would double every
// bucket and halve every sample size.

/** Every key this module can return. Anything unrecognised becomes `other`. */
const SETUP_KEYS = [
  'orb_breakout',
  'range_breakout',
  'breakout',
  'engulfing',
  'inside_bar',
  'outside_bar',
  'pin_bar',
  'hammer',
  'shooting_star',
  'star',
  'doji',
  'marubozu',
  'tweezer',
  'three_bar_run',
  'pullback',
  'level_test',
  'trend',
  'other',
];

// Ordered most-specific first: the first phrase found wins. Order is the whole
// design here — "Doji + Inside Bar" is an inside bar that happens to be a doji,
// and "outside bar at swing low" is an outside bar, not a generic level test.
const RULES = [
  ['orb_breakout',   ['opening range', 'orb']],
  ['range_breakout', ['range breakout', 'range break']],
  ['engulfing',      ['engulf']],
  ['inside_bar',     ['inside bar']],
  ['outside_bar',    ['outside bar']],
  ['pin_bar',        ['pin bar', 'pinbar']],
  ['shooting_star',  ['shooting star']],
  ['star',           ['morning star', 'evening star', 'doji star']],
  ['hammer',         ['hammer', 'hanging man']],
  ['three_bar_run',  ['white soldiers', 'black crows', 'three soldiers', 'three crows']],
  ['tweezer',        ['tweezer']],
  ['marubozu',       ['marubozu']],
  ['doji',           ['dragonfly', 'gravestone', 'doji']],
  ['pullback',       ['pullback', 'pull back', 'retest', 'throwback']],
  ['level_test',     ['swing high', 'swing low', 'support', 'resistance', 'key level']],
  ['breakout',       ['breakout', 'break out', 'breakdown']],
  ['trend',          ['trend', 'continuation']],
];

/** Lowercase, turn separators into spaces, drop punctuation, collapse spacing. */
function canonicalise(label) {
  if (typeof label !== 'string') return '';
  return label
    .toLowerCase()
    .replace(/[-_/+]+/g, ' ')          // "Outside-Bar" and "Doji + Inside Bar"
    .replace(/[^a-z0-9 ]+/g, ' ')      // brackets, commas, exclamation marks
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map one free-text setup label to a stable key, or 'other'. */
function normaliseSetup(label) {
  const text = canonicalise(label);
  if (!text) return 'other';
  for (const [key, phrases] of RULES) {
    for (const phrase of phrases) {
      if (text.includes(phrase)) return key;
    }
  }
  return 'other';
}

/**
 * Pick one key for a call from its list of labels (array or the stored JSON
 * string). Takes the first label that names a real setup, so a vague leading
 * label cannot bury a specific one; 'other' only when nothing matches.
 */
function setupKeyFor(labels) {
  let list = labels;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return 'other'; }
  }
  if (!Array.isArray(list)) return 'other';
  for (const label of list) {
    const key = normaliseSetup(label);
    if (key !== 'other') return key;
  }
  return 'other';
}

module.exports = { normaliseSetup, setupKeyFor, SETUP_KEYS, canonicalise };
