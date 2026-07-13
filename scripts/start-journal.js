#!/usr/bin/env node
'use strict';

// Standalone journal server — uses sql.js (pure WASM) so it works in any
// Node.js version regardless of what better-sqlite3 was compiled for.

require('dotenv/config');

const express  = require('express');
const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const Anthropic = require('@anthropic-ai/sdk').default;

const DB_PATH = process.env.JOURNAL_DB_PATH
  || path.join(os.homedir(), 'Library', 'Application Support', 'trading-analyzer', 'trades.db');

const STATIC_DIR = path.join(__dirname, '..', 'dist', 'journal');

// ─── sql.js wrappers ──────────────────────────────────────────────────────────

let SQL; // set once in main()

function openDb() {
  if (!fs.existsSync(DB_PATH)) return null;
  const buf = fs.readFileSync(DB_PATH);
  return new SQL.Database(buf);
}

function closeDb(db) {
  db.close();
}

function saveAndClose(db) {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  db.close();
}

function queryAll(db, sql, params) {
  const stmt = db.prepare(sql);
  if (params && params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(db, sql, params) {
  const rows = queryAll(db, sql, params);
  return rows[0] ?? null;
}

function dbRun(db, sql, params) {
  db.run(sql, params || []);
}

function lastInsertId(db) {
  const row = queryOne(db, 'SELECT last_insert_rowid() AS id');
  return row ? row.id : null;
}

// ─── Row → TradeRecord ────────────────────────────────────────────────────────

function rowToRecord(row) {
  return {
    id:            row.id,
    created_at:    row.created_at,
    symbol:        row.symbol,
    timeframe:     row.timeframe,
    direction:     row.direction,
    entry_price:   row.entry_price  ?? null,
    stop_price:    row.stop_price   ?? null,
    target_price:  row.target_price ?? null,
    trailing_stop: Boolean(row.trailing_stop),
    rr_planned:    row.rr_planned   ?? null,
    verdict:       row.verdict,
    headline:      row.headline      ?? null,
    objective:     row.objective     ?? null,
    steps_json:    row.steps_json    ?? null,
    structure:     row.structure     ?? null,
    rationale:     row.rationale     ?? null,
    patterns_json: row.patterns_json ?? null,
    confidence:    row.confidence    ?? null,
    exit_at:       row.exit_at       ?? null,
    exit_price:    row.exit_price    ?? null,
    pnl_gross:     row.pnl_gross     ?? null,
    pnl_net:       row.pnl_net       ?? null,
    r_multiple:    row.r_multiple    ?? null,
    notes:         row.notes         ?? null,
    tags_json:     row.tags_json     ?? null,
    critique_json: row.critique_json ?? null,
  };
}

// ─── Stats (mirrors TradeStore.getStats) ─────────────────────────────────────

function computeStats(db) {
  const counts = queryOne(db, `
    SELECT
      COUNT(*) as totalTrades,
      SUM(CASE WHEN exit_at IS NOT NULL AND r_multiple > 0 THEN 1 ELSE 0 END) as winCount,
      SUM(CASE WHEN exit_at IS NOT NULL AND r_multiple IS NOT NULL AND r_multiple <= 0 THEN 1 ELSE 0 END) as lossCount,
      SUM(CASE WHEN exit_at IS NULL THEN 1 ELSE 0 END) as openCount,
      AVG(CASE WHEN exit_at IS NOT NULL AND r_multiple IS NOT NULL THEN r_multiple END) as avgR,
      SUM(CASE WHEN exit_at IS NOT NULL THEN pnl_net ELSE 0 END) as totalNetPnl
    FROM trades
  `);

  const winCount   = counts ? (counts.winCount  ?? 0) : 0;
  const lossCount  = counts ? (counts.lossCount ?? 0) : 0;
  const closedForRate = winCount + lossCount;
  const winRate    = closedForRate > 0 ? winCount / closedForRate : 0;

  const hourRows = queryAll(db, `
    SELECT
      CAST(strftime('%H', datetime(created_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) as hour,
      COUNT(*) as count,
      AVG(pnl_net) as avgNetPnl
    FROM trades
    WHERE exit_at IS NOT NULL
    GROUP BY hour
    ORDER BY hour
  `);

  const patternRows = queryAll(db, `
    SELECT patterns_json, r_multiple
    FROM trades
    WHERE exit_at IS NOT NULL AND patterns_json IS NOT NULL
  `);

  const patternMap = new Map();
  for (const row of patternRows) {
    let names = [];
    try { names = JSON.parse(row.patterns_json); } catch { continue; }
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      if (typeof name !== 'string') continue;
      const s = patternMap.get(name) ?? { count: 0, wins: 0, totalR: 0 };
      s.count++;
      if ((row.r_multiple ?? 0) > 0) s.wins++;
      s.totalR += row.r_multiple ?? 0;
      patternMap.set(name, s);
    }
  }

  const byPattern = Array.from(patternMap.entries()).map(([pattern, s]) => ({
    pattern,
    count:   s.count,
    wins:    s.wins,
    winRate: s.count > 0 ? s.wins / s.count : 0,
    avgR:    s.count > 0 ? s.totalR / s.count : 0,
  }));

  const curveRows = queryAll(db, `
    SELECT
      date(created_at / 1000, 'unixepoch', 'localtime') as date,
      SUM(pnl_net) as dailyNet
    FROM trades
    WHERE exit_at IS NOT NULL AND pnl_net IS NOT NULL
    GROUP BY date
    ORDER BY date
  `);

  let cumulative = 0;
  const equityCurve = curveRows.map(r => {
    cumulative += r.dailyNet ?? 0;
    return { date: r.date, cumulativeNet: cumulative };
  });

  // byConfidenceBucket
  const bucketRows = queryAll(db, `
    SELECT
      CASE
        WHEN confidence < 0.2 THEN '0-20%'
        WHEN confidence < 0.4 THEN '20-40%'
        WHEN confidence < 0.6 THEN '40-60%'
        WHEN confidence < 0.8 THEN '60-80%'
        ELSE '80-100%'
      END as bucket,
      COUNT(*) as count,
      SUM(CASE WHEN r_multiple > 0 THEN 1 ELSE 0 END) as wins,
      AVG(r_multiple) as avgR
    FROM trades
    WHERE exit_at IS NOT NULL AND confidence IS NOT NULL
    GROUP BY bucket ORDER BY bucket
  `);
  const byConfidenceBucket = bucketRows.map(r => ({
    bucket: r.bucket,
    count: r.count,
    wins: r.wins ?? 0,
    winRate: r.count > 0 ? (r.wins ?? 0) / r.count : 0,
    avgR: r.avgR ?? 0,
  }));

  // byDayOfWeek
  const dowRows = queryAll(db, `
    SELECT
      CAST(strftime('%w', datetime(created_at/1000, 'unixepoch', 'localtime')) AS INTEGER) as dow,
      COUNT(*) as count,
      AVG(pnl_net) as avgNetPnl,
      SUM(CASE WHEN r_multiple > 0 THEN 1 ELSE 0 END) as wins
    FROM trades WHERE exit_at IS NOT NULL
    GROUP BY dow ORDER BY dow
  `);
  const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDayOfWeek = dowRows.map(r => ({
    dow: r.dow,
    label: DOW_LABELS[r.dow] ?? '?',
    count: r.count,
    avgNetPnl: r.avgNetPnl ?? 0,
    winRate: r.count > 0 ? (r.wins ?? 0) / r.count : 0,
  }));

  return {
    totalTrades:  counts ? (counts.totalTrades ?? 0) : 0,
    winCount,
    lossCount,
    openCount:    counts ? (counts.openCount ?? 0) : 0,
    winRate,
    avgR:         counts ? (counts.avgR ?? 0) : 0,
    totalNetPnl:  counts ? (counts.totalNetPnl ?? 0) : 0,
    byPattern,
    byHour: hourRows.map(r => ({ hour: r.hour, count: r.count, avgNetPnl: r.avgNetPnl ?? 0 })),
    equityCurve,
    byConfidenceBucket,
    byDayOfWeek,
  };
}

// ─── Empty stats (no DB yet) ──────────────────────────────────────────────────

const EMPTY_STATS = {
  totalTrades: 0, winCount: 0, lossCount: 0, openCount: 0,
  winRate: 0, avgR: 0, totalNetPnl: 0,
  byPattern: [], byHour: [], equityCurve: [],
  byConfidenceBucket: [],
  byDayOfWeek: [],
};

// ─── Critique prompt ──────────────────────────────────────────────────────────

function buildCritiquePrompt(trade) {
  const steps = (() => { try { return JSON.parse(trade.steps_json || '[]'); } catch { return []; } })();
  const patterns = (() => { try { return JSON.parse(trade.patterns_json || '[]'); } catch { return []; } })();
  const resultLine = trade.r_multiple !== null
    ? `${trade.r_multiple > 0 ? '+' : ''}${trade.r_multiple.toFixed(2)}R ($${(trade.pnl_gross ?? 0).toFixed(2)})`
    : 'Still open / unknown';

  return `You are reviewing an automated trade taken by an AI-driven trading system.

Trade: ${trade.direction} on ${trade.symbol} (${trade.timeframe} timeframe) entered at ${trade.entry_price ?? 'unknown'}
Stop: ${trade.stop_price ?? 'unknown'} | Target: ${trade.target_price ?? 'unknown'} | Planned R:R: ${trade.rr_planned ?? 'unknown'}
Result: ${resultLine}

What the system saw:
${trade.headline ?? '(no headline)'}

Setup steps:
${steps.join('\n')}

Market structure: ${trade.structure ?? '(none)'}
Rationale: ${trade.rationale ?? '(none)'}
Patterns detected: ${patterns.join(', ') || '(none)'}
Confidence: ${trade.confidence !== null ? ((trade.confidence ?? 0) * 100).toFixed(0) : '?'}%

In 3-5 sentences of plain English:
1. Was this a good setup to take?
2. What did the system get right?
3. One specific improvement for future similar setups.`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const initSqlJs = require('sql.js');
  SQL = await initSqlJs();

  const app = express();
  app.use(express.json());
  app.use(express.static(STATIC_DIR));

  // GET /api/trades
  app.get('/api/trades', (_req, res) => {
    const db = openDb();
    if (!db) return res.json([]);
    try {
      res.json(queryAll(db, 'SELECT * FROM trades ORDER BY created_at DESC, id DESC').map(rowToRecord));
    } catch (e) {
      console.error('[journal] GET /api/trades:', e);
      res.status(500).json({ error: String(e) });
    } finally {
      closeDb(db);
    }
  });

  // GET /api/trades/:id
  app.get('/api/trades/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const db = openDb();
    if (!db) return res.status(404).json({ error: 'No database' });
    try {
      const row = queryOne(db, 'SELECT * FROM trades WHERE id=?', [id]);
      if (!row) return res.status(404).json({ error: 'Not found' });
      res.json(rowToRecord(row));
    } catch (e) {
      console.error('[journal] GET /api/trades/:id:', e);
      res.status(500).json({ error: String(e) });
    } finally {
      closeDb(db);
    }
  });

  // POST /api/trades/:id/notes
  app.post('/api/trades/:id/notes', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { notes, tags } = req.body;
    if (typeof notes !== 'string') return res.status(400).json({ error: 'notes must be a string' });
    if (!Array.isArray(tags) || !tags.every(t => typeof t === 'string'))
      return res.status(400).json({ error: 'tags must be string[]' });

    const db = openDb();
    if (!db) return res.status(500).json({ error: 'No database' });
    try {
      dbRun(db, 'UPDATE trades SET notes=?, tags_json=? WHERE id=?', [notes, JSON.stringify(tags), id]);
      saveAndClose(db);
      res.json({ ok: true });
    } catch (e) {
      console.error('[journal] POST /api/trades/:id/notes:', e);
      try { closeDb(db); } catch {}
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/trades/:id/critique
  app.post('/api/trades/:id/critique', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    // Load trade
    const db = openDb();
    if (!db) return res.status(500).json({ error: 'No database' });
    const row = queryOne(db, 'SELECT * FROM trades WHERE id=?', [id]);
    closeDb(db);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const trade = rowToRecord(row);

    // Return cached
    if (trade.critique_json) {
      try { return res.json(JSON.parse(trade.critique_json)); } catch {}
    }

    // Generate via Anthropic
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY || '';
      if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

      const client = new Anthropic({ apiKey });
      const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role: 'user', content: buildCritiquePrompt(trade) }],
      });

      const first = message.content[0];
      if (first.type !== 'text') throw new Error('Unexpected Anthropic response type');
      const critiqueText = first.text;

      // Persist
      const critique = { text: critiqueText, created_at: Date.now() };
      const db2 = openDb();
      if (db2) {
        try {
          dbRun(db2, 'UPDATE trades SET critique_json=? WHERE id=?', [JSON.stringify(critique), id]);
          saveAndClose(db2);
        } catch { try { closeDb(db2); } catch {} }
      }

      res.json(critique);
    } catch (e) {
      console.error('[journal] POST /api/trades/:id/critique:', e);
      res.status(500).json({ error: String(e) });
    }
  });

  // DELETE /api/trades — wipe all trades (paper trading reset)
  app.delete('/api/trades', (_req, res) => {
    const db = openDb();
    if (!db) return res.json({ ok: true, deleted: 0 });
    try {
      const row = queryOne(db, 'SELECT COUNT(*) as n FROM trades');
      const count = row ? (row.n ?? 0) : 0;
      dbRun(db, 'DELETE FROM trades');
      saveAndClose(db);
      console.log(`[journal] Trade journal reset — ${count} trade(s) deleted`);
      res.json({ ok: true, deleted: count });
    } catch (e) {
      console.error('[journal] DELETE /api/trades:', e);
      try { closeDb(db); } catch {}
      res.status(500).json({ error: String(e) });
    }
  });

  // GET /api/stats
  app.get('/api/stats', (_req, res) => {
    const db = openDb();
    if (!db) return res.json(EMPTY_STATS);
    try {
      res.json(computeStats(db));
    } catch (e) {
      console.error('[journal] GET /api/stats:', e);
      res.status(500).json({ error: String(e) });
    } finally {
      closeDb(db);
    }
  });

  // SPA fallback
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(STATIC_DIR, 'index.html'), err => {
      if (err) res.status(404).send('Journal not built yet. Run: pnpm build:journal');
    });
  });

  app.listen(3001, '127.0.0.1', () => {
    console.log('Journal server listening on http://localhost:3001');
    if (!fs.existsSync(DB_PATH)) {
      console.log(`No database yet at: ${DB_PATH}`);
      console.log('Trades will appear once the Electron app executes auto-trades.');
    }
  });
}

main().catch(err => { console.error(err); process.exit(1); });
