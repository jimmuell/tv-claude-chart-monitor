// llm-providers.js
// Pluggable LLM backends for CommentaryEngine.
//
// Every provider exposes the same tiny surface so commentary.js never has to
// care which model is behind it:
//
//   provider.name                    -> 'anthropic' | 'gemini'
//   provider.hasKey                  -> boolean (false => engine stubs out)
//   provider.model                   -> resolved model id, for logging
//   await provider.complete(sys, usr, opts) -> raw response text
//
// `opts` is { json?: boolean, maxOutputTokens?: number, model?: string }. `json` defaults to
// true (the commentary card is JSON); pass false for prose callers such as the
// journal's trade critique. `model` overrides the configured model for one
// call — pass `provider.fastModel` for cheap/high-volume work such as the
// journal's lesson extraction. `system` may be null.
//
// `complete()` throws on failure; commentary.js catches and falls back to its
// existing `_stub(ctx, reasons, 'api-error: ...')` path, so a provider outage
// degrades exactly the way an Anthropic outage always has.
//
// CommonJS on purpose — see CLAUDE.md: src/shared/*.js is not compiled by tsc
// and is require()'d at runtime from the main process.

const DEFAULT_TIMEOUT_MS = 60_000;

// Transient statuses worth one retry. 429 is the one that actually matters on
// a free tier; 500/503 show up during provider hiccups.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// Free-tier Gemini 503s ("experiencing high demand") constantly, and how badly
// depends on which model you ask for: measured over 4 real commentary calls,
// gemini-3.8-flash answered 0/4 while gemini-3-flash-preview answered 4/4.
//
// So retrying ONE model harder is the wrong shape — congestion is per-model.
// Instead each pass walks the whole model chain (primary, then llm.fallbackModels),
// which fails over in ~500ms rather than sleeping on a model that is down.
// Backoff applies only between passes, once every candidate has been tried.
const DEFAULT_MAX_PASSES = 3;
const RETRY_DELAY_MS = 2_000;

// Not every 429 is transient. The free tier caps requests per DAY per model
// (quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier, limit 20), which
// no backoff ladder will clear. A model known to be at its daily cap is skipped
// for this long before we spend one request re-probing it. Not tied to the real
// reset instant on purpose — Google does not report it, and a periodic re-probe
// self-heals whenever the quota does roll over.
const DAILY_CAP_COOLDOWN_MS = 15 * 60_000;

// Google reports how long to wait in RetryInfo.retryDelay, which beats guessing
// with a fixed ladder. But this is a per-bar tool: a 39s sleep blows the bar we
// are commenting on, so an advertised delay is honoured only up to this bound.
// Beyond it we take the one wasted request and let the next bar try again.
const MAX_HONORED_RETRY_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull quota facts out of a Gemini 429 body. Returns { perDay, retryAfterMs }.
// Tolerates a non-JSON or reshaped body — an unparseable 429 is treated as the
// transient kind, which is the safe default (it retries rather than giving up).
const parseQuotaFailure = (body) => {
  const out = { perDay: false, retryAfterMs: 0 };
  let parsed;
  try { parsed = JSON.parse(body); } catch { return out; }
  const details = parsed?.error?.details;
  if (!Array.isArray(details)) return out;
  for (const d of details) {
    for (const v of d?.violations || []) {
      if (typeof v?.quotaId === 'string' && /PerDay/i.test(v.quotaId)) out.perDay = true;
    }
    // "6s" / "6.95s" / "39s"
    const m = typeof d?.retryDelay === 'string' && d.retryDelay.match(/^([\d.]+)s$/);
    if (m) out.retryAfterMs = Math.ceil(parseFloat(m[1]) * 1000);
  }
  return out;
};

// Copy a request body without its thinkingConfig, leaving the original intact
// so other candidate models still get the configured budget.
const stripThinking = (payload) => {
  const generationConfig = { ...payload.generationConfig };
  delete generationConfig.thinkingConfig;
  return { ...payload, generationConfig };
};

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

class AnthropicProvider {
  constructor(cfg, logger) {
    this.name = 'anthropic';
    this.cfg = cfg;
    this.logger = logger || console;
    this.model = cfg.model || 'claude-sonnet-4-6';
    // Cheaper model for high-volume, low-stakes calls. Falls back to the main
    // model so an unset fastModel is never a silent quality downgrade.
    this.fastModel = cfg.fastModel || this.model;
    this.maxOutputTokens = cfg.maxOutputTokens || 2500;

    const apiKey = process.env[cfg.apiKeyEnv || 'ANTHROPIC_API_KEY'];
    if (!apiKey) {
      this.client = null;
      this.hasKey = false;
      return;
    }
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    this.client = new Anthropic({ apiKey });
    this.hasKey = true;
  }

  async complete(system, userMsg, opts = {}) {
    const req = {
      model: opts.model || this.model,
      max_tokens: opts.maxOutputTokens || this.maxOutputTokens,
      messages: [{ role: 'user', content: userMsg }],
    };
    if (system) req.system = system;
    const res = await this.client.messages.create(req);
    return res.content?.[0]?.text || '';
  }
}

// ---------------------------------------------------------------------------
// Google Gemini (free tier via AI Studio)
// ---------------------------------------------------------------------------
//
// Uses the REST API through fetch rather than @google/generative-ai so we add
// no dependency. Node 18+ / Electron 30 both ship global fetch.
//
// Two Gemini-specific gotchas are handled here:
//
//  1. THINKING BUDGET. Flash models think by default, and those thinking tokens
//     are drawn from maxOutputTokens. With a 2500 budget the model can spend the
//     whole allowance reasoning and hand back an empty candidate with
//     finishReason MAX_TOKENS. Setting thinkingBudget: 0 turns it off.
//
//     But support is not uniform: gemini-3.x *flash* accepts thinkingBudget 0,
//     while the *flash-lite* models reject it outright with a 400 "Request
//     contains an invalid argument" (they don't think, so the knob is moot).
//     Since llm.fastModel is typically a lite model sharing one config block,
//     a 400 on a request that carried thinkingConfig is retried once without
//     it. That self-heals across the model churn this API keeps producing.
//
//  2. MULTI-PART RESPONSES. Gemini may split a reply across several parts, and
//     thinking models can interleave `thought: true` parts. We join the real
//     text parts and drop the thought parts.

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

class GeminiProvider {
  constructor(cfg, logger) {
    this.name = 'gemini';
    this.cfg = cfg;
    this.logger = logger || console;
    this.model = cfg.model || 'gemini-2.5-flash';
    this.fastModel = cfg.fastModel || this.model;
    this.maxOutputTokens = cfg.maxOutputTokens || 2500;
    this.timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxPasses = cfg.maxPasses || cfg.maxAttempts || DEFAULT_MAX_PASSES;
    this.fallbackModels = Array.isArray(cfg.fallbackModels) ? cfg.fallbackModels : [];
    this.apiKey = process.env[cfg.apiKeyEnv || 'GEMINI_API_KEY'] || null;
    this.hasKey = Boolean(this.apiKey);
    // model -> timestamp after which a daily-capped model is worth re-probing.
    this._cappedUntil = new Map();
  }

  _isCapped(model) {
    const until = this._cappedUntil.get(model);
    if (until == null) return false;
    if (Date.now() >= until) { this._cappedUntil.delete(model); return false; }
    return true;
  }

  _body(system, userMsg, opts) {
    const generationConfig = {
      maxOutputTokens: opts.maxOutputTokens || this.maxOutputTokens,
      temperature: this.cfg.temperature != null ? this.cfg.temperature : 0.4,
    };
    if (opts.json !== false) {
      // Native JSON mode. The schema in SYSTEM_PROMPT has nullable unions and
      // discriminated shapes that Gemini's responseSchema subset can't express,
      // so we ask for JSON output without pinning a schema and let
      // commentary._extractJson stay the safety net.
      generationConfig.responseMimeType = 'application/json';
    }
    if (this.cfg.thinkingBudget != null) {
      generationConfig.thinkingConfig = { thinkingBudget: this.cfg.thinkingBudget };
    }
    const body = {
      contents: [{ role: 'user', parts: [{ text: userMsg }] }],
      generationConfig,
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    return body;
  }

  async complete(system, userMsg, opts = {}) {
    const maxTokens = opts.maxOutputTokens || this.maxOutputTokens;
    const model = opts.model || this.model;

    // Dedupe so a fallback list that repeats the primary doesn't double-call it.
    const candidates = [...new Set([model, ...this.fallbackModels])];
    const basePayload = this._body(system, userMsg, opts);
    const droppedThinking = new Set();
    let res = null;
    let json = null;
    let lastModel = model;
    // Transport rejection from the most recent attempt, if any. Reset per
    // attempt so a later HTTP failure reports its own, more specific detail.
    let lastError = null;
    // Error body of the most recent non-ok response. Read eagerly because a
    // 429 has to be classified here, and a body can only be consumed once.
    let lastBody = '';
    let retryAfterMs = 0;

    outer:
    for (let pass = 1; pass <= this.maxPasses; pass++) {
      // Skip models known to be at their daily cap — asking again only adds
      // latency before the stub.
      const live = candidates.filter((c) => !this._isCapped(c));
      if (live.length === 0) break;

      for (const candidate of live) {
        lastModel = candidate;
        let payload = basePayload;
        if (droppedThinking.has(candidate) && payload.generationConfig.thinkingConfig) {
          payload = stripThinking(payload);
        }

        // Inner loop runs at most twice: once as configured, and once more if
        // the model rejects thinkingConfig (see gotcha 1).
        for (let tries = 0; tries < 2; tries++) {
          res = null;
          lastError = null;
          try {
            res = await fetch(`${GEMINI_ENDPOINT}/${candidate}:generateContent`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(this.timeoutMs),
            });
          } catch (err) {
            // fetch REJECTS on a transport failure — our AbortSignal.timeout
            // firing, ECONNRESET, DNS — rather than resolving with a non-ok
            // response. The failover walk below keys on res.status, so without
            // this catch a single hung request to the primary model escaped
            // both loops, discarded every fallback, and stubbed the card with
            // "api-error: The operation was aborted due to timeout".
            //
            // A hung socket is congestion like any 503, and congestion is
            // per-model, so a transport failure joins the walk. No same-model
            // retry: the inner loop exists only to strip thinkingConfig, and a
            // throw yielded no status to diagnose.
            lastError = err;
            this.logger.warn(
              `[commentary] gemini request to ${candidate} failed (${err.message}); ` +
              'trying next model',
            );
            break;
          }
          if (res.ok) { json = await res.json(); break outer; }

          lastBody = await res.text().catch(() => '');
          if (res.status === 429) {
            const { perDay, retryAfterMs: advised } = parseQuotaFailure(lastBody);
            if (perDay) {
              // A daily cap will not clear on a backoff. Park the model.
              this._cappedUntil.set(candidate, Date.now() + DAILY_CAP_COOLDOWN_MS);
              this.logger.warn(
                `[commentary] gemini ${candidate} is at its free-tier daily request cap; ` +
                `skipping it for ${Math.round(DAILY_CAP_COOLDOWN_MS / 60000)}m`,
              );
            } else if (advised > 0) {
              retryAfterMs = Math.min(advised, MAX_HONORED_RETRY_MS);
            }
          }

          // A 400 on a request carrying thinkingConfig is almost always a model
          // that doesn't accept the knob (the flash-lite family). Strip it and
          // retry once — one wasted request on a config mismatch, then it works.
          if (res.status === 400 && payload.generationConfig.thinkingConfig
              && !droppedThinking.has(candidate)) {
            droppedThinking.add(candidate);
            this.logger.warn(
              `[commentary] gemini ${candidate} rejected thinkingConfig; retrying without it`,
            );
            payload = stripThinking(payload);
            continue;
          }
          break;
        }

        // A transport failure has no status to classify; always try the next
        // candidate.
        if (lastError) continue;

        // A non-retryable failure on the primary model (bad key, unknown model)
        // will fail identically on every fallback — surface it now.
        if (!RETRYABLE_STATUS.has(res.status)) break outer;

        if (candidates.length > 1) {
          this.logger.warn(
            `[commentary] gemini ${res.status} on ${candidate}; trying next model`,
          );
        }
      }

      if (pass < this.maxPasses) {
        // Nothing left to ask: every candidate is parked on its daily cap.
        // Fail now rather than sleeping toward a guaranteed failure.
        if (candidates.every((c) => this._isCapped(c))) break;
        const delay = Math.max(RETRY_DELAY_MS * pass, retryAfterMs);
        this.logger.warn(
          `[commentary] all gemini models unavailable ` +
          `(pass ${pass}/${this.maxPasses}); retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }

    // Keyed on json rather than res.ok: res is null when the final attempt threw.
    if (!json) {
      // Say this plainly. It is the one failure a trader can act on — no model
      // in the chain has requests left today, so waiting will not help.
      if (candidates.every((c) => this._isCapped(c))) {
        throw new Error(
          `all gemini models are at their free-tier daily request cap ` +
          `(${candidates.join(', ')}) — the free tier allows 20 requests/day/model. ` +
          'Switch llm to the anthropic block, add models to llm.fallbackModels, ' +
          'or reduce how often analysis fires.',
        );
      }
      if (lastError) throw lastError;
      // Mirror the Anthropic SDK's error shape ("400 {json}") so the existing
      // `api-error: ...` stub text reads the same regardless of provider.
      throw new Error(`${res.status} ${lastBody}`.trim());
    }
    if (lastModel !== model) {
      this.logger.warn(`[commentary] gemini answered on fallback model ${lastModel}`);
    }

    // A prompt-level block never produces candidates.
    const blockReason = json.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(`gemini blocked the prompt: ${blockReason}`);
    }

    const candidate = json.candidates?.[0];
    if (!candidate) {
      throw new Error('gemini returned no candidates');
    }

    const text = (candidate.content?.parts || [])
      .filter((p) => p && !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');

    const finish = candidate.finishReason;
    if (!text) {
      if (finish === 'MAX_TOKENS') {
        throw new Error(
          `gemini hit maxOutputTokens (${maxTokens}) before emitting text — ` +
          'raise llm.maxOutputTokens or set llm.thinkingBudget to 0',
        );
      }
      throw new Error(`gemini returned empty text (finishReason: ${finish || 'unknown'})`);
    }
    if (finish === 'MAX_TOKENS') {
      // Partial JSON. Hand it back anyway — _extractJson's greedy brace match
      // sometimes rescues it, and the parse-failure path logs the raw sample.
      this.logger.warn(
        `[commentary] gemini response truncated at ${maxTokens} tokens; output may be incomplete`,
      );
    }
    return text;
  }
}

// ---------------------------------------------------------------------------

const PROVIDERS = {
  anthropic: AnthropicProvider,
  gemini: GeminiProvider,
};

/**
 * Build the provider named by cfg.provider (default 'anthropic').
 * Throws on an unknown provider name — a typo in config.json should be loud,
 * not a silent fallback to a model the user didn't ask for.
 */
function createProvider(cfg, logger) {
  const name = (cfg.provider || 'anthropic').toLowerCase();
  const Ctor = PROVIDERS[name];
  if (!Ctor) {
    throw new Error(
      `unknown llm.provider '${cfg.provider}' — expected one of: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return new Ctor(cfg, logger);
}

module.exports = { createProvider, AnthropicProvider, GeminiProvider, PROVIDERS };
