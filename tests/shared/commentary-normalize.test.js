// The card contract says `objective` is a string, but the prompt describes it
// as "2-4 short bullet sentences" and a sibling field (steps_what_happened)
// genuinely IS an array. Claude Haiku reads that and returns `objective` as an
// array; Gemini happened to return a string. Nothing enforced it, so the shape
// depended on the model — and the renderer's splitBullets(objective) threw
// "text.split is not a function", which unmounted the whole panel.
//
// normalizeCard() makes the card match its declared types whatever the model did.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { normalizeCard } =
  require(path.join(__dirname, '..', '..', 'src/shared/commentary'));

test('an array objective is joined into a string', () => {
  const card = normalizeCard({ objective: ['First sentence.', 'Second sentence.'] });
  assert.strictEqual(typeof card.objective, 'string');
  // Newline-joined on purpose: the UI's splitBullets() splits on newlines, so
  // the model's bullets round-trip to exactly the bullets it intended.
  assert.strictEqual(card.objective, 'First sentence.\nSecond sentence.');
});

test('a string objective is left exactly as-is', () => {
  const card = normalizeCard({ objective: 'Already a string.' });
  assert.strictEqual(card.objective, 'Already a string.');
});

test('every declared string field is coerced, not just objective', () => {
  const card = normalizeCard({
    headline: ['a', 'b'],
    what_now: ['do this'],
    what_not: ['not that'],
    bottom_line: ['the point'],
    structure_read: ['structure'],
  });
  for (const f of ['headline', 'what_now', 'what_not', 'bottom_line', 'structure_read']) {
    assert.strictEqual(typeof card[f], 'string', `${f} should be a string`);
  }
});

test('nullable string fields keep null rather than becoming "null"', () => {
  const card = normalizeCard({ entry_was: null, next_trigger: null, key_lesson: null });
  assert.strictEqual(card.entry_was, null);
  assert.strictEqual(card.next_trigger, null);
  assert.strictEqual(card.key_lesson, null);
});

test('steps_what_happened returned as a string becomes an array', () => {
  // The mirror-image failure: the renderer maps over this one.
  const card = normalizeCard({ steps_what_happened: 'One thing.\nAnother thing.' });
  assert.deepStrictEqual(card.steps_what_happened, ['One thing.', 'Another thing.']);
});

test('an array steps_what_happened is left alone', () => {
  const card = normalizeCard({ steps_what_happened: ['a', 'b'] });
  assert.deepStrictEqual(card.steps_what_happened, ['a', 'b']);
});

test('a non-string scalar is stringified rather than crashing the renderer', () => {
  const card = normalizeCard({ objective: 42 });
  assert.strictEqual(card.objective, '42');
});

test('nested arrays of non-strings are dropped, not rendered as [object Object]', () => {
  const card = normalizeCard({ objective: ['real text', { junk: 1 }, 'more text'] });
  assert.strictEqual(card.objective, 'real text\nmore text');
});

test('normalizing a card with no recognised fields is a no-op', () => {
  const card = normalizeCard({ confidence: 0.8, trade_plan: null });
  assert.strictEqual(card.confidence, 0.8);
  assert.strictEqual(card.trade_plan, null);
});

test('a null or non-object card is passed through untouched', () => {
  assert.strictEqual(normalizeCard(null), null);
  assert.strictEqual(normalizeCard(undefined), undefined);
});

// ── TVCM-11B: presence, not just type ─────────────────────────────────────
// normalizeCard used to coerce field TYPES but never guarantee a field was
// PRESENT. The renderer maps over these fields unconditionally, so an omitted
// field threw in render and blanked the panel.

test('an omitted steps_what_happened becomes an empty array, not undefined', () => {
  const card = normalizeCard({ headline: 'x' });
  assert.ok(Array.isArray(card.steps_what_happened));
  assert.strictEqual(card.steps_what_happened.length, 0);
});

test('a non-array steps_what_happened becomes an array', () => {
  assert.deepStrictEqual(normalizeCard({ steps_what_happened: 42 }).steps_what_happened, []);
  assert.deepStrictEqual(normalizeCard({ steps_what_happened: null }).steps_what_happened, []);
});

test('a key level with no usable price is dropped rather than thrown on', () => {
  const card = normalizeCard({
    key_levels_to_watch: [
      { price: 6012.25, label: 'ORB high', action: 'watch' },
      { label: 'missing price', action: 'watch' },
      { price: 'not a number', label: 'bad', action: 'watch' },
      null,
    ],
  });
  assert.strictEqual(card.key_levels_to_watch.length, 1);
  assert.strictEqual(card.key_levels_to_watch[0].price, 6012.25);
  // Every survivor must render: price is a number and label is a string.
  for (const lvl of card.key_levels_to_watch) {
    assert.strictEqual(typeof lvl.price, 'number');
    assert.strictEqual(typeof lvl.label, 'string');
  }
});

test('a string price is coerced rather than dropped', () => {
  const card = normalizeCard({ key_levels_to_watch: [{ price: '6012.25', label: 'VWAP' }] });
  assert.strictEqual(card.key_levels_to_watch[0].price, 6012.25);
});

test('a null key_levels_to_watch stays null — the renderer guards that case', () => {
  assert.strictEqual(normalizeCard({ key_levels_to_watch: null }).key_levels_to_watch, null);
});
