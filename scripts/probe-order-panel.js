#!/usr/bin/env node
/**
 * probe-order-panel.js
 *
 * Scans TradingView's DOM for order-panel elements while the AMP Live order
 * form is open and visible.  Run this to verify or update the selector
 * strategies used by src/main/order-executor.ts.
 *
 * Usage:
 *   1. Open TradingView Desktop with AMP Live connected
 *   2. Open the order/trade panel (click the "Trade" or "Trading" tab)
 *   3. node scripts/probe-order-panel.js
 */
'use strict';

const CDP = require('../node_modules/chrome-remote-interface');

const PORT = parseInt(process.env.CDP_PORT || '9222', 10);

const PROBE = `
(() => {
  try {
    const out = {};

    // ── 1. Trading panel tab buttons ────────────────────────────────────────
    const tabButtons = [...document.querySelectorAll('button, [role="tab"]')]
      .filter(el => {
        const t = (el.textContent || '').trim().toLowerCase();
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        return t === 'trading' || t === 'trade' || a === 'trading' || a === 'trade';
      })
      .map(el => ({
        tag:      el.tagName,
        text:     el.textContent?.trim().slice(0, 40),
        cls:      el.className?.slice(0, 80),
        ariaLabel: el.getAttribute('aria-label'),
        dataName: el.getAttribute('data-name'),
      }));
    out.tradingTabs = tabButtons;

    // ── 2. All inputs with relevant aria-labels / placeholders ─────────────
    const tradingInputs = [...document.querySelectorAll('input')].map(el => ({
      type:        el.type,
      value:       el.value,
      placeholder: el.placeholder,
      ariaLabel:   el.getAttribute('aria-label'),
      dataName:    el.getAttribute('data-name'),
      cls:         el.className?.slice(0, 80),
      parentText:  el.parentElement?.textContent?.trim().slice(0, 60),
      grandParentText: el.parentElement?.parentElement?.textContent?.trim().slice(0, 80),
    })).filter(inp =>
      /qty|quantity|lot|contract|stop|loss|profit|target|price|amount/i.test(
        [inp.placeholder, inp.ariaLabel, inp.dataName, inp.parentText].join(' ')
      )
    );
    out.tradingInputs = tradingInputs;

    // ── 3. All buttons that look like buy / sell / order actions ──────────
    const actionButtons = [...document.querySelectorAll('button')].filter(b => {
      const t = (b.textContent || '').trim();
      const a = b.getAttribute('aria-label') || '';
      return /^(buy|sell|place order|submit|confirm)/i.test(t) ||
             /buy|sell|order/i.test(a);
    }).map(b => ({
      text:      b.textContent?.trim().slice(0, 40),
      ariaLabel: b.getAttribute('aria-label'),
      dataName:  b.getAttribute('data-name'),
      cls:       b.className?.slice(0, 80),
      disabled:  b.disabled,
    }));
    out.actionButtons = actionButtons;

    // ── 4. SL/TP toggles ───────────────────────────────────────────────────
    const bracketToggles = [...document.querySelectorAll('button, [role="checkbox"], [role="switch"]')]
      .filter(el => {
        const t = (el.textContent || '').toLowerCase();
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        return /stop.loss|take.profit|sl.tp|bracket|tp.sl/i.test(t + ' ' + a);
      })
      .map(el => ({
        tag:        el.tagName,
        role:       el.getAttribute('role'),
        text:       el.textContent?.trim().slice(0, 40),
        ariaLabel:  el.getAttribute('aria-label'),
        ariaChecked: el.getAttribute('aria-checked'),
        ariaPressed: el.getAttribute('aria-pressed'),
        cls:        el.className?.slice(0, 80),
      }));
    out.bracketToggles = bracketToggles;

    // ── 5. Any elements with data-name that look order-related ─────────────
    const dataNameEls = [...document.querySelectorAll('[data-name]')]
      .filter(el => /qty|quantity|order|stop|profit|target|trade|buy|sell/i.test(el.getAttribute('data-name') || ''))
      .map(el => ({
        tag:      el.tagName,
        dataName: el.getAttribute('data-name'),
        cls:      el.className?.slice(0, 60),
        text:     el.textContent?.trim().slice(0, 40),
      }));
    out.dataNameEls = dataNameEls;

    // ── 6. Scan for any visible element whose label text has SL/TP keywords ─
    const labelHits = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent?.trim() || '';
      if (/^(qty|quantity|stop loss|take profit|s\/l|t\/p|target|contracts?)$/i.test(t)) {
        const parent = node.parentElement;
        labelHits.push({
          text:   t,
          tag:    parent?.tagName,
          cls:    parent?.className?.slice(0, 60),
          sibling: parent?.nextElementSibling?.tagName,
          siblingCls: parent?.nextElementSibling?.className?.slice(0, 60),
        });
      }
    }
    out.labelHits = labelHits.slice(0, 20);

    return JSON.stringify(out, null, 2);
  } catch (e) {
    return JSON.stringify({ fatalError: String(e), stack: e.stack });
  }
})()
`;

async function run() {
  let client;
  try {
    const targets = await CDP.List({ port: PORT });
    if (!targets.length) {
      console.error('No CDP targets found. Is TradingView running with --remote-debugging-port=' + PORT + '?');
      process.exit(1);
    }

    const target = targets.find(t => t.type === 'page' && !t.url.startsWith('devtools://'))
                || targets[0];
    console.log('Probing target:', target.url?.slice(0, 80), '\n');

    client = await CDP({ port: PORT, target: target.id });
    const { Runtime } = client;
    await Runtime.enable();

    const result = await Runtime.evaluate({
      expression:    PROBE,
      returnByValue: true,
      awaitPromise:  false,
    });

    if (result.exceptionDetails) {
      console.error('CDP evaluation threw:', result.exceptionDetails);
      process.exit(1);
    }

    const raw = result.result?.value;
    if (typeof raw !== 'string') {
      console.log('Raw result:', JSON.stringify(result.result, null, 2));
    } else {
      try { console.log(JSON.stringify(JSON.parse(raw), null, 2)); }
      catch { console.log(raw); }
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

run();
