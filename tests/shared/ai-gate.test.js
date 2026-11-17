'use strict';

// Whether TVCM may spend money on an LLM.
//
// Jim turned AI chart analysis off on 2026-11-17: the recommendation scorecard was below
// break-even and the Anthropic bill was climbing. This is a SPENDING rule, not a display
// one — a gate that only hid the output would still be billed.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const fs     = require('fs');

const g = require(path.join(__dirname, '../../src/shared/ai-gate.js'));
const root = path.join(__dirname, '../..');

// ── The gate itself ──────────────────────────────────────────────────────

test('only an explicit true buys anything', () => {
  assert.strictEqual(g.aiAllowed({ aiAnalysisEnabled: true }), true);
});

test('absent, malformed and almost-true all read as OFF', () => {
  for (const settings of [undefined, null, {}, { aiAnalysisEnabled: false },
                          { aiAnalysisEnabled: 'true' }, { aiAnalysisEnabled: 1 },
                          { aiAnalysisEnabled: 'yes' }, { aiAnalysisEnabled: {} }]) {
    assert.strictEqual(g.aiAllowed(settings), false, JSON.stringify(settings));
  }
});

test('the default in the shipped settings is OFF', () => {
  // A setting that costs money per tick has to be asked for.
  const src = fs.readFileSync(path.join(root, 'src/main/settings.ts'), 'utf8');
  assert.match(src, /aiAnalysisEnabled:\s*false/, 'the default must be false in DEFAULTS');
});

test('the reason is given when off, and there is nothing to say when on', () => {
  assert.strictEqual(g.aiOffReason({ aiAnalysisEnabled: true }), null);
  assert.match(g.aiOffReason({}), /AI analysis is off/);
  assert.match(g.aiOffReason(null), /Settings/, 'it must say where to turn it back on');
});

test('the message the panel shows is the one the gate defines', () => {
  assert.strictEqual(g.AI_OFF_MESSAGE, 'AI analysis is off');
  assert.strictEqual(g.AI_OFF_CODE, 'TVCM-AI-OFF');
});

// ── Every route to a provider is behind it ───────────────────────────────
//
// These read the source. The alternative — loading bridge.ts — needs Electron, and the
// thing worth protecting is not one call but the claim that there is only one: a new
// call site added tomorrow has to fail something today.

/** Every file that could reach an LLM, excluding the provider module itself. */
function appSources() {
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|js|mjs)$/.test(name)) continue;
      if (full.endsWith('src/shared/llm-providers.js')) continue;
      files.push(full);
    }
  };
  walk(path.join(root, 'src'));
  return files;
}

test('the app builds a provider in exactly one place', () => {
  // commentary.js is the only module that calls createProvider(), and bridge.ts is the
  // only module that constructs a CommentaryEngine. If that stops being true, the gate
  // below is no longer sufficient and this test is the warning.
  const creators = appSources().filter(f => /createProvider\s*\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(creators.map(f => path.relative(root, f)), ['src/shared/commentary.js']);

  const engines = appSources().filter(f => /new CommentaryEngine\s*\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(engines.map(f => path.relative(root, f)), ['src/main/bridge.ts']);
});

test('the one place that builds a provider refuses first while AI is off', () => {
  const bridge = fs.readFileSync(path.join(root, 'src/main/bridge.ts'), 'utf8');
  const fn = bridge.slice(bridge.indexOf('function ensureEngine'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(!aiEnabled\) throw/, 'ensureEngine must refuse before constructing');
  assert.ok(body.indexOf('if (!aiEnabled) throw') < body.indexOf('new CommentaryEngine'),
    'and it must refuse BEFORE the constructor, not after');
});

test('runAnalysis refuses before it reads anything at all', () => {
  const bridge = fs.readFileSync(path.join(root, 'src/main/bridge.ts'), 'utf8');
  const fn = bridge.slice(bridge.indexOf('export async function runAnalysis'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(!aiEnabled\) throw/);
  assert.ok(body.indexOf('if (!aiEnabled) throw') < body.indexOf('withReader'),
    'a refused analysis must not cost a CDP round trip either');
});

test('the bridge starts refusing, whatever anybody forgets to call', () => {
  const bridge = fs.readFileSync(path.join(root, 'src/main/bridge.ts'), 'utf8');
  assert.match(bridge, /let aiEnabled = false;/, 'the permission must default to off');
  assert.match(bridge, /aiEnabled = on === true;/, 'and only an explicit true may set it');
});

test('the scheduler does not start while AI is off', () => {
  const index = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  const fn = index.slice(index.indexOf('function startSchedulerOnce'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /aiGate\.aiAllowed/);
  assert.ok(body.indexOf('aiGate.aiAllowed') < body.indexOf('scheduler?.start'),
    'the check must come before the start');
});

test('Refresh Now is refused in the main process as well as the panel', () => {
  const index = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  const handler = index.slice(index.indexOf('ipcMain.handle(IPC.ANALYZE_RUN'));
  const body = handler.slice(0, handler.indexOf('await runAnalysis') + 40);
  assert.match(body, /aiGate\.aiAllowed/);
  assert.ok(body.indexOf('aiGate.aiAllowed') < body.indexOf('await runAnalysis'),
    'an IPC call that arrives anyway must not reach runAnalysis');
});

test('every annotator write path is gated, and the clears are not', () => {
  const src = fs.readFileSync(path.join(root, 'src/main/annotator.ts'), 'utf8');
  for (const fn of ['writeLevels', 'writeLevel', 'writeTradePlan', 'writePatternMarkers', 'writeConfidence']) {
    const at = src.indexOf(`export async function ${fn}`);
    assert.ok(at > 0, fn);
    assert.match(src.slice(at, at + 400), /if \(!drawingAllowed\) return;/, `${fn} is not gated`);
  }
  // Turning AI off has to be able to wipe what AI drew, so the clears must NOT be gated.
  for (const fn of ['clearTradePlan', 'clearAll']) {
    const at = src.indexOf(`export async function ${fn}`);
    assert.ok(at > 0, fn);
    assert.ok(!/if \(!drawingAllowed\) return;/.test(src.slice(at, at + 200)),
      `${fn} must still work so the chart can be cleaned up`);
  }
});

test('the panel says so, and Refresh is disabled with that reason', () => {
  const app = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');
  assert.match(app, /AI analysis is off/);
  assert.match(app, /disabled=\{uiStatus === 'loading' \|\| !aiEnabled\}/);
  assert.match(app, /title=\{aiEnabled \? [^}]*'AI analysis is off'\}/);
});

test('the P&L half of the app is not touched by any of this', () => {
  // The claim Jim is relying on: turning AI off costs him nothing he uses.
  for (const f of ['src/shared/live-feed.js', 'src/shared/pnl-merge.js', 'src/shared/corrections.js',
                   'src/shared/opening-balance.js', 'src/shared/tray-title.js',
                   'src/shared/order-history.js', 'src/pnlwindow/App.tsx']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/createProvider|CommentaryEngine|aiAnalysisEnabled/.test(src),
      `${f} must have nothing to do with AI`);
  }
});
