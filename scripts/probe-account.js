#!/usr/bin/env node
'use strict';

const CDP = require('../node_modules/chrome-remote-interface');

const PORT = parseInt(process.env.CDP_PORT || '9222', 10);

const PROBE = `
(() => {
  try {
    const findings = {};

    // 1. TradingViewApi — trading/account/broker keys
    const api = window.TradingViewApi;
    findings.tvApiExists = !!api;
    findings.tvApiTradingKeys = api ? Object.keys(api).filter(k =>
      /trading|broker|account|position|order|balance|paper/i.test(k)
    ) : [];

    // 2. Active chart — trading-adjacent methods
    const chart = api && typeof api.activeChart === 'function' ? api.activeChart() : null;
    findings.chartExists = !!chart;
    if (chart) {
      findings.chartTradingKeys = Object.keys(chart).filter(k =>
        /trading|broker|account|position|order|balance/i.test(k)
      );
      findings.chartHasBroker = typeof chart.getBroker === 'function';
      if (typeof chart.getBroker === 'function') {
        try {
          const b = chart.getBroker();
          findings.brokerType = b ? (b.constructor?.name || typeof b) : null;
          findings.brokerKeys = b ? Object.keys(b).filter(k =>
            /account|balance|equity|pnl|position|order|cash/i.test(k)
          ) : [];
        } catch (e) { findings.brokerError = String(e); }
      }
    }

    // 3. Window-level globals that sound trading-related
    findings.windowTradingGlobals = Object.keys(window).filter(k =>
      /^(tv|trading|broker|account|paper|order|position|balance)/i.test(k)
    ).slice(0, 30);

    // 4. DOM: all unique class names containing account/balance/equity/pnl keywords
    const classHits = new Set();
    document.querySelectorAll('*').forEach(el => {
      const cls = typeof el.className === 'string' ? el.className : '';
      if (/account|balance|equity|pnl|margin|availab/i.test(cls)) {
        cls.trim().split(/\s+/).forEach(c => {
          if (/account|balance|equity|pnl|margin|availab/i.test(c)) classHits.add(c);
        });
      }
    });
    findings.suspectClasses = [...classHits].slice(0, 30);

    // 5. DOM: find any visible text rows that contain numeric values next to
    //    known account labels — grab up to 10
    const labelPats = /account balance|equity|realized|unrealized|p&l|pnl|margin|available/i;
    const rows = [];
    document.querySelectorAll('div, tr, li').forEach(el => {
      if (el.children.length > 0 && el.children.length <= 6) {
        const text = el.textContent?.trim() || '';
        if (labelPats.test(text) && text.length < 200) {
          rows.push({ tag: el.tagName, cls: el.className?.slice(0, 80), text: text.slice(0, 120) });
        }
      }
    });
    findings.accountRows = rows.slice(0, 12);

    // 6. Any iframe that might host the trading panel
    const iframes = [...document.querySelectorAll('iframe')].map(f => ({
      src: f.src?.slice(0, 80),
      id:  f.id,
      cls: f.className?.slice(0, 60),
    }));
    findings.iframes = iframes.slice(0, 5);

    return JSON.stringify(findings, null, 2);
  } catch (e) {
    return JSON.stringify({ fatalError: String(e), stack: e.stack });
  }
})()
`;

async function run() {
  let client;
  try {
    // Get the list of pages from the CDP target
    const targets = await CDP.List({ port: PORT });
    if (!targets.length) {
      console.error('No CDP targets found. Is TradingView running with --remote-debugging-port=' + PORT + '?');
      process.exit(1);
    }

    // Prefer the main page (not devtools or extension pages)
    const target = targets.find(t => t.type === 'page' && !t.url.startsWith('devtools://'))
                || targets[0];
    console.log('Probing target:', target.url?.slice(0, 80), '\n');

    client = await CDP({ port: PORT, target: target.id });
    const { Runtime } = client;
    await Runtime.enable();

    const result = await Runtime.evaluate({
      expression:            PROBE,
      returnByValue:         true,
      awaitPromise:          false,
    });

    if (result.exceptionDetails) {
      console.error('CDP evaluation threw:', result.exceptionDetails);
      process.exit(1);
    }

    const raw = result.result?.value;
    if (typeof raw !== 'string') {
      console.log('Raw result (non-string):', JSON.stringify(result.result, null, 2));
    } else {
      try {
        const parsed = JSON.parse(raw);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(raw);
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

run();
