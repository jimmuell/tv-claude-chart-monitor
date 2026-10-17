#!/usr/bin/env node
// test-llm-provider.js
// Smoke-tests the configured LLM provider without launching Electron or
// needing a live TradingView CDP connection. Feeds CommentaryEngine a
// synthetic chart context and prints the parsed card.
//
//   node scripts/test-llm-provider.js              # use config.json's llm block
//   node scripts/test-llm-provider.js --models     # list models the key can see
//   node scripts/test-llm-provider.js --provider anthropic
//
// Exit code 0 = a real card came back. 1 = stubbed or failed.

require('dotenv').config();

const path = require('path');
const { CommentaryEngine } = require(path.join(__dirname, '..', 'src/shared/commentary'));

const ROOT = path.join(__dirname, '..');
const config = require(path.join(ROOT, 'config', 'config.json'));

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] || true);
};

// --- Gemini model listing -------------------------------------------------
// Model ids move around; this shows exactly what your key has access to, so a
// 404 on `llm.model` is one command away from being diagnosed.
async function listGeminiModels() {
  const cfg = config.llm || {};
  const key = process.env[cfg.apiKeyEnv || 'GEMINI_API_KEY'];
  if (!key) {
    console.error(`No key in env ${cfg.apiKeyEnv || 'GEMINI_API_KEY'}`);
    process.exit(1);
  }
  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models',
    { headers: { 'x-goog-api-key': key } },
  );
  if (!res.ok) {
    console.error(`${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const { models = [] } = await res.json();
  const usable = models.filter((m) =>
    (m.supportedGenerationMethods || []).includes('generateContent'));
  console.log(`${usable.length} models support generateContent:\n`);
  for (const m of usable) {
    console.log(`  ${m.name.replace('models/', '').padEnd(42)} ${m.displayName || ''}`);
  }
}

// --- Synthetic context ----------------------------------------------------
// Shaped to match what context.js produces, so buildUserMessage() renders the
// same prompt the live pipeline would.
function fakeContext() {
  const base = 7777.75;
  const recent = Array.from({ length: 10 }, (_, i) => {
    const o = base - (9 - i) * 1.5;
    return {
      time: `09:${String(30 + i).padStart(2, '0')}`,
      open: o, high: o + 2.25, low: o - 1.75, close: o + 0.75,
    };
  });
  return {
    symbol: 'CME_MINI:MES1!',
    timeframe: 5,
    closedBar: recent[recent.length - 1],
    recent,
    ma: 7771.2,
    trend: { trend: 'up', reason: 'higher highs and higher lows, price above rising MA' },
    maEvents: [],
    zones: [
      {
        zone: { kind: 'level', price: 7782.0, label: 'Overnight High' },
        interaction: 'approaching', distanceTicks: 4.25,
      },
      {
        zone: { kind: 'zone', lo: 7762.0, hi: 7766.5, label: 'Demand Zone' },
        interaction: 'none', distanceTicks: 12.5,
      },
    ],
    classification: { tags: ['bullish_engulfing', 'trend_continuation'] },
    orbState: null,
    orbSignal: null,
  };
}

async function main() {
  if (argv.includes('--models')) return listGeminiModels();

  const overrideProvider = flag('provider');
  let llm = config.llm || config.anthropic;
  if (overrideProvider && typeof overrideProvider === 'string') {
    llm = config[overrideProvider] || { ...llm, provider: overrideProvider };
  }

  console.log(`provider=${llm.provider}  model=${llm.model}  keyEnv=${llm.apiKeyEnv}`);
  console.log(`key present: ${process.env[llm.apiKeyEnv] ? 'yes' : 'NO'}\n`);

  const engine = new CommentaryEngine(llm, console);
  const started = Date.now();
  const card = await engine.analyze(fakeContext(), [{ kind: 'on-demand' }]);
  const elapsed = Date.now() - started;

  console.log(`\n--- card (${elapsed}ms) ---`);
  console.log(JSON.stringify(card, null, 2));

  // A stub always carries confidence 0 and an "analysis (" objective prefix.
  const stubbed = /^Stubbed analysis \(/.test(card.objective || '');
  console.log(`\n${stubbed ? '✗ STUBBED — provider did not answer' : '✓ live commentary'}`);
  process.exit(stubbed ? 1 : 0);
}

// Only self-run when invoked directly, so other scripts can reuse fakeContext.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { fakeContext };
