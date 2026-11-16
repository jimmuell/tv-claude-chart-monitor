'use strict';

// Sorting the columns of the Order History & P&L window.
//
// Every fixture is SYNTHETIC. The one rule worth protecting is that a column sorts by
// the VALUE behind the label and never by the label: the Trades tab prints
// "Sun 11/15 17:10" and "Mon 11/16 08:30", and read as text Monday wins.

const { test, before } = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const url    = require('url');

let s, view;
before(async () => {
  s    = await import(url.pathToFileURL(path.join(__dirname, '../../src/shared/pnl-sort.mjs')).href);
  view = await import(url.pathToFileURL(path.join(__dirname, '../../src/shared/pnl-view.mjs')).href);
});

/** One trade shaped like the engine's, with overridable fields. */
function trade(over = {}) {
  return {
    id: 1, status: 'CLOSED', direction: 'long', sessionDate: '2026-11-16',
    openSessionDate: '2026-11-16', crossesBoundary: false,
    openTime: '2026-11-16 09:00:00', closeTime: '2026-11-16 09:30:00',
    entryQty: 5, exitQty: 5, avgEntry: 7000, avgExit: 7005, maxPositionSize: 5,
    contractSides: 10, gross: 125, fees: 6, net: 119, orderIds: ['o1'], ...over,
  };
}

/** One fill shaped like the engine's. */
function fill(over = {}) {
  return {
    orderId: 'o1', symbol: 'MES', side: 'Buy', qty: 5, price: 7000,
    fillTime: '2026-11-16 09:00:00', sessionDate: '2026-11-16',
    status: 'Filled', orderType: 'Market', ...over,
  };
}

// ── Real values, never the text on screen ────────────────────────────────

test('a date-time column sorts chronologically, not the way the label reads', () => {
  const sunday = trade({ id: 1, openTime: '2026-11-15 17:10:00' });
  const monday = trade({ id: 2, openTime: '2026-11-16 08:30:00' });
  // The labels: "Mon 11/16 08:30:00" sorts BEFORE "Sun 11/15 17:10:00" as text.
  assert.ok(view.fmtDayStamp(monday.openTime) < view.fmtDayStamp(sunday.openTime),
    'the fixture must actually reproduce the text-order trap');

  const asc = s.sortRows([monday, sunday], 'trades', { key: 'open', dir: 'asc' });
  assert.deepStrictEqual(asc.map(t => t.id), [1, 2], 'Sunday evening comes first');
  const desc = s.sortRows([sunday, monday], 'trades', { key: 'open', dir: 'desc' });
  assert.deepStrictEqual(desc.map(t => t.id), [2, 1]);
});

test('a money column sorts by the number, so negatives are the smallest', () => {
  const rows = [trade({ id: 1, net: 9 }), trade({ id: 2, net: -250.85 }), trade({ id: 3, net: 10 })];
  assert.deepStrictEqual(
    s.sortRows(rows, 'trades', { key: 'net', dir: 'asc' }).map(t => t.id), [2, 1, 3]);
  assert.deepStrictEqual(
    s.sortRows(rows, 'trades', { key: 'net', dir: 'desc' }).map(t => t.id), [3, 1, 2]);
});

test('a number column is not text either — 9 is less than 10', () => {
  const rows = [fill({ orderId: 'a', qty: 10 }), fill({ orderId: 'b', qty: 9 })];
  assert.deepStrictEqual(
    s.sortRows(rows, 'fills', { key: 'qty', dir: 'asc' }).map(f => f.orderId), ['b', 'a']);
});

test('past days sort by the session date as a date', () => {
  const days = [
    { sessionDate: '2026-11-09', netPnl: 1, fees: 1, contractSides: 2, tradeCount: 1 },
    { sessionDate: '2026-11-13', netPnl: 2, fees: 1, contractSides: 2, tradeCount: 1 },
    { sessionDate: '2026-11-16', netPnl: 3, fees: 1, contractSides: 2, tradeCount: 1 },
  ];
  assert.deepStrictEqual(
    s.sortRows(days, 'days', { key: 'session', dir: 'desc' }).map(d => d.sessionDate),
    ['2026-11-16', '2026-11-13', '2026-11-09']);
});

// ── Blanks, ties and unknown columns ─────────────────────────────────────

test('an open trade has no exit or net, and those rows sort last both ways', () => {
  const rows = [trade({ id: 1, net: null, avgExit: null, status: 'OPEN' }),
                trade({ id: 2, net: -50 }), trade({ id: 3, net: 50 })];
  assert.deepStrictEqual(
    s.sortRows(rows, 'trades', { key: 'net', dir: 'asc' }).map(t => t.id), [2, 3, 1]);
  assert.deepStrictEqual(
    s.sortRows(rows, 'trades', { key: 'net', dir: 'desc' }).map(t => t.id), [3, 2, 1]);
  assert.deepStrictEqual(
    s.sortRows(rows, 'trades', { key: 'exit', dir: 'asc' }).map(t => t.id), [2, 3, 1]);
});

test('the sort is stable — equal rows keep the order they arrived in', () => {
  const rows = [trade({ id: 1, direction: 'long' }), trade({ id: 2, direction: 'short' }),
                trade({ id: 3, direction: 'long' }), trade({ id: 4, direction: 'short' })];
  assert.deepStrictEqual(
    s.sortRows(rows, 'trades', { key: 'dir', dir: 'asc' }).map(t => t.id), [1, 3, 2, 4]);
  assert.deepStrictEqual(
    s.sortRows(rows, 'trades', { key: 'dir', dir: 'desc' }).map(t => t.id), [2, 4, 1, 3]);
});

test('an unknown column leaves the rows exactly as they came', () => {
  const rows = [trade({ id: 3 }), trade({ id: 1 }), trade({ id: 2 })];
  assert.deepStrictEqual(
    s.sortRows(rows, 'trades', { key: 'nonsense', dir: 'asc' }).map(t => t.id), [3, 1, 2]);
  assert.deepStrictEqual(s.sortRows(null, 'trades', s.DEFAULT_SORT.trades), []);
});

// ── The fills stay attached to their trade ───────────────────────────────

test('sorting trades never moves a fill out from under its trade', () => {
  const a = trade({ id: 1, openTime: '2026-11-16 09:00:00', net: 500,  orderIds: ['a1', 'a2'] });
  const b = trade({ id: 2, openTime: '2026-11-16 10:00:00', net: -100, orderIds: ['b1', 'b2'] });
  const fills = [
    fill({ orderId: 'a1', fillTime: '2026-11-16 09:00:00' }),
    fill({ orderId: 'b1', fillTime: '2026-11-16 10:00:00' }),
    fill({ orderId: 'a2', fillTime: '2026-11-16 09:30:00' }),
    fill({ orderId: 'b2', fillTime: '2026-11-16 10:30:00' }),
  ];
  for (const sort of [{ key: 'net', dir: 'asc' }, { key: 'open', dir: 'desc' }, { key: 'size', dir: 'asc' }]) {
    for (const t of s.sortRows([a, b], 'trades', sort)) {
      assert.deepStrictEqual(view.fillsForTrade(t, fills).map(f => f.orderId).sort(),
        t.orderIds.slice().sort(), `trade ${t.id} lost its fills under ${sort.key}`);
    }
  }
});

// ── Clicking a header ────────────────────────────────────────────────────

test('a first click sorts, a second click reverses, a third goes back', () => {
  let sort = s.nextSort(s.DEFAULT_SORT.trades, 'trades', 'net');
  assert.deepStrictEqual(sort, { key: 'net', dir: 'asc' });
  sort = s.nextSort(sort, 'trades', 'net');
  assert.deepStrictEqual(sort, { key: 'net', dir: 'desc' });
  sort = s.nextSort(sort, 'trades', 'net');
  assert.deepStrictEqual(sort, { key: 'net', dir: 'asc' });
});

test('past days open newest first, and one click on Session keeps it that way', () => {
  assert.deepStrictEqual(s.DEFAULT_SORT.days, { key: 'session', dir: 'desc' });
  assert.deepStrictEqual(s.nextSort({ key: 'net', dir: 'asc' }, 'days', 'session'),
    { key: 'session', dir: 'desc' });
});

test('the arrow is only ever on the sorted column', () => {
  const sort = { key: 'net', dir: 'desc' };
  assert.strictEqual(s.arrowFor(sort, 'net'), '↓');
  assert.strictEqual(s.arrowFor({ key: 'net', dir: 'asc' }, 'net'), '↑');
  assert.strictEqual(s.arrowFor(sort, 'open'), '');
  assert.strictEqual(s.arrowFor(null, 'net'), '');
});

// ── Remembering the choice ───────────────────────────────────────────────

/** A localStorage stand-in, including one that refuses, like a private window. */
function fakeStorage(initial, broken) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => { if (broken) throw new Error('denied'); return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { if (broken) throw new Error('denied'); map.set(k, v); },
    map,
  };
}

test('each tab remembers its own choice, and they do not collide', () => {
  const store = fakeStorage();
  s.writeSort(store, 'trades', { key: 'net', dir: 'desc' });
  s.writeSort(store, 'fills',  { key: 'price', dir: 'asc' });
  assert.deepStrictEqual(s.readSort(store, 'trades'), { key: 'net', dir: 'desc' });
  assert.deepStrictEqual(s.readSort(store, 'fills'),  { key: 'price', dir: 'asc' });
  assert.deepStrictEqual(s.readSort(store, 'days'),   s.DEFAULT_SORT.days);
});

test('a storage that refuses falls back to the default instead of throwing', () => {
  const broken = fakeStorage({}, true);
  assert.deepStrictEqual(s.readSort(broken, 'trades'), s.DEFAULT_SORT.trades);
  assert.doesNotThrow(() => s.writeSort(broken, 'trades', { key: 'net', dir: 'asc' }));
  assert.deepStrictEqual(s.readSort(null, 'fills'), s.DEFAULT_SORT.fills);
});

test('a remembered column that no longer exists is discarded, not trusted', () => {
  const store = fakeStorage({ 'tvcm.sort.trades': JSON.stringify({ key: 'gone', dir: 'desc' }) });
  assert.deepStrictEqual(s.readSort(store, 'trades'), s.DEFAULT_SORT.trades);
  const junk = fakeStorage({ 'tvcm.sort.fills': 'not json' });
  assert.deepStrictEqual(s.readSort(junk, 'fills'), s.DEFAULT_SORT.fills);
});

// ── The comparison itself ────────────────────────────────────────────────

test('blanks compare last whichever value they are put against', () => {
  assert.strictEqual(s.compareValues(null, 5, 'number'), 1);
  assert.strictEqual(s.compareValues(5, null, 'number'), -1);
  assert.strictEqual(s.compareValues(null, null, 'number'), 0);
  assert.strictEqual(s.compareValues('', 'a', 'text'), 1);
});

test('text compares without caring about case', () => {
  assert.strictEqual(s.compareValues('Buy', 'sell', 'text'), -1);
  assert.strictEqual(s.compareValues('SELL', 'Buy', 'text'), 1);
});

test('an unparseable date-time is a blank, not the epoch', () => {
  assert.strictEqual(s.normaliseValue('not a time', 'datetime'), null);
  assert.strictEqual(s.normaliseValue('2026-11-16 09:00:00', 'datetime'),
    Date.parse('2026-11-16T09:00:00'));
});
