#!/usr/bin/env node
'use strict';

/**
 * probe-broker-api.js
 *
 * Second-pass probe after probe-order-ticket.js:
 *  1. Lists ALL CDP targets so we know if a separate window holds the order form
 *  2. Walks up from [data-name="buy-order-button"] to dump the order panel's
 *     full DOM structure (outerHTML + all children with data-name + all numerics)
 *  3. Deep-probes ChartApiInstance, _exposed_chartWidgetCollection, widgetbar
 *     with prototype-chain key enumeration and placeOrder search
 *
 * Run with TradingView's order panel OPEN:
 *   node scripts/probe-broker-api.js
 */

const CDP = require('../node_modules/chrome-remote-interface');
const PORT = parseInt(process.env.CDP_PORT || '9222', 10);

const PROBE = `
(() => {
  const out = {
    orderPanelHtml:      null,
    orderPanelDataNames: [],
    orderPanelNumerics:  [],
    qtyElShadow:         null,
    unitSelectorShadow:  null,
    apiDeepScan:         {},
    placeOrderPaths:     [],
  };

  // ── 1. Walk up from buy-order-button to find the order panel container ────
  const buyBtn = document.querySelector('[data-name="buy-order-button"]');
  if (buyBtn) {
    let el = buyBtn.parentElement;
    let panelEl = null;
    for (let i = 0; i < 20 && el; i++) {
      const rect = el.getBoundingClientRect();
      // Look for a container ≥150 wide, ≥80 tall, but not the body/full page
      if (rect.width >= 150 && rect.width <= 1000 && rect.height >= 80) {
        panelEl = el;
        break;
      }
      el = el.parentElement;
    }
    if (panelEl) {
      out.orderPanelHtml = panelEl.outerHTML.slice(0, 10000);
      out.orderPanelDataNames = [...panelEl.querySelectorAll('[data-name]')].map(e => ({
        tag:       e.tagName,
        dn:        e.getAttribute('data-name'),
        text:      (e.textContent || '').trim().slice(0, 50),
        hasShadow: !!e.shadowRoot,
      }));
      out.orderPanelNumerics = [...panelEl.querySelectorAll('*')].filter(e => {
        const t = (e.textContent || '').trim();
        return /^\\d+(\\.\\d+)?$/.test(t) && e.children.length === 0;
      }).map(e => ({
        tag:  e.tagName,
        cls:  (e.className || '').slice(0, 80),
        text: (e.textContent || '').trim(),
        dn:   e.getAttribute('data-name'),
        id:   e.id || null,
        role: e.getAttribute('role'),
      })).slice(0, 40);
    }

    // Also inspect qtyEl and unit-label-selector shadow roots
    const qtyEl = document.querySelector('[data-name="qtyEl"]');
    if (qtyEl) {
      out.qtyElShadow = {
        outerHTML:  qtyEl.outerHTML.slice(0, 600),
        hasShadow:  !!qtyEl.shadowRoot,
        shadowHTML: qtyEl.shadowRoot ? qtyEl.shadowRoot.innerHTML.slice(0, 600) : null,
      };
    }
    const unitSel = document.querySelector('[data-name="unit-label-selector"]');
    if (unitSel) {
      out.unitSelectorShadow = {
        outerHTML:  unitSel.outerHTML.slice(0, 600),
        hasShadow:  !!unitSel.shadowRoot,
        shadowHTML: unitSel.shadowRoot ? unitSel.shadowRoot.innerHTML.slice(0, 600) : null,
      };
    }
  }

  // ── 2. Deep broker API scan ───────────────────────────────────────────────
  function allKeys(obj) {
    const keys = new Set();
    let cur = obj;
    let depth = 0;
    while (cur && cur !== Object.prototype && depth < 5) {
      Object.getOwnPropertyNames(cur).forEach(k => keys.add(k));
      cur = Object.getPrototypeOf(cur);
      depth++;
    }
    return [...keys];
  }

  function findPlaceOrder(obj, path, depth) {
    if (!obj || typeof obj !== 'object' || depth > 4) return;
    try {
      const keys = allKeys(obj).slice(0, 60);
      for (const k of keys) {
        try {
          const val = obj[k];
          if (typeof val === 'function' && /placeOrder|modifyOrder|createOrder/i.test(k)) {
            out.placeOrderPaths.push({ path: path + '.' + k, fn: val.toString().slice(0, 400) });
          }
          if (val && typeof val === 'object' && !Array.isArray(val) && depth < 3) {
            findPlaceOrder(val, path + '.' + k, depth + 1);
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  // --- ChartApiInstance ---
  try {
    const chai = window.ChartApiInstance;
    if (chai) {
      const keys = allKeys(chai);
      out.apiDeepScan.ChartApiInstance = { type: typeof chai, keys: keys.slice(0, 60) };
      for (const m of ['chart', 'activeChart', 'getChart', 'broker', 'getBroker', 'trading', 'getTrading', 'widget']) {
        if (typeof chai[m] === 'function') {
          try {
            const res = chai[m]();
            const rKeys = allKeys(res || {}).slice(0, 50);
            out.apiDeepScan['ChartApiInstance.' + m + '()'] = { keys: rKeys };
            findPlaceOrder(res, 'ChartApiInstance.' + m + '()', 0);
          } catch (e) {
            out.apiDeepScan['ChartApiInstance.' + m + '.error'] = e.message;
          }
        }
      }
      findPlaceOrder(chai, 'ChartApiInstance', 0);
    }
  } catch (e) { out.apiDeepScan.ChartApiInstance_error = e.message; }

  // --- _exposed_chartWidgetCollection ---
  try {
    const coll = window._exposed_chartWidgetCollection;
    if (coll) {
      const isArray = Array.isArray(coll);
      const entries = isArray ? coll : Object.values(coll);
      out.apiDeepScan._exposed_chartWidgetCollection = {
        type:    typeof coll,
        isArray,
        length:  entries.length,
      };
      for (let i = 0; i < Math.min(entries.length, 3); i++) {
        const item = entries[i];
        const keys = allKeys(item || {}).slice(0, 60);
        out.apiDeepScan['_exposed_chartWidgetCollection[' + i + ']'] = { keys };
        findPlaceOrder(item, '_exposed_chartWidgetCollection[' + i + ']', 0);
        for (const m of ['activeChart', 'chart', 'getBroker', 'broker']) {
          if (typeof item?.[m] === 'function') {
            try {
              const res = item[m]();
              const rKeys = allKeys(res || {}).slice(0, 50);
              out.apiDeepScan['_exposed_chartWidgetCollection[' + i + '].' + m + '()'] = { keys: rKeys };
              findPlaceOrder(res, '_exposed_chartWidgetCollection[' + i + '].' + m + '()', 0);
            } catch (e) {
              out.apiDeepScan['_exposed_chartWidgetCollection[' + i + '].' + m + '.error'] = e.message;
            }
          }
        }
      }
    }
  } catch (e) { out.apiDeepScan._exposed_chart_error = e.message; }

  // --- widgetbar ---
  try {
    const wb = window.widgetbar;
    if (wb) {
      const keys = allKeys(wb).slice(0, 60);
      out.apiDeepScan.widgetbar = { keys };
      findPlaceOrder(wb, 'widgetbar', 0);
    }
  } catch (e) { out.apiDeepScan.widgetbar_error = e.message; }

  // --- footerWidget ---
  try {
    const fw = window.footerWidget;
    if (fw) {
      const keys = allKeys(fw).slice(0, 60);
      out.apiDeepScan.footerWidget = { keys };
      findPlaceOrder(fw, 'footerWidget', 0);
    }
  } catch (e) { out.apiDeepScan.footerWidget_error = e.message; }

  // --- WIDGET_HOST ---
  try {
    const wh = window.WIDGET_HOST;
    if (wh) {
      out.apiDeepScan.WIDGET_HOST = { type: typeof wh, value: String(wh).slice(0, 100) };
    }
  } catch (e) {}

  return JSON.stringify(out, null, 2);
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

    // Print all targets FIRST so we can see if the order form is a separate window
    console.error('=== ALL CDP TARGETS ===');
    targets.forEach((t, i) => {
      console.error(`[${i}] type=${t.type} title=${JSON.stringify((t.title || '').slice(0, 60))} url=${(t.url || '').slice(0, 100)}`);
    });
    console.error('');

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
