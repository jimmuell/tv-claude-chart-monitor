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

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'config.json');

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

function stripFences(s) {
  return s.replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
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
    account_type:     row.account_type     ?? null,
    qty:              row.qty              ?? null,
    direction_source: row.direction_source ?? null,
    entry_source:     row.entry_source     ?? null,
    needs_review:     Boolean(row.needs_review),
    exit_at:       row.exit_at       ?? null,
    exit_price:    row.exit_price    ?? null,
    exit_source:   row.exit_source   ?? null,
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
  const FILTER = `needs_review = 0 AND direction != 'unknown'`;

  const reviewRow = queryOne(db, `SELECT COUNT(*) as count FROM trades WHERE NOT (${FILTER})`);
  const needsReviewCount = reviewRow ? (reviewRow.count ?? 0) : 0;

  const counts = queryOne(db, `
    SELECT
      COUNT(*) as totalTrades,
      SUM(CASE WHEN exit_at IS NOT NULL AND pnl_net > 0 THEN 1 ELSE 0 END) as winCount,
      SUM(CASE WHEN exit_at IS NOT NULL AND pnl_net IS NOT NULL AND pnl_net < 0 THEN 1 ELSE 0 END) as lossCount,
      SUM(CASE WHEN exit_at IS NULL THEN 1 ELSE 0 END) as openCount,
      SUM(CASE WHEN exit_at IS NOT NULL THEN pnl_net ELSE 0 END) as totalNetPnl
    FROM trades
    WHERE ${FILTER}
  `);
  const avgRRow = queryOne(db, `
    SELECT AVG(r_multiple) as avgR FROM trades
    WHERE exit_at IS NOT NULL AND r_multiple IS NOT NULL AND ${FILTER}
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
    WHERE exit_at IS NOT NULL AND ${FILTER}
    GROUP BY hour
    ORDER BY hour
  `);

  const patternRows = queryAll(db, `
    SELECT patterns_json, r_multiple
    FROM trades
    WHERE exit_at IS NOT NULL AND patterns_json IS NOT NULL AND ${FILTER}
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
    WHERE exit_at IS NOT NULL AND pnl_net IS NOT NULL AND ${FILTER}
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
      SUM(CASE WHEN pnl_net > 0 THEN 1 ELSE 0 END) as wins,
      AVG(r_multiple) as avgR
    FROM trades
    WHERE exit_at IS NOT NULL AND confidence IS NOT NULL AND ${FILTER}
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
      SUM(CASE WHEN pnl_net > 0 THEN 1 ELSE 0 END) as wins
    FROM trades WHERE exit_at IS NOT NULL AND ${FILTER}
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
    totalTrades:      counts ? (counts.totalTrades ?? 0) : 0,
    winCount,
    lossCount,
    openCount:        counts ? (counts.openCount ?? 0) : 0,
    winRate,
    avgR:             avgRRow ? (avgRRow.avgR ?? 0) : 0,
    totalNetPnl:      counts ? (counts.totalNetPnl ?? 0) : 0,
    needsReviewCount,
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
  winRate: 0, avgR: 0, totalNetPnl: 0, needsReviewCount: 0,
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

// ─── SSE broadcast ────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcastRefresh(reason) {
  const payload = `data: ${JSON.stringify({ type: 'refresh', reason, ts: Date.now() })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// Watch DB file for changes written by the Electron main process.
// fs.watch on macOS (FSEvents) is unreliable for cross-process writes, so we
// use mtime polling as the primary detection mechanism (2 s interval).
// fs.watch is kept as a fast-path supplement — it fires immediately when it
// works, but missing events are caught by the next poll anyway.
let lastDbMtime = 0;
let dbWatchTimer = null;

function broadcastRefreshDebounced() {
  clearTimeout(dbWatchTimer);
  dbWatchTimer = setTimeout(() => broadcastRefresh('db_change'), 250);
}

function watchDb() {
  // Seed the baseline mtime so the first poll doesn't broadcast on startup.
  try { lastDbMtime = fs.statSync(DB_PATH).mtimeMs; } catch { lastDbMtime = 0; }

  // Reliable path: poll mtime every 2 s.
  setInterval(() => {
    try {
      const mtime = fs.statSync(DB_PATH).mtimeMs;
      if (mtime !== lastDbMtime) {
        lastDbMtime = mtime;
        broadcastRefreshDebounced();
      }
    } catch { /* DB doesn't exist yet */ }
  }, 2000);

  // Fast-path supplement: fs.watch fires immediately when the OS delivers the
  // event (often works, not guaranteed on macOS).
  try {
    fs.watch(DB_PATH, broadcastRefreshDebounced);
  } catch (e) {
    console.warn('[journal] fs.watch failed (mtime poll still active):', e.message);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const initSqlJs = require('sql.js');
  SQL = await initSqlJs();

  watchDb();

  const app = express();
  app.use(express.json());
  app.use(express.static(STATIC_DIR));

  // GET /api/events — SSE stream; clients subscribe and receive 'refresh' events
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    res.write('data: {"type":"connected"}\n\n');
  });

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
      broadcastRefresh('notes_updated');
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
      const critiqueText = stripFences(first.text);

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

  // POST /api/trades — manually log a trade entry (open position)
  app.post('/api/trades', (req, res) => {
    const { symbol, direction, entry_price, stop_price, created_at } = req.body;
    if (!symbol || !direction || typeof entry_price !== 'number') {
      return res.status(400).json({ error: 'symbol, direction, entry_price required' });
    }
    if (direction !== 'long' && direction !== 'short' && direction !== 'unknown') {
      return res.status(400).json({ error: 'direction must be long, short, or unknown' });
    }
    const db = openDb();
    if (!db) return res.status(500).json({ error: 'db_unavailable' });
    try {
      dbRun(db,
        `INSERT INTO trades (created_at, symbol, timeframe, direction, entry_price, stop_price, verdict)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [created_at ?? Date.now(), symbol, '1', direction, entry_price,
         typeof stop_price === 'number' ? stop_price : null, 'manual']
      );
      const id = queryOne(db, 'SELECT last_insert_rowid() as id').id;
      const row = queryOne(db, 'SELECT * FROM trades WHERE id=?', [id]);
      saveAndClose(db);
      broadcastRefresh('trade_logged');
      res.json(rowToRecord(row));
    } catch (e) {
      console.error('[journal] POST /api/trades:', e);
      try { closeDb(db); } catch {}
      res.status(500).json({ error: String(e) });
    }
  });

  // DELETE /api/trades — wipe all trades (paper trading reset).
  // The Electron main process (better-sqlite3) is the single writer: it performs the
  // drop+recreate and signals completion. The server only reads the count and signals.
  app.delete('/api/trades', async (_req, res) => {
    const SIGNAL = DB_PATH + '.reset';
    const DONE   = DB_PATH + '.reset.done';

    // Read count without writing (sql.js must NOT write during reset)
    let count = 0;
    const db = openDb();
    if (db) {
      try {
        const row = queryOne(db, 'SELECT COUNT(*) as n FROM trades');
        count = row ? (row.n ?? 0) : 0;
      } finally {
        closeDb(db); // close WITHOUT saveAndClose — Electron owns the file
      }
    }

    // Remove stale done signal from any prior reset
    try { fs.unlinkSync(DONE); } catch { /* ok */ }

    // Tell Electron to drop+recreate the table
    try { fs.writeFileSync(SIGNAL, String(Date.now())); } catch { /* ignore */ }

    // Wait for Electron to confirm completion (polls every 100ms, up to 4s)
    await new Promise(resolve => {
      const deadline = Date.now() + 4000;
      const check = setInterval(() => {
        if (fs.existsSync(DONE) || Date.now() >= deadline) {
          clearInterval(check);
          try { fs.unlinkSync(DONE); } catch { /* ok */ }
          resolve(undefined);
        }
      }, 100);
    });

    console.log(`[journal] Trade journal reset — ${count} trade(s) removed, schema rebuilt by Electron`);
    broadcastRefresh('journal_reset');
    res.json({ ok: true, deleted: count });
  });

  // DELETE /api/trades/:id — delete a single trade
  app.delete('/api/trades/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
    const db = openDb();
    if (!db) return res.status(404).json({ error: 'not_found' });
    try {
      dbRun(db, 'DELETE FROM trades WHERE id=?', [id]);
      saveAndClose(db);
      res.json({ ok: true });
    } catch (e) {
      console.error('[journal] DELETE /api/trades/:id:', e);
      try { closeDb(db); } catch {}
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/trades/:id/close — manually close an open trade
  app.post('/api/trades/:id/close', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
    const { exit_price, pnl_gross } = req.body;
    if (typeof pnl_gross !== 'number') return res.status(400).json({ error: 'pnl_gross required' });

    const db = openDb();
    if (!db) return res.status(404).json({ error: 'not_found' });
    try {
      const row = queryOne(db, 'SELECT * FROM trades WHERE id=?', [id]);
      if (!row) { closeDb(db); return res.status(404).json({ error: 'trade_not_found' }); }
      if (row.exit_at) { closeDb(db); return res.status(400).json({ error: 'already_closed' }); }

      // exit_price: only derive when entry is known and direction is not unknown
      let computedExitPrice = exit_price ?? null;
      let exitSrc = null;
      if (computedExitPrice === null && row.entry_price !== null && row.direction !== 'unknown') {
        const qty   = row.qty ?? 1;
        const delta = pnl_gross / (5.0 * qty);
        computedExitPrice = row.direction === 'long'
          ? row.entry_price + delta
          : row.entry_price - delta;
        exitSrc = 'derived';
      }

      // r_multiple: only compute when stop and entry are both known
      let rMultiple = null;
      if (row.entry_price !== null && row.stop_price !== null && row.direction !== 'unknown') {
        const qty  = row.qty ?? 1;
        const risk = Math.abs(row.entry_price - row.stop_price) * 5 * qty;
        rMultiple  = risk > 0 ? pnl_gross / risk : null;
      }

      dbRun(db,
        'UPDATE trades SET exit_at=?, exit_price=?, exit_source=?, pnl_gross=?, pnl_net=?, r_multiple=? WHERE id=?',
        [Date.now(), computedExitPrice, exitSrc, pnl_gross, pnl_gross, rMultiple, id]
      );
      const updated = queryOne(db, 'SELECT * FROM trades WHERE id=?', [id]);
      saveAndClose(db);
      broadcastRefresh('trade_closed');
      res.json(rowToRecord(updated));
    } catch (e) {
      console.error('[journal] POST /api/trades/:id/close:', e);
      try { closeDb(db); } catch {}
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/trades/:id/direction — fix direction on a needs_review trade
  app.post('/api/trades/:id/direction', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
    const { direction } = req.body;
    if (direction !== 'long' && direction !== 'short')
      return res.status(400).json({ error: 'direction must be long or short' });

    const db = openDb();
    if (!db) return res.status(404).json({ error: 'not_found' });
    try {
      const row = queryOne(db, 'SELECT * FROM trades WHERE id=?', [id]);
      if (!row) { closeDb(db); return res.status(404).json({ error: 'trade_not_found' }); }

      // Re-derive exit_price and r_multiple now that direction is known
      let exitPrice = row.exit_price ?? null;
      let exitSrc = row.exit_source ?? null;
      let rMultiple = row.r_multiple ?? null;

      if (row.exit_at !== null && row.entry_price !== null && row.pnl_gross !== null && exitPrice === null) {
        const qty = row.qty ?? 1;
        const delta = row.pnl_gross / (5.0 * qty);
        exitPrice = direction === 'long' ? row.entry_price + delta : row.entry_price - delta;
        exitSrc = 'derived';
      }
      if (row.exit_at !== null && row.entry_price !== null && row.stop_price !== null && rMultiple === null) {
        const qty = row.qty ?? 1;
        const risk = Math.abs(row.entry_price - row.stop_price) * 5 * qty;
        rMultiple = risk > 0 ? (row.pnl_gross ?? 0) / risk : null;
      }

      dbRun(db,
        'UPDATE trades SET direction=?, needs_review=0, exit_price=?, exit_source=?, r_multiple=? WHERE id=?',
        [direction, exitPrice, exitSrc, rMultiple, id]
      );
      const updated = queryOne(db, 'SELECT * FROM trades WHERE id=?', [id]);
      saveAndClose(db);
      broadcastRefresh('direction_fixed');
      res.json(rowToRecord(updated));
    } catch (e) {
      console.error('[journal] POST /api/trades/:id/direction:', e);
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

  // POST /api/review
  app.post('/api/review', async (_req, res) => {
    const db = openDb();
    if (!db) return res.status(422).json({ error: 'insufficient_data', minRequired: 5 });

    const trades = queryAll(db, `
      SELECT direction, r_multiple, pnl_net, confidence, patterns_json, created_at, exit_at
      FROM trades WHERE exit_at IS NOT NULL ORDER BY created_at ASC
    `);
    closeDb(db);

    if (trades.length < 5) return res.status(422).json({ error: 'insufficient_data', minRequired: 5 });

    // Aggregate stats
    const totalClosed = trades.length;
    const wins = trades.filter(t => (t.r_multiple ?? 0) > 0);
    const losses = trades.filter(t => (t.r_multiple ?? 0) <= 0);
    const winRate = totalClosed > 0 ? (wins.length / totalClosed * 100).toFixed(1) : '0.0';
    const avgR = (trades.reduce((s, t) => s + (t.r_multiple ?? 0), 0) / totalClosed).toFixed(2);

    const longs = trades.filter(t => t.direction === 'long');
    const shorts = trades.filter(t => t.direction === 'short');
    const longWinRate = longs.length > 0 ? (longs.filter(t => (t.r_multiple ?? 0) > 0).length / longs.length * 100).toFixed(1) : 'N/A';
    const shortWinRate = shorts.length > 0 ? (shorts.filter(t => (t.r_multiple ?? 0) > 0).length / shorts.length * 100).toFixed(1) : 'N/A';

    // Pattern performance — top 5 by avgR
    const patternMap = {};
    for (const t of trades) {
      let patterns = [];
      try { patterns = JSON.parse(t.patterns_json || '[]'); } catch {}
      for (const p of patterns) {
        if (!patternMap[p]) patternMap[p] = { count: 0, wins: 0, totalR: 0 };
        patternMap[p].count++;
        if ((t.r_multiple ?? 0) > 0) patternMap[p].wins++;
        patternMap[p].totalR += (t.r_multiple ?? 0);
      }
    }
    const topPatterns = Object.entries(patternMap)
      .map(([name, s]) => ({ name, count: s.count, winRate: (s.wins / s.count * 100).toFixed(1), avgR: (s.totalR / s.count).toFixed(2) }))
      .sort((a, b) => parseFloat(b.avgR) - parseFloat(a.avgR))
      .slice(0, 5);

    // Confidence correlation
    const highConf = trades.filter(t => (t.confidence ?? 0) >= 0.5);
    const lowConf = trades.filter(t => (t.confidence ?? 1) < 0.5);
    const highConfAvgR = highConf.length > 0 ? (highConf.reduce((s, t) => s + (t.r_multiple ?? 0), 0) / highConf.length).toFixed(2) : 'N/A';
    const lowConfAvgR = lowConf.length > 0 ? (lowConf.reduce((s, t) => s + (t.r_multiple ?? 0), 0) / lowConf.length).toFixed(2) : 'N/A';

    // Worst 3 and best 3 trades
    const sorted = [...trades].sort((a, b) => (a.r_multiple ?? 0) - (b.r_multiple ?? 0));
    const worst3 = sorted.slice(0, 3).map(t => ({ direction: t.direction, r: (t.r_multiple ?? 0).toFixed(2), pnl: (t.pnl_net ?? 0).toFixed(2) }));
    const best3 = sorted.slice(-3).reverse().map(t => ({ direction: t.direction, r: (t.r_multiple ?? 0).toFixed(2), pnl: (t.pnl_net ?? 0).toFixed(2) }));

    // Current config
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

    const prompt = `You are a trading coach reviewing a trader's automated trading system results. Analyze the following data and provide actionable recommendations.

TRADING STATS:
- Total closed trades: ${totalClosed}
- Win rate: ${winRate}%
- Avg R-multiple: ${avgR}R
- Long win rate: ${longWinRate}% (${longs.length} trades)
- Short win rate: ${shortWinRate}% (${shorts.length} trades)

TOP PATTERNS BY AVG R:
${topPatterns.map(p => `- ${p.name}: count=${p.count}, winRate=${p.winRate}%, avgR=${p.avgR}R`).join('\n') || 'No pattern data'}

CONFIDENCE CORRELATION:
- High confidence (≥50%): avgR=${highConfAvgR}R (${highConf.length} trades)
- Low confidence (<50%): avgR=${lowConfAvgR}R (${lowConf.length} trades)

WORST 3 TRADES:
${worst3.map(t => `- ${t.direction}: ${t.r}R ($${t.pnl})`).join('\n')}

BEST 3 TRADES:
${best3.map(t => `- ${t.direction}: ${t.r}R ($${t.pnl})`).join('\n')}

CURRENT FILTER CONFIG:
- minConfidence: ${cfg.filter?.minConfidence ?? 0}
- zoneProximityTicks: ${cfg.filter?.zoneProximityTicks ?? 'N/A'}
- perZoneCooldownSec: ${cfg.filter?.perZoneCooldownSec ?? 'N/A'}
- globalCooldownSec: ${cfg.filter?.globalCooldownSec ?? 'N/A'}
- fireOn.notablePatterns: ${cfg.filter?.fireOn?.notablePatterns ?? 'N/A'}
- fireOn.zoneInteractions: ${cfg.filter?.fireOn?.zoneInteractions ?? 'N/A'}
- fireOn.trendOrMaEvents: ${cfg.filter?.fireOn?.trendOrMaEvents ?? 'N/A'}
- fireOn.everyCandleIfActionable: ${cfg.filter?.fireOn?.everyCandleIfActionable ?? 'N/A'}

Respond with ONLY a raw JSON object (no markdown, no code fences). Shape:
{
  "summary": "2-3 paragraph plain English analysis of what is and isn't working",
  "patternRecommendations": [
    { "pattern": "pattern name", "recommendation": "keep|avoid|reduce", "reason": "brief reason" }
  ],
  "configRecommendations": [
    { "field": "filter.minConfidence", "currentValue": 0, "suggestedValue": 0.55, "reason": "brief reason" }
  ],
  "overallVerdict": "profitable|marginal|losing"
}`;

    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
      const review = JSON.parse(stripFences(text));
      res.json({ ...review, generated_at: Date.now() });
    } catch (e) {
      res.status(500).json({ error: 'review_failed', detail: e.message });
    }
  });

  // GET /api/config
  app.get('/api/config', (_req, res) => {
    try {
      res.json(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } catch (e) {
      res.status(500).json({ error: 'config_read_failed', detail: e.message });
    }
  });

  // POST /api/config — deep-merges only the filter subtree, atomic write
  app.post('/api/config', (req, res) => {
    try {
      const current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const incoming = req.body.filter ?? {};
      // Only allow merging known filter keys
      const allowedKeys = ['zoneProximityTicks', 'perZoneCooldownSec', 'globalCooldownSec', 'minConfidence', 'fireOn'];
      const updatedFilter = { ...current.filter };
      for (const key of allowedKeys) {
        if (key in incoming) {
          if (key === 'fireOn' && typeof incoming[key] === 'object') {
            // deep merge fireOn, coercing values to booleans and stripping unknown keys
            const validFireOnKeys = ['notablePatterns', 'zoneInteractions', 'trendOrMaEvents', 'everyCandleIfActionable'];
            const mergedFireOn = { ...current.filter?.fireOn };
            for (const fk of validFireOnKeys) {
              if (fk in incoming.fireOn) mergedFireOn[fk] = Boolean(incoming.fireOn[fk]);
            }
            updatedFilter.fireOn = mergedFireOn;
          } else if (key === 'minConfidence') {
            const v = Number(incoming[key]);
            updatedFilter[key] = isFinite(v) ? Math.max(0, Math.min(1, v)) : (current.filter?.[key] ?? 0);
          } else if (key === 'zoneProximityTicks') {
            const v = Number(incoming[key]);
            updatedFilter[key] = isFinite(v) && v >= 0 ? Math.round(v) : (current.filter?.[key] ?? 4);
          } else if (key === 'perZoneCooldownSec' || key === 'globalCooldownSec') {
            const v = Number(incoming[key]);
            updatedFilter[key] = isFinite(v) && v >= 0 ? Math.round(v) : (current.filter?.[key] ?? 20);
          }
        }
      }
      const updated = { ...current, filter: updatedFilter };
      const tmp = CONFIG_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
      fs.renameSync(tmp, CONFIG_PATH);
      res.json({ ok: true, config: updated });
    } catch (e) {
      res.status(500).json({ error: 'config_write_failed', detail: e.message });
    }
  });

  // SPA fallback
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(STATIC_DIR, 'index.html'), err => {
      if (err) res.status(404).send('Journal not built yet. Run: pnpm build:journal');
    });
  });

  const server = app.listen(3001, '127.0.0.1', () => {
    console.log('Journal server listening on http://localhost:3001');
    if (!fs.existsSync(DB_PATH)) {
      console.log(`No database yet at: ${DB_PATH}`);
      console.log('Trades will appear once the Electron app executes auto-trades.');
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('[journal] Port 3001 already in use — journal server already running. Exiting cleanly.');
      process.exit(0);
    }
    throw err;
  });
}

main().catch(err => { console.error(err); process.exit(1); });
