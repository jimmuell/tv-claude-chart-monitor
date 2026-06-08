/**
 * pnl-reader.ts
 *
 * Reads live account data from TradingView's bottom panel via CDP evalPage().
 *
 * Confirmed DOM structure (probed 2026-05-15, AMP Live / TradingView web):
 *
 * BALANCES TABLE  (ka-table-wrapper whose thead contains "Account Balance"):
 *   Ka-Table renders 4 copies of each header (frozen-column architecture) and
 *   2 copies of each body cell.  We dedup at i%4 (headers) and i%2 (cells).
 *   Unique column order: Currency | Account Balance | OTE/MVO | P/L |
 *     OTE/MVO+P/L | Prev Day Balance | Collateral | NLV | UPL | MVO |
 *     Cash Excess | Currency Rate
 *
 * ORDER HISTORY:
 *   Today's filled rows: class="ka-tr ka-row  row-pnigL71h", contain
 *   the date string (YYYY-MM-DD CST) and the word "filled".
 *   "Buy" / "Sell" appear as substrings of the row text.
 *   round-trips = min(buyFills, sellFills)
 *
 * ACCOUNT SUMMARY TOP BAR (fallback for OTE):
 *   class="accountSummaryField-*" with [labelDiv, valueDiv] children.
 *   Fields: "Total Margin", "OTE", "Purchasing Power"
 */

import { evalPage } from './bridge';

export interface RawAccountData {
  accountBalance:  number | null;
  prevDayBalance:  number | null;
  realizedPnl:     number | null;  // P/L field from Balances table
  unrealizedPnl:   number | null;  // OTE/MVO from Balances, or OTE from top bar
  purchasingPower: number | null;
  roundTrips:      number;         // buy+sell filled orders today
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseNum(s: string | undefined | null): number | null {
  if (!s) return null;
  // TradingView uses unicode minus U+2212 for negative values; normalize to ASCII hyphen first
  const n = parseFloat(s.replace(/−/g, '-').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Main read expression — runs in the TradingView page context
// ---------------------------------------------------------------------------

const READ_EXPR = `
  (() => {
    try {
      const out = {};

      // ── 1. BALANCES TABLE ──────────────────────────────────────────────────
      // Find the ka-table-wrapper whose thead contains "Account Balance"
      const wrappers = [...document.querySelectorAll('[class*="ka-table-wrapper"]')];
      const balTable  = wrappers.find(w =>
        w.querySelector('[class*="ka-thead"]')?.textContent?.includes('Account Balance')
      );

      if (balTable) {
        // Headers repeat 4× — take every 4th (index % 4 === 0) for unique columns
        const allHeaders = [...balTable.querySelectorAll('[class*="ka-thead-cell"]')]
          .map(th => th.textContent?.trim()).filter(Boolean);
        const uniqueHeaders = allHeaders.filter((_, i) => i % 4 === 0);

        // Body cells appear once each (only headers are duplicated in Ka-Table's
        // frozen-column architecture).  Use all cells; positional mapping to headers.
        const firstRow = balTable.querySelector('[class*="ka-tbody"] [class*="ka-tr"]');
        const uniqueCells = firstRow
          ? [...firstRow.querySelectorAll('[class*="ka-td"], td')].map(td => td.textContent?.trim())
          : [];

        const balMap = {};
        uniqueHeaders.forEach((h, i) => { balMap[h] = uniqueCells[i] ?? ''; });
        out.balanceMap = balMap;
      }

      // ── 2. ACCOUNT SUMMARY TOP BAR (OTE fallback) ─────────────────────────
      const summaryFields = {};
      document.querySelectorAll('[class*="accountSummaryField"]').forEach(el => {
        const kids = [...el.children];
        if (kids.length >= 2) {
          const label = kids[0].textContent?.trim();
          const value = kids[1].textContent?.trim();
          if (label) summaryFields[label] = value;
        }
      });
      out.summaryFields = summaryFields;

      // ── 3. ORDER HISTORY: count today's filled buys and sells ─────────────
      // Date in YYYY-MM-DD CST format — matches the timestamp in each row
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const allRows = [...document.querySelectorAll('[class*="ka-tr"][class*="ka-row"]')];
      const filledToday = allRows.filter(r => {
        const t = r.textContent || '';
        return t.includes(today) && t.toLowerCase().includes('filled');
      });

      let buyFills = 0, sellFills = 0;
      filledToday.forEach(row => {
        const t = row.textContent || '';
        if (/Buy/.test(t))  buyFills++;
        if (/Sell/.test(t)) sellFills++;
      });
      out.orderHistory = { buyFills, sellFills, roundTrips: Math.min(buyFills, sellFills), total: filledToday.length };

      return JSON.stringify(out);
    } catch (e) {
      return JSON.stringify({ _error: String(e) });
    }
  })()
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function readAccountData(): Promise<RawAccountData | null> {
  let raw: unknown;
  try {
    raw = await evalPage(READ_EXPR);
  } catch (err) {
    console.warn('[pnl-reader] evalPage failed:', (err as Error).message);
    return null;
  }

  if (typeof raw !== 'string') return null;

  let parsed: {
    balanceMap?:    Record<string, string>;
    summaryFields?: Record<string, string>;
    orderHistory?:  { buyFills: number; sellFills: number; roundTrips: number; total: number };
    _error?:        string;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }

  if (parsed._error) {
    console.warn('[pnl-reader]', parsed._error);
    return null;
  }

  const bal = parsed.balanceMap ?? {};
  const sum = parsed.summaryFields ?? {};
  const oh  = parsed.orderHistory ?? { buyFills: 0, sellFills: 0, roundTrips: 0, total: 0 };

  // P/L from Balances table = gross realized P&L for the session
  const realizedPnl     = parseNum(bal['P/L']);
  const accountBalance  = parseNum(bal['Account Balance']);
  const prevDayBalance  = parseNum(bal['Prev Day Balance']);

  // Unrealized: top-bar OTE is real-time (updated tick-by-tick for open positions).
  // Balances table OTE/MVO is a fallback — may lag or show 0 for closed positions.
  const unrealizedPnl   = parseNum(sum['OTE']) ?? parseNum(bal['OTE/MVO']);

  // Purchasing power: prefer top-bar (live) over Balances "Cash Excess"
  const purchasingPower = parseNum(sum['Purchasing Power']) ?? parseNum(bal['Cash Excess']);

  // Return null only if we have zero useful data (panel not visible)
  if (realizedPnl === null && accountBalance === null && unrealizedPnl === null) {
    return null;
  }

  return {
    accountBalance,
    prevDayBalance,
    realizedPnl,
    unrealizedPnl,
    purchasingPower,
    roundTrips: oh.roundTrips,
  };
}

// ---------------------------------------------------------------------------
// Diagnostic — logs raw DOM findings to console
// ---------------------------------------------------------------------------

export async function probeAccountData(): Promise<string> {
  const result = await evalPage(READ_EXPR);
  return typeof result === 'string' ? result : JSON.stringify(result);
}
