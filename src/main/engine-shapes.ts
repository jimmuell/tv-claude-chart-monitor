import type { ImportedSession, ImportedTrade, ImportedFill, SessionBoundary } from '../shared/types';

// The engine's own records carry more than the UI needs, and both the CSV watcher and
// the live feed have to narrow them the same way. Doing it in one place is what stops
// the two paths quietly describing the same trade differently.

/** Converts the engine's session object into the shape the UI consumes. */
export function toImportedSession(s: any): ImportedSession {
  return {
    sessionDate:         s.sessionDate,
    fillCount:           s.fillCount,
    buys:                s.buys,
    sells:               s.sells,
    avgBuy:              s.avgBuy,
    avgSell:             s.avgSell,
    grossPnl:            s.grossPnl,
    contractSides:       s.contractSides,
    roundTrips:          s.contractSides / 2,
    fees:                s.fees,
    netPnl:              s.netPnl,
    openPositionAtStart: s.openPositionAtStart,
    openPositionAtEnd:   s.openPositionAtEnd,
  };
}

/** Copies one engine trade into the shape the window consumes. */
export function toImportedTrade(t: any): ImportedTrade {
  return {
    id: t.id, status: t.status, direction: t.direction,
    sessionDate: t.sessionDate, openSessionDate: t.openSessionDate,
    crossesBoundary: t.crossesBoundary,
    openTime: t.openTime, closeTime: t.closeTime,
    entryQty: t.entryQty, exitQty: t.exitQty,
    avgEntry: t.avgEntry, avgExit: t.avgExit,
    maxPositionSize: t.maxPositionSize, contractSides: t.contractSides,
    gross: t.gross, fees: t.fees, net: t.net,
    orderIds: t.orderIds,
  };
}

/** Copies one engine fill into the shape the window consumes. */
export function toImportedFill(f: any): ImportedFill {
  return {
    orderId: f.orderId, symbol: f.symbol, side: f.side, qty: f.qty, price: f.price,
    fillTime: f.fillTime, sessionDate: f.sessionDate, status: f.status, orderType: f.orderType,
  };
}

/** Reduces a session's trade reconciliation to the few numbers the window shows. */
export function toBoundary(rec: any): SessionBoundary | null {
  if (!rec) return null;
  return {
    boundaryNet:      rec.boundaryNet,
    outboundTradeIds: rec.outbound ? rec.outbound.tradeIds : [],
    inboundTradeIds:  rec.inbound ? rec.inbound.tradeIds : [],
    tradeCount:       rec.tradeCount,
    openTradeIds:     rec.openTradeIds || [],
  };
}
