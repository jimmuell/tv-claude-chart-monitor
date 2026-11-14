import { loadConfig, resolveLlm } from './bridge';
import { sharedModule } from './shared-require';
import type { TradeStore } from './trade-store';

// Same provider plumbing the analyzer uses, so a lesson is extracted by whatever
// model config.json says is active.
const { createProvider } = sharedModule('llm-providers.js') as {
  createProvider: (cfg: unknown, logger: unknown) => {
    name: string; hasKey: boolean; fastModel: string;
    complete: (system: string | null, user: string, opts: Record<string, unknown>) => Promise<string>;
  };
};

/** The prompt that turns one trade critique into a single reusable lesson. */
function buildPrompt(trade: Record<string, any>, critiqueText: string): string {
  const patterns = (() => {
    try { return JSON.parse(trade.patterns_json || '[]'); } catch { return []; }
  })();
  const outcome = trade.r_multiple !== null && trade.r_multiple !== undefined
    ? (trade.r_multiple > 0 ? 'win' : 'loss')
    : 'unknown';

  return `Extract ONE trading lesson from this analysis. Respond with JSON only — no other text.

Trade: ${trade.direction} ${trade.symbol} (${trade.timeframe}m) @ ${trade.entry_price ?? 'unknown'}
Outcome: ${outcome}${trade.r_multiple != null ? ` (${trade.r_multiple > 0 ? '+' : ''}${Number(trade.r_multiple).toFixed(2)}R)` : ''}
Patterns: ${patterns.join(', ') || 'none'}

Critique:
${critiqueText}

JSON schema:
{
  "pattern": "snake_case setup name, e.g. bearish_ma_touch, orb_breakdown, failed_retest",
  "direction": "long" | "short" | "both",
  "outcome": "win" | "loss",
  "lesson_text": "One actionable sentence — what to do or avoid in this exact situation",
  "context_text": "Conditions when this rule applies (market structure, time, context)"
}`;
}

/** Strips a ```json fence if the model wrapped its answer in one. */
function stripFences(text: string): string {
  return String(text ?? '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

export interface ExtractResult {
  extracted: number;
  skipped:   number;
  errors:    string[];
}

/**
 * Turns closed, critiqued trades into unapproved lessons — the journal's old write
 * path, moved into the app. Nothing is ever auto-approved: a lesson only reaches the
 * analyzer prompt after a human says so in the Lessons tab.
 */
export async function extractLessons(store: TradeStore, limit = 5): Promise<ExtractResult> {
  const out: ExtractResult = { extracted: 0, skipped: 0, errors: [] };

  let provider;
  try {
    provider = createProvider(resolveLlm(loadConfig()), console);
    if (!provider.hasKey) {
      out.errors.push('TVCM-LESSON-NO-KEY: no API key for the active LLM provider');
      return out;
    }
  } catch (err) {
    out.errors.push(`TVCM-LESSON-NO-KEY: ${(err as Error).message}`);
    return out;
  }

  const candidates = store.lessonCandidates(limit);
  for (const trade of candidates as unknown as Array<Record<string, any>>) {
    // Belt and braces: a lesson needs a finished trade and must not duplicate one.
    if (!trade.exit_at || store.hasLessonForTrade(trade.id)) { out.skipped++; continue; }

    let critiqueText = '';
    try {
      critiqueText = JSON.parse(trade.critique_json || '{}').text ?? '';
    } catch { /* unparseable critique — treated as absent below */ }
    if (!critiqueText) { out.skipped++; continue; }

    try {
      const text = await provider.complete(null, buildPrompt(trade, critiqueText), {
        model: provider.fastModel,
        maxOutputTokens: 250,
      });
      const lesson = JSON.parse(stripFences(text));
      if (!lesson.lesson_text) { out.skipped++; continue; }

      store.insertLesson({
        trade_id:     trade.id,
        symbol:       trade.symbol,
        timeframe:    trade.timeframe,
        direction:    lesson.direction ?? trade.direction,
        pattern:      lesson.pattern ?? null,
        outcome:      lesson.outcome ?? (trade.r_multiple > 0 ? 'win' : 'loss'),
        lesson_text:  lesson.lesson_text,
        context_text: lesson.context_text ?? null,
      });
      out.extracted++;
    } catch (err) {
      out.errors.push(`TVCM-LESSON-EXTRACT-FAILED: trade #${trade.id} — ${(err as Error).message}`);
    }
  }
  return out;
}
