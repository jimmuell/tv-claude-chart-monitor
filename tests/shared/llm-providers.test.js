// Tests for the pluggable LLM provider layer.
//
// The Gemini provider talks HTTP, so these stub global.fetch and assert on the
// request body we build and the response shapes we have to survive. No network.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { createProvider, GeminiProvider } =
  require(path.join(__dirname, '..', '..', 'src/shared/llm-providers'));

const quietLogger = { info() {}, warn() {}, error() {} };

// Build a Gemini provider with a key present, without touching the real env
// beyond the one var we set and restore.
async function withGemini(cfg, fn) {
  const ENV = 'TEST_GEMINI_KEY';
  const prior = process.env[ENV];
  process.env[ENV] = 'test-key';
  const realFetch = global.fetch;
  // Must await fn before restoring: a non-async finally would put the real
  // fetch back mid-test and let stubbed calls escape to the network.
  try {
    const p = new GeminiProvider({ apiKeyEnv: ENV, ...cfg }, quietLogger);
    return await fn(p);
  } finally {
    global.fetch = realFetch;
    if (prior === undefined) delete process.env[ENV]; else process.env[ENV] = prior;
  }
}

// Minimal successful Gemini payload.
const okResponse = (text, finishReason = 'STOP') => ({
  ok: true,
  status: 200,
  json: async () => ({
    candidates: [{ content: { parts: [{ text }] }, finishReason }],
  }),
});

// --- factory ---------------------------------------------------------------

test('createProvider selects a backend by name', () => {
  const g = createProvider({ provider: 'gemini', apiKeyEnv: 'NOPE' }, quietLogger);
  assert.strictEqual(g.name, 'gemini');
});

test('createProvider defaults to anthropic when provider is absent', () => {
  const a = createProvider({ apiKeyEnv: 'NOPE' }, quietLogger);
  assert.strictEqual(a.name, 'anthropic');
});

test('createProvider throws on an unknown provider rather than falling back', () => {
  assert.throws(
    () => createProvider({ provider: 'llama' }, quietLogger),
    /unknown llm\.provider 'llama'/,
  );
});

test('hasKey is false when the configured env var is unset', () => {
  const g = createProvider({ provider: 'gemini', apiKeyEnv: 'DEFINITELY_UNSET_XYZ' }, quietLogger);
  assert.strictEqual(g.hasKey, false);
});

test('fastModel falls back to model so an unset value is not a silent downgrade', () => {
  const g = createProvider(
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKeyEnv: 'NOPE' }, quietLogger);
  assert.strictEqual(g.fastModel, 'gemini-2.5-flash');

  const h = createProvider(
    { provider: 'gemini', model: 'gemini-2.5-flash', fastModel: 'lite', apiKeyEnv: 'NOPE' },
    quietLogger);
  assert.strictEqual(h.fastModel, 'lite');
});

// --- Gemini request shape --------------------------------------------------

test('gemini request carries system instruction and JSON mode by default', async () => {
  await withGemini({ model: 'm1' }, async (p) => {
    let captured;
    global.fetch = async (url, init) => {
      captured = { url, body: JSON.parse(init.body), headers: init.headers };
      return okResponse('{"ok":1}');
    };
    await p.complete('SYS', 'USER');

    assert.match(captured.url, /\/models\/m1:generateContent$/);
    assert.strictEqual(captured.headers['x-goog-api-key'], 'test-key');
    assert.strictEqual(captured.body.systemInstruction.parts[0].text, 'SYS');
    assert.strictEqual(captured.body.contents[0].parts[0].text, 'USER');
    assert.strictEqual(captured.body.generationConfig.responseMimeType, 'application/json');
  });
});

test('json:false omits responseMimeType for prose callers', async () => {
  await withGemini({}, async (p) => {
    let body;
    global.fetch = async (_u, init) => { body = JSON.parse(init.body); return okResponse('prose'); };
    await p.complete(null, 'USER', { json: false });

    assert.ok(!('responseMimeType' in body.generationConfig));
    // A null system must not produce an empty systemInstruction.
    assert.ok(!('systemInstruction' in body));
  });
});

test('thinkingConfig is sent only when thinkingBudget is configured', async () => {
  await withGemini({ thinkingBudget: 0 }, async (p) => {
    let body;
    global.fetch = async (_u, init) => { body = JSON.parse(init.body); return okResponse('{}'); };
    await p.complete('S', 'U');
    assert.deepStrictEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  });

  await withGemini({}, async (p) => {
    let body;
    global.fetch = async (_u, init) => { body = JSON.parse(init.body); return okResponse('{}'); };
    await p.complete('S', 'U');
    assert.ok(!('thinkingConfig' in body.generationConfig),
      'gemini-2.0-* rejects thinkingConfig, so it must be omitted when unset');
  });
});

test('opts.model and opts.maxOutputTokens override the configured values', async () => {
  await withGemini({ model: 'big', maxOutputTokens: 2500 }, async (p) => {
    let captured;
    global.fetch = async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return okResponse('{}');
    };
    await p.complete('S', 'U', { model: 'small', maxOutputTokens: 250 });
    assert.match(captured.url, /\/models\/small:generateContent$/);
    assert.strictEqual(captured.body.generationConfig.maxOutputTokens, 250);
  });
});

// --- Gemini response handling ----------------------------------------------

test('multi-part responses are joined and thought parts dropped', async () => {
  await withGemini({}, async (p) => {
    global.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        candidates: [{
          content: { parts: [
            { text: 'reasoning noise', thought: true },
            { text: '{"a":' },
            { text: '1}' },
          ] },
          finishReason: 'STOP',
        }],
      }),
    });
    assert.strictEqual(await p.complete('S', 'U'), '{"a":1}');
  });
});

test('a truncated response still returns its partial text', async () => {
  await withGemini({}, async (p) => {
    global.fetch = async () => okResponse('{"a":1', 'MAX_TOKENS');
    assert.strictEqual(await p.complete('S', 'U'), '{"a":1');
  });
});

test('MAX_TOKENS with no text points at the thinking-budget fix', async () => {
  await withGemini({ maxOutputTokens: 2500 }, async (p) => {
    global.fetch = async () => okResponse('', 'MAX_TOKENS');
    await assert.rejects(() => p.complete('S', 'U'), /thinkingBudget/);
  });
});

test('a blocked prompt throws rather than returning empty commentary', async () => {
  await withGemini({}, async (p) => {
    global.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }),
    });
    await assert.rejects(() => p.complete('S', 'U'), /blocked the prompt: SAFETY/);
  });
});

test('an HTTP error surfaces status and body for the api-error stub', async () => {
  await withGemini({}, async (p) => {
    global.fetch = async () => ({
      ok: false, status: 400,
      text: async () => '{"error":{"message":"bad model"}}',
    });
    await assert.rejects(() => p.complete('S', 'U'), /400 .*bad model/);
  });
});

test('a 429 is retried, then succeeds', async () => {
  await withGemini({}, async (p) => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, text: async () => 'rate limited' };
      return okResponse('{"ok":1}');
    };
    assert.strictEqual(await p.complete('S', 'U'), '{"ok":1}');
    assert.strictEqual(calls, 2);
  });
});

test('a 400 is not retried as a transient error', async () => {
  await withGemini({}, async (p) => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return { ok: false, status: 400, text: async () => 'bad request' };
    };
    await assert.rejects(() => p.complete('S', 'U'));
    // No thinkingConfig was sent, so there is nothing to strip and retry.
    assert.strictEqual(calls, 1);
  });
});

test('a 400 on a thinkingConfig request retries once without it', async () => {
  // The flash-lite family rejects thinkingBudget outright; fastModel calls
  // share the main config block, so the provider has to self-heal.
  await withGemini({ thinkingBudget: 0 }, async (p) => {
    const bodies = [];
    global.fetch = async (_u, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return { ok: false, status: 400, text: async () => 'invalid argument' };
      }
      return okResponse('{"ok":1}');
    };
    assert.strictEqual(await p.complete('S', 'U'), '{"ok":1}');
    assert.strictEqual(bodies.length, 2);
    assert.deepStrictEqual(bodies[0].generationConfig.thinkingConfig, { thinkingBudget: 0 });
    assert.ok(!('thinkingConfig' in bodies[1].generationConfig),
      'the retry must drop thinkingConfig');
    // Stripping thinkingConfig must not disturb the rest of the request.
    assert.strictEqual(bodies[1].generationConfig.responseMimeType, 'application/json');
    assert.strictEqual(bodies[1].contents[0].parts[0].text, 'U');
  });
});

test('the thinkingConfig strip is attempted only once', async () => {
  await withGemini({ thinkingBudget: 0 }, async (p) => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return { ok: false, status: 400, text: async () => 'invalid argument' };
    };
    await assert.rejects(() => p.complete('S', 'U'));
    assert.strictEqual(calls, 2, 'one original + one stripped retry, then give up');
  });
});

test('503 is retried for maxPasses with backoff between passes', async () => {
  await withGemini({ maxPasses: 3 }, async (p) => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return { ok: false, status: 503, text: async () => 'high demand' };
    };
    const started = Date.now();
    await assert.rejects(() => p.complete('S', 'U'), /503/);
    assert.strictEqual(calls, 3);
    // Linear backoff: 2s after pass 1, 4s after pass 2.
    assert.ok(Date.now() - started >= 6000, 'should back off between passes');
  });
});

test('maxPasses of 1 disables retrying', async () => {
  await withGemini({ maxPasses: 1 }, async (p) => {
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 503, text: async () => 'x' }; };
    await assert.rejects(() => p.complete('S', 'U'));
    assert.strictEqual(calls, 1);
  });
});

// --- model fallback chain --------------------------------------------------

test('a congested model falls over to the next candidate', async () => {
  await withGemini(
    { model: 'busy', fallbackModels: ['spare'], maxPasses: 1 },
    async (p) => {
      const tried = [];
      global.fetch = async (url) => {
        const m = url.match(/models\/([^:]+):/)[1];
        tried.push(m);
        if (m === 'busy') return { ok: false, status: 503, text: async () => 'high demand' };
        return okResponse('{"ok":1}');
      };
      assert.strictEqual(await p.complete('S', 'U'), '{"ok":1}');
      assert.deepStrictEqual(tried, ['busy', 'spare']);
    });
});

test('failover happens before any backoff sleep', async () => {
  // The whole point of walking the chain: a down model costs a request, not 2s.
  await withGemini(
    { model: 'busy', fallbackModels: ['spare'], maxPasses: 3 },
    async (p) => {
      global.fetch = async (url) => (/models\/busy:/.test(url)
        ? { ok: false, status: 503, text: async () => 'x' }
        : okResponse('{"ok":1}'));
      const started = Date.now();
      await p.complete('S', 'U');
      assert.ok(Date.now() - started < 1000, 'must not sleep before trying the fallback');
    });
});

test('every candidate is tried on each pass', async () => {
  await withGemini(
    { model: 'a', fallbackModels: ['b'], maxPasses: 2 },
    async (p) => {
      const tried = [];
      global.fetch = async (url) => {
        tried.push(url.match(/models\/([^:]+):/)[1]);
        return { ok: false, status: 503, text: async () => 'x' };
      };
      await assert.rejects(() => p.complete('S', 'U'), /503/);
      assert.deepStrictEqual(tried, ['a', 'b', 'a', 'b']);
    });
});

test('a duplicate in fallbackModels is not called twice', async () => {
  await withGemini(
    { model: 'a', fallbackModels: ['a', 'b'], maxPasses: 1 },
    async (p) => {
      const tried = [];
      global.fetch = async (url) => {
        tried.push(url.match(/models\/([^:]+):/)[1]);
        return { ok: false, status: 503, text: async () => 'x' };
      };
      await assert.rejects(() => p.complete('S', 'U'));
      assert.deepStrictEqual(tried, ['a', 'b']);
    });
});

test('a non-retryable error stops the chain instead of hammering every model', async () => {
  // A bad key or unknown model fails identically everywhere — failing over
  // would just multiply the same error.
  await withGemini(
    { model: 'a', fallbackModels: ['b', 'c'], maxPasses: 3 },
    async (p) => {
      let calls = 0;
      global.fetch = async () => {
        calls++;
        return { ok: false, status: 403, text: async () => 'API key not valid' };
      };
      await assert.rejects(() => p.complete('S', 'U'), /403/);
      assert.strictEqual(calls, 1);
    });
});

test('a thinkingConfig rejection is remembered per model, not retried each pass', async () => {
  await withGemini(
    { model: 'lite', thinkingBudget: 0, maxPasses: 2 },
    async (p) => {
      const bodies = [];
      global.fetch = async (_u, init) => {
        const b = JSON.parse(init.body);
        bodies.push(b);
        // Rejects thinkingConfig; still 503s afterwards so the passes continue.
        if (b.generationConfig.thinkingConfig) {
          return { ok: false, status: 400, text: async () => 'invalid argument' };
        }
        return { ok: false, status: 503, text: async () => 'high demand' };
      };
      await assert.rejects(() => p.complete('S', 'U'), /503/);
      // Pass 1: with thinking (400) then without (503). Pass 2: straight to
      // without — the rejection is remembered.
      assert.strictEqual(bodies.length, 3);
      assert.ok(bodies[0].generationConfig.thinkingConfig);
      assert.ok(!bodies[1].generationConfig.thinkingConfig);
      assert.ok(!bodies[2].generationConfig.thinkingConfig);
    });
});

test('stripping thinkingConfig for one model does not affect the next', async () => {
  await withGemini(
    { model: 'lite', fallbackModels: ['full'], thinkingBudget: 0, maxPasses: 1 },
    async (p) => {
      const seen = [];
      global.fetch = async (url, init) => {
        const m = url.match(/models\/([^:]+):/)[1];
        const b = JSON.parse(init.body);
        seen.push([m, Boolean(b.generationConfig.thinkingConfig)]);
        if (m === 'lite' && b.generationConfig.thinkingConfig) {
          return { ok: false, status: 400, text: async () => 'invalid argument' };
        }
        if (m === 'lite') return { ok: false, status: 503, text: async () => 'x' };
        return okResponse('{"ok":1}');
      };
      assert.strictEqual(await p.complete('S', 'U'), '{"ok":1}');
      assert.deepStrictEqual(seen, [['lite', true], ['lite', false], ['full', true]]);
    });
});

// --- transport failures ----------------------------------------------------
//
// fetch REJECTS on a transport failure (AbortSignal.timeout firing, ECONNRESET,
// DNS) rather than resolving with a non-ok response. The failover chain keys on
// res.status, so a thrown error used to escape both loops untouched — one slow
// request to the primary model discarded every fallback and stubbed the card
// with "api-error: The operation was aborted due to timeout".

const timeoutError = () => {
  const e = new Error('The operation was aborted due to timeout');
  e.name = 'TimeoutError';
  return e;
};

test('a request that times out falls over to the next candidate', async () => {
  await withGemini(
    { model: 'hung', fallbackModels: ['spare'], maxPasses: 1 },
    async (p) => {
      const tried = [];
      global.fetch = async (url) => {
        const m = url.match(/models\/([^:]+):/)[1];
        tried.push(m);
        if (m === 'hung') throw timeoutError();
        return okResponse('{"ok":1}');
      };
      assert.strictEqual(await p.complete('S', 'U'), '{"ok":1}');
      assert.deepStrictEqual(tried, ['hung', 'spare']);
    });
});

test('a connection reset falls over like any other transient failure', async () => {
  await withGemini(
    { model: 'flaky', fallbackModels: ['spare'], maxPasses: 1 },
    async (p) => {
      global.fetch = async (url) => {
        if (url.includes('flaky')) {
          const e = new Error('fetch failed');
          e.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
          throw e;
        }
        return okResponse('{"ok":1}');
      };
      assert.strictEqual(await p.complete('S', 'U'), '{"ok":1}');
    });
});

test('a transport failure on every candidate surfaces the error, not a TypeError', async () => {
  await withGemini(
    { model: 'a', fallbackModels: ['b'], maxPasses: 1 },
    async (p) => {
      let calls = 0;
      global.fetch = async () => { calls++; throw timeoutError(); };
      await assert.rejects(() => p.complete('S', 'U'), /aborted due to timeout/);
      assert.strictEqual(calls, 2, 'both candidates must be tried before giving up');
    });
});

test('an HTTP failure after a transport failure still reports the HTTP detail', async () => {
  // The last attempt's outcome is what the api-error stub shows the trader, so
  // a transport error must not mask a later, more specific HTTP body.
  await withGemini(
    { model: 'hung', fallbackModels: ['refused'], maxPasses: 1 },
    async (p) => {
      global.fetch = async (url) => {
        if (url.includes('hung')) throw timeoutError();
        return { ok: false, status: 429, text: async () => 'quota exhausted' };
      };
      await assert.rejects(() => p.complete('S', 'U'), /429 .*quota exhausted/);
    });
});

// --- quota exhaustion ------------------------------------------------------
//
// Not every 429 is transient. The free tier caps requests PER DAY PER MODEL
// (quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier, limit 20), and
// that does not clear on a 2s backoff. Retrying it walks every model and sleeps
// the full ladder for a guaranteed failure, delaying the stub on every bar.

const quota429 = (model, { perDay = true, retryDelay = '39s' } = {}) => ({
  ok: false,
  status: 429,
  text: async () => JSON.stringify({
    error: {
      code: 429,
      message: `Quota exceeded for metric: generate_content_free_tier_requests, model: ${model}`,
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{
            quotaId: perDay
              ? 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'
              : 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
            quotaDimensions: { model, location: 'global' },
            quotaValue: '20',
          }],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
      ],
    },
  }),
});

test('a per-day quota 429 is not retried across passes', async () => {
  await withGemini({ model: 'a', maxPasses: 3 }, async (p) => {
    let calls = 0;
    global.fetch = async () => { calls++; return quota429('a'); };
    const started = Date.now();
    await assert.rejects(() => p.complete('S', 'U'), /daily/i);
    assert.strictEqual(calls, 1, 'a daily cap does not clear on a backoff ladder');
    assert.ok(Date.now() - started < 1500, 'must not sleep the retry ladder');
  });
});

test('a per-day quota 429 still fails over to a model with quota left', async () => {
  await withGemini(
    { model: 'capped', fallbackModels: ['fresh'], maxPasses: 3 },
    async (p) => {
      const tried = [];
      global.fetch = async (url) => {
        const m = url.match(/models\/([^:]+):/)[1];
        tried.push(m);
        if (m === 'capped') return quota429('capped');
        return okResponse('{"ok":1}');
      };
      assert.strictEqual(await p.complete('S', 'U'), '{"ok":1}');
      assert.deepStrictEqual(tried, ['capped', 'fresh']);
    });
});

test('a model capped for the day is skipped on later calls', async () => {
  // Per-bar tool: once a model is known exhausted, re-asking it every bar just
  // adds latency before the stub.
  await withGemini(
    { model: 'capped', fallbackModels: ['fresh'], maxPasses: 1 },
    async (p) => {
      const tried = [];
      global.fetch = async (url) => {
        const m = url.match(/models\/([^:]+):/)[1];
        tried.push(m);
        if (m === 'capped') return quota429('capped');
        return okResponse('{"ok":1}');
      };
      await p.complete('S', 'U');
      await p.complete('S', 'U');
      assert.deepStrictEqual(tried, ['capped', 'fresh', 'fresh'],
        'the second call should go straight to the model with quota');
    });
});

test('every model capped for the day throws an actionable error', async () => {
  await withGemini(
    { model: 'a', fallbackModels: ['b'], maxPasses: 3 },
    async (p) => {
      global.fetch = async (url) => quota429(url.match(/models\/([^:]+):/)[1]);
      await assert.rejects(() => p.complete('S', 'U'),
        (e) => /daily/i.test(e.message) && /a, b|a,b/.test(e.message));
    });
});

test('a per-minute 429 honours the RetryInfo delay over the fixed ladder', async () => {
  // Google tells us exactly how long to wait; a 2s ladder just fails again.
  await withGemini({ model: 'a', maxPasses: 2 }, async (p) => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return quota429('a', { perDay: false, retryDelay: '3s' });
      return okResponse('{"ok":1}');
    };
    const started = Date.now();
    assert.strictEqual(await p.complete('S', 'U'), '{"ok":1}');
    const waited = Date.now() - started;
    assert.ok(waited >= 3000, `should wait the advertised 3s, waited ${waited}ms`);
  });
});

test('an advertised retry delay longer than a bar is clamped, not slept through', async () => {
  // Google sometimes advises 39s. Sleeping that long blows the bar we are
  // commenting on, so we take one wasted request instead.
  await withGemini({ model: 'a', maxPasses: 2 }, async (p) => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return quota429('a', { perDay: false, retryDelay: '39s' });
      return okResponse('{"ok":1}');
    };
    const started = Date.now();
    assert.strictEqual(await p.complete('S', 'U'), '{"ok":1}');
    const waited = Date.now() - started;
    assert.ok(waited < 12000, `should clamp the 39s advice, waited ${waited}ms`);
    assert.ok(waited >= 2000, 'but still backs off');
  });
});

test('a malformed 429 body is treated as transient rather than a daily cap', async () => {
  await withGemini({ model: 'a', maxPasses: 2 }, async (p) => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, text: async () => 'not json at all' };
      return okResponse('{"ok":1}');
    };
    assert.strictEqual(await p.complete('S', 'U'), '{"ok":1}');
    assert.strictEqual(calls, 2);
  });
});
