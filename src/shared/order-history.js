'use strict';

/**
 * Order-history P&L engine.
 *
 * Turns a TradingView "Order history" CSV export into per-session realized P&L,
 * contract-sides and fees. Pure: no Electron, no TradingView, no filesystem, no
 * network — it takes CSV text in and returns numbers out.
 *
 * Two rules come from reconciling the export against AMP's 13-NOV-26 statement
 * by hand. Both are load-bearing; neither is negotiable:
 *
 *   RULE 1 — A trading session runs 17:00 to 17:00 America/Chicago and is named
 *            for the day it ENDS. AMP's "13-NOV-26" is every fill from
 *            2026-11-12 17:00 CT up to (not including) 2026-11-13 17:00 CT.
 *
 *   RULE 2 — Count every row with Fill quantity > 0 regardless of Status. A
 *            Take Profit that filled 2 of 5 and was then Cancelled shows
 *            Status "Cancelled", and those 2 contracts are real fills.
 *
 * The Commission column in the export is always empty — AMP does not populate
 * it — so fees are computed from contract-sides, never read from the file.
 */

// ── Constants ───────────────────────────────────────────────────────────────

/** MES: 1 point = $5.00. */
const MES_POINT_VALUE = 5.0;

/**
 * $ per contract per side. Mirrors DEFAULT_FEE_CONFIG.perContractSideFee in
 * src/main/fee-calculator.ts; a test asserts the two have not drifted apart.
 */
const DEFAULT_PER_CONTRACT_SIDE_FEE = 0.60;

/** The hour (America/Chicago) at which one trading session ends and the next begins. */
const SESSION_ROLLOVER_HOUR = 17;

/** Columns the export must carry for any of this to mean anything. */
const REQUIRED_COLUMNS = ['Side', 'Fill quantity', 'Avg fill price', 'Status time', 'Order ID'];

// ── CSV parsing ─────────────────────────────────────────────────────────────

/** Splits one CSV line into fields, honouring "quoted, fields" and "" escapes. */
function splitCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/** Splits CSV text into lines, tolerating CRLF and a trailing newline. */
function splitCsvLines(text) {
  return String(text == null ? '' : text).split(/\r\n|\n|\r/).filter(l => l.length > 0);
}

// ── Time and sessions (RULE 1) ──────────────────────────────────────────────

/**
 * Reads "YYYY-MM-DD HH:MM:SS" as the wall-clock Chicago time it is, with no
 * timezone conversion — which is also why DST cannot corrupt a session boundary.
 */
function parseLocalStamp(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = `${y}-${mo}-${d}`;
  const hour = Number(h);
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || hour > 23 || Number(mi) > 59) return null;
  return { date, hour, minute: Number(mi), second: Number(s || '0'), sortKey: `${date} ${h}:${mi}:${s || '00'}` };
}

/** Adds one day to a "YYYY-MM-DD" string without going through Date's timezone. */
function nextDay(dateText) {
  const [y, m, d] = dateText.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/** RULE 1: the session a Chicago wall-clock fill time belongs to, named for the day it ends. */
function sessionDateFor(stampText) {
  const t = parseLocalStamp(stampText);
  if (!t) return null;
  return t.hour >= SESSION_ROLLOVER_HOUR ? nextDay(t.date) : t.date;
}

// ── Parsing the export ──────────────────────────────────────────────────────

/**
 * Parses an Order history CSV into fills, keeping only rows that actually filled
 * (RULE 2) and reporting every row it had to drop and why.
 */
function parseOrderHistoryCsv(text, options) {
  const sourceName = (options && options.sourceName) || 'export';
  const lines = splitCsvLines(text);
  const skipped = [];

  if (lines.length === 0) {
    return { fills: [], skipped, header: [], descending: false, error: 'TVCM-OH-EMPTY-FILE' };
  }

  const header = splitCsvLine(lines[0]).map(h => h.trim());
  const missing = REQUIRED_COLUMNS.filter(c => header.indexOf(c) === -1);
  if (missing.length > 0) {
    return {
      fills: [], skipped, header, descending: false,
      error: `TVCM-OH-BAD-HEADER: missing column(s) ${missing.join(', ')}`,
    };
  }

  const col = (name) => header.indexOf(name);
  const iSide = col('Side'), iQty = col('Fill quantity'), iPx = col('Avg fill price');
  const iTime = col('Status time'), iId = col('Order ID');
  const iSymbol = col('Symbol'), iStatus = col('Status'), iType = col('Type');

  const fills = [];
  for (let n = 1; n < lines.length; n++) {
    const f = splitCsvLine(lines[n]);
    const lineNo = n + 1;
    const note = (reason) => skipped.push({ line: lineNo, source: sourceName, reason, orderId: f[iId] });

    const qty = Number(f[iQty]);
    if (!f[iQty] || !Number.isFinite(qty) || qty <= 0) continue; // RULE 2: no fill, no row — not an error

    const side = String(f[iSide] || '').trim();
    if (side !== 'Buy' && side !== 'Sell') { note(`TVCM-OH-BAD-ROW: unrecognised Side "${side}"`); continue; }

    const price = Number(f[iPx]);
    if (!f[iPx] || !Number.isFinite(price)) { note('TVCM-OH-BAD-ROW: filled row has no usable Avg fill price'); continue; }

    const stamp = parseLocalStamp(f[iTime]);
    if (!stamp) { note(`TVCM-OH-BAD-ROW: unparseable Status time "${f[iTime]}"`); continue; }

    const orderId = String(f[iId] || '').trim();
    if (!orderId) { note('TVCM-OH-BAD-ROW: no Order ID, cannot dedupe'); continue; }

    fills.push({
      orderId,
      symbol:      iSymbol >= 0 ? f[iSymbol] : '',
      side,
      qty,
      price,
      fillTime:    stamp.sortKey,
      sessionDate: stamp.hour >= SESSION_ROLLOVER_HOUR ? nextDay(stamp.date) : stamp.date,
      status:      iStatus >= 0 ? f[iStatus] : '',
      orderType:   iType >= 0 ? f[iType] : '',
      source:      sourceName,
      line:        lineNo,
    });
  }

  // TradingView exports newest-first. Detect it rather than assume it, so a
  // re-ordered or concatenated file still lands in chronological order.
  const descending = fills.length > 1 && fills[0].fillTime > fills[fills.length - 1].fillTime;
  if (descending) fills.reverse();

  return { fills, skipped, header, descending, error: null };
}

/**
 * Keeps one row per Order ID — the last one supplied wins, so a re-export that
 * revises an order replaces the earlier copy instead of double-counting it.
 */
function dedupeByOrderId(fills) {
  const byId = new Map();
  const replaced = [];
  for (const f of fills) {
    if (byId.has(f.orderId)) replaced.push({ orderId: f.orderId, keptFrom: f.source, line: f.line });
    byId.set(f.orderId, f);
  }
  return { fills: Array.from(byId.values()), replaced };
}

/** Puts fills in time order, keeping equal timestamps in the order they arrived. */
function sortChronologically(fills) {
  return fills
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.fillTime < b.f.fillTime ? -1 : a.f.fillTime > b.f.fillTime ? 1 : a.i - b.i))
    .map(x => x.f);
}

// ── FIFO position ledger ────────────────────────────────────────────────────

/** A fresh trade record, opened by the fill that takes the position away from flat. */
function startTrade(id, fill, sign) {
  return {
    id,
    status:           'OPEN',
    direction:        sign === 1 ? 'long' : 'short',
    openSessionDate:  fill.sessionDate,
    sessionDate:      null,          // set to the session it CLOSES in
    openTime:         fill.fillTime,
    closeTime:        null,
    entryQty:         0,
    exitQty:          0,
    entryNotional:    0,
    exitNotional:     0,
    maxPositionSize:  0,
    grossRaw:         0,             // rounded to cents at the end
    orderIds:         [],
    matchCount:       0,
    /** Realized P&L this trade booked into each session, which is how a boundary-crossing trade is reconciled. */
    grossBySession:   new Map(),
    /** Contract-sides this trade filled in each session, for the same reason. */
    sidesBySession:   new Map(),
  };
}

/** Records an order id on a trade once, keeping the order the fills arrived in. */
function noteOrderId(trade, orderId) {
  if (trade.orderIds[trade.orderIds.length - 1] !== orderId && !trade.orderIds.includes(orderId)) {
    trade.orderIds.push(orderId);
  }
}

/** Adds a quantity to a trade's per-session side tally, used to split fees across a boundary. */
function addSides(trade, sessionDate, qty) {
  trade.sidesBySession.set(sessionDate, (trade.sidesBySession.get(sessionDate) || 0) + qty);
}

/**
 * Walks every fill through one continuous FIFO lot queue, booking realized P&L
 * to the session of the fill that CLOSES a lot. The queue is never reset at a
 * session boundary, which is how a position held through 17:00 carries forward.
 *
 * The same walk groups fills into TRADES. A trade is a flat-to-flat episode: it
 * opens when the position leaves zero and closes when it returns. A fill that
 * reverses through zero is split — part of it closes the running trade, the rest
 * opens the next one — so a reversal is two trades, not one.
 */
function runFifoLedger(fills, pointValue) {
  const lots = [];                 // { sign, qty, price, orderId, fillTime }
  const realizedBySession = new Map();
  const positionAtSessionStart = new Map();
  const matches = [];
  const trades = [];
  let position = 0;
  let openTrade = null;
  let nextTradeId = 1;

  for (const f of fills) {
    if (!positionAtSessionStart.has(f.sessionDate)) positionAtSessionStart.set(f.sessionDate, position);
    const sign = f.side === 'Buy' ? 1 : -1;
    let remaining = f.qty;
    let closedQty = 0;

    while (remaining > 0 && lots.length > 0 && lots[0].sign === -sign) {
      const lot = lots[0];
      const matched = Math.min(remaining, lot.qty);
      // A long lot closed by a sell earns (sell - cost); a short lot closed by a buy earns (proceeds - buy).
      const pnl = (lot.sign === 1 ? f.price - lot.price : lot.price - f.price) * matched * pointValue;
      realizedBySession.set(f.sessionDate, (realizedBySession.get(f.sessionDate) || 0) + pnl);
      matches.push({
        sessionDate:  f.sessionDate,        // the session this P&L is booked to
        qty:          matched,
        side:         lot.sign === 1 ? 'long' : 'short',
        openOrderId:  lot.orderId,
        openTime:     lot.fillTime,
        openPrice:    lot.price,
        closeOrderId: f.orderId,
        closeTime:    f.fillTime,
        closePrice:   f.price,
        pnl,
        tradeId:      openTrade ? openTrade.id : null,
      });

      if (openTrade) {
        openTrade.grossRaw += pnl;
        openTrade.grossBySession.set(f.sessionDate, (openTrade.grossBySession.get(f.sessionDate) || 0) + pnl);
        openTrade.exitQty += matched;
        openTrade.exitNotional += matched * f.price;
        openTrade.matchCount++;
      }

      lot.qty -= matched;
      remaining -= matched;
      closedQty += matched;
      if (lot.qty === 0) lots.shift();
    }

    // The closing portion of this fill belongs to the trade that was already running.
    if (closedQty > 0 && openTrade) {
      noteOrderId(openTrade, f.orderId);
      addSides(openTrade, f.sessionDate, closedQty);
      if (position + sign * closedQty === 0) {
        openTrade.status     = 'CLOSED';
        openTrade.closeTime  = f.fillTime;
        openTrade.sessionDate = f.sessionDate;   // a trade belongs to the session it CLOSES in
        trades.push(openTrade);
        openTrade = null;
      }
    }

    // Whatever is left opens exposure: either a scale-in, or the far side of a reversal.
    if (remaining > 0) {
      if (!openTrade) openTrade = startTrade(nextTradeId++, f, sign);
      noteOrderId(openTrade, f.orderId);
      addSides(openTrade, f.sessionDate, remaining);
      openTrade.entryQty += remaining;
      openTrade.entryNotional += remaining * f.price;
      lots.push({ sign, qty: remaining, price: f.price, orderId: f.orderId, fillTime: f.fillTime });
    }

    position += sign * f.qty;
    if (openTrade) openTrade.maxPositionSize = Math.max(openTrade.maxPositionSize, Math.abs(position));
    if (!realizedBySession.has(f.sessionDate)) realizedBySession.set(f.sessionDate, 0);
  }

  // A position still open when the data runs out is a real trade, just not a finished one.
  if (openTrade) trades.push(openTrade);

  return { lots, realizedBySession, positionAtSessionStart, matches, trades, positionAtEnd: position };
}

/** Turns a ledger trade into the shape callers consume, rounding money once at the end. */
function finaliseTrade(t, rate) {
  const contractSides = t.entryQty + t.exitQty;
  const fees  = toCents(contractSides * rate);
  const open  = t.status === 'OPEN';
  const gross = open ? null : toCents(t.grossRaw);
  return {
    id:              t.id,
    status:          t.status,
    direction:       t.direction,
    sessionDate:     t.sessionDate,       // the session it CLOSED in; null while open
    openSessionDate: t.openSessionDate,
    /** True when the trade opened in one session and closed in another. */
    crossesBoundary: t.status === 'CLOSED' && t.sessionDate !== t.openSessionDate,
    openTime:        t.openTime,
    closeTime:       t.closeTime,
    entryQty:        t.entryQty,
    exitQty:         t.exitQty,
    avgEntry:        t.entryQty > 0 ? t.entryNotional / t.entryQty : null,
    // Left null while the trade is open: an unrealized exit price would be a guess.
    avgExit:         open || t.exitQty === 0 ? null : t.exitNotional / t.exitQty,
    maxPositionSize: t.maxPositionSize,
    contractSides,
    gross,
    fees,                                  // sides already filled; a cost, not a forecast
    net:             open ? null : toCents(gross - fees),
    orderIds:        t.orderIds.slice(),
    fillCount:       t.orderIds.length,
    /** Realized P&L booked into each session, so a crossing trade can be reconciled. */
    grossBySession:  Object.fromEntries(Array.from(t.grossBySession, ([k, v]) => [k, toCents(v)])),
    /** Contract-sides filled in each session, which is how its fees split. */
    sidesBySession:  Object.fromEntries(t.sidesBySession),
  };
}

/**
 * Explains, to the cent, the gap between "sum of the trades that closed in this
 * session" and the session total. Session totals stay FIFO-per-session so they keep
 * matching the broker statement; a trade, by contrast, is counted whole in the session
 * it closed in. The two views differ only when a trade spans a 17:00 boundary, and the
 * difference is attributed here rather than absorbed:
 *
 *   OUTBOUND — trades that closed in this session but booked some P&L into an earlier
 *              one (counted in tradesNet, not in sessionNet).
 *   INBOUND  — trades that booked P&L into this session but closed in a later one
 *              (counted in sessionNet, not in tradesNet).
 *
 * Whatever is left after both is pure per-trade cent rounding, reported separately so a
 * two-cent rounding artefact is never mistaken for a boundary effect.
 */
function reconcileTrades(session, trades, rate) {
  const S = session.sessionDate;
  const closedHere = trades.filter(t => t.status === 'CLOSED' && t.sessionDate === S);
  const touchedHere = trades.filter(t => t.sidesBySession[S] != null);
  const openHere = touchedHere.filter(t => t.status === 'OPEN');

  const tradesGross = toCents(closedHere.reduce((x, t) => x + (t.gross ?? 0), 0));
  const tradesFees  = toCents(closedHere.reduce((x, t) => x + t.fees, 0));
  const tradesNet   = toCents(tradesGross - tradesFees);

  // P&L and sides this session received from trades that closed somewhere else.
  const inboundTrades = touchedHere.filter(t => !(t.status === 'CLOSED' && t.sessionDate === S));
  const inboundGross  = toCents(inboundTrades.reduce((x, t) => x + (t.grossBySession[S] || 0), 0));
  const inboundSides  = inboundTrades.reduce((x, t) => x + (t.sidesBySession[S] || 0), 0);

  // P&L and sides that trades closing here booked into earlier sessions.
  const outboundTrades = closedHere.filter(t => t.crossesBoundary);
  const outboundGross  = toCents(outboundTrades.reduce((x, t) => x + ((t.gross ?? 0) - (t.grossBySession[S] || 0)), 0));
  const outboundSides  = outboundTrades.reduce((x, t) => x + (t.contractSides - (t.sidesBySession[S] || 0)), 0);

  const grossDelta = toCents(tradesGross - session.grossPnl);
  const feesDelta  = toCents(tradesFees - session.fees);
  const netDelta   = toCents(tradesNet - session.netPnl);

  // Everything the boundary does not explain is per-trade rounding.
  const boundaryGross = toCents(outboundGross - inboundGross);
  const boundaryFees  = toCents((outboundSides - inboundSides) * rate);

  return {
    sessionDate: S,
    tradeCount:  closedHere.length,
    tradeIds:    closedHere.map(t => t.id),
    openTradeIds: openHere.map(t => t.id),

    sessionGross: session.grossPnl,
    sessionFees:  session.fees,
    sessionNet:   session.netPnl,
    tradesGross, tradesFees, tradesNet,
    grossDelta, feesDelta, netDelta,

    /** Trades counted here that booked part of their P&L into an earlier session. */
    outbound: { tradeIds: outboundTrades.map(t => t.id), gross: outboundGross, sides: outboundSides },
    /** Trades that booked P&L here but are counted in a later session's trade list. */
    inbound:  { tradeIds: inboundTrades.map(t => t.id),  gross: inboundGross,  sides: inboundSides },

    /** The part of each delta the boundary accounts for. */
    boundaryGross,
    boundaryFees,
    boundaryNet:   toCents(boundaryGross - boundaryFees),
    /** What is left once the boundary is accounted for: cent rounding only. */
    roundingDelta: toCents(netDelta - toCents(boundaryGross - boundaryFees)),

    crossingTradeIds: outboundTrades.map(t => t.id),
    /** True when the trade view and the session view agree to the cent. */
    balanced:      netDelta === 0,
    /** True when the delta is fully explained by boundary-crossing trades plus rounding. */
    explained:     Math.abs(toCents(netDelta - toCents(boundaryGross - boundaryFees))) < 0.05,
    /** Set only when the gap is NOT explained — the trade split would then be wrong. */
    warning:       Math.abs(toCents(netDelta - toCents(boundaryGross - boundaryFees))) < 0.05
      ? null
      : 'TVCM-OH-TRADE-UNEXPLAINED',
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Rounds money to whole cents so sums of floats cannot drift off the statement. */
function toCents(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Parses one or more exports and returns per-session realized P&L, contract-sides,
 * fees, net and any position still open at the end of each session.
 *
 * `texts` may be a single CSV string or an array of them, oldest export first —
 * later exports win on a repeated Order ID.
 */
function analyseOrderHistory(texts, options) {
  const opts = options || {};
  const inputs = Array.isArray(texts) ? texts : [texts];

  let parsed = [];
  const skipped = [];
  const errors = [];
  inputs.forEach((text, i) => {
    const r = parseOrderHistoryCsv(text, { sourceName: (opts.sourceNames && opts.sourceNames[i]) || `export[${i}]` });
    if (r.error) errors.push(r.error);
    parsed = parsed.concat(r.fills);
    skipped.push(...r.skipped);
  });

  return analyseFills(parsed, { ...opts, skipped, errors });
}

/**
 * The same analysis, starting from fills that are already parsed. The CSV path reaches
 * it through analyseOrderHistory(); the live feed reaches it directly, so both get the
 * identical session, FIFO and fee rules rather than a second implementation of them.
 *
 * `fills` must be in the shape parseOrderHistoryCsv() produces. They are deduped and
 * sorted here, so a caller may pass them in any order and need not dedupe first.
 */
function analyseFills(inputFills, options) {
  const opts = options || {};
  const pointValue = opts.pointValue == null ? MES_POINT_VALUE : opts.pointValue;
  const rate = opts.perContractSideFee == null ? DEFAULT_PER_CONTRACT_SIDE_FEE : opts.perContractSideFee;
  const skipped = opts.skipped || [];
  const errors = opts.errors || [];

  const { fills: unique, replaced } = dedupeByOrderId(inputFills || []);
  const fills = sortChronologically(unique);

  if (fills.length === 0) {
    return { sessions: [], trades: [], fills: [], skipped, replaced, errors, openLotsAtEnd: [], warning: 'TVCM-OH-NO-ROWS' };
  }

  const ledger = runFifoLedger(fills, pointValue);

  // Per-session tallies of what was bought and sold.
  const agg = new Map();
  for (const f of fills) {
    let a = agg.get(f.sessionDate);
    if (!a) { a = { buys: 0, sells: 0, buyNotional: 0, sellNotional: 0, fillCount: 0 }; agg.set(f.sessionDate, a); }
    if (f.side === 'Buy') { a.buys += f.qty; a.buyNotional += f.qty * f.price; }
    else { a.sells += f.qty; a.sellNotional += f.qty * f.price; }
    a.fillCount++;
  }

  // End-of-session position: the running total after that session's last fill.
  const positionAfter = new Map();
  let running = 0;
  for (const f of fills) { running += (f.side === 'Buy' ? 1 : -1) * f.qty; positionAfter.set(f.sessionDate, running); }

  const trades = ledger.trades.map(t => finaliseTrade(t, rate));

  const sessions = Array.from(agg.keys()).sort().map(sessionDate => {
    const a = agg.get(sessionDate);
    const contractSides = a.buys + a.sells;
    const fees = toCents(contractSides * rate);
    const grossPnl = toCents(ledger.realizedBySession.get(sessionDate) || 0);
    const openPositionAtEnd = positionAfter.get(sessionDate);
    return {
      sessionDate,
      fillCount:             a.fillCount,
      buys:                  a.buys,
      sells:                 a.sells,
      avgBuy:                a.buys > 0 ? a.buyNotional / a.buys : null,
      avgSell:               a.sells > 0 ? a.sellNotional / a.sells : null,
      grossPnl,
      contractSides,
      fees,
      netPnl:                toCents(grossPnl - fees),
      openPositionAtStart:   ledger.positionAtSessionStart.get(sessionDate),
      openPositionAtEnd,
      flatToFlat:            ledger.positionAtSessionStart.get(sessionDate) === 0 && openPositionAtEnd === 0,
    };
  });

  for (const s2 of sessions) s2.tradeReconciliation = reconcileTrades(s2, trades, rate);

  return {
    sessions,
    trades,
    matches: ledger.matches,
    fills,
    skipped,
    replaced,
    errors,
    openLotsAtEnd: ledger.lots.map(l => ({ side: l.sign === 1 ? 'long' : 'short', qty: l.qty, price: l.price })),
    positionAtEnd: ledger.positionAtEnd,
    warning: null,
  };
}

/**
 * Every trade that CLOSED in the given session, oldest first. Pass
 * `{ includeOpen: true }` to also get a still-running trade that OPENED in it, so a
 * position carried past 17:00 is visible somewhere rather than vanishing.
 */
function sessionTrades(result, sessionDate, options) {
  const includeOpen = !!(options && options.includeOpen);
  return (result.trades || []).filter(t =>
    (t.status === 'CLOSED' && t.sessionDate === sessionDate) ||
    (includeOpen && t.status === 'OPEN' && t.openSessionDate === sessionDate));
}

/** The one session you asked for, or null when there were no fills that day. */
function sessionSummary(result, sessionDate) {
  return result.sessions.find(s => s.sessionDate === sessionDate) || null;
}

module.exports = {
  MES_POINT_VALUE,
  DEFAULT_PER_CONTRACT_SIDE_FEE,
  SESSION_ROLLOVER_HOUR,
  REQUIRED_COLUMNS,
  splitCsvLine,
  splitCsvLines,
  parseLocalStamp,
  nextDay,
  sessionDateFor,
  parseOrderHistoryCsv,
  dedupeByOrderId,
  sortChronologically,
  runFifoLedger,
  analyseOrderHistory,
  analyseFills,
  sessionSummary,
  sessionTrades,
  finaliseTrade,
  reconcileTrades,
  toCents,
};
