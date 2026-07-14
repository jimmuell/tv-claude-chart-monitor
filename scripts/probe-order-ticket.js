#!/usr/bin/env node
'use strict';

/**
 * probe-order-ticket.js
 *
 * Discovers the TradingView trading surface for bracket order placement.
 * Run with the order panel OPEN in TradingView Desktop.
 *
 * Usage:
 *   node scripts/probe-order-ticket.js
 *
 * Prerequisites:
 *   TradingView Desktop launched with: --remote-debugging-port=9222
 */

const CDP = require('../node_modules/chrome-remote-interface');

const PORT = parseInt(process.env.CDP_PORT || '9222', 10);

const PROBE = `
(() => {
  try {
    const out = {
      windowTradingKeys:  [],
      apiProbe:           {},
      placeOrderPaths:    [],
      brokerDetails:      null,
      inputs:             [],
      iframes:            [],
      slTpElements:       [],
    };

    // ── 1a. Broker / trading API scan ────────────────────────────────────────

    // Keys on window that look trading-related
    out.windowTradingKeys = Object.keys(window).filter(k =>
      /trade|broker|order|widget|chart/i.test(k)
    ).slice(0, 40);

    function probeObj(obj, path, depth) {
      if (!obj || typeof obj !== 'object' || depth > 2) return;
      try {
        // Check for placeOrder at this level
        if (typeof obj.placeOrder === 'function') {
          out.placeOrderPaths.push(path);
        }
        // Check for modifyOrder / positions / brackets
        const tradingMethods = ['placeOrder','modifyOrder','positions','brackets',
                                'closePosition','modifyBrackets'];
        const found = tradingMethods.filter(m => typeof obj[m] === 'function');
        if (found.length > 0) {
          out.apiProbe[path + '.[methods]'] = found;
        }

        // Try .activeChart() → .getBroker()
        if (typeof obj.activeChart === 'function') {
          try {
            const chart = obj.activeChart();
            const chartKeys = Object.keys(chart || {}).filter(k =>
              /broker|order|trade|symbol|position/i.test(k)
            );
            out.apiProbe[path + '.activeChart.relevantKeys'] = chartKeys;

            if (typeof chart.getBroker === 'function') {
              try {
                const broker = chart.getBroker();
                const bKeys  = Object.keys(broker || {});
                out.apiProbe[path + '.broker.allKeys'] = bKeys.slice(0, 50);
                if (typeof broker.placeOrder === 'function') {
                  out.placeOrderPaths.push(path + '.activeChart().getBroker()');
                  // Capture placeOrder signature
                  out.brokerDetails = {
                    path: path + '.activeChart().getBroker()',
                    keys: bKeys,
                    placeOrderStr: broker.placeOrder.toString().slice(0, 300),
                  };
                }
              } catch (e) { out.apiProbe[path + '.broker.error'] = e.message; }
            }
          } catch (e) { out.apiProbe[path + '.activeChart.error'] = e.message; }
        }

        // Recurse one more level for nested objects
        if (depth < 1) {
          const ownKeys = Object.getOwnPropertyNames(obj).slice(0, 25);
          for (const k of ownKeys) {
            try {
              const child = obj[k];
              if (child && typeof child === 'object' && !Array.isArray(child)) {
                probeObj(child, path + '.' + k, depth + 1);
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }

    // Probe every trading-adjacent window key
    for (const k of out.windowTradingKeys) {
      try { probeObj(window[k], 'window.' + k, 0); } catch (e) {}
    }
    // Also try the well-known TradingViewApi directly
    if (window.TradingViewApi) {
      probeObj(window.TradingViewApi, 'window.TradingViewApi', 0);
    }

    // ── 1b. DOM dump ──────────────────────────────────────────────────────────

    // All <input> elements (standard inputs only — not shadow DOM)
    out.inputs = [...document.querySelectorAll('input')].map(el => ({
      type:        el.type,
      value:       el.value,
      placeholder: el.placeholder,
      aria:        el.getAttribute('aria-label'),
      name:        el.name,
      dn:          el.getAttribute('data-name'),
      parentText:  (el.parentElement?.textContent || '').trim().slice(0, 80),
    }));

    // All iframes — check same-origin accessibility
    out.iframes = [...document.querySelectorAll('iframe')].map(f => {
      let accessible = false;
      let bodyText   = null;
      let hasTP      = false;
      try {
        const d = f.contentDocument;
        accessible = !!d;
        bodyText   = (d?.body?.textContent || '').slice(0, 200);
        hasTP      = bodyText.toLowerCase().includes('take profit');
      } catch (e) {}
      return {
        src:        (f.src || '').slice(0, 120),
        id:         f.id,
        name:       f.name,
        accessible,
        hasTP,
        bodyText,
      };
    });

    // Elements containing SL/TP-related text (small, specific elements only)
    const keywords = ['stop loss','take profit','stop-loss','take-profit'];
    out.slTpElements = [...document.querySelectorAll('*')].filter(el => {
      const t = (el.textContent || '').toLowerCase();
      return keywords.some(k => t.includes(k)) && el.children.length < 5 && t.length < 120;
    }).map(el => ({
      tag:  el.tagName,
      cls:  (el.className || '').slice(0, 80),
      text: (el.textContent || '').trim().slice(0, 100),
      dn:   el.getAttribute('data-name'),
      id:   el.id,
    })).slice(0, 25);

    // Also scan data-name elements for order-related names
    out.orderDataNames = [...document.querySelectorAll('[data-name]')].map(el => ({
      tag: el.tagName,
      dn:  el.getAttribute('data-name'),
      text: (el.textContent || '').trim().slice(0, 40),
    })).filter(e => /order|buy|sell|qty|stop|profit|bracket|unit/i.test(e.dn || ''));

    return JSON.stringify(out, null, 2);
  } catch (e) {
    return JSON.stringify({ fatalError: String(e), stack: e.stack?.slice(0, 500) });
  }
})()
`;

async function run() {
  let client;
  try {
    const targets = await CDP.List({ port: PORT });
    if (!targets.length) {
      console.error('No CDP targets. Is TradingView running with --remote-debugging-port=' + PORT + '?');
      process.exit(1);
    }
    const target = targets.find(t => t.type === 'page' && t.url.includes('tradingview'))
                || targets.find(t => t.type === 'page' && !t.url.startsWith('devtools://'))
                || targets[0];
    console.error('Probing:', target.url?.slice(0, 80), '\n');

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
    try {
      console.log(JSON.stringify(JSON.parse(raw), null, 2));
    } catch {
      console.log(raw);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

run();
