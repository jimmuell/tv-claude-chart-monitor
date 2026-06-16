'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ActionabilityFilter } = require('../../src/shared/filter');

// Base config with everything off — each test turns on only what it needs.
const cfg = (over = {}) => ({
  zoneProximityTicks: 4,
  perZoneCooldownSec: 0,
  globalCooldownSec: 0,
  fireOn: {
    notablePatterns: false,
    zoneInteractions: false,
    trendOrMaEvents: false,
    everyCandleIfActionable: false,
    suggestedLevels: false,
    ...(over.fireOn || {}),
  },
  ...over,
});

// Minimal ctx with sensible empty defaults.
const ctx = (over = {}) => ({
  symbol: 'MES',
  notable: false,
  classification: { tags: [] },
  zones: [],
  maEvents: [],
  nearestZone: null,
  candidateLevels: [],
  ...over,
});

test('fires on a notable pattern', () => {
  const f = new ActionabilityFilter(cfg({ fireOn: { notablePatterns: true } }));
  const r = f.evaluate(ctx({ notable: true, classification: { tags: ['hammer'] } }), 1000);
  assert.strictEqual(r.fire, true);
  assert.ok(r.reasons.some((x) => x.kind === 'pattern'));
});

test('fires on a zone interaction', () => {
  const f = new ActionabilityFilter(cfg({ fireOn: { zoneInteractions: true } }));
  const r = f.evaluate(ctx({ zones: [{ zone: { id: 'z1', label: 'L' }, interaction: 'broke_up' }] }), 1000);
  assert.strictEqual(r.fire, true);
  assert.ok(r.reasons.some((x) => x.kind === 'zone' && x.interaction === 'broke_up'));
});

test('fires on an MA event', () => {
  const f = new ActionabilityFilter(cfg({ fireOn: { trendOrMaEvents: true } }));
  const r = f.evaluate(ctx({ maEvents: [{ type: 'ma_cross_up' }] }), 1000);
  assert.strictEqual(r.fire, true);
  assert.ok(r.reasons.some((x) => x.kind === 'ma'));
});

test('everyCandleIfActionable fires on zone proximity', () => {
  const f = new ActionabilityFilter(cfg({ fireOn: { everyCandleIfActionable: true } }));
  const r = f.evaluate(ctx({ nearestZone: { zone: { id: 'z', label: 'L' }, distance: 0.25 } }), 1000);
  assert.strictEqual(r.fire, true);
  assert.ok(r.reasons.some((x) => x.kind === 'near-zone'));
});

test('does not fire when nothing is actionable', () => {
  const f = new ActionabilityFilter(cfg({ fireOn: { notablePatterns: true } }));
  assert.strictEqual(f.evaluate(ctx(), 1000).fire, false);
});

test('global cooldown suppresses a repeat fire, then clears', () => {
  const f = new ActionabilityFilter(cfg({ fireOn: { zoneInteractions: true }, globalCooldownSec: 20 }));
  const c = ctx({ zones: [{ zone: { id: 'z1', label: 'L' }, interaction: 'broke_up' }] });
  const first = f.evaluate(c, 0);
  assert.strictEqual(first.fire, true);
  f.noteFired(c, first.reasons, 0);
  const within = f.evaluate(c, 1000);            // 1s later — inside 20s window
  assert.strictEqual(within.fire, false);
  assert.strictEqual(within.suppressedBy, 'global-cooldown');
  const after = f.evaluate(c, 21000);            // 21s later — window expired
  assert.strictEqual(after.fire, true);
});

test('per-zone cooldown suppresses the same zone, then clears', () => {
  const f = new ActionabilityFilter(cfg({ fireOn: { zoneInteractions: true }, perZoneCooldownSec: 90 }));
  const c = ctx({ zones: [{ zone: { id: 'z1', label: 'L' }, interaction: 'broke_up' }] });
  const first = f.evaluate(c, 0);
  assert.strictEqual(first.fire, true);
  f.noteFired(c, first.reasons, 0);
  assert.strictEqual(f.evaluate(c, 1000).fire, false);   // within 90s → zone reason gated out
  assert.strictEqual(f.evaluate(c, 91000).fire, true);   // after 90s → fires again
});

test('suggest_level fires and bypasses the global cooldown', () => {
  const f = new ActionabilityFilter(cfg({
    fireOn: { zoneInteractions: true, suggestedLevels: true },
    globalCooldownSec: 60,
    suggestLevelMinTouches: 3,
  }));
  // First, a real event sets the global cooldown.
  const zoneCtx = ctx({ zones: [{ zone: { id: 'z1', label: 'L' }, interaction: 'broke_up' }] });
  const e = f.evaluate(zoneCtx, 0);
  f.noteFired(zoneCtx, e.reasons, 0);
  // Now a suggest-only ctx within the cooldown window still fires (info bypasses).
  const sugCtx = ctx({
    candidateLevels: [{ kind: 'support', price: 100, touchCount: 3, firstTouchTime: 1, lastTouchTime: 2, strength: 3 }],
  });
  const r = f.evaluate(sugCtx, 5000);
  assert.strictEqual(r.fire, true);
  assert.ok(r.reasons.some((x) => x.kind === 'suggest_level'));
});

test('evaluateLifecycleDirective fires and honors its own cooldown', () => {
  const f = new ActionabilityFilter(cfg({ lifecycleCooldownSec: 30 }));
  const directive = { directive: 'remove', tracked_level_id: 'tl1', price: 100, rationale_short: 'gone' };
  const first = f.evaluateLifecycleDirective('MES', directive, 0);
  assert.strictEqual(first.fire, true);
  f.noteFired({ symbol: 'MES' }, first.reasons, 0);
  const within = f.evaluateLifecycleDirective('MES', directive, 5000);
  assert.strictEqual(within.fire, false);
  assert.strictEqual(within.suppressedBy, 'lifecycle-cooldown');
});
