import express from 'express';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { TradeStore } from './trade-store';
import type { TradeRecord, TradeCritique, TradeStats } from '../shared/types';

/**
 * Start the journal HTTP server.
 * Returns the server instance (for potential shutdown in tests).
 * Logs "Journal server listening on http://localhost:3001" when ready.
 */
export function startJournalServer(
  store: TradeStore,
  getApiKey: () => string,
): ReturnType<typeof import('http').createServer> {
  const app = express();

  app.use(express.json());

  // ---------------------------------------------------------------------------
  // Static file serving
  // ---------------------------------------------------------------------------
  const staticDir = path.join(__dirname, '../../dist/journal');
  app.use(express.static(staticDir));

  // ---------------------------------------------------------------------------
  // REST API
  // ---------------------------------------------------------------------------

  /** GET /api/trades — all trades newest-first */
  app.get('/api/trades', (_req, res) => {
    try {
      const trades: TradeRecord[] = store.getAll();
      res.json(trades);
    } catch (err) {
      console.error('[journal-server] GET /api/trades error:', err);
      res.status(500).json({ error: 'Failed to load trades', detail: String(err) });
    }
  });

  /** GET /api/trades/:id — single trade */
  app.get('/api/trades/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid trade id' });
        return;
      }
      const trade = store.getById(id);
      if (!trade) {
        res.status(404).json({ error: 'Trade not found' });
        return;
      }
      res.json(trade);
    } catch (err) {
      console.error('[journal-server] GET /api/trades/:id error:', err);
      res.status(500).json({ error: 'Failed to load trade', detail: String(err) });
    }
  });

  /** POST /api/trades/:id/notes — update notes and tags */
  app.post('/api/trades/:id/notes', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid trade id' });
        return;
      }

      const { notes, tags } = req.body as { notes?: unknown; tags?: unknown };

      if (typeof notes !== 'string') {
        res.status(400).json({ error: 'notes must be a string' });
        return;
      }
      if (!Array.isArray(tags) || !tags.every(t => typeof t === 'string')) {
        res.status(400).json({ error: 'tags must be an array of strings' });
        return;
      }

      const trade = store.getById(id);
      if (!trade) {
        res.status(404).json({ error: 'Trade not found' });
        return;
      }

      store.addNotes(id, notes, tags);
      res.json({ ok: true });
    } catch (err) {
      console.error('[journal-server] POST /api/trades/:id/notes error:', err);
      res.status(500).json({ error: 'Failed to update notes', detail: String(err) });
    }
  });

  /** POST /api/trades/:id/critique — get or generate Claude critique */
  app.post('/api/trades/:id/critique', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid trade id' });
        return;
      }

      const trade = store.getById(id);
      if (!trade) {
        res.status(404).json({ error: 'Trade not found' });
        return;
      }

      // Return cached critique if available
      if (trade.critique_json) {
        try {
          const critique = JSON.parse(trade.critique_json) as TradeCritique;
          res.json(critique);
          return;
        } catch {
          // Corrupt cache — fall through to regenerate
        }
      }

      // Build prompt
      const steps: string[] = trade.steps_json ? (() => {
        try { return JSON.parse(trade.steps_json) as string[]; } catch { return []; }
      })() : [];

      const patterns: string[] = trade.patterns_json ? (() => {
        try { return JSON.parse(trade.patterns_json) as string[]; } catch { return []; }
      })() : [];

      const resultLine = trade.r_multiple !== null
        ? `${trade.r_multiple > 0 ? '+' : ''}${trade.r_multiple.toFixed(2)}R (${(trade.pnl_gross ?? 0) > 0 ? '+' : ''}$${(trade.pnl_gross ?? 0).toFixed(2)})`
        : 'Still open / unknown';

      const prompt = `You are reviewing an automated trade taken by an AI-driven trading system.

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

      // Call Anthropic API
      let critiqueText: string;
      try {
        const apiKey = getApiKey();
        const client = new Anthropic({ apiKey });
        const message = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }],
        });

        const firstBlock = message.content[0];
        if (firstBlock.type !== 'text') {
          throw new Error('Unexpected response type from Anthropic API');
        }
        critiqueText = firstBlock.text;
      } catch (apiErr) {
        console.error('[journal-server] Anthropic API error:', apiErr);
        res.status(500).json({ error: 'Critique failed', detail: String(apiErr) });
        return;
      }

      // Persist and return
      store.addCritique(id, critiqueText);
      const saved = store.getById(id);
      const critique = saved?.critique_json
        ? (JSON.parse(saved.critique_json) as TradeCritique)
        : { text: critiqueText, created_at: Date.now() };

      res.json(critique);
    } catch (err) {
      console.error('[journal-server] POST /api/trades/:id/critique error:', err);
      res.status(500).json({ error: 'Critique failed', detail: String(err) });
    }
  });

  /** GET /api/stats — aggregate stats */
  app.get('/api/stats', (_req, res) => {
    try {
      const stats: TradeStats = store.getStats();
      res.json(stats);
    } catch (err) {
      console.error('[journal-server] GET /api/stats error:', err);
      res.status(500).json({ error: 'Failed to compute stats', detail: String(err) });
    }
  });

  // ---------------------------------------------------------------------------
  // SPA fallback — serve index.html for non-API GETs
  // ---------------------------------------------------------------------------
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.sendFile(path.join(staticDir, 'index.html'), err => {
      if (err) {
        // index.html doesn't exist yet (dev mode) — return 404
        res.status(404).send('Journal not built yet. Run: npm run build:journal');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Start listening
  // ---------------------------------------------------------------------------
  const server = app.listen(3001, '127.0.0.1', () => {
    console.log('Journal server listening on http://localhost:3001');
  });

  return server;
}
