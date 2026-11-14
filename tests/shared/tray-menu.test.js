'use strict';

// The tray menu's structure. Pure template, no Electron — index.ts attaches the
// click handlers by id.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const { trayMenuTemplate, menuItemIds, escapeMenuLabel } = require(path.join(__dirname, '../../src/shared/tray-menu.js'));

const labels = (items) => items.filter(i => i.label).map(i => i.label);

test('the top level offers the panel, P&L and Troubleshooting', () => {
  const t = trayMenuTemplate({ panelVisible: false, alwaysOnTop: true });
  assert.deepStrictEqual(labels(t), [
    'Show Panel', 'Refresh Now', 'Always on Top',
    'Order History & P&L', 'Troubleshooting', 'Quit',
  ]);
});

test('Order History & P&L is present and opens from the tray', () => {
  const ids = menuItemIds(trayMenuTemplate({}));
  assert.ok(ids.includes('pnlWindow'), 'the window must be reachable from the tray menu');
});

test('Troubleshooting holds the log folder and the recorder reset', () => {
  const t = trayMenuTemplate({});
  assert.ok(!labels(t).includes('Open Log Folder'), 'it must not be at the top level');
  const trouble = t.find(i => i.id === 'troubleshooting');
  assert.ok(trouble, 'a Troubleshooting item must exist');
  assert.deepStrictEqual(labels(trouble.submenu), ['Open Log Folder', 'Reset trade recorder data…']);
});

test('the reset item is worded as a dialog, not an instant action', () => {
  const reset = trayMenuTemplate({}).find(i => i.id === 'troubleshooting')
    .submenu.find(i => i.id === 'resetRecorder');
  assert.ok(reset.label.endsWith('…'), 'an ellipsis promises a confirmation step');
});

test('the journal is gone from the menu', () => {
  const ids = menuItemIds(trayMenuTemplate({}));
  assert.ok(!ids.includes('openJournal'), 'the journal has been retired');
  assert.ok(!labels(trayMenuTemplate({})).some(l => /journal/i.test(l)));
});

test('the panel item reflects whether the panel is showing', () => {
  assert.strictEqual(trayMenuTemplate({ panelVisible: true }).find(i => i.id === 'togglePanel').label, 'Hide Panel');
  assert.strictEqual(trayMenuTemplate({ panelVisible: false }).find(i => i.id === 'togglePanel').label, 'Show Panel');
});

test('Always on Top is a checkbox that reflects the window', () => {
  const on  = trayMenuTemplate({ alwaysOnTop: true }).find(i => i.id === 'alwaysOnTop');
  const off = trayMenuTemplate({ alwaysOnTop: false }).find(i => i.id === 'alwaysOnTop');
  assert.strictEqual(on.type, 'checkbox');
  assert.strictEqual(on.checked, true);
  assert.strictEqual(off.checked, false);
});

test('every item carries an id so a handler can be attached, and ids are unique', () => {
  const ids = menuItemIds(trayMenuTemplate({}));
  assert.deepStrictEqual(ids, [...new Set(ids)], 'duplicate ids would cross-wire two menu items');
  const t = trayMenuTemplate({});
  for (const item of t) {
    if (item.type === 'separator') continue;
    assert.ok(item.id, `"${item.label}" has no id`);
  }
});

test('missing state still produces a usable menu', () => {
  assert.doesNotThrow(() => trayMenuTemplate(undefined));
  assert.ok(trayMenuTemplate(undefined).length > 0);
});

test('ampersands are doubled, or Electron eats them as mnemonics', () => {
  // Seen for real: "Order History & P&L" rendered as "Order History  PL".
  assert.strictEqual(escapeMenuLabel('Order History & P&L'), 'Order History && P&&L');
  assert.strictEqual(escapeMenuLabel('Quit'), 'Quit');
  assert.strictEqual(escapeMenuLabel(undefined), '');
});

test('every label with an ampersand survives escaping intact', () => {
  const walk = (items) => items.forEach(i => {
    if (i.label) {
      const rendered = escapeMenuLabel(i.label).replace(/&&/g, '&');
      assert.strictEqual(rendered, i.label, `"${i.label}" would not render as written`);
    }
    if (i.submenu) walk(i.submenu);
  });
  walk(trayMenuTemplate({}));
});
