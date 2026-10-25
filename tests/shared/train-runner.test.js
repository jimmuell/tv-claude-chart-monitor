'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseArgs, hhmmToMinutes, chicagoMinutes, chicagoDate, resolveDays,
} = require('../../scripts/train-replay');

test('arguments parse with safe defaults, including the call cap', () => {
  const d = parseArgs([]);
  assert.strictEqual(d.maxCalls, 200, 'the hard cap must default on');
  assert.strictEqual(d.start, '08:30');
  assert.strictEqual(d.end, '11:00');
  assert.strictEqual(d.days, 1);

  const a = parseArgs(['--days', '3', '--from', '2026-10-22', '--max-calls', '50']);
  assert.strictEqual(a.days, 3);
  assert.strictEqual(a.from, '2026-10-22');
  assert.strictEqual(a.maxCalls, 50);
});

test('the window is interpreted in Chicago time', () => {
  assert.strictEqual(hhmmToMinutes('08:30'), 510);
  assert.strictEqual(hhmmToMinutes('11:00'), 660);
  assert.strictEqual(hhmmToMinutes('nonsense'), null);

  // 14:00 UTC on 2026-10-20 is 09:00 CT.
  const t = Math.floor(Date.UTC(2026, 9, 20, 14, 0, 0) / 1000);
  assert.strictEqual(chicagoMinutes(t), 540);
  assert.strictEqual(chicagoDate(t), '2026-10-20');
});

test('a bar just before Chicago midnight belongs to the right day', () => {
  // 04:30 UTC on the 21st is 23:30 CT on the 20th.
  const t = Math.floor(Date.UTC(2026, 9, 21, 4, 30, 0) / 1000);
  assert.strictEqual(chicagoDate(t), '2026-10-20');
});

test('resolveDays skips weekends', () => {
  // 2026-10-23 is a Friday; the next weekday is Monday the 26th.
  const days = resolveDays({ days: 3, from: '2026-10-23' });
  assert.deepStrictEqual(days, ['2026-10-23', '2026-10-26', '2026-10-27']);
  for (const d of days) {
    const dow = new Date(d + 'T12:00:00Z').getUTCDay();
    assert.ok(dow !== 0 && dow !== 6, `${d} is a weekend`);
  }
});

test('resolveDays returns the N most recent weekdays when --from is absent', () => {
  const days = resolveDays({ days: 3, from: null });
  assert.strictEqual(days.length, 3);
  assert.deepStrictEqual([...days].sort(), days, 'oldest first');
  for (const d of days) {
    const dow = new Date(d + 'T12:00:00Z').getUTCDay();
    assert.ok(dow !== 0 && dow !== 6, `${d} is a weekend`);
  }
});

// ── stepping / waiting, against a mock reader ────────────────────────────────

/** A fake chart that advances one bar each time step is evaluated. */
function mockReader(barSeconds = 60, startTime = 1792600000) {
  const state = { time: startTime, steps: 0 };
  return {
    state,
    async evalPage(expr) {
      if (String(expr).includes('doStep')) { state.steps++; state.time += barSeconds; return 'ok'; }
      return 'ok';
    },
  };
}
const chartOf = (r) => ({ symbol: 'CME_MINI:MES1!', timeframe: '1', replay: true, lastTime: r.state.time });

test('stepAndWait waits for the saved row before returning', async () => {
  const { stepAndWait } = require('../../scripts/train-replay');
  const reader = mockReader();
  let clock = 0;
  let rowAppearsAfter = 5;          // the app takes 5 polls to save
  let polls = 0;

  const res = await stepAndWait(reader, chartOf(reader), { barTimeoutMs: 60000 }, {
    readChart: async () => chartOf(reader),
    hasRow: () => (++polls >= rowAppearsAfter ? { id: 1, blocked: 0, verdict: 'wait' } : null),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  });

  assert.strictEqual(res.advanced, true, 'the cursor moved');
  assert.ok(res.row, 'it must not return until the row exists');
  assert.strictEqual(polls, rowAppearsAfter, 'it polled until the row appeared');
  assert.ok(res.waitedMs > 0, 'the wait is measured');
});

test('stepAndWait gives up after the timeout instead of hanging forever', async () => {
  const { stepAndWait } = require('../../scripts/train-replay');
  const reader = mockReader();
  let clock = 0;

  const res = await stepAndWait(reader, chartOf(reader), { barTimeoutMs: 3000 }, {
    readChart: async () => chartOf(reader),
    hasRow: () => null,                       // the app never saves
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  });

  assert.strictEqual(res.advanced, true);
  assert.strictEqual(res.row, null, 'reports the miss rather than pretending it saved');
  assert.ok(clock >= 3000, 'it waited the full timeout first');
});

test('stepAndWait reports a stalled cursor rather than looping', async () => {
  const { stepAndWait } = require('../../scripts/train-replay');
  const frozen = { state: { time: 1792600000, steps: 0 }, async evalPage() { return 'ok'; } };
  let clock = 0;

  const res = await stepAndWait(frozen, chartOf(frozen), { barTimeoutMs: 1000 }, {
    readChart: async () => chartOf(frozen),   // never advances
    hasRow: () => null,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  });

  assert.strictEqual(res.advanced, false, 'a frozen replay is detected');
  assert.strictEqual(res.row, null);
});

test('one step per bar: the mock advances exactly one bar each call', async () => {
  const { stepAndWait } = require('../../scripts/train-replay');
  const reader = mockReader(60);
  let clock = 0;
  const seen = [];

  for (let i = 0; i < 5; i++) {
    const res = await stepAndWait(reader, chartOf(reader), { barTimeoutMs: 10000 }, {
      readChart: async () => chartOf(reader),
      hasRow: () => ({ id: i, blocked: 0, verdict: 'wait' }),
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    });
    seen.push(res.barTime);
  }

  assert.strictEqual(reader.state.steps, 5, 'exactly one step per bar');
  for (let i = 1; i < seen.length; i++) {
    assert.strictEqual(seen[i] - seen[i - 1], 60, 'no bar was skipped');
  }
});
