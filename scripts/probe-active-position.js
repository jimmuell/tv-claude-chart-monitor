#!/usr/bin/env node
'use strict';

/**
 * probe-active-position.js
 *
 * Run this with an OPEN POSITION in TradingView and the Order panel CLOSED.
 * Then run it again with the Order panel OPEN to compare.
 *
 * Answers:
 *  1. What is the "Trade" button's parent structure (how to click it reliably)?
 *  2. When the panel is open, what inputs exist in the bracketControlGroup?
 *  3. What buttons exist in the panel (find the panel-level buy button)?
 *  4. Are there any position-management elements with TP/SL controls?
 *
 * Usage:
 *   node scripts/probe-active-position.js         # panel CLOSED
 *   node scripts/probe-active-position.js         # panel OPEN (run again after opening)
 */

const CDP = require('../node_modules/chrome-remote-interface');
const PORT = parseInt(process.env.CDP_PORT || '9222', 10);

const PROBE = `
(() => {
  const out = {};

  // ── 1. "Trade" button structure ─────────────────────────────────────────────
  // Find every element whose direct text is exactly "Trade" or "Trading"
  out.tradeButtonCandidates = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = (node.textContent || '').trim();
    if (t === 'Trade' || t === 'Trading') {
      const parent = node.parentElement;
      if (!parent) continue;
      const rect = parent.getBoundingClientRect();
      // Walk up 4 levels looking for a clickable ancestor
      const ancestors = [];
      let el = parent;
      for (let i = 0; i < 5; i++) {
        if (!el) break;
        const r = el.getBoundingClientRect();
        ancestors.push({
          tag:  el.tagName,
          cls:  (el.className || '').slice(0, 80),
          dn:   el.getAttribute('data-name'),
          role: el.getAttribute('role'),
          w:    Math.round(r.width),
          h:    Math.round(r.height),
        });
        el = el.parentElement;
      }
      out.tradeButtonCandidates.push({ textNode: t, ancestors });
    }
  }

  // ── 2. All data-name elements with buy/sell ──────────────────────────────────
  out.buySellelements = [...document.querySelectorAll('[data-name]')]
    .filter(el => /buy|sell/i.test(el.getAttribute('data-name') || ''))
    .map(el => {
      const rect = el.getBoundingClientRect();
      return {
        tag:     el.tagName,
        dn:      el.getAttribute('data-name'),
        txt:     (el.textContent || '').trim().slice(0, 50),
        cls:     (el.className || '').slice(0, 80),
        w:       Math.round(rect.width),
        h:       Math.round(rect.height),
        x:       Math.round(rect.x),
        y:       Math.round(rect.y),
        visible: rect.width > 0 && rect.height > 0,
      };
    });

  // ── 3. Bracket / order panel inputs ─────────────────────────────────────────
  const bg = document.querySelector('[class*="bracketControlGroup"]');
  if (bg) {
    const checkboxes = [...bg.querySelectorAll('input[type="checkbox"]')].map((cb, i) => ({
      index:      i,
      checked:    cb.checked,
      name:       cb.name,
      ariaLabel:  cb.getAttribute('aria-label'),
      cls:        cb.className,
    }));
    const textInputs = [...bg.querySelectorAll('input[type="text"], input[type="number"]')].map((inp, i) => ({
      index:       i,
      value:       inp.value,
      type:        inp.type,
      ariaLabel:   inp.getAttribute('aria-label'),
      placeholder: inp.placeholder,
      cls:         inp.className,
    }));
    out.bracketGroup = { found: true, checkboxes, textInputs, outerHTML: bg.outerHTML.slice(0, 3000) };
  } else {
    out.bracketGroup = { found: false };
  }

  // ── 4. All visible buttons (large scan to find the panel buy button) ─────────
  out.allVisibleButtons = [...document.querySelectorAll('button, [role="button"], [data-name*="buy"], [data-name*="sell"]')]
    .filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .map(el => {
      const r = el.getBoundingClientRect();
      return {
        tag:     el.tagName,
        txt:     (el.textContent || '').trim().slice(0, 50),
        dn:      el.getAttribute('data-name'),
        role:    el.getAttribute('role'),
        cls:     (el.className || '').slice(0, 80),
        w:       Math.round(r.width),
        h:       Math.round(r.height),
        x:       Math.round(r.x),
        y:       Math.round(r.y),
      };
    })
    .filter(el => el.txt.length > 0 || el.dn)
    .slice(0, 40);

  // ── 5. Position management widget on chart (post-fill) ──────────────────────
  // Look for elements near/below the chart that have position-related content
  const positionEls = [...document.querySelectorAll('*')]
    .filter(el => {
      const cls = (el.className || '');
      const dn  = (el.getAttribute('data-name') || '');
      const txt = (el.textContent || '').trim();
      return /position|bracket|stopLoss|takeProfit|exitPoint/i.test(cls + dn) ||
             /add.stop|add.target|close.position/i.test(txt);
    })
    .map(el => {
      const r = el.getBoundingClientRect();
      return {
        tag:     el.tagName,
        cls:     (el.className || '').slice(0, 100),
        dn:      el.getAttribute('data-name'),
        txt:     (el.textContent || '').trim().slice(0, 80),
        w:       Math.round(r.width),
        h:       Math.round(r.height),
        visible: r.width > 0 && r.height > 0,
      };
    })
    .filter(el => el.visible)
    .slice(0, 20);
  out.positionElements = positionEls;

  // ── 6. Order panel container (when open) ────────────────────────────────────
  const orderPanel = document.querySelector('[data-name="order-panel"]');
  if (orderPanel) {
    const inputs = [...orderPanel.querySelectorAll('input, button, [role="button"]')].map(el => ({
      tag:       el.tagName,
      type:      el.type,
      txt:       (el.textContent || '').trim().slice(0, 40),
      dn:        el.getAttribute('data-name'),
      ariaLabel: el.getAttribute('aria-label'),
      cls:       (el.className || '').slice(0, 60),
      value:     el.value,
    }));
    out.orderPanelInputs = inputs;
    out.orderPanelHTML   = orderPanel.outerHTML.slice(0, 5000);
  } else {
    out.orderPanelInputs = null;
    out.orderPanelHTML   = null;
  }

  return JSON.stringify(out, null, 2);
})()
`;

async function run() {
  let client;
  try {
    const targets = await CDP.List({ port: PORT });
    if (!targets.length) {
      console.error('No CDP targets. Is TradingView running with --remote-debugging-port=9222?');
      process.exit(1);
    }
    const target = targets.find(t => t.type === 'page' && !t.url.startsWith('devtools://')) || targets[0];
    console.error('Probing:', target.url?.slice(0, 80));

    client = await CDP({ port: PORT, target: target.id });
    await client.Runtime.enable();

    const result = await client.Runtime.evaluate({
      expression:    PROBE,
      returnByValue: true,
      awaitPromise:  false,
    });

    if (result.exceptionDetails) {
      console.error('CDP threw:', JSON.stringify(result.exceptionDetails, null, 2));
      process.exit(1);
    }

    const raw = result.result?.value;
    try { console.log(JSON.stringify(JSON.parse(raw), null, 2)); }
    catch { console.log(raw); }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

run();
