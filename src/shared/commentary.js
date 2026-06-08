// commentary.js
// Calls the Anthropic API to turn a structured chart context into the kind of
// trader-style breakdown the user wants:
//   - objective state of the chart
//   - setup verdict (was/is this a valid trade)
//   - where the entry WAS, what to do NOW, what NOT to do
//   - key lesson
//
// Returns a structured object so the UI can render consistently and so the
// journal can store typed fields.

const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");

const SYSTEM_PROMPT = `You are an experienced futures price-action trader and coach reviewing a freshly-closed candle on a futures chart in real time. Your job is to give the trader a short, decisive, nuanced read on what just happened and what to do about it.

You must think in terms of MARKET STRUCTURE first:
- Is this a trend move, a pullback within a trend, a range, or a transition?
- Where is price relative to the dominant moving average? Is the MA rising, falling, or flat?
- Are lower highs / lower lows intact, or has structure shifted?
- Is this a relief bounce inside a bearish structure, or a legitimate reversal?

Format your response as STRICT JSON matching this schema:
{
  "headline": string,                 // one short line, <= 90 chars, notification-style
  "objective": string,                // 2-4 short bullet sentences: what the chart shows NOW
  "steps_what_happened": string[],    // 2-4 numbered play-by-play steps, each one sentence, no repeats
  "setup_verdict": "valid_long" | "valid_short" | "valid_long_was" | "valid_short_was" | "no_trade" | "wait",
  "entry_was": string | null,         // where entry was (price + reason), null if no setup
  "what_now": string,                 // decisive: what to do RIGHT NOW
  "what_not": string,                 // decisive: what NOT to do, common mistakes to avoid
  "next_trigger": string | null,      // specific condition that makes a fresh trade valid
  "key_lesson": string | null,        // optional one-liner takeaway
  "bottom_line": string,              // 1-3 sentences: what happened, where we stand, single most important thing to watch
  "trade_plan": {                     // concrete plan when a live setup exists; null otherwise
    "direction": "long" | "short" | "none",
    "entry": number | null,           // exact price or zone
    "stop": number | null,
    "target": number | null,
    "rr": number | null,
    "confidence": "low" | "medium" | "high",
    "rationale": string | null
  } | null,
  "key_levels_to_watch": [            // 3-5 actionable levels, ORDERED by importance (most important first)
    {
      "label": string,                // max 20 chars, concise (e.g. "MA Resistance", "Swing Low", "Range Mid")
      "price": number,
      "color": "green" | "red" | "yellow" | "blue" | "gray",
      "priority": "primary" | "secondary",
      "action": string                // explicit action: "short on rejection", "long on hold above", "watch for break"
    }
  ] | null,
  "structure_read": string,           // 1-2 sentences describing current market structure context (e.g. "Relief bounce inside bearish intraday structure. Lower highs intact, MA declining.")
  "highest_probability_trade": {      // the single best trade right now, even if verdict is "wait"
    "setup": string,                  // e.g. "Short failed retest at 7443-7445"
    "entry_zone": string,             // e.g. "7443-7445"
    "stop": string,                   // e.g. "Above 7454"
    "targets": string,                // e.g. "7431, then 7425, 7420"
    "bias": "long" | "short" | "neutral",
    "condition": string               // what must happen first, e.g. "Price must reach 7443-7445 and show rejection candle"
  } | null,
  "confidence": number,               // 0-1
  "candlestick_patterns": [           // OPTIONAL: 1-3 notable patterns on recent bars; null if none significant
    {
      "name": string,                 // human name, e.g. "Bullish Engulfing", "Hammer", "Inside Bar"
      "meaning": string,              // 1 sentence, plain English for a beginner, e.g. "Buyers overpowered sellers; signals a potential upward reversal"
      "signal": "bullish" | "bearish" | "neutral",
      "bar_offset": number            // 0 = just-closed candle, 1 = one bar back, 2 = two bars back
    }
  ] | null
}

RULES:
- STRUCTURE FIRST: Always lead your analysis with the market structure context. Is this trending, ranging, breaking down, or reversing? Every level and trade idea must be grounded in the structure.
- LEVEL PRIORITIZATION: Not all levels are equal. Mark the 2-3 most important levels as "primary" and less critical reference levels as "secondary". Primary levels are where you'd actually trade. Secondary levels are internal references or distant targets.
- LABEL BREVITY: Labels must be max 20 characters. Use concise names: "MA Resist", "Swing Low", "Range Mid", "Breakdown Tgt". No slashes, no long descriptions.
- HIGHEST PROBABILITY TRADE: Always identify the single best trade setup, even if the verdict is "wait". Describe what you're waiting FOR specifically. Include entry zone, stop, and targets.
- Be honest. If the move already played out, say the trade WAS there but is late now. Use *_was variants.
- Anchor every claim in the data given. Refer to drawn zones by price band.
- Never recommend chasing into the middle of a move.
- Never recommend real-money action; you are coaching, not executing.
- Keep "objective" factual; keep "what_now" / "what_not" decisive.
- "steps_what_happened" reads like play-by-play: each step one short sentence.
- "bottom_line" is the hallway summary: direct, no fluff.
- "trade_plan": populate for "valid_long" or "valid_short". Null for "was" verdicts and "wait"/"no_trade".
- "key_levels_to_watch": populate for "wait", "no_trade", or "*_was" verdicts. 3-5 entries minimum, ordered by importance.
- IMPORTANT: Always populate at least ONE of "trade_plan" or "key_levels_to_watch". Never both null.
- CANDLESTICK PATTERNS: Populate "candlestick_patterns" only when one or more patterns from the "pattern tags:" line are genuinely significant in context (e.g. a bullish engulfing at a key support level matters; a random doji in the middle of nowhere does not). Return 1-3 entries max. Use bar_offset 0 for the just-closed candle, 1 for the prior candle. Write "meaning" for a beginner in one plain sentence. Return null if no pattern is contextually notable.
- Output JSON only. No prose around it.`;

function buildUserMessage(ctx) {
  // Compress recent action.
  const recent = ctx.recent.map(c => `${c.time} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`).join("\n");

  const zonesLines = ctx.zones.map(zs => {
    const z = zs.zone;
    const range = z.kind === "level" ? `level @ ${z.price}` : `${z.lo}-${z.hi}`;
    return `- ${z.label} (${z.kind} ${range}) interaction=${zs.interaction} dist=${zs.distanceTicks.toFixed(1)} ticks`;
  }).join("\n") || "(none)";

  const tags = ctx.classification.tags.join(", ") || "(none)";
  const ma = ctx.ma != null ? ctx.ma.toFixed(2) : "n/a";
  const closed = ctx.closedBar;
  const trendStr = `${ctx.trend.trend} (${ctx.trend.reason})`;
  const maEv = (ctx.maEvents || []).map(e => e.type).join(", ") || "(none)";

  let orbSection = "";
  if (ctx.orbState) {
    const orb = ctx.orbState;
    const orbLines = [`ORB phase: ${orb.phase}`];
    if (orb.range) {
      orbLines.push(`ORB range: high=${orb.range.high}  low=${orb.range.low}`);
    }
    if (ctx.orbSignal) {
      const s = ctx.orbSignal;
      orbLines.push(
        `ORB signal: direction=${s.direction}  isConfirmation=${s.isConfirmation}` +
        `  close=${s.closePrice}  entry=${s.entry}  stop=${s.stop}  target=${s.target || "n/a"}`
      );
      orbLines.push(`ORB reason: ${s.reason}`);
    }
    orbSection = `\nORB (Opening Range Breakout) context:\n${orbLines.map(l => "  " + l).join("\n")}\n`;
  }

  return `Symbol: ${ctx.symbol}  Timeframe: ${ctx.timeframe}m  Mode: ${ctx.replayMode ? "REPLAY" : "LIVE"}

Just-closed candle:
  time=${closed.time}  O=${closed.open}  H=${closed.high}  L=${closed.low}  C=${closed.close}  vol=${closed.volume}
  pattern tags: ${tags}

Trend: ${trendStr}
Moving average (close): ${ma}
MA events on this close: ${maEv}
${orbSection}
Trader's drawn zones / levels:
${zonesLines}

Recent 10 closed bars (oldest first):
${recent}
`;
}

class CommentaryEngine {
  constructor(anthropicConfig, logger) {
    this.cfg = anthropicConfig;
    this.logger = logger || console;
    const apiKey = process.env[anthropicConfig.apiKeyEnv || "ANTHROPIC_API_KEY"];
    if (!apiKey) {
      this.logger.warn(`[commentary] no API key in env ${anthropicConfig.apiKeyEnv}; commentary will be stubbed`);
      this.client = null;
    } else {
      this.client = new Anthropic({ apiKey });
    }
  }

  async analyze(ctx, reasons) {
    // Phase 4b.2 — if the only reasons are suggest_level entries, short-circuit
    // and produce a deterministic "💡 SUGGESTION" card without calling the
    // Anthropic API. Suggestions are nudges to draw a line in TV; they don't
    // need an LLM read.
    const allSuggestLevel = Array.isArray(reasons) && reasons.length > 0
      && reasons.every((r) => r && r.kind === 'suggest_level');
    if (allSuggestLevel) {
      return this._suggestLevelCommentary(ctx, reasons);
    }

    // Phase 4b.3.b — lifecycle directives are deterministic; no API call.
    const allLifecycle = Array.isArray(reasons) && reasons.length > 0
      && reasons.every((r) => r && r.kind === 'lifecycle');
    if (allLifecycle) {
      return this._lifecycleCommentary(reasons[0]);
    }

    if (!this.cfg.enabled) return this._stub(ctx, reasons, "disabled in config");
    if (!this.client) return this._stub(ctx, reasons, "no API key");

    const userMsg = buildUserMessage(ctx) + `\nFire reasons: ${JSON.stringify(reasons)}`;
    try {
      const res = await this.client.messages.create({
        model: this.cfg.model || "claude-sonnet-4-6",
        // Bumped from 700 in Phase 4a — the new steps_what_happened (array of
        // 2-4 items) + bottom_line fields add ~200 tokens to typical responses,
        // and longer setups can run another 300+. 700 was truncating mid-string,
        // producing JSON without a closing brace and breaking _extractJson.
        max_tokens: this.cfg.maxOutputTokens || 2500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      });
      const text = res.content?.[0]?.text || "";
      const json = this._extractJson(text);
      if (!json) {
        // Log a generous sample so we can diagnose without UI access. Most
        // failure modes (smart quotes, unescaped chars, malformed structure)
        // are visible in the first ~600 chars.
        const sample = text.length > 600 ? text.slice(0, 600) + "…[truncated, full length " + text.length + "]" : text;
        this.logger.warn(`[commentary] JSON parse failed; raw text follows ▼\n${sample}\n▲ end raw text`);
        return { headline: "Model output unparseable", objective: text, setup_verdict: "wait", entry_was: null, what_now: "", what_not: "", steps_what_happened: [], bottom_line: null, next_trigger: null, key_lesson: null, trade_plan: null, key_levels_to_watch: null, confidence: 0 };
      }
      return json;
    } catch (err) {
      this.logger.error(`[commentary] API call failed: ${err.message}`);
      return this._stub(ctx, reasons, `api-error: ${err.message}`);
    }
  }

  // Robustly extract a JSON object from a Claude text response.
  // Handles four patterns and a sanitize-then-retry pass:
  //   1. Raw JSON: { ... }
  //   2. Markdown-fenced JSON: ```json\n{ ... }\n``` (or just ```\n{ ... }\n```)
  //   3. Greedy outermost { ... } match (strips prose preamble/postamble)
  //   4. Fence-with-no-close-fence (truncated trailing prose)
  //   5. Sanitized retry of each candidate — replaces curly quotes with
  //      straight quotes, which are the single most common parse failure when
  //      Claude generates prose-heavy content with quoted phrases.
  _extractJson(text) {
    if (!text) return null;

    const candidates = [];
    candidates.push(text.trim());

    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch) candidates.push(fenceMatch[1].trim());

    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) candidates.push(braceMatch[0]);

    const fenceOpenOnly = text.match(/```(?:json)?\s*(\{[\s\S]*\})/);
    if (fenceOpenOnly) candidates.push(fenceOpenOnly[1]);

    // Try each candidate raw, then sanitized.
    const sanitize = (s) => s
      .replace(/[“”]/g, '"')   // " "  → "
      .replace(/[‘’]/g, "'")   // ' '  → '
      .replace(/[–—]/g, "-");  // – —  → -

    for (const c of candidates) {
      try { return JSON.parse(c); } catch (_) { /* retry sanitized */ }
      try { return JSON.parse(sanitize(c)); } catch (_) { /* try next candidate */ }
    }
    return null;
  }

  // Phase 4b.2: deterministic commentary for "💡 suggest a level" fires.
  // No API call. Each suggest_level reason becomes an entry in the
  // suggested_levels array; the headline + bottom_line summarize the top one.
  // Schema fields the renderer/journal already understand keep their meaning;
  // new field `suggested_level` carries the primary candidate, and `kind` is
  // set to 'suggest_level' so the renderer can branch.
  _suggestLevelCommentary(ctx, reasons) {
    const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const candidates = reasons
      .map((r) => r.candidateLevel)
      .filter((c) => c && typeof c.price === 'number')
      .sort((a, b) => (b.touchCount || 0) - (a.touchCount || 0));
    if (candidates.length === 0) {
      // Defensive: shouldn't happen because the filter wouldn't fire empty
      // suggest_level reasons, but degrade gracefully if it does.
      return this._stub(ctx, reasons, 'suggest_level: no candidate payload');
    }
    const primary = candidates[0];
    const kindWord = primary.kind === 'resistance' ? 'resistance' : 'support';
    const headline = `Watching emerging ${kindWord} at ${fmt(primary.price)} — ${primary.touchCount} touches`;
    const objective =
      `Swing-pivot detector identified an emerging ${kindWord} at ` +
      `${fmt(primary.price)} with ${primary.touchCount} touches in the recent window.`;
    const what_now =
      `Consider drawing a horizontal line at ${fmt(primary.price)} in TradingView ` +
      `to track this level across sessions.`;
    const what_not =
      `Don't trade off this level yet — it's a candidate that needs more confirmation ` +
      `or your own conviction.`;
    const bottom_line =
      `Emerging ${kindWord} at ${fmt(primary.price)} (${primary.touchCount} touches). ` +
      `Draw it to make it persistent.`;
    // Confidence scales gently with touchCount: 3 → 0.5, 4 → 0.6, 5 → 0.7, capped.
    const conf = Math.min(0.85, 0.4 + 0.1 * primary.touchCount);

    return {
      kind: 'suggest_level',
      headline,
      objective,
      steps_what_happened: [],
      setup_verdict: 'wait',
      entry_was: null,
      what_now,
      what_not,
      next_trigger:
        `Price returns to ${fmt(primary.price)} and reacts — that's the cleanest test.`,
      key_lesson: null,
      bottom_line,
      trade_plan: null,
      key_levels_to_watch: null,
      suggested_level: {
        price: primary.price,
        kind:  primary.kind,
        touchCount: primary.touchCount,
        firstTouchTime: primary.firstTouchTime,
        lastTouchTime:  primary.lastTouchTime,
        strength: primary.strength,
      },
      suggested_levels: candidates, // full list, in case the renderer wants it
      candlestick_patterns: null,
      confidence: conf,
    };
  }

  // Phase 4b.3.b: deterministic lifecycle card. One directive per card.
  _lifecycleCommentary(reason) {
    const dir   = reason.directive;       // 'remove' | 'refine' | 'recategorize'
    const price = reason.price != null ? Number(reason.price) : null;
    const fmt   = (n) => n != null ? Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '?';
    const rat   = reason.rationale_short || '';

    let headline, objective, what_now, what_not, bottom_line;
    if (dir === 'remove') {
      headline    = `✕ Removed ${fmt(price)} — ${rat}`;
      objective   = `The level at ${fmt(price)} has been invalidated: ${rat}.`;
      what_now    = `Remove or ignore ${fmt(price)} from your bias — it is no longer acting as a boundary.`;
      what_not    = `Don’t trade off this level until it reasserts.`;
      bottom_line = `${fmt(price)} broken and held. Update your bias.`;
    } else if (dir === 'refine') {
      const zt = reason.zone_top, zb = reason.zone_bottom;
      headline    = `🔁 ${fmt(price)} → ${fmt(zb)}–${fmt(zt)} — ${rat}`;
      objective   = `Multiple wicks at ${fmt(price)} spanning a band from ${fmt(zb)} to ${fmt(zt)}: ${rat}.`;
      what_now    = `Treat ${fmt(zb)}–${fmt(zt)} as a zone, not a single line. Use the edges for entries/exits.`;
      what_not    = `Don’t trade the midpoint as if it were a clean level.`;
      bottom_line = `${fmt(price)} upgraded to zone ${fmt(zb)}–${fmt(zt)}.`;
    } else {
      const nk = reason.new_kind || '?', pk = reason.prior_kind || '?';
      headline    = `↕ ${fmt(price)} flipped ${pk} → ${nk} — ${rat}`;
      objective   = `${fmt(price)} previously acted as ${pk}. After a break and retest, it now acts as ${nk}: ${rat}.`;
      what_now    = `Update your bias: ${fmt(price)} is now ${nk}. Trade it from the new side.`;
      what_not    = `Don’t use ${fmt(price)} for ${pk} plays — the role has flipped.`;
      bottom_line = `${fmt(price)} flipped from ${pk} to ${nk}.`;
    }

    return {
      kind: 'lifecycle',
      headline,
      objective,
      steps_what_happened: [],
      setup_verdict: 'wait',
      entry_was: null,
      what_now,
      what_not,
      next_trigger: null,
      key_lesson: null,
      bottom_line,
      trade_plan: null,
      key_levels_to_watch: null,
      lifecycle_event: {
        directive:        dir,
        tracked_level_id: reason.tracked_level_id,
        price:            price,
        prior_kind:       reason.prior_kind || null,
        new_kind:         reason.new_kind   || null,
        zone_top:         reason.zone_top   || null,
        zone_bottom:      reason.zone_bottom || null,
        rationale_short:  rat,
        evidence:         reason.evidence   || {},
      },
      candlestick_patterns: null,
      confidence: 0.7,
    };
  }

  _stub(ctx, reasons, why) {
    const tags = ctx.classification.tags.slice(0, 4).join(", ");
    const headline = `${ctx.symbol} ${ctx.timeframe}m close @ ${ctx.closedBar.close} — ${tags || "no pattern"}`;

    // Derive key_levels_to_watch from the zones in context so the renderer
    // can be tested without a live API call.
    const curPrice = ctx.closedBar.close;
    const keyLevels = (ctx.zones || []).slice(0, 4).map(zs => {
      const z = zs.zone;
      const price = z.kind === "level" ? z.price : ((z.lo + z.hi) / 2);
      const isAbove = price > curPrice;
      return {
        label: z.label || z.kind,
        price: Number(Number(price).toFixed(2)),
        color: isAbove ? "red" : "green",
        action: isAbove ? "short on rejection" : "long on hold",
      };
    });
    if (keyLevels.length === 0) {
      keyLevels.push({ label: "Prior close", price: curPrice, color: "gray", action: "watch" });
    }

    return {
      headline,
      objective: `Stubbed analysis (${why}). Trend: ${ctx.trend.trend}. Tags: ${tags}.`,
      steps_what_happened: [],
      setup_verdict: "wait",
      entry_was: null,
      what_now: "Wait for live commentary to enable.",
      what_not: "Don't trade off a stubbed read.",
      next_trigger: null,
      key_lesson: null,
      bottom_line: `${ctx.symbol} at ${ctx.closedBar.close}. Commentary stubbed — ${why}.`,
      trade_plan: null,
      key_levels_to_watch: keyLevels,
      candlestick_patterns: null,
      confidence: 0,
    };
  }
}

module.exports = { CommentaryEngine, SYSTEM_PROMPT, buildUserMessage };
