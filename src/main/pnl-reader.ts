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

export interface PositionData {
  symbol:     string | null;
  direction:  'long' | 'short';
  entryPrice: number | null;
}

export interface RawAccountData {
  accountBalance:       number | null;
  prevDayBalance:       number | null;
  realizedPnl:          number | null;  // P/L field from Balances table
  unrealizedPnl:        number | null;  // OTE/MVO from Balances, or OTE from top bar
  purchasingPower:      number | null;
  roundTrips:           number;         // buy+sell filled orders today
  buyFills:             number;         // total buy fills today (used for direction inference)
  sellFills:            number;         // total sell fills today
  openingFillDirection: 'long' | 'short' | null;  // direction inferred from newest (closing) fill
  positionsTabCount:    number | null;  // count shown in Positions tab badge (always visible, any tab)
  openPosition:         PositionData | null;  // from Positions panel when tab is active
  accountType:          'amp_live' | 'paper' | null;
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

      // ── ACCOUNT TYPE DETECTION ────────────────────────────────────────────
      // AMP Live: balance Ka-Table present ('Account Balance' column) OR top-bar 'OTE'
      // Paper:    top-bar 'Unrealized PnL' or lowercase-b 'Account balance'
      let accountType = null;
      const balTablePresent = !!wrappers.find(w =>
        w.querySelector('[class*="ka-thead"]')?.textContent?.includes('Account Balance')
      );
      if (balTablePresent || summaryFields['OTE'] !== undefined) {
        accountType = 'amp_live';
      } else if (summaryFields['Unrealized PnL'] !== undefined || summaryFields['Account balance'] !== undefined) {
        accountType = 'paper';
      }
      out.accountType = accountType;

      // ── 3. ORDER HISTORY: count today's filled buys and sells ─────────────
      // Date in YYYY-MM-DD CST format — matches the timestamp in each row
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const allRows = [...document.querySelectorAll('[class*="ka-tr"][class*="ka-row"]')];

      // Emit sample row texts for debugging fill format (first 4 rows regardless of filter)
      out.fillDebug = {
        today,
        totalRows: allRows.length,
        sampleRows: allRows.slice(0, 4).map(r => (r.textContent || '').trim().slice(0, 160)),
      };

      const filledToday = allRows.filter(r => {
        const t  = r.textContent || '';
        const tl = t.toLowerCase();
        // AMP Live: "filled"; paper trading may use "executed", "complete", or "fill"
        return t.includes(today) &&
          (tl.includes('filled') || tl.includes('executed') || tl.includes('complete'));
      });

      // Side text: AMP Live uses "Buy"/"Sell"; paper trading may use "Long"/"Short"
      let buyFills = 0, sellFills = 0;
      filledToday.forEach(row => {
        const t = row.textContent || '';
        if (/\bBuy\b|\bLong\b/i.test(t))  buyFills++;
        if (/\bSell\b|\bShort\b/i.test(t)) sellFills++;
      });

      // Infer opening direction from fills.
      // When fills are unbalanced (open position): net side IS the direction.
      // When fills are balanced (round-trip complete): find the opening fill (earliest by DOM order).
      // TradingView typically renders Order History newest-first, so the LAST item is the
      // oldest (= opening) fill. Read its side directly — no inversion needed.
      let openingFillDir = null;
      if (buyFills !== sellFills) {
        openingFillDir = buyFills > sellFills ? 'long' : 'short';
      } else if (filledToday.length >= 2) {
        // Last item = oldest in DOM (newest-first render order) = opening fill
        const tOldest = (filledToday[filledToday.length - 1]?.textContent || '');
        const isOpenBuy  = /\bBuy\b|\bLong\b/i.test(tOldest)  && !/\bSell\b|\bShort\b/i.test(tOldest);
        const isOpenSell = /\bSell\b|\bShort\b/i.test(tOldest) && !/\bBuy\b|\bLong\b/i.test(tOldest);
        if (isOpenBuy)  openingFillDir = 'long';
        if (isOpenSell) openingFillDir = 'short';
        out.fillDebug.openingFillText = tOldest.slice(0, 160);
      }
      out.fillDebug.filledTodayCount = filledToday.length;
      out.fillDebug.filledTodayTexts = filledToday.map(r => (r.textContent || '').trim().slice(0, 160));
      out.orderHistory = { buyFills, sellFills, roundTrips: Math.min(buyFills, sellFills), total: filledToday.length, openingFillDir };

      // ── 4. POSITIONS TABLE ─────────────────────────────────────────────────
      // Visible when the "Positions" tab is active. Ka-Table with headers repeating 4×.
      // Header column names vary by broker/account type:
      //   AMP Live:    Entry price | Avg. price | Avg. entry
      //   Paper trade: Avg fill price
      let openPosition = null;
      const posTable = wrappers.find(w => {
        const hdr = w.querySelector('[class*="ka-thead"]')?.textContent ?? '';
        return (
          hdr.includes('Entry price') || hdr.includes('Avg. price') ||
          hdr.includes('Avg. entry') || hdr.includes('Avg fill price')
        ) && !hdr.includes('Account Balance') && !hdr.includes('Status');
      });
      if (posTable) {
        const allHdrs = [...posTable.querySelectorAll('[class*="ka-thead-cell"]')]
          .map(th => th.textContent?.trim()).filter(Boolean);
        const uniqueHdrs = allHdrs.filter((_, i) => i % 4 === 0);
        const firstRow = posTable.querySelector('[class*="ka-tbody"] [class*="ka-tr"]');
        if (firstRow) {
          const cells = [...firstRow.querySelectorAll('[class*="ka-td"], td')]
            .map(td => td.textContent?.trim() ?? '');
          const pm = {};
          uniqueHdrs.forEach((h, i) => { pm[h] = cells[i] ?? ''; });
          const qtyRaw   = pm['Qty'] ?? pm['Size'] ?? pm['Quantity'] ?? '';
          const sideRaw  = (pm['Side'] ?? '').toLowerCase();
          const entryRaw = pm['Entry price'] ?? pm['Avg. price'] ?? pm['Avg. entry'] ?? pm['Avg fill price'] ?? '';
          const symRaw   = pm['Symbol'] ?? '';
          const qty = parseFloat(qtyRaw.replace(/[^0-9.\-]/g, ''));
          const entryPrice = parseFloat(entryRaw.replace(/[^0-9.]/g, ''));
          let direction = null;
          if (sideRaw.includes('buy') || sideRaw.includes('long')) direction = 'long';
          else if (sideRaw.includes('sell') || sideRaw.includes('short')) direction = 'short';
          else if (!isNaN(qty) && qty !== 0) direction = qty > 0 ? 'long' : 'short';
          if (direction) {
            openPosition = { symbol: symRaw || null, direction, entryPrice: isNaN(entryPrice) ? null : entryPrice };
          }
        }
      }
      out.openPosition = openPosition;

      // ── 5. POSITIONS TAB COUNT ─────────────────────────────────────────────
      // The bottom-panel tab label shows "Positions (N)" when N positions are open.
      // This is always in the DOM regardless of which tab is active —
      // unlike Ka-Table rows which are lazy-rendered only for the active tab.
      let positionsTabCount = null;
      try {
        const tabCandidates = [
          ...document.querySelectorAll('[role="tab"]'),
          ...document.querySelectorAll('button[class*="tab"]'),
          ...document.querySelectorAll('[class*="tab-"][class*="button"]'),
        ];
        for (const el of tabCandidates) {
          const txt = (el.textContent || '').trim();
          if (/^positions/i.test(txt)) {
            const m = txt.match(/(\d+)/);
            positionsTabCount = m ? parseInt(m[1]) : 0;
            break;
          }
        }
      } catch (_e) {}
      out.positionsTabCount = positionsTabCount;

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
    balanceMap?:       Record<string, string>;
    summaryFields?:    Record<string, string>;
    orderHistory?:     { buyFills: number; sellFills: number; roundTrips: number; total: number; openingFillDir: 'long' | 'short' | null };
    openPosition?:     { symbol: string | null; direction: 'long' | 'short'; entryPrice: number | null } | null;
    positionsTabCount?: number | null;
    fillDebug?:        Record<string, unknown>;
    accountType?:      'amp_live' | 'paper' | null;
    _error?:           string;
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
  const oh  = parsed.orderHistory ?? { buyFills: 0, sellFills: 0, roundTrips: 0, total: 0, openingFillDir: null };

  // Field names vary by broker/account type. Try all known variants.
  // AMP Live uses a Balances Ka-Table with P/L, OTE/MVO, Account Balance columns.
  // Paper trading uses the Account Summary top bar with Realized PnL, Unrealized PnL, etc.
  const realizedPnl     = parseNum(bal['P/L']) ?? parseNum(sum['Realized PnL']);
  const accountBalance  = parseNum(bal['Account Balance']) ?? parseNum(sum['Account balance']);
  const prevDayBalance  = parseNum(bal['Prev Day Balance']);

  // Unrealized P&L: AMP Live calls it OTE; paper trading calls it "Unrealized PnL".
  const unrealizedPnl   = parseNum(sum['OTE']) ?? parseNum(sum['Unrealized PnL']) ?? parseNum(bal['OTE/MVO']);

  // Purchasing power: varies by broker
  const purchasingPower = parseNum(sum['Purchasing Power']) ?? parseNum(sum['Available funds']) ?? parseNum(bal['Cash Excess']);

  // Return null only if we have zero useful data (panel not visible)
  if (realizedPnl === null && accountBalance === null && unrealizedPnl === null) {
    console.log('[pnl-reader] no usable data — panel not visible or no account loaded');
    return null;
  }

  const result = {
    accountBalance,
    prevDayBalance,
    realizedPnl,
    unrealizedPnl,
    purchasingPower,
    roundTrips:           oh.roundTrips,
    buyFills:             oh.buyFills,
    sellFills:            oh.sellFills,
    openingFillDirection: (oh.openingFillDir ?? null) as 'long' | 'short' | null,
    positionsTabCount:    parsed.positionsTabCount ?? null,
    openPosition:         parsed.openPosition ?? null,
    accountType:          (parsed.accountType ?? null) as 'amp_live' | 'paper' | null,
  };
  console.log(`[pnl-reader] accountType=${result.accountType} OTE=${sum['OTE']} unrealizedPnl=${unrealizedPnl} openPosition=${JSON.stringify(result.openPosition)} tabCount=${result.positionsTabCount} fills=${result.buyFills}B/${result.sellFills}S openingDir=${result.openingFillDirection}`);
  if (parsed.fillDebug && (oh.total > 0 || (parsed.fillDebug.totalRows as number) > 0)) {
    console.log('[pnl-reader] fillDebug:', JSON.stringify(parsed.fillDebug));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Diagnostic — logs raw DOM findings to console
// ---------------------------------------------------------------------------

export async function probeAccountData(): Promise<string> {
  const result = await evalPage(READ_EXPR);
  return typeof result === 'string' ? result : JSON.stringify(result);
}
