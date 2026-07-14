import path from 'path';
import Database from 'better-sqlite3';
import type { TradeRecord, TradeEntry, TradeExit, TradeStats } from '../shared/types';

// MES point value: $5/point (used for approximate exit_price calculation)
const POINT_VALUE = 5.0;

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

    exit_at       INTEGER,
    exit_price    REAL,
    pnl_gross     REAL,
    pnl_net       REAL,
    r_multiple    REAL,

    notes         TEXT,
    tags_json     TEXT,
    critique_json TEXT
  )
`;

function rowToRecord(row: Record<string, unknown>): TradeRecord {
  return {
    id:            row.id as number,
    created_at:    row.created_at as number,
    symbol:        row.symbol as string,
    timeframe:     row.timeframe as string,
    direction:     row.direction as 'long' | 'short',
    entry_price:   row.entry_price as number | null,
    stop_price:    row.stop_price as number | null,
    target_price:  row.target_price as number | null,
    trailing_stop: Boolean(row.trailing_stop),
    rr_planned:    row.rr_planned as number | null,
    verdict:       row.verdict as 'valid_long' | 'valid_short' | 'manual',
    headline:      row.headline as string | null,
    objective:     row.objective as string | null,
    steps_json:    row.steps_json as string | null,
    structure:     row.structure as string | null,
    rationale:     row.rationale as string | null,
    patterns_json: row.patterns_json as string | null,
    confidence:    row.confidence as number | null,
    exit_at:       row.exit_at as number | null,
    exit_price:    row.exit_price as number | null,
    pnl_gross:     row.pnl_gross as number | null,
    pnl_net:       row.pnl_net as number | null,
    r_multiple:    row.r_multiple as number | null,
    notes:         row.notes as string | null,
    tags_json:     row.tags_json as string | null,
    critique_json: row.critique_json as string | null,
  };
}

export class TradeStore {
  private db: Database.Database;

  constructor(userDataPath: string) {
    const dbPath = path.join(userDataPath, 'trades.db');
    this.db = new Database(dbPath);
    this.db.exec(CREATE_TABLE);
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
        patterns_json, confidence
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?
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
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Update the most recent trade WHERE exit_at IS NULL.
   * Computes exit_price as entry_price ± pnl_gross/POINT_VALUE (approximation).
   * Returns true if a row was updated, false if no open trade found.
   */
  recordExitForOpenTrade(exit: TradeExit): boolean {
    const open = this.db.prepare(
      `SELECT id, entry_price, direction FROM trades WHERE exit_at IS NULL ORDER BY created_at DESC LIMIT 1`
    ).get() as { id: number; entry_price: number | null; direction: string } | undefined;

    if (!open) return false;

    const entryPrice = open.entry_price ?? 0;
    let exitPrice: number;
    if (open.direction === 'long') {
      exitPrice = entryPrice + exit.pnl_gross / POINT_VALUE;
    } else {
      exitPrice = entryPrice - exit.pnl_gross / POINT_VALUE;
    }

    const result = this.db.prepare(
      `UPDATE trades SET exit_at=?, pnl_gross=?, pnl_net=?, r_multiple=?, exit_price=? WHERE id=?`
    ).run(exit.exit_at, exit.pnl_gross, exit.pnl_net, exit.r_multiple, exitPrice, open.id);

    return result.changes > 0;
  }

  /** Returns true if any trade has no exit_at recorded. */
  hasOpenTrade(): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM trades WHERE exit_at IS NULL LIMIT 1`
    ).get();
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

  /** Aggregate stats. */
  getStats(): TradeStats {
    // Basic counts
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) as totalTrades,
        SUM(CASE WHEN exit_at IS NOT NULL AND r_multiple > 0 THEN 1 ELSE 0 END) as winCount,
        SUM(CASE WHEN exit_at IS NOT NULL AND r_multiple IS NOT NULL AND r_multiple <= 0 THEN 1 ELSE 0 END) as lossCount,
        SUM(CASE WHEN exit_at IS NULL THEN 1 ELSE 0 END) as openCount,
        AVG(CASE WHEN exit_at IS NOT NULL AND r_multiple IS NOT NULL THEN r_multiple END) as avgR,
        SUM(CASE WHEN exit_at IS NOT NULL THEN pnl_net ELSE 0 END) as totalNetPnl
      FROM trades
    `).get() as {
      totalTrades: number;
      winCount: number;
      lossCount: number;
      openCount: number;
      avgR: number | null;
      totalNetPnl: number | null;
    };

    const winCount = counts.winCount ?? 0;
    const lossCount = counts.lossCount ?? 0;
    const closedForRate = winCount + lossCount;
    const winRate = closedForRate > 0 ? winCount / closedForRate : 0;

    // byHour
    const hourRows = this.db.prepare(`
      SELECT
        CAST(strftime('%H', datetime(created_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) as hour,
        COUNT(*) as count,
        AVG(pnl_net) as avgNetPnl
      FROM trades
      WHERE exit_at IS NOT NULL
      GROUP BY hour
      ORDER BY hour
    `).all() as Array<{ hour: number; count: number; avgNetPnl: number | null }>;

    const byHour = hourRows.map(r => ({
      hour:      r.hour,
      count:     r.count,
      avgNetPnl: r.avgNetPnl ?? 0,
    }));

    // byPattern — parse patterns_json for each closed trade
    const patternRows = this.db.prepare(`
      SELECT patterns_json, r_multiple
      FROM trades
      WHERE exit_at IS NOT NULL AND patterns_json IS NOT NULL
    `).all() as Array<{ patterns_json: string; r_multiple: number | null }>;

    const patternMap = new Map<string, { count: number; wins: number; totalR: number }>();
    for (const row of patternRows) {
      let names: string[] = [];
      try {
        names = JSON.parse(row.patterns_json);
      } catch {
        continue;
      }
      if (!Array.isArray(names)) continue;
      for (const name of names) {
        if (typeof name !== 'string') continue;
        const existing = patternMap.get(name) ?? { count: 0, wins: 0, totalR: 0 };
        existing.count++;
        if ((row.r_multiple ?? 0) > 0) existing.wins++;
        existing.totalR += row.r_multiple ?? 0;
        patternMap.set(name, existing);
      }
    }

    const byPattern = Array.from(patternMap.entries()).map(([pattern, stats]) => ({
      pattern,
      count:   stats.count,
      wins:    stats.wins,
      winRate: stats.count > 0 ? stats.wins / stats.count : 0,
      avgR:    stats.count > 0 ? stats.totalR / stats.count : 0,
    }));

    // equityCurve — cumulative sum of pnl_net grouped by date
    const curveRows = this.db.prepare(`
      SELECT
        date(created_at / 1000, 'unixepoch', 'localtime') as date,
        SUM(pnl_net) as dailyNet
      FROM trades
      WHERE exit_at IS NOT NULL AND pnl_net IS NOT NULL
      GROUP BY date
      ORDER BY date
    `).all() as Array<{ date: string; dailyNet: number }>;

    let cumulative = 0;
    const equityCurve = curveRows.map(r => {
      cumulative += r.dailyNet ?? 0;
      return { date: r.date, cumulativeNet: cumulative };
    });

    return {
      totalTrades:  counts.totalTrades ?? 0,
      winCount,
      lossCount,
      openCount:    counts.openCount ?? 0,
      winRate,
      avgR:         counts.avgR ?? 0,
      totalNetPnl:  counts.totalNetPnl ?? 0,
      byPattern,
      byHour,
      equityCurve,
    };
  }

  /** Wipe all trades — called when the journal UI resets. */
  clearAll(): void {
    this.db.exec('DELETE FROM trades');
    console.log('[trade-store] clearAll: all trades deleted via better-sqlite3');
  }

  /** Close the database connection (for testing cleanup). */
  close(): void {
    this.db.close();
  }
}
