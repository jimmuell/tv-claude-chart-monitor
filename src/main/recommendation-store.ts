/**
 * recommendation-store.ts
 *
 * Persistence for every recommendation the app makes — not just the ones that
 * became trades. One row per analysis at bar close, including no_trade, wait
 * and low-confidence calls, because the calls the app declines are exactly what
 * tells you whether its filters are working.
 *
 * IMPORTANT — why this does not touch SCHEMA_VERSION:
 * trade-store.ts drops and recreates `trades` whenever PRAGMA user_version is
 * below its SCHEMA_VERSION. Bumping that constant to add this table would
 * destroy Jim's trade history. The table is therefore created with
 * CREATE TABLE IF NOT EXISTS and user_version is left exactly as it is, so the
 * drop path is never entered. Proven by tests/main/recommendation-store.test.js.
 *
 * Shares the Database handle owned by TradeStore so there is still a single
 * writer to trades.db.
 */

import type Database from 'better-sqlite3';

/** Outcome of grading a call. AMBIGUOUS/EXPIRED/NOT_TRIGGERED are never wins or losses. */
export type RecOutcome =
  | 'PENDING' | 'UNGRADEABLE' | 'NOT_TRIGGERED'
  | 'WIN' | 'LOSS' | 'AMBIGUOUS' | 'EXPIRED';

export interface RecommendationInput {
  created_at:   number;
  symbol:       string;
  timeframe:    string;
  /** Open time (epoch SECONDS) of the bar this call describes — part of the dedup key. */
  bar_time:     number;
  bar_price:    number | null;
  verdict:      string;
  direction:    'long' | 'short' | 'none' | null;
  confidence:   number | null;
  entry:        number | null;
  stop:         number | null;
  target:       number | null;
  rr_planned:   number | null;
  /** JSON array of pattern/setup labels, as the commentary reported them. Never modified. */
  setups_json:  string | null;
  /** Normalised bucket derived from setups_json, so the scorecard groups like with like. */
  setup_key:    string | null;
  /** 1 when the rules lever would have stopped the app acting on this call. */
  blocked:      number;
  /** Which rule fired, in plain English. Null when the call was allowed. */
  blocked_reason: string | null;
  /** Hash of the rules + app version in force. Part of the dedup key. */
  rules_version:  string | null;
  /** Tokens the analysis actually consumed, as the API reported them. */
  input_tokens:   number | null;
  output_tokens:  number | null;
  /** Estimated cost of this one call, in USD. */
  cost_usd:       number | null;
  /** Milliseconds the analysis took — feeds the replay pacing warning. */
  analysis_ms:    number | null;
  structure:    string | null;
  /** 1 when the chart was in Bar Replay. Replay calls are excluded from the default scorecard. */
  replay_mode:  number;
  account_type: string | null;
  app_version:  string | null;
  model_id:     string | null;
  /** Compact JSON of the whole result, so a column we did not think of is recoverable. */
  raw_json:     string | null;
}

export interface RecommendationRow extends RecommendationInput {
  id:              number;
  outcome:         RecOutcome | null;
  bars_to_outcome: number | null;
  r_gross:         number | null;
  r_net:           number | null;
  graded_at:       number | null;
}

const CREATE_RECOMMENDATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS recommendations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      INTEGER NOT NULL,

    symbol          TEXT    NOT NULL,
    timeframe       TEXT    NOT NULL,
    bar_time        INTEGER NOT NULL,
    bar_price       REAL,

    verdict         TEXT    NOT NULL,
    direction       TEXT,
    confidence      REAL,
    entry           REAL,
    stop            REAL,
    target          REAL,
    rr_planned      REAL,
    setups_json     TEXT,
    structure       TEXT,

    replay_mode     INTEGER NOT NULL DEFAULT 0,
    account_type    TEXT,
    app_version     TEXT,
    model_id        TEXT,
    raw_json        TEXT,

    outcome         TEXT,
    bars_to_outcome INTEGER,
    r_gross         REAL,
    r_net           REAL,
    graded_at       INTEGER
  )
`;

// Dedup: one row per symbol+timeframe+bar+mode. A manual refresh on the same bar
// must not create a second call (index.ts has two analysis entry points).
const CREATE_DEDUP_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendations_dedup
    ON recommendations (symbol, timeframe, bar_time, replay_mode)
`;

const CREATE_UNGRADED_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_recommendations_ungraded
    ON recommendations (outcome, replay_mode)
`;

/** True when the table already has this column. */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/**
 * Create the recommendations table and its indexes without touching user_version.
 * New columns are added with ALTER TABLE rather than a schema-version bump,
 * because trade-store drops `trades` whenever user_version moves.
 */
export function initRecommendationsSchema(db: Database.Database): void {
  db.exec(CREATE_RECOMMENDATIONS_TABLE);
  db.exec(CREATE_DEDUP_INDEX);
  db.exec(CREATE_UNGRADED_INDEX);
  if (!hasColumn(db, 'recommendations', 'setup_key')) {
    db.exec('ALTER TABLE recommendations ADD COLUMN setup_key TEXT');
  }
  if (!hasColumn(db, 'recommendations', 'blocked')) {
    db.exec('ALTER TABLE recommendations ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'recommendations', 'blocked_reason')) {
    db.exec('ALTER TABLE recommendations ADD COLUMN blocked_reason TEXT');
  }
  if (!hasColumn(db, 'recommendations', 'rules_version')) {
    db.exec('ALTER TABLE recommendations ADD COLUMN rules_version TEXT');
  }
  for (const [col, type] of [['input_tokens', 'INTEGER'], ['output_tokens', 'INTEGER'],
                             ['cost_usd', 'REAL'], ['analysis_ms', 'INTEGER']] as const) {
    if (!hasColumn(db, 'recommendations', col)) {
      db.exec(`ALTER TABLE recommendations ADD COLUMN ${col} ${type}`);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_recommendations_setup ON recommendations (setup_key, replay_mode)');
  // The dedup key now includes rules_version: the same replay day under the SAME
  // rules still cannot double count, but under NEW rules it is a fair re-test.
  // Replacing an index is safe — it is not the table.
  db.exec('DROP INDEX IF EXISTS idx_recommendations_dedup');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendations_dedup_v2
             ON recommendations (symbol, timeframe, bar_time, replay_mode, rules_version)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_recommendations_rules ON recommendations (rules_version, replay_mode, blocked)');
}

export interface ScorecardBucket {
  label:    string;
  graded:   number;
  wins:     number;
  losses:   number;
  winRate:  number;
  avgNetR:  number | null;
}

export interface Scorecard {
  /** Counts that feed the win rate. */
  graded:       number;
  wins:         number;
  losses:       number;
  winRate:      number;
  avgNetR:      number | null;
  avgGrossR:    number | null;
  /** Reported separately — never folded into the win rate. */
  ambiguous:    number;
  expired:      number;
  notTriggered: number;
  ungradeable:  number;
  pending:      number;
  /** Every saved call in scope, graded or not. */
  total:        number;
  bySetup:      ScorecardBucket[];
  byHour:       ScorecardBucket[];
  byDirection:  ScorecardBucket[];
  /** Win rate this plan must beat, from fees and the median planned R:R. */
  breakEven:    number | null;
  medianRr:     number | null;
  /** The rules version these numbers are filtered to, or null for all. */
  rulesVersion: string | null;
  /**
   * Calls the rules lever stopped the app acting on, graded anyway (shadow
   * grading). Never folded into the numbers above — a blocked winner is the
   * cost of a rule, and seeing it is the whole point.
   */
  blocked: {
    graded:  number;
    wins:    number;
    losses:  number;
    winRate: number;
    avgNetR: number | null;
    total:   number;
  };
}

export class RecommendationStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    initRecommendationsSchema(this.db);
  }

  /** Save one call. Returns its id, or null when the bar already has one (dedup). */
  save(rec: RecommendationInput): number | null {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO recommendations (
        created_at, symbol, timeframe, bar_time, bar_price,
        verdict, direction, confidence, entry, stop, target, rr_planned,
        setups_json, setup_key, structure, replay_mode, account_type, app_version, model_id, raw_json,
        blocked, blocked_reason, rules_version, input_tokens, output_tokens, cost_usd, analysis_ms
      ) VALUES (
        @created_at, @symbol, @timeframe, @bar_time, @bar_price,
        @verdict, @direction, @confidence, @entry, @stop, @target, @rr_planned,
        @setups_json, @setup_key, @structure, @replay_mode, @account_type, @app_version, @model_id, @raw_json,
        @blocked, @blocked_reason, @rules_version,
        @input_tokens, @output_tokens, @cost_usd, @analysis_ms
      )
    `);
    const info = stmt.run(rec as unknown as Record<string, unknown>);
    return info.changes > 0 ? Number(info.lastInsertRowid) : null;
  }

  /** Calls still waiting on a verdict, oldest bar first. */
  getUngraded(limit = 200): RecommendationRow[] {
    return this.db.prepare(`
      SELECT * FROM recommendations
      WHERE outcome IS NULL OR outcome = 'PENDING'
      ORDER BY bar_time ASC
      LIMIT ?
    `).all(limit) as RecommendationRow[];
  }

  /**
   * Write a grade onto a call. Idempotent: re-grading with the same verdict is a
   * no-op write, and a settled outcome is never overwritten by a later PENDING.
   */
  applyGrade(
    id: number,
    grade: { outcome: RecOutcome; barsToOutcome: number | null; rGross: number | null; rNet: number | null },
  ): void {
    if (grade.outcome === 'PENDING') {
      // Still unresolved — leave the row untouched so it is picked up again.
      return;
    }
    this.db.prepare(`
      UPDATE recommendations
         SET outcome = ?, bars_to_outcome = ?, r_gross = ?, r_net = ?, graded_at = ?
       WHERE id = ?
         AND (outcome IS NULL OR outcome = 'PENDING')
    `).run(grade.outcome, grade.barsToOutcome, grade.rGross, grade.rNet, Date.now(), id);
  }

  /**
   * Clear grades that a rule change could invalidate, so the grader settles them
   * again. Only WIN/LOSS/AMBIGUOUS are affected by scoring-rule changes —
   * NOT_TRIGGERED and UNGRADEABLE are decided before any level is scored.
   * Returns the rows cleared, with their previous outcome, for a before/after diff.
   */
  clearGradesForRegrade(): Array<{ id: number; outcome: string }> {
    const rows = this.db.prepare(`
      SELECT id, outcome FROM recommendations
      WHERE outcome IN ('WIN','LOSS','AMBIGUOUS')
    `).all() as Array<{ id: number; outcome: string }>;
    if (rows.length > 0) {
      this.db.prepare(`
        UPDATE recommendations
           SET outcome = NULL, bars_to_outcome = NULL, r_gross = NULL, r_net = NULL, graded_at = NULL
         WHERE outcome IN ('WIN','LOSS','AMBIGUOUS')
      `).run();
    }
    return rows;
  }

  /** Current outcome of one call, for comparing before and after a re-grade. */
  outcomeOf(id: number): string | null {
    const row = this.db.prepare('SELECT outcome FROM recommendations WHERE id = ?').get(id) as
      { outcome: string | null } | undefined;
    return row ? row.outcome : null;
  }

  /**
   * Fill setup_key on rows that predate the column. The caller supplies the pure
   * normaliser, so this module needs no knowledge of the label vocabulary.
   * Idempotent: only rows with a NULL key are touched.
   */
  backfillSetupKeys(mapper: (setupsJson: string | null) => string): number {
    const rows = this.db.prepare(
      'SELECT id, setups_json FROM recommendations WHERE setup_key IS NULL',
    ).all() as Array<{ id: number; setups_json: string | null }>;
    const update = this.db.prepare('UPDATE recommendations SET setup_key = ? WHERE id = ?');
    for (const row of rows) update.run(mapper(row.setups_json), row.id);
    return rows.length;
  }

  /** Total saved calls, optionally restricted to live or replay. */
  count(replayMode?: 0 | 1): number {
    const row = replayMode === undefined
      ? this.db.prepare('SELECT COUNT(*) AS n FROM recommendations').get()
      : this.db.prepare('SELECT COUNT(*) AS n FROM recommendations WHERE replay_mode = ?').get(replayMode);
    return (row as { n: number }).n ?? 0;
  }

  /** Delete rows whose app_version marks them as seeded test data. */
  deleteByAppVersion(appVersion: string): number {
    return this.db.prepare('DELETE FROM recommendations WHERE app_version = ?').run(appVersion).changes;
  }

  /**
   * Aggregate the scorecard for one mode. Live (replay_mode=0) by default, and
   * restricted to one rules_version when given so results from different rules
   * are never averaged together.
   */
  getScorecard(opts: { replayMode?: 0 | 1; rulesVersion?: string | null } = {}): Scorecard {
    const mode = opts.replayMode ?? 0;
    const ver  = opts.rulesVersion ?? null;
    // Allowed calls only for the headline numbers; blocked are reported apart.
    const verSql = ver === null ? '' : ' AND rules_version = ?';
    const args   = (extra: unknown[] = []): unknown[] =>
      ver === null ? [mode, ...extra] : [mode, ver, ...extra];

    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN outcome = 'WIN'           THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN outcome = 'LOSS'          THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN outcome = 'AMBIGUOUS'     THEN 1 ELSE 0 END) AS ambiguous,
        SUM(CASE WHEN outcome = 'EXPIRED'       THEN 1 ELSE 0 END) AS expired,
        SUM(CASE WHEN outcome = 'NOT_TRIGGERED' THEN 1 ELSE 0 END) AS notTriggered,
        SUM(CASE WHEN outcome = 'UNGRADEABLE'   THEN 1 ELSE 0 END) AS ungradeable,
        SUM(CASE WHEN outcome IS NULL OR outcome = 'PENDING' THEN 1 ELSE 0 END) AS pending,
        COUNT(*) AS total
      FROM recommendations WHERE replay_mode = ?${verSql} AND blocked = 0
    `).all(...args())[0] as Record<string, number | null>;

    const wins   = counts.wins   ?? 0;
    const losses = counts.losses ?? 0;
    const graded = wins + losses;

    const rRow = this.db.prepare(`
      SELECT AVG(r_net) AS avgNet, AVG(r_gross) AS avgGross, AVG(ABS(entry - stop)) AS riskPoints
      FROM recommendations
      WHERE replay_mode = ?${verSql} AND blocked = 0 AND outcome IN ('WIN','LOSS') AND r_net IS NOT NULL
    `).all(...args())[0] as { avgNet: number | null; avgGross: number | null; riskPoints: number | null };

    const rrs = this.db.prepare(`
      SELECT rr_planned FROM recommendations
      WHERE replay_mode = ?${verSql} AND blocked = 0 AND rr_planned IS NOT NULL AND outcome IN ('WIN','LOSS')
      ORDER BY rr_planned
    `).all(...args()) as Array<{ rr_planned: number }>;
    const medianRr = rrs.length > 0 ? rrs[Math.floor(rrs.length / 2)].rr_planned : null;

    const b = this.db.prepare(`
      SELECT
        SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
        AVG(CASE WHEN outcome IN ('WIN','LOSS') THEN r_net END) AS avgNet,
        COUNT(*) AS total
      FROM recommendations WHERE replay_mode = ?${verSql} AND blocked = 1
    `).all(...args())[0] as Record<string, number | null>;
    const bWins = b.wins ?? 0;
    const bLoss = b.losses ?? 0;

    return {
      graded, wins, losses,
      winRate:      graded > 0 ? wins / graded : 0,
      avgNetR:      rRow.avgNet,
      avgGrossR:    rRow.avgGross,
      ambiguous:    counts.ambiguous    ?? 0,
      expired:      counts.expired      ?? 0,
      notTriggered: counts.notTriggered ?? 0,
      ungradeable:  counts.ungradeable  ?? 0,
      pending:      counts.pending      ?? 0,
      total:        counts.total        ?? 0,
      bySetup:      this.bucketBySetup(mode, ver),
      byHour:       this.bucketByHour(mode, ver),
      byDirection:  this.bucketByDirection(mode, ver),
      medianRr,
      breakEven:    breakEvenFrom(medianRr, rRow.riskPoints),
      rulesVersion: ver,
      blocked: {
        graded:  bWins + bLoss,
        wins:    bWins,
        losses:  bLoss,
        winRate: (bWins + bLoss) > 0 ? bWins / (bWins + bLoss) : 0,
        avgNetR: b.avgNet,
        total:   b.total ?? 0,
      },
    };
  }

  /** Token and dollar totals for a set of calls, for the cost report. */
  costSummary(opts: { replayMode?: 0 | 1; rulesVersion?: string | null } = {}): {
    calls: number; withUsage: number; inputTokens: number; outputTokens: number;
    costUsd: number; avgCostUsd: number | null; avgAnalysisMs: number | null;
  } {
    const mode = opts.replayMode ?? 0;
    const ver  = opts.rulesVersion ?? null;
    const sql = `
      SELECT COUNT(*) AS calls,
             SUM(CASE WHEN input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS withUsage,
             COALESCE(SUM(input_tokens), 0)  AS inputTokens,
             COALESCE(SUM(output_tokens), 0) AS outputTokens,
             COALESCE(SUM(cost_usd), 0)      AS costUsd,
             AVG(cost_usd)                   AS avgCostUsd,
             AVG(analysis_ms)                AS avgAnalysisMs
      FROM recommendations
      WHERE replay_mode = ?${ver === null ? '' : ' AND rules_version = ?'}`;
    const row = this.db.prepare(sql).all(...(ver === null ? [mode] : [mode, ver]))[0] as Record<string, number | null>;
    return {
      calls: row.calls ?? 0, withUsage: row.withUsage ?? 0,
      inputTokens: row.inputTokens ?? 0, outputTokens: row.outputTokens ?? 0,
      costUsd: row.costUsd ?? 0, avgCostUsd: row.avgCostUsd, avgAnalysisMs: row.avgAnalysisMs,
    };
  }

  /** Every rules_version present, newest first, with how many calls each produced. */
  listRulesVersions(): Array<{ rules_version: string; n: number; firstSeen: number; lastSeen: number }> {
    return this.db.prepare(`
      SELECT COALESCE(rules_version, '(none)') AS rules_version, COUNT(*) AS n,
             MIN(created_at) AS firstSeen, MAX(created_at) AS lastSeen
      FROM recommendations
      GROUP BY rules_version
      ORDER BY lastSeen DESC
    `).all() as Array<{ rules_version: string; n: number; firstSeen: number; lastSeen: number }>;
  }

  /** Win rate and average net R per normalised setup key — one bucket per call. */
  private bucketBySetup(mode: 0 | 1, ver: string | null): ScorecardBucket[] {
    const rows = this.db.prepare(`
      SELECT COALESCE(setup_key, 'other') AS setup_key, outcome, r_net FROM recommendations
      WHERE replay_mode = ? AND blocked = 0 AND outcome IN ('WIN','LOSS')
        ${ver === null ? '' : 'AND rules_version = ?'}
    `).all(...(ver === null ? [mode] : [mode, ver])) as Array<{ setup_key: string; outcome: string; r_net: number | null }>;

    const map = new Map<string, { graded: number; wins: number; losses: number; rSum: number; rCount: number }>();
    for (const row of rows) {
      const s = map.get(row.setup_key) ?? { graded: 0, wins: 0, losses: 0, rSum: 0, rCount: 0 };
      s.graded++;
      if (row.outcome === 'WIN')  s.wins++;
      if (row.outcome === 'LOSS') s.losses++;
      if (row.r_net !== null) { s.rSum += row.r_net; s.rCount++; }
      map.set(row.setup_key, s);
    }
    return toBuckets(map);
  }

  /** Win rate and average net R per local hour of day. */
  private bucketByHour(mode: 0 | 1, ver: string | null): ScorecardBucket[] {
    const rows = this.db.prepare(`
      SELECT
        CAST(strftime('%H', datetime(created_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) AS hour,
        outcome, r_net
      FROM recommendations
      WHERE replay_mode = ? AND blocked = 0 AND outcome IN ('WIN','LOSS')
        ${ver === null ? '' : 'AND rules_version = ?'}
    `).all(...(ver === null ? [mode] : [mode, ver])) as Array<{ hour: number; outcome: string; r_net: number | null }>;

    const map = new Map<string, { graded: number; wins: number; losses: number; rSum: number; rCount: number }>();
    for (const row of rows) {
      const label = String(row.hour).padStart(2, '0') + ':00';
      const s = map.get(label) ?? { graded: 0, wins: 0, losses: 0, rSum: 0, rCount: 0 };
      s.graded++;
      if (row.outcome === 'WIN')  s.wins++;
      if (row.outcome === 'LOSS') s.losses++;
      if (row.r_net !== null) { s.rSum += row.r_net; s.rCount++; }
      map.set(label, s);
    }
    return toBuckets(map).sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Win rate and average net R for long versus short. */
  private bucketByDirection(mode: 0 | 1, ver: string | null): ScorecardBucket[] {
    const rows = this.db.prepare(`
      SELECT direction, outcome, r_net FROM recommendations
      WHERE replay_mode = ? AND blocked = 0 AND outcome IN ('WIN','LOSS') AND direction IN ('long','short')
        ${ver === null ? '' : 'AND rules_version = ?'}
    `).all(...(ver === null ? [mode] : [mode, ver])) as Array<{ direction: string; outcome: string; r_net: number | null }>;

    const map = new Map<string, { graded: number; wins: number; losses: number; rSum: number; rCount: number }>();
    for (const row of rows) {
      const s = map.get(row.direction) ?? { graded: 0, wins: 0, losses: 0, rSum: 0, rCount: 0 };
      s.graded++;
      if (row.outcome === 'WIN')  s.wins++;
      if (row.outcome === 'LOSS') s.losses++;
      if (row.r_net !== null) { s.rSum += row.r_net; s.rCount++; }
      map.set(row.direction, s);
    }
    return toBuckets(map);
  }
}

/** Turn a label->tally map into sorted scorecard buckets. */
function toBuckets(
  map: Map<string, { graded: number; wins: number; losses: number; rSum: number; rCount: number }>,
): ScorecardBucket[] {
  return Array.from(map.entries())
    .map(([label, s]) => ({
      label,
      graded:  s.graded,
      wins:    s.wins,
      losses:  s.losses,
      winRate: s.wins + s.losses > 0 ? s.wins / (s.wins + s.losses) : 0,
      avgNetR: s.rCount > 0 ? s.rSum / s.rCount : null,
    }))
    .sort((a, b) => b.graded - a.graded);
}

/** Break-even win rate from planned R:R and the fee share of risk. */
function breakEvenFrom(rrPlanned: number | null, riskPoints: number | null): number | null {
  if (rrPlanned === null || rrPlanned <= 0) return null;
  const POINT_VALUE = 5.0;
  const FEE_PER_RT  = 1.24;
  const riskDollars = (riskPoints ?? 0) * POINT_VALUE;
  const feeR = riskDollars > 0 ? FEE_PER_RT / riskDollars : 0;
  return (1 + feeR) / (rrPlanned + 1);
}
