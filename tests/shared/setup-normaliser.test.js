'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normaliseSetup, setupKeyFor, SETUP_KEYS } = require('../../src/shared/setup-normaliser');

test('the three real spellings that fragmented the scorecard collapse to one key', () => {
  // Observed verbatim in the TVCM-6 live check: three labels, one idea, three buckets.
  const a = normaliseSetup('Bearish Outside Bar');
  const b = normaliseSetup('Bearish Outside-Bar');
  const c = normaliseSetup('Bearish outside bar short at swing low break');

  assert.strictEqual(a, 'outside_bar');
  assert.strictEqual(b, 'outside_bar', 'a hyphen must not create a new setup');
  assert.strictEqual(c, 'outside_bar', 'trailing prose must not create a new setup');
  assert.strictEqual(new Set([a, b, c]).size, 1);
});

test('case, punctuation and spacing are irrelevant', () => {
  for (const label of [
    'HAMMER', 'hammer', '  Hammer  ', 'Hammer!', 'ham-mer'.replace('-', ''), '(Hammer)',
  ]) {
    assert.strictEqual(normaliseSetup(label), 'hammer', `failed on ${JSON.stringify(label)}`);
  }
});

test('direction is not part of the key — the scorecard reports long vs short separately', () => {
  assert.strictEqual(normaliseSetup('Bullish Engulfing'), 'engulfing');
  assert.strictEqual(normaliseSetup('bearish engulfing'), 'engulfing');
  assert.strictEqual(normaliseSetup('Three-White-Soldiers'), 'three_bar_run');
  assert.strictEqual(normaliseSetup('Three-Black-Crows'), 'three_bar_run');
});

test('recognises the setups this app actually produces', () => {
  const cases = {
    'ORB breakout':                        'orb_breakout',
    'Opening Range Breakout + retest':     'orb_breakout',
    'Range breakout (either direction)':   'range_breakout',
    'Doji + Inside Bar':                   'inside_bar',
    'Bearish Pin Bar (wick down)':         'pin_bar',
    'Dragonfly Doji':                      'doji',
    'shooting star':                       'shooting_star',
    'Bullish Marubozu':                    'marubozu',
    'Tweezer Bottom':                      'tweezer',
    'Morning Star':                        'star',
    'pullback to the 20 MA':               'pullback',
    'break of swing high':                 'level_test',
    'trend continuation':                  'trend',
  };
  for (const [label, key] of Object.entries(cases)) {
    assert.strictEqual(normaliseSetup(label), key, `failed on ${JSON.stringify(label)}`);
  }
});

test('the more specific pattern wins when a label names two', () => {
  // "Doji + Inside Bar" is an inside bar that happens to be a doji.
  assert.strictEqual(normaliseSetup('Doji + Inside Bar'), 'inside_bar');
  // "outside bar ... swing low" is an outside bar, not a generic level test.
  assert.strictEqual(normaliseSetup('outside bar at swing low'), 'outside_bar');
});

test('anything unrecognised becomes other, never a new bucket', () => {
  for (const label of ['', '   ', null, undefined, 42, {}, 'vibes', 'the chart looks nice']) {
    assert.strictEqual(normaliseSetup(label), 'other', `failed on ${JSON.stringify(label)}`);
  }
});

test('every key the normaliser can return is in the published list', () => {
  const labels = [
    'hammer', 'shooting star', 'doji', 'marubozu', 'pin bar', 'bullish engulfing',
    'inside bar', 'outside bar', 'tweezer', 'three white soldiers', 'morning star',
    'ORB breakout', 'range breakout', 'breakout', 'pullback', 'swing high', 'trend', 'nonsense',
  ];
  for (const l of labels) {
    assert.ok(SETUP_KEYS.includes(normaliseSetup(l)), `${normaliseSetup(l)} missing from SETUP_KEYS`);
  }
});

test('setupKeyFor picks the first meaningful label from a list', () => {
  assert.strictEqual(setupKeyFor(['vibes', 'Bearish Outside Bar']), 'outside_bar',
    'skips an unrecognised label to find a real setup');
  assert.strictEqual(setupKeyFor(['Bullish Engulfing', 'hammer']), 'engulfing',
    'keeps the first recognised one when several match');
  assert.strictEqual(setupKeyFor([]), 'other');
  assert.strictEqual(setupKeyFor(null), 'other');
  assert.strictEqual(setupKeyFor(['vibes', 'nonsense']), 'other');
});

test('setupKeyFor accepts the stored JSON string as well as an array', () => {
  assert.strictEqual(setupKeyFor('["Bearish Outside-Bar"]'), 'outside_bar');
  assert.strictEqual(setupKeyFor('not json'), 'other', 'bad JSON must not throw');
});

test('normalising is deterministic and stable', () => {
  // The same label must always give the same key — backfill and live writes
  // must never disagree.
  const label = 'Bearish Outside-Bar';
  const first = normaliseSetup(label);
  for (let i = 0; i < 50; i++) assert.strictEqual(normaliseSetup(label), first);
});
