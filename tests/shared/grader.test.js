'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { gradeCall, breakEvenWinRate } = require('../../src/shared/grader');

// Bars are the shape readBars() returns: ascending time, OHLC + volume.
const bar = (t, o, h, l, c) => ({ time: t, open: o, high: h, low: l, close: c, volume: 100 });

// MES: $5/point, $1.24 per round trip. A 3.25-point stop risks $16.25,
// so one round trip costs 1.24/16.25 = 0.0763 R.
const LONG  = { direction: 'long',  entry: 100, stop: 96.75, target: 103.25 }; // 1:1, risk 3.25
const SHORT = { direction: 'short', entry: 100, stop: 103.25, target: 96.75 };

const T0 = 1792600000;
const t = (i) => T0 + i * 60; // 1-minute bars

test('clean win, long: entry touched then target reached', () => {
  const bars = [
    bar(t(1), 100.5, 100.75, 99.75, 100.25),   // entry 100 inside range -> triggered
    bar(t(2), 100.25, 101.5, 100.0, 101.25),
    bar(t(3), 101.25, 103.5, 101.0, 103.25),   // high 103.5 >= target
  ];
  const g = gradeCall(LONG, bars);

  assert.strictEqual(g.outcome, 'WIN');
  assert.strictEqual(g.barsToOutcome, 3);
  assert.ok(Math.abs(g.rGross - 1) < 1e-9, `rGross should be 1.0, got ${g.rGross}`);
  // net = 1 - 1.24/(3.25*5) = 1 - 0.076307...
  assert.ok(Math.abs(g.rNet - (1 - 1.24 / 16.25)) < 1e-9, `rNet was ${g.rNet}`);
  assert.ok(g.rNet < g.rGross, 'fees must reduce net R');
});

test('clean loss, long: entry touched then stop reached', () => {
  const bars = [
    bar(t(1), 100.5, 100.75, 99.75, 100.0),
    bar(t(2), 100.0, 100.25, 96.5, 96.75),     // low 96.5 <= stop
  ];
  const g = gradeCall(LONG, bars);

  assert.strictEqual(g.outcome, 'LOSS');
  assert.strictEqual(g.barsToOutcome, 2);
  assert.strictEqual(g.rGross, -1);
  // a loss also pays the fee
  assert.ok(Math.abs(g.rNet - (-1 - 1.24 / 16.25)) < 1e-9, `rNet was ${g.rNet}`);
});

test('clean win, short: target is below entry', () => {
  const bars = [
    bar(t(1), 99.5, 100.25, 99.25, 99.75),     // entry 100 inside range
    bar(t(2), 99.75, 99.75, 96.5, 96.75),      // low 96.5 <= target 96.75
  ];
  const g = gradeCall(SHORT, bars);

  assert.strictEqual(g.outcome, 'WIN');
  assert.ok(Math.abs(g.rGross - 1) < 1e-9);
});

test('clean loss, short: stop is above entry', () => {
  const bars = [
    bar(t(1), 99.5, 100.25, 99.25, 100.0),
    bar(t(2), 100.0, 103.5, 99.75, 103.25),    // high 103.5 >= stop 103.25
  ];
  const g = gradeCall(SHORT, bars);

  assert.strictEqual(g.outcome, 'LOSS');
  assert.strictEqual(g.rGross, -1);
});

test('not triggered: entry never touched inside the trigger window', () => {
  // Price runs away upward; a long limit at 100 is never reached.
  const bars = [
    bar(t(1), 101, 101.5, 100.75, 101.25),
    bar(t(2), 101.25, 102, 101.0, 101.75),
    bar(t(3), 101.75, 102.5, 101.5, 102.25),
    bar(t(4), 102.25, 103, 102.0, 102.75),
    bar(t(5), 102.75, 103.5, 102.5, 103.25),   // target region, but never filled
    bar(t(6), 103.25, 104, 99.0, 100.0),       // touches entry — too late
  ];
  const g = gradeCall(LONG, bars, { triggerWindow: 5 });

  assert.strictEqual(g.outcome, 'NOT_TRIGGERED');
  assert.strictEqual(g.rGross, null, 'no position was taken, so there is no R');
  assert.strictEqual(g.rNet, null);
});

test('expired: triggered but neither level reached within the bar limit', () => {
  const bars = [bar(t(1), 100.5, 100.75, 99.75, 100.25)]; // triggered
  for (let i = 2; i <= 12; i++) bars.push(bar(t(i), 100, 100.5, 99.5, 100));
  const g = gradeCall(LONG, bars, { expireBars: 10 });

  assert.strictEqual(g.outcome, 'EXPIRED');
  assert.strictEqual(g.rGross, null, 'an unresolved call has no R');
  assert.strictEqual(g.rNet, null);
});

test('ambiguous: one bar touches both target and stop', () => {
  // Order within a bar is unknowable, so this must never be scored.
  const bars = [
    bar(t(1), 100.5, 100.75, 99.75, 100.25),
    bar(t(2), 100.25, 103.5, 96.5, 100.0),     // high >= target AND low <= stop
  ];
  const g = gradeCall(LONG, bars);

  assert.strictEqual(g.outcome, 'AMBIGUOUS');
  assert.strictEqual(g.rGross, null, 'ambiguous is never a win or a loss');
  assert.strictEqual(g.rNet, null);
});

test('ambiguous: a gap opens beyond the stop and the bar also reaches the target', () => {
  // Gap down through the stop, then a rally through the target in the same bar.
  const bars = [
    bar(t(1), 100.5, 100.75, 99.75, 100.25),   // triggered
    bar(t(2), 95.0, 104.0, 95.0, 103.5),       // opens below stop, high above target
  ];
  const g = gradeCall(LONG, bars);

  assert.strictEqual(g.outcome, 'AMBIGUOUS');
  assert.strictEqual(g.rGross, null);
});

test('fees turn a tiny win negative', () => {
  // Wide stop, nearly-touching target: gross R is positive but one round trip
  // of $1.24 on $50 of risk (10 points) costs 0.0248 R and swamps it.
  const tiny = { direction: 'long', entry: 100, stop: 90, target: 100.1 };
  const bars = [
    bar(t(1), 100.25, 100.5, 99.5, 100.0),     // triggered
    bar(t(2), 100.0, 100.25, 99.9, 100.1),     // high 100.25 >= target 100.1
  ];
  const g = gradeCall(tiny, bars);

  assert.strictEqual(g.outcome, 'WIN');
  assert.ok(g.rGross > 0, `gross R should be positive, got ${g.rGross}`);
  assert.ok(g.rNet < 0, `net R should be NEGATIVE after fees, got ${g.rNet}`);
});

test('ungradeable: a call missing direction, entry, stop or target', () => {
  const bars = [bar(t(1), 100.5, 103.5, 96.5, 100)];
  for (const bad of [
    { direction: 'long', entry: null, stop: 96.75, target: 103.25 },
    { direction: 'long', entry: 100, stop: null, target: 103.25 },
    { direction: 'long', entry: 100, stop: 96.75, target: null },
    { direction: 'none', entry: 100, stop: 96.75, target: 103.25 },
  ]) {
    assert.strictEqual(gradeCall(bad, bars).outcome, 'UNGRADEABLE');
  }
});

test('no bars yet: stays pending rather than guessing', () => {
  assert.strictEqual(gradeCall(LONG, []).outcome, 'PENDING');
  assert.strictEqual(gradeCall(LONG, [bar(t(1), 101, 101.5, 100.75, 101.25)]).outcome, 'PENDING',
    'one bar inside the trigger window is not yet a verdict');
});

test('session end expires a call before the bar limit', () => {
  const bars = [
    bar(t(1), 100.5, 100.75, 99.75, 100.25),   // triggered
    bar(t(2), 100, 100.5, 99.5, 100),
    bar(t(3), 100, 100.5, 99.5, 100),
  ];
  const g = gradeCall(LONG, bars, { expireBars: 60, sessionEndTime: t(3) });

  assert.strictEqual(g.outcome, 'EXPIRED', 'session end cuts the call off first');
});

test('break-even win rate accounts for fees and planned R:R', () => {
  // 1:1 with a 3.25-point stop. NB the risk is 3.25 * $5 = $16.25, not the $16
  // setting: autoTradeStopDollars is rounded to whole ticks (13 ticks). Fee in R
  // is 1.24/16.25 = 0.076308, so break-even is 1.076308/2 = 53.82%.
  const be = breakEvenWinRate({ rrPlanned: 1, riskPoints: 3.25 });
  assert.ok(Math.abs(be - 0.5381538) < 1e-6, `expected ~0.53815, got ${be}`);

  // A 2:1 plan needs far fewer winners.
  const be2 = breakEvenWinRate({ rrPlanned: 2, riskPoints: 3.25 });
  assert.ok(be2 < 0.37, `2:1 break-even should be well under 37%, got ${be2}`);

  // Free trading would be exactly 50% at 1:1.
  const beFree = breakEvenWinRate({ rrPlanned: 1, riskPoints: 3.25, feePerRt: 0 });
  assert.ok(Math.abs(beFree - 0.5) < 1e-9, `got ${beFree}`);
});
