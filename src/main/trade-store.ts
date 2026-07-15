import path from 'path';
import Database from 'better-sqlite3';
import type { TradeRecord, TradeEntry, TradeExit, TradeStats } from '../shared/types';

// MES point value: $5/point
const POINT_VALUE = 5.0;

// Schema version — increment when columns are added or types change.
// On version mismatch, the table is dropped and recreated (old rows are known-bad).
const SCHEMA_VERSION = 2;

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    INTEGER NOT NULL,

    symbol        TEXT    NOT NULL,
    timeframe     TEXT    NOT NULL,
    direction     TEXT    NOT NULL,
    entry_price   REAL,
    stop_price    REAL,
    target_price  REAL,
    trailing_stop INTEGER,
    rr_planned    REAL,

    verdict       TEXT    NOT NULL,
    headline      TEXT,
    objective     TEXT,
    steps_json    TEXT,
    structure     TEXT,
    rationale     TEXT,
    patterns_json TEXT,
    confidence    REAL,

    account_type     TEXT,
    qty              INTEGER,
    direction_source TEXT,
    entry_source     TEXT,

    exit_at       INTEGER,
    exit_price    REAL,
    exit_source   TEXT,
    pnl_gross     REAL,
    pnl_net       REAL,
    r_multiple    REAL,

    needs_review  INTEGER NOT NULL DEFAULT 0,

    notes         TEXT,
    tags_json     TEXT,
    critique_json TEXT
  )
`;

function rowToRecord(row: Record<string, unknown>): TradeRecord {
  return {
    id:               row.id as number,
    created_at:       row.created_at as number,
    symbol:           row.symbol as string,
    timeframe:        row.timeframe as string,
    direction:        row.direction as 'long' | 'short' | 'unknown',
    entry_price:      row.entry_price as number | null,
    stop_price:       row.stop_price as number | null,
    target_price:     row.target_price as number | null,
    trailing_stop:    Boolean(row.trailing_stop),
    rr_planned:       row.rr_planned as number | null,
    verdict:          row.verdict as 'valid_long' | 'valid_short' | 'manual',
    headline:         row.headline as string | null,
    objective:        row.objective as string | null,
    steps_json:       row.steps_json as string | null,
    structure:        row.structure as string | null,
    rationale:        row.rationale as string | null,
    patterns_json:    row.patterns_json as string | null,
    confidence:       row.confidence as number | null,
    account_type:     (row.account_type as 'amp_live' | 'paper' | null) ?? null,
    qty:              row.qty as number | null,
    direction_source: (row.direction_source as 'positions_panel' | 'order_history' | 'cached' | 'unknown' | null) ?? null,
    entry_source:     (row.entry_source as 'observed' | 'rescued' | null) ?? null,
    needs_review:     Boolean(row.needs_review),
    exit_at:          row.exit_at as number | null,
    exit_price:       row.exit_price as number | null,
    exit_source:      (row.exit_source as 'derived' | null) ?? null,
    pnl_gross:        row.pnl_gross as number | null,
    pnl_net:          row.pnl_net as number | null,
    r_multiple:       row.r_multiple as number | null,
    notes:            row.notes as string | null,
    tags_json:        row.tags_json as string | null,
    critique_json:    row.critique_json as string | null,
  };
}

export class TradeStore {
  private db: Database.Database;

  constructor(userDataPath: string) {
    const dbPath = path.join(userDataPath, 'trades.db');
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version < SCHEMA_VERSION) {
      console.log(`[trade-store] schema v${version} < v${SCHEMA_VERSION} — dropping and recreating`);
      this.db.exec('DROP TABLE IF EXISTS trades');
    }
    this.db.exec(CREATE_TABLE);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /** Record a new trade entry. Returns the new trade's id. */
  recordEntry(entry: TradeEntry): number {
    const stmt = this.db.prepare(`
      INSERT INTO trades (
        created_at,
        symbol, timeframe, direction,
        entry_price, stop_price, target_price,
        trailing_stop, rr_planned,
        verdict, headline, objective,
        steps_json, structure, rationale,
        patterns_json, confidence,
        account_type, qty, direction_source, entry_source, needs_review
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `);

    const result = stmt.run(
      Date.now(),
      entry.symbol,
      entry.timeframe,
      entry.direction,
      entry.entry_price ?? null,
      entry.stop_price ?? null,
      entry.target_price ?? null,
      entry.trailing_stop ? 1 : 0,
      entry.rr_planned ?? null,
      entry.verdict,
      entry.headline ?? null,
      entry.objective ?? null,
      entry.steps_json ?? null,
      entry.structure ?? null,
      entry.rationale ?? null,
      entry.patterns_json ?? null,
      entry.confidence ?? null,
      entry.account_type ?? null,
      entry.qty ?? null,
      entry.direction_source ?? null,
      entry.entry_source ?? null,
      entry.needs_review ? 1 : 0,
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Close the most recent open trade for the given symbol + account type.
   * Scoped by symbol AND account_type — will not close a trade for a different instrument.
   * Refuses to close trades opened >12 h ago (marks needs_review instead).
   * Computes exit_price only when entry_price IS NOT NULL AND direction != 'unknown'.
   * Computes r_multiple only when stop_price IS NOT NULL AND entry_price IS NOT NULL.
   */
  recordExitForOpenTrade(
    exit: TradeExit,
    symbol: string,
    accountType?: 'amp_live' | 'paper' | null,
  ): boolean {
    const acctType = accountType ?? null;
    const open = this.db.prepare(`
      SELECT id, entry_price, stop_price, direction, qty, created_at
      FROM trades
      WHERE exit_at IS NULL
        AND symbol = ?
        AND account_type IS ?
      ORDER BY created_at DESC LIMIT 1
    `).get(symbol, acctType) as {
      id: number;
      entry_price: number | null;
      stop_price:  number | null;
      direction:   string;
      qty:         number | null;
      created_at:  number;
    } | undefined;

    if (!open) return false;

    // Refuse to close stale trades — position may have been lost across midnight / app restart
    if (Date.now() - open.created_at > 12 * 60 * 60 * 1000) {
      console.warn(`[trade-store] stale open trade id=${open.id} (>12h old) — marking needs_review, leaving open`);
      this.db.prepare('UPDATE trades SET needs_review=1 WHERE id=?').run(open.id);
      return false;
    }

    // exit_price: only derive when we have reliable entry and direction
    let exitPrice: number | null = null;
    let exitSource: 'derived' | null = null;
    if (open.entry_price !== null && open.direction !== 'unknown') {
      const qty   = open.qty ?? 1;
      const delta = exit.pnl_gross / (POINT_VALUE * qty);
      exitPrice   = open.direction === 'long'
        ? open.entry_price + delta
        : open.entry_price - delta;
      exitSource  = 'derived';
    }

    // r_multiple: only compute when stop and entry are both known
    let rMultiple: number | null = null;
    if (open.entry_price !== null && open.stop_price !== null && open.direction !== 'unknown') {
      const qty  = open.qty ?? 1;
      const risk = Math.abs(open.entry_price - open.stop_price) * POINT_VALUE * qty;
      rMultiple  = risk > 0 ? exit.pnl_gross / risk : null;
    }

    const result = this.db.prepare(
      `UPDATE trades SET exit_at=?, pnl_gross=?, pnl_net=?, r_multiple=?, exit_price=?, exit_source=? WHERE id=?`
    ).run(exit.exit_at, exit.pnl_gross, exit.pnl_net, rMultiple, exitPrice, exitSource, open.id);

    return result.changes > 0;
  }

  /** Returns true if an open (no exit_at) trade exists for this symbol + account type. */
  hasOpenTrade(symbol: string, accountType?: 'amp_live' | 'paper' | null): boolean {
    const acctType = accountType ?? null;
    const row = this.db.prepare(
      `SELECT 1 FROM trades WHERE exit_at IS NULL AND symbol = ? AND account_type IS ? LIMIT 1`
    ).get(symbol, acctType);
    return row !== undefined;
  }

  /** Add or replace notes and tags on a trade. */
  addNotes(id: number, notes: string, tags: string[]): void {
    this.db.prepare(
      `UPDATE trades SET notes=?, tags_json=? WHERE id=?`
    ).run(notes, JSON.stringify(tags), id);
  }

  /** Store a Claude critique on a trade. */
  addCritique(id: number, text: string): void {
    const critique = JSON.stringify({ text, created_at: Date.now() });
    this.db.prepare(
      `UPDATE trades SET critique_json=? WHERE id=?`
    ).run(critique, id);
  }

  /** All trades, newest first. */
  getAll(): TradeRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM trades ORDER BY created_at DESC, id DESC`
    ).all() as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  /** Single trade by id. Returns undefined if not found. */
  getById(id: number): TradeRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM trades WHERE id=?`
    ).get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Aggregate stats.
   *  Excludes trades with needs_review=1 OR direction='unknown'.
   *  Win/loss classified by pnl_net (not r_multiple); scratches (pnl_net=0) are neither.
   *  winRate denominator = wins + losses (scratches excluded). */
  getStats(): TradeStats {
    const FILTER = `needs_review = 0 AND direction != 'unknown'`;

    // Count trades excluded from stats
    const reviewRow = this.db.prepare(
      `SELECT COUNT(*) as count FROM trades WHERE NOT (${FILTER})`
    ).get() as { count: number };
    const needsReviewCount = reviewRow.count ?? 0;

    // Basic counts — excluded rows not counted
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) as totalTrades,
        SUM(CASE WHEN exit_at IS NOT NULL AND pnl_net > 0 THEN 1 ELSE 0 END) as winCount,
        SUM(CASE WHEN exit_at IS NOT NULL AND pnl_net IS NOT NULL AND pnl_net < 0 THEN 1 ELSE 0 END) as lossCount,
        SUM(CASE WHEN exit_at IS NULL THEN 1 ELSE 0 END) as openCount,
        SUM(CASE WHEN exit_at IS NOT NULL THEN pnl_net ELSE 0 END) as totalNetPnl
      FROM trades
      WHERE ${FILTER}
    `).get() as {
      totalTrades:  number;
      winCount:     number;
      lossCount:    number;
      openCount:    number;
      totalNetPnl:  number | null;
    };

    // avgR: only non-null r_multiple values
    const avgRRow = this.db.prepare(`
      SELECT AVG(r_multiple) as avgR
      FROM trades
      WHERE exit_at IS NOT NULL AND r_multiple IS NOT NULL AND ${FILTER}
    `).get() as { avgR: number | null };

    const winCount  = counts.winCount  ?? 0;
    const lossCount = counts.lossCount ?? 0;
    const closedForRate = winCount + lossCount; // scratches not counted
    const winRate = closedForRate > 0 ? winCount / closedForRate : 0;

    // byHour
    const hourRows = this.db.prepare(`
      SELECT
        CAST(strftime('%H', datetime(created_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) as hour,
        COUNT(*) as count,
        AVG(pnl_net) as avgNetPnl
      FROM trades
      WHERE exit_at IS NOT NULL AND ${FILTER}
      GROUP BY hour
      ORDER BY hour
    `).all() as Array<{ hour: number; count: number; avgNetPnl: number | null }>;

    const byHour = hourRows.map(r => ({
      hour:      r.hour,
      count:     r.count,
      avgNetPnl: r.avgNetPnl ?? 0,
    }));

    // byPattern
    const patternRows = this.db.prepare(`
      SELECT patterns_json, r_multiple
      FROM trades
      WHERE exit_at IS NOT NULL AND patterns_json IS NOT NULL AND ${FILTER}
    `).all() as Array<{ patterns_json: string; r_multiple: number | null }>;

    const patternMap = new Map<string, { count: number; wins: number; totalR: number; rCount: number }>();
    for (const row of patternRows) {
      let names: string[] = [];
      try { names = JSON.parse(row.patterns_json); } catch { continue; }
      if (!Array.isArray(names)) continue;
      for (const name of names) {
        if (typeof name !== 'string') continue;
        const s = patternMap.get(name) ?? { count: 0, wins: 0, totalR: 0, rCount: 0 };
        s.count++;
        if ((row.r_multiple ?? 0) > 0) s.wins++;
        if (row.r_multiple !== null) { s.totalR += row.r_multiple; s.rCount++; }
        patternMap.set(name, s);
      }
    }

    const byPattern = Array.from(patternMap.entries()).map(([pattern, s]) => ({
      pattern,
      count:   s.count,
      wins:    s.wins,
      winRate: s.count > 0 ? s.wins / s.count : 0,
      avgR:    s.rCount > 0 ? s.totalR / s.rCount : 0,
    }));

    // equityCurve
    const curveRows = this.db.prepare(`
      SELECT
        date(created_at / 1000, 'unixepoch', 'localtime') as date,
        SUM(pnl_net) as dailyNet
      FROM trades
      WHERE exit_at IS NOT NULL AND pnl_net IS NOT NULL AND ${FILTER}
      GROUP BY date
      ORDER BY date
    `).all() as Array<{ date: string; dailyNet: number }>;

    let cumulative = 0;
    const equityCurve = curveRows.map(r => {
      cumulative += r.dailyNet ?? 0;
      return { date: r.date, cumulativeNet: cumulative };
    });

    return {
      totalTrades:      counts.totalTrades ?? 0,
      winCount,
      lossCount,
      openCount:        counts.openCount ?? 0,
      winRate,
      avgR:             avgRRow.avgR ?? 0,
      totalNetPnl:      counts.totalNetPnl ?? 0,
      needsReviewCount,
      byPattern,
      byHour,
      equityCurve,
    };
  }

  /**
   * Reset the journal: drop and rebuild the trades table at the current schema,
   * then reset the AUTOINCREMENT counter so the next id starts at 1.
   * This is the single source of truth for table shape — no second CREATE TABLE.
   */
  clearAll(): void {
    this.db.exec('DROP TABLE IF EXISTS trades');
    this.initSchema();
    // sqlite_sequence is cleared by DROP TABLE; this guard handles edge cases
    try { this.db.exec("DELETE FROM sqlite_sequence WHERE name='trades'"); } catch { /* absent before first insert */ }
    console.log(`[trade-store] clearAll: table rebuilt at schema v${SCHEMA_VERSION}, id counter reset`);
  }

  /** Close the database connection (for testing cleanup). */
  close(): void {
    this.db.close();
  }
}
