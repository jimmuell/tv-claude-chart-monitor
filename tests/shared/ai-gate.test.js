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

// REWRITTEN in TVCM-46. TVCM-44 built the FIRST version of Jim's instruction, which said
// AI off entirely. He corrected it at 15:59: AI runs automatically 07:30–16:30 CT on
// trading days and is MANUAL outside that. So the kill switch now defaults ON, and the
// spending is bounded by the window instead — which is what these assert.

test('the kill switch is on by default, and only an explicit false turns it off', () => {
  assert.strictEqual(g.aiAllowed({}), true);
  assert.strictEqual(g.aiAllowed(null), true);
  assert.strictEqual(g.aiAllowed({ aiAnalysisEnabled: true }), true);
  assert.strictEqual(g.aiAllowed({ aiAnalysisEnabled: false }), false);
});

test('the shipped default has AI on and the window at Jim\u2019s hours', () => {
  const src = fs.readFileSync(path.join(root, 'src/main/settings.ts'), 'utf8');
  assert.match(src, /aiAnalysisEnabled:\s*true/);
  assert.match(src, /aiAutoWindowStart:\s*'07:30'/);
  assert.match(src, /aiAutoWindowEnd:\s*'16:30'/);
});

test('the reason is given when off, and there is nothing to say when on', () => {
  assert.strictEqual(g.aiOffReason({ aiAnalysisEnabled: true }), null);
  assert.strictEqual(g.aiOffReason({}), null, 'on by default means nothing to apologise for');
  assert.match(g.aiOffReason({ aiAnalysisEnabled: false }), /AI analysis is off/);
  assert.match(g.aiOffReason({ aiAnalysisEnabled: false }), /Settings/);
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

test('the scheduler does not start while AI is off entirely', () => {
  const index = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  const fn = index.slice(index.indexOf('function startSchedulerOnce'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /aiGate\.aiAllowed/);
  assert.ok(body.indexOf('aiGate.aiAllowed') < body.indexOf('scheduler?.start'),
    'the check must come before the start');
});

test('Refresh Now checks only the kill switch, never the window', () => {
  // Manual is always allowed while AI is on: pressing Refresh IS the decision to spend.
  const index = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  const handler = index.slice(index.indexOf('ipcMain.handle(IPC.ANALYZE_RUN'));
  const body = handler.slice(0, handler.indexOf('await runAnalysis') + 40);
  assert.match(body, /aiGate\.aiManualAllowed/);
  assert.ok(!/aiAutoAllowed|insideAutoWindow/.test(body),
    'the window must not gate a manual press');
});

test('the scheduler asks the window before every automatic analysis', () => {
  const sched = fs.readFileSync(path.join(root, 'src/main/scheduler.ts'), 'utf8');
  const fn = sched.slice(sched.indexOf('private _execute()'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /if \(!this\._autoAllowed\(\)\)/);
  assert.ok(body.indexOf('this._autoAllowed()') < body.indexOf('runAnalysis()'),
    'the check must come before the call, not after');
  assert.match(sched, /_autoAllowed: \(\) => boolean = \(\) => false;/,
    'a scheduler nobody tells must refuse');
  const index = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  assert.match(index, /scheduler\.setAutoGate\(\(\) => aiGate\.aiAutoAllowed\(/);
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

test('the panel names the window outside it, and Refresh stays usable', () => {
  const app = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');
  assert.match(app, /autoWindowSentence/, 'the hours must appear on screen');
  assert.match(app, /getAiWindowStatus/, 'decided by the shared rule, in the main process');
  // The gate is CommonJS. Importing it here served \ to the browser and
  // blanked the whole panel with "module is not defined" (TVCM-46).
  assert.ok(!/from '\.\.\/shared\/ai-gate/.test(app),
    'the renderer must never import the CommonJS gate');
  // Refresh is only ever disabled by the kill switch or a run in flight — never by the
  // window, because outside the window is precisely when Jim needs it.
  assert.match(app, /disabled=\{uiStatus === 'loading' \|\| !aiEnabled\}/);
  assert.ok(!/disabled=\{[^}]*autoWindowOpen/.test(app));
});

// ── The window itself ────────────────────────────────────────────────────

/** An instant, given as UTC with its Chicago meaning in the test name. */
const at = (iso) => Date.parse(iso);

test('the boundaries are inclusive at the start and exclusive at the end', () => {
  //                     CT 07:29        CT 07:30       CT 16:29       CT 16:30
  const cases = [['2026-11-17T13:29:00Z', false], ['2026-11-17T13:30:00Z', true],
                 ['2026-11-17T22:29:00Z', true],  ['2026-11-17T22:30:00Z', false]];
  for (const [iso, expected] of cases) {
    assert.strictEqual(g.aiAutoAllowed({}, at(iso)), expected, iso);
  }
});

test('the boundaries are right on the other side of a DST change', () => {
  // CST (UTC-6) in November, CDT (UTC-5) in July. The same wall-clock minute is a
  // different UTC instant, which is why the clock is read through the calendar.
  assert.strictEqual(g.aiAutoAllowed({}, at('2026-07-15T12:29:00Z')), false, 'CDT 07:29');
  assert.strictEqual(g.aiAutoAllowed({}, at('2026-07-15T12:30:00Z')), true,  'CDT 07:30');
  assert.strictEqual(g.aiAutoAllowed({}, at('2026-07-15T21:29:00Z')), true,  'CDT 16:29');
  assert.strictEqual(g.aiAutoAllowed({}, at('2026-07-15T21:30:00Z')), false, 'CDT 16:30');
});

test('nothing automatic happens at the weekend', () => {
  assert.strictEqual(g.isTradingWeekday(at('2026-11-21T16:00:00Z')), false, 'Saturday');
  assert.strictEqual(g.isTradingWeekday(at('2026-11-22T16:00:00Z')), false, 'Sunday');
  assert.strictEqual(g.isTradingWeekday(at('2026-11-20T16:00:00Z')), true,  'Friday');
  // 10:00 CT on a Saturday is inside the hours and still refused.
  assert.strictEqual(g.insideAutoWindow({}, at('2026-11-21T16:00:00Z')), true);
  assert.strictEqual(g.aiAutoAllowed({}, at('2026-11-21T16:00:00Z')), false);
});

test('an hour outside the window is a whole hour of zero automatic calls', () => {
  // The acceptance, simulated: every minute from 17:00 to 17:59 CT.
  let allowed = 0;
  for (let m = 0; m < 60; m++) {
    if (g.aiAutoAllowed({}, at('2026-11-17T23:00:00Z') + m * 60_000)) allowed += 1;
  }
  assert.strictEqual(allowed, 0, 'the scheduler must not be permitted once in the hour');
});

test('an hour inside the window permits every minute of it', () => {
  let allowed = 0;
  for (let m = 0; m < 60; m++) {
    if (g.aiAutoAllowed({}, at('2026-11-17T15:00:00Z') + m * 60_000)) allowed += 1;
  }
  assert.strictEqual(allowed, 60, '09:00–09:59 CT is inside 07:30–16:30');
});

test('a manual press is allowed at every one of those minutes', () => {
  // Outside the window is exactly when Refresh matters.
  for (let m = 0; m < 60; m++) {
    assert.strictEqual(g.aiManualAllowed({}), true);
  }
  assert.strictEqual(g.aiManualAllowed({ aiAnalysisEnabled: false }), false,
    'only the kill switch refuses a manual press');
});

test('the window is configurable, and nonsense falls back to the defaults', () => {
  const nine = { aiAutoWindowStart: '09:00', aiAutoWindowEnd: '10:00' };
  assert.strictEqual(g.aiAutoAllowed(nine, at('2026-11-17T14:30:00Z')), false, 'CT 08:30 is outside 09:00-10:00');
  assert.strictEqual(g.aiAutoAllowed(nine, at('2026-11-17T15:30:00Z')), true,  'CT 09:30 — yes');
  for (const bad of [{ aiAutoWindowStart: 'nonsense' }, { aiAutoWindowStart: '25:00' },
                     { aiAutoWindowEnd: '' }, { aiAutoWindowEnd: null }]) {
    const w = g.autoWindow(bad);
    assert.ok(w.startMinutes !== null && w.endMinutes !== null, JSON.stringify(bad));
  }
  assert.deepStrictEqual(
    [g.autoWindow({}).start, g.autoWindow({}).end], ['07:30', '16:30']);
});

test('the sentence names the hours the way a person says them', () => {
  assert.strictEqual(g.autoWindowText({}),
    'Auto-analysis 7:30\u20134:30 CT \u2014 press Refresh for an update');
  assert.strictEqual(g.autoWindowText({ aiAutoWindowStart: '09:00', aiAutoWindowEnd: '12:15' }),
    'Auto-analysis 9:00\u201312:15 CT \u2014 press Refresh for an update');
});

test('the status line explains which reason applies', () => {
  assert.strictEqual(g.autoStatusText({}, at('2026-11-17T15:00:00Z')), null, 'inside: nothing to say');
  assert.match(g.autoStatusText({}, at('2026-11-17T23:00:00Z')), /Auto-analysis/);
  assert.match(g.autoStatusText({}, at('2026-11-21T16:00:00Z')), /weekend/);
  assert.strictEqual(g.autoStatusText({ aiAnalysisEnabled: false }, Date.now()), 'AI analysis is off');
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

test('no renderer file imports a CommonJS shared module', () => {
  // The repo's rule, learned the hard way twice: src/shared/*.js is CommonJS loaded by
  // the main process; Vite serves the renderer as native ES modules, so a CJS import
  // arrives as `module.exports` and throws before anything renders (CLAUDE.md, TVCM-46).
  const dirs = ['src/renderer', 'src/pnlwindow'];
  const offenders = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (!/\.(ts|tsx)$/.test(name)) continue;
      const src = fs.readFileSync(path.join(root, dir, name), 'utf8');
      for (const m of src.matchAll(/from\s+'([^']*\/shared\/[^']+)'/g)) {
        const target = m[1];
        if (/\.mjs$/.test(target) || /\/types$/.test(target)) continue;
        if (/\.js$/.test(target)) offenders.push(`${dir}/${name} → ${target}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, []);
});
