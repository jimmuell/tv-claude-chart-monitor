#!/usr/bin/env node
'use strict';

/**
 * probe-broker-api.js
 *
 * Task 3 probe: Does getBroker() expose position side/qty/entry and fill
 * history WITHOUT requiring the Positions/Order-History Ka-Table to be active?
 *
 * Run with TradingView open, an active position (or one just closed today),
 * and the Balances tab active (the failing case for pnl-reader):
 *
 *   node scripts/probe-broker-api.js
 *
 * Questions answered:
 *   Q1: Does window._exposed_chartWidgetCollection exist?
 *   Q2: Does getBroker() expose position side/qty/entry?
 *   Q3: Does getBroker() expose fill history with timestamps?
 *   Q4: Does all of the above work when the Balances tab is active?
 *   Q5: Does it behave differently on paper vs AMP Live?
 */

const CDP = require('../node_modules/chrome-remote-interface');
const PORT = parseInt(process.env.CDP_PORT || '9222', 10);

const PROBE = `
(() => {
  const out = {
    collectionExists:   false,
    collectionType:     null,
    collectionLength:   0,
    widgets:            [],
    activeTabLabel:     null,
    errors:             [],
  };

  // ── Helper: enumerate all keys up the prototype chain ─────────────────────
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

  // ── Helper: safely call a method and return shape of result ───────────────
  function tryCall(obj, method, label) {
    try {
      if (typeof obj[method] !== 'function') return { exists: false };
      const result = obj[method]();
      if (result && typeof result.then === 'function') {
        // Promise — can't await in a synchronous eval; note it
        return { exists: true, isPromise: true };
      }
      if (result === null || result === undefined) {
        return { exists: true, value: null };
      }
      if (Array.isArray(result)) {
        return {
          exists:  true,
          isArray: true,
          length:  result.length,
          sample:  result.slice(0, 3).map(item => {
            if (!item || typeof item !== 'object') return item;
            const k = allKeys(item).slice(0, 40);
            const preview = {};
            for (const key of k) {
              try {
                const v = item[key];
                if (v !== null && typeof v !== 'function' && typeof v !== 'object') {
                  preview[key] = v;
                } else if (v === null) {
                  preview[key] = null;
                }
              } catch (e) {}
            }
            return preview;
          }),
        };
      }
      const keys = allKeys(result).slice(0, 60);
      const preview = {};
      for (const key of keys.slice(0, 30)) {
        try {
          const v = result[key];
          if (v !== null && typeof v !== 'function' && typeof v !== 'object') {
            preview[key] = v;
          } else if (v === null) {
            preview[key] = null;
          } else if (typeof v === 'function') {
            preview[key] = '[function]';
          }
        } catch (e) {}
      }
      return { exists: true, keys, preview };
    } catch (e) {
      return { exists: true, error: e.message };
    }
  }

  // ── Helper: look for position-relevant methods on broker object ────────────
  function probeBroker(broker, widgetIdx) {
    if (!broker) return { null: true };
    const result = { allKeys: allKeys(broker).slice(0, 80) };

    // Likely method names for positions, fills, orders
    const positionMethods  = ['positions', 'openPositions', 'getPositions', 'currentAccount', 'accountSummary'];
    const fillMethods      = ['executions', 'fills', 'trades', 'ordersHistory', 'getExecutions', 'orderHistory'];
    const accountMethods   = ['accountInfo', 'accounts', 'getAccount', 'currentAccount'];

    result.positionMethods = {};
    for (const m of positionMethods) {
      result.positionMethods[m] = tryCall(broker, m, 'broker.' + m);
    }

    result.fillMethods = {};
    for (const m of fillMethods) {
      result.fillMethods[m] = tryCall(broker, m, 'broker.' + m);
    }

    result.accountMethods = {};
    for (const m of accountMethods) {
      result.accountMethods[m] = tryCall(broker, m, 'broker.' + m);
    }

    // Check properties directly on the broker for any side/qty/price data
    const interestingProps = ['position', 'side', 'qty', 'quantity', 'entryPrice',
                              'unrealizedPnl', 'realizedPnl', 'account', 'accountId'];
    result.directProps = {};
    for (const p of interestingProps) {
      try {
        if (p in broker) {
          const v = broker[p];
          result.directProps[p] = typeof v === 'function' ? '[function]' : v;
        }
      } catch (e) {}
    }

    return result;
  }

  // ── Detect which bottom-panel tab is active ────────────────────────────────
  try {
    // TradingView bottom panel tab buttons
    const tabBtns = document.querySelectorAll('[data-name="bottom-tab"]');
    if (tabBtns.length === 0) {
      // Alternate selector
      const activeTabs = document.querySelectorAll('.tabs-hWoJB button[class*="active"], .footer-tab[class*="active"]');
      out.activeTabLabel = activeTabs.length > 0
        ? (activeTabs[0].textContent || '').trim().slice(0, 40)
        : 'unknown (no tab selectors matched)';
    } else {
      for (const btn of tabBtns) {
        const cls = btn.className || '';
        if (/active|selected/i.test(cls)) {
          out.activeTabLabel = (btn.textContent || '').trim().slice(0, 40);
          break;
        }
      }
    }
    // Fallback: look for any tab-looking element that appears selected
    if (!out.activeTabLabel) {
      const anyActive = document.querySelector('[class*="tab"][class*="active"], [role="tab"][aria-selected="true"]');
      out.activeTabLabel = anyActive ? (anyActive.textContent || '').trim().slice(0, 40) : 'unknown';
    }
  } catch (e) {
    out.errors.push('tab-detect: ' + e.message);
  }

  // ── Q1: Does _exposed_chartWidgetCollection exist? ─────────────────────────
  try {
    const coll = window._exposed_chartWidgetCollection;
    if (coll == null) {
      out.collectionExists = false;
    } else {
      out.collectionExists = true;
      out.collectionType   = Array.isArray(coll) ? 'array' : typeof coll;
      const entries = Array.isArray(coll) ? coll : Object.values(coll);
      out.collectionLength = entries.length;

      // ── Q2/Q3/Q4: Probe each widget's getBroker() ─────────────────────────
      // Scan ALL entries — find any that have getBroker or broker-like methods.
      // The collection mixes reactive primitives with real widget objects.
      const brokerEntries = [];
      const scanMethods   = ['getBroker', 'broker', 'trading', 'getTrading', 'brokerApi',
                             'activeChart', 'getActiveChart', 'chart', 'getChart'];

      for (let i = 0; i < entries.length; i++) {
        const item = entries[i];
        if (!item || typeof item !== 'object') continue;
        const keys = allKeys(item);
        // Only catalogue entries that look like real widget objects
        const interesting = scanMethods.filter(m => keys.includes(m));
        if (interesting.length === 0) continue;

        const info = {
          index:          i,
          matchedMethods: interesting,
          widgetKeys:     keys.slice(0, 60),
          getBroker:      null,
          brokerProbe:    null,
        };

        if (typeof item.getBroker === 'function') {
          try {
            const broker = item.getBroker();
            info.getBroker = broker != null ? 'returned object' : 'returned null';
            if (broker) info.brokerProbe = probeBroker(broker, i);
          } catch (e) {
            info.getBroker = 'error: ' + e.message;
          }
        } else {
          info.getBroker = 'method not present — trying alternates';
          for (const alt of ['broker', 'trading', 'getTrading', 'brokerApi']) {
            if (typeof item[alt] === 'function') {
              try {
                const broker = item[alt]();
                info['alt_' + alt] = broker != null ? 'returned object' : 'returned null';
                if (broker) info['brokerProbe_' + alt] = probeBroker(broker, i);
              } catch (e) {
                info['alt_' + alt + '_error'] = e.message;
              }
            } else if (item[alt] != null && typeof item[alt] !== 'function') {
              info['prop_' + alt] = typeof item[alt];
            }
          }
        }

        brokerEntries.push(info);
        // Cap at 10 widget-like entries to keep output manageable
        if (brokerEntries.length >= 10) break;
      }
      out.widgets = brokerEntries;
      out.totalScanned = entries.length;
      out.widgetLikeCount = brokerEntries.length;
    }
  } catch (e) {
    out.errors.push('collection-probe: ' + e.message);
  }

  // ── Q5: Deep dive into TradingViewApi internals ───────────────────────────
  out.tvApiDeep = {};
  try {
    const api = window.TradingViewApi;
    if (!api) { out.tvApiDeep.missing = true; }
    else {
      // _activeChartWidgetWV — watched value holding the active chart widget
      try {
        const wv = api._activeChartWidgetWV;
        if (wv != null) {
          const wvKeys = allKeys(wv).slice(0, 40);
          out.tvApiDeep._activeChartWidgetWV = { type: typeof wv, keys: wvKeys };
          // Watched values expose .value() or ._value
          let widget = null;
          if (typeof wv.value === 'function') { try { widget = wv.value(); } catch (e) {} }
          else if (wv._value !== undefined)   { widget = wv._value; }
          else if (wv.getValue !== undefined)  { try { widget = wv.getValue(); } catch (e) {} }

          if (widget) {
            const wKeys = allKeys(widget).slice(0, 80);
            out.tvApiDeep._activeChartWidget = {
              type: typeof widget,
              keys: wKeys,
              hasBroker: wKeys.some(k => /broker|position|fill|execution/i.test(k)),
            };
            out.tvApiDeep._activeChartWidget.brokerProbe = probeBroker(widget, -10);
            // Walk broker-sounding keys at depth 1
            for (const k of wKeys) {
              if (!/broker|position|fill|execution|trading/i.test(k)) continue;
              try {
                const v = widget[k];
                if (v == null) continue;
                if (typeof v === 'function') {
                  const res = v.call(widget);
                  out.tvApiDeep['_activeChartWidget.' + k + '()'] = probeBroker(res, -11);
                } else if (typeof v === 'object') {
                  out.tvApiDeep['_activeChartWidget.' + k] = { keys: allKeys(v).slice(0, 40) };
                  out.tvApiDeep['_activeChartWidget.' + k + '_probe'] = probeBroker(v, -12);
                }
              } catch (e) {
                out.tvApiDeep['_activeChartWidget.' + k + '_error'] = e.message;
              }
            }
          } else {
            out.tvApiDeep._activeChartWidget = null;
          }
        }
      } catch (e) { out.tvApiDeep._activeChartWidgetWV_error = e.message; }

      // _widgebarApi (typo in TV source — widgebar not widgetbar)
      try {
        const wa = api._widgebarApi;
        if (wa != null) {
          const waKeys = allKeys(wa).slice(0, 60);
          out.tvApiDeep._widgebarApi = { type: typeof wa, keys: waKeys };
          for (const k of waKeys) {
            if (!/broker|position|fill|execution|trading/i.test(k)) continue;
            try {
              const v = wa[k];
              if (typeof v === 'function') {
                const res = v.call(wa);
                out.tvApiDeep['_widgebarApi.' + k + '()'] = probeBroker(res, -20);
              } else {
                out.tvApiDeep['_widgebarApi.' + k] = { keys: allKeys(v || {}).slice(0, 40) };
              }
            } catch (e) { out.tvApiDeep['_widgebarApi.' + k + '_error'] = e.message; }
          }
        }
      } catch (e) { out.tvApiDeep._widgebarApi_error = e.message; }

      // _chartWidgets (different from _chartWidgetCollection?)
      try {
        const cw = api._chartWidgets;
        if (cw != null) {
          const isArr = Array.isArray(cw);
          const entries = isArr ? cw : Object.values(cw);
          out.tvApiDeep._chartWidgets = { type: typeof cw, isArray: isArr, length: entries.length };
          for (let i = 0; i < Math.min(entries.length, 3); i++) {
            const item = entries[i];
            if (!item) continue;
            const keys = allKeys(item).slice(0, 60);
            out.tvApiDeep['_chartWidgets[' + i + ']'] = { keys };
            out.tvApiDeep['_chartWidgets[' + i + ']_brokerProbe'] = probeBroker(item, -30 - i);
            if (typeof item.getBroker === 'function') {
              try {
                const b = item.getBroker();
                out.tvApiDeep['_chartWidgets[' + i + '].getBroker()'] = probeBroker(b, -40 - i);
              } catch (e) { out.tvApiDeep['_chartWidgets[' + i + '].getBroker_error'] = e.message; }
            }
          }
        }
      } catch (e) { out.tvApiDeep._chartWidgets_error = e.message; }
    }
  } catch (e) { out.tvApiDeep.error = e.message; }

  // ── ChartApiInstance.setBroker — can we read the registered broker back? ──
  try {
    const chai = window.ChartApiInstance;
    out.chaiDeep = {};
    if (chai) {
      // _brokerId tells us which broker is registered
      out.chaiDeep._brokerId = chai._brokerId ?? null;
      // Look for any property that holds broker state
      const brokerKeys = allKeys(chai).filter(k => /broker|session|trading/i.test(k));
      out.chaiDeep.brokerRelatedKeys = brokerKeys;
      for (const k of brokerKeys) {
        try {
          const v = chai[k];
          if (v == null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') {
            out.chaiDeep[k] = v;
          } else if (typeof v === 'function') {
            // Don't call arbitrary functions on the live data socket
            out.chaiDeep[k] = '[function]';
          } else if (typeof v === 'object') {
            out.chaiDeep[k + '_keys'] = allKeys(v).slice(0, 40);
            out.chaiDeep[k + '_probe'] = probeBroker(v, -50);
          }
        } catch (e) {}
      }
    }
  } catch (e) { out.chaiDeep = { error: e.message }; }

  // ── Sweep known globals for broker/position access ─────────────────────────
  const globalCandidates = ['tvWidget', '_tvWidget', 'tvWidgets', 'chartWidget',
                             'widgetbar', 'footerWidget', 'brokerApi', 'brokerConnection',
                             'TradingPlatformAdapter'];
  out.globalSweep = {};
  for (const name of globalCandidates) {
    try {
      const g = window[name];
      if (g == null) { out.globalSweep[name] = null; continue; }
      const keys = allKeys(g).slice(0, 60);
      const hasBroker = keys.some(k => /broker|position|fill|execution|order/i.test(k));
      out.globalSweep[name] = { type: typeof g, keyCount: keys.length, hasBrokerRelated: hasBroker, keys };
      if (typeof g.getBroker === 'function') {
        try {
          const b = g.getBroker();
          out.globalSweep[name].getBrokerResult = b != null ? 'object' : 'null';
          if (b) out.globalSweep[name].brokerProbe = probeBroker(b, -1);
        } catch (e) {
          out.globalSweep[name].getBrokerError = e.message;
        }
      }
    } catch (e) {
      out.globalSweep[name] = { error: e.message };
    }
  }

  return JSON.stringify(out, null, 2);
})()
`;

async function run() {
  let client;
  try {
    const targets = await CDP.List({ port: PORT });
    if (!targets.length) {
      console.error('No CDP targets. Start TradingView with --remote-debugging-port=' + PORT);
      process.exit(1);
    }

    console.error('=== CDP TARGETS ===');
    targets.forEach((t, i) =>
      console.error(`[${i}] type=${t.type} title=${JSON.stringify((t.title || '').slice(0, 60))} url=${(t.url || '').slice(0, 80)}`)
    );
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
      console.error('CDP exception:', JSON.stringify(result.exceptionDetails, null, 2));
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
