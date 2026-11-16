/**
 * Column sorting for the Order History & P&L window.
 *
 * ESM on purpose, like pnl-view.mjs and pnl-range.mjs: Vite serves these files to the
 * window as native modules, so a CommonJS file here would arrive in the browser as
 * unparsed text.
 *
 * One rule governs this file: **a column sorts by its real value, never by the text on
 * screen.** The Trades tab shows "Sun 11/15 17:10" and "Mon 11/16 08:30"; sorted as text
 * Monday comes first, which is backwards, and "$9.00" would outrank "$10.00". Every
 * column therefore declares what kind of value it holds, and the comparison is done on
 * the number or the instant behind the label.
 *
 * Two smaller rules that are easy to get wrong:
 *   - Blank values sort LAST in both directions. A trade that is still open has no exit
 *     price and no net; floating those to the top of an ascending sort would read as
 *     "the worst trades", which is a lie.
 *   - The sort is STABLE. Rows that tie keep the order they arrived in, so sorting by
 *     Dir leaves each direction's trades in time order rather than shuffled.
 */

/** Where each tab's choice is remembered between openings. */
export const SORT_STORAGE_PREFIX = 'tvcm.sort.';

/** The sortable columns of each tab, in the order they are drawn. */
export const COLUMNS = {
  trades: [
    { key: 'number',   label: '#',            type: 'number',   align: 'num', pick: (r) => r.number },
    { key: 'open',     label: 'Open – Close', type: 'datetime',          pick: (r) => r.openTime },
    { key: 'dir',      label: 'Dir',          type: 'text',                   pick: (r) => r.direction },
    { key: 'size',     label: 'Size',         type: 'number',   align: 'num', pick: (r) => r.maxPositionSize },
    { key: 'entry',    label: 'Avg entry',    type: 'number',   align: 'num', pick: (r) => r.avgEntry },
    { key: 'exit',     label: 'Avg exit',     type: 'number',   align: 'num', pick: (r) => r.avgExit },
    { key: 'fees',     label: 'Fees',         type: 'money',    align: 'num', pick: (r) => r.fees },
    { key: 'net',      label: 'Net',          type: 'money',    align: 'num', pick: (r) => r.net },
  ],
  fills: [
    { key: 'time',     label: 'Time',         type: 'datetime',               pick: (r) => r.fillTime },
    { key: 'side',     label: 'Side',         type: 'text',                   pick: (r) => r.side },
    { key: 'type',     label: 'Type',         type: 'text',                   pick: (r) => r.orderType },
    { key: 'qty',      label: 'Qty',          type: 'number',   align: 'num', pick: (r) => r.qty },
    { key: 'price',    label: 'Price',        type: 'number',   align: 'num', pick: (r) => r.price },
    { key: 'status',   label: 'Status',       type: 'text',                   pick: (r) => r.status },
    { key: 'orderId',  label: 'Order ID',     type: 'text',                   pick: (r) => r.orderId },
  ],
  days: [
    { key: 'session',  label: 'Session',      type: 'datetime', firstDir: 'desc', pick: (r) => r.sessionDate },
    { key: 'trades',   label: 'Trades',       type: 'number',   align: 'num', pick: (r) => r.tradeCount },
    { key: 'sides',    label: 'Contracts',    type: 'number',   align: 'num', pick: (r) => r.contractSides },
    { key: 'fees',     label: 'Fees',         type: 'money',    align: 'num', pick: (r) => r.fees },
    { key: 'net',      label: 'Net',          type: 'money',    align: 'num', pick: (r) => r.netPnl },
  ],
};

/**
 * How each tab sorts until Jim says otherwise: trades and fills in the order they
 * happened, past days newest first — which is how all three already read.
 */
export const DEFAULT_SORT = {
  trades: { key: 'open',    dir: 'asc'  },
  fills:  { key: 'time',    dir: 'asc'  },
  days:   { key: 'session', dir: 'desc' },
};

/** The columns of one tab, or an empty list for a tab that has none. */
export function columnsFor(tab) {
  return COLUMNS[tab] || [];
}

/** One column by key, or null when the key is unknown (a renamed or dropped column). */
export function columnFor(tab, key) {
  return columnsFor(tab).find(c => c.key === key) || null;
}

/**
 * A cell's value as something comparable, or null when there is nothing to compare.
 * Date-times are read as instants; money and numbers as numbers; text case-insensitively.
 */
export function normaliseValue(value, type) {
  if (value === null || value === undefined || value === '') return null;
  if (type === 'datetime') {
    const ms = Date.parse(String(value).replace(' ', 'T'));
    return Number.isFinite(ms) ? ms : null;
  }
  if (type === 'number' || type === 'money') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return String(value).toLowerCase();
}

/** Compares two raw cell values ascending, with blanks last whichever way it is read. */
export function compareValues(a, b, type) {
  const va = normaliseValue(a, type);
  const vb = normaliseValue(b, type);
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;
  return va < vb ? -1 : va > vb ? 1 : 0;
}

/**
 * The rows of a tab in the chosen order. Stable: ties keep the order they came in, and
 * blanks stay at the bottom in both directions. An unknown column leaves the rows alone
 * rather than silently sorting by something else.
 */
export function sortRows(rows, tab, sort) {
  const list = (rows || []).filter(Boolean);
  const col = columnFor(tab, sort && sort.key);
  if (!col) return list.slice();
  const dir = sort && sort.dir === 'desc' ? -1 : 1;
  return list
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const va = normaliseValue(col.pick(a.row), col.type);
      const vb = normaliseValue(col.pick(b.row), col.type);
      if (va === null || vb === null) {
        if (va === null && vb === null) return a.i - b.i;
        return va === null ? 1 : -1;
      }
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return c !== 0 ? c * dir : a.i - b.i;
    })
    .map(x => x.row);
}

/** What a click on a header does: a new column starts fresh, the same one reverses. */
export function nextSort(current, tab, key) {
  if (current && current.key === key) {
    return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' };
  }
  const col = columnFor(tab, key);
  return { key, dir: (col && col.firstDir) || 'asc' };
}

/** The arrow drawn on the sorted column, and nothing on the others. */
export function arrowFor(sort, key) {
  if (!sort || sort.key !== key) return '';
  return sort.dir === 'desc' ? '↓' : '↑';
}

/** The tab's remembered choice, falling back to its default when there is none. */
export function readSort(storage, tab) {
  try {
    const raw = storage && storage.getItem(SORT_STORAGE_PREFIX + tab);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && columnFor(tab, parsed.key)) {
      return { key: parsed.key, dir: parsed.dir === 'desc' ? 'desc' : 'asc' };
    }
  } catch { /* private window, or a corrupt entry — fall back to the default */ }
  return { ...(DEFAULT_SORT[tab] || { key: null, dir: 'asc' }) };
}

/** Remembers a tab's choice; a storage that refuses to write is not an error. */
export function writeSort(storage, tab, sort) {
  try {
    storage.setItem(SORT_STORAGE_PREFIX + tab, JSON.stringify({ key: sort.key, dir: sort.dir }));
  } catch { /* private window — the choice simply lasts this opening */ }
}
