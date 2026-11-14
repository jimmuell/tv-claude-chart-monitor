'use strict';

/**
 * The tray menu's shape, with no Electron in it, so the structure can be tested.
 * index.ts turns each `id` into a click handler; nothing here knows what the items do.
 */

/**
 * The menu as a list of items. Diagnostics live under Troubleshooting so the top
 * level stays about the two things Jim opens daily: the panel and his P&L.
 */
function trayMenuTemplate(state) {
  const s = state || {};
  return [
    { id: 'togglePanel', label: s.panelVisible ? 'Hide Panel' : 'Show Panel' },
    { id: 'refreshNow',  label: 'Refresh Now' },
    { type: 'separator' },
    { id: 'alwaysOnTop', label: 'Always on Top', type: 'checkbox', checked: !!s.alwaysOnTop },
    { type: 'separator' },
    { id: 'pnlWindow',   label: 'Order History & P&L' },
    { id: 'openJournal', label: 'Open Journal' },
    { type: 'separator' },
    {
      id: 'troubleshooting',
      label: 'Troubleshooting',
      submenu: [
        { id: 'openLogFolder', label: 'Open Log Folder' },
      ],
    },
    { type: 'separator' },
    { id: 'quit', label: 'Quit' },
  ];
}

/** Every item id in the template, including nested ones, for wiring and for tests. */
function menuItemIds(template) {
  const out = [];
  for (const item of template) {
    if (item.id) out.push(item.id);
    if (item.submenu) out.push(...menuItemIds(item.submenu));
  }
  return out;
}

module.exports = { trayMenuTemplate, menuItemIds };
