#!/usr/bin/env node
'use strict';

const CDP = require('../node_modules/chrome-remote-interface');

const PORT = parseInt(process.env.CDP_PORT || '9222', 10);

const PROBE = `
(async () => {
  const findings = {};

  findings.origin = window.location.origin;
  findings.href   = window.location.href.slice(0, 100);

  findings.alertGlobals = Object.keys(window).filter(function(k) {
    return /alert|alarm|notify/i.test(k);
  }).slice(0, 20);

  const csrfCookie = (document.cookie.split(';').map(function(c) { return c.trim(); })
    .find(function(c) { return c.startsWith('csrftoken='); }) || '');
  findings.hasCsrf     = csrfCookie.length > 0;
  findings.csrfPreview = csrfCookie.slice(0, 40);

  try {
    const csrf = csrfCookie.split('=')[1] || '';
    const r = await fetch('https://pricealert.tradingview.com/api/v2/alerts/', {
      credentials: 'include',
      headers: { 'X-CSRFToken': csrf },
    });
    findings.getAlertsStatus  = r.status;
    findings.getAlertsHeaders = Object.fromEntries(Array.from(r.headers).slice(0, 10));
    if (r.ok) {
      const data = await r.json();
      findings.existingAlertCount = Array.isArray(data) ? data.length
        : (data.alerts ? data.alerts.length : 'unknown shape');
      findings.alertSample = JSON.stringify(data).slice(0, 400);
    } else {
      findings.getAlertsBody = (await r.text()).slice(0, 300);
    }
  } catch (e) {
    findings.getAlertsError = String(e);
  }

  try {
    const chart = window.TradingViewApi.activeChart();
    findings.symbol     = chart.symbol();
    findings.resolution = chart.resolution();
  } catch (e) {
    findings.chartError = String(e);
  }

  return findings;
})()
`;

async function main() {
  let client;
  try {
    const targets = await CDP.List({ port: PORT });
    const page = targets.find(function(t) {
      return t.type === 'page' &&
        (t.url.includes('tradingview') || t.title.toLowerCase().includes('tradingview'));
    });
    if (!page) {
      console.error('No TradingView page target found on port', PORT);
      process.exit(1);
    }
    client = await CDP({ port: PORT, target: page });
    await client.Runtime.enable();
    const { result, exceptionDetails } = await client.Runtime.evaluate({
      expression: PROBE,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      console.error('CDP eval failed:', exceptionDetails.text);
      process.exit(1);
    }
    console.log(JSON.stringify(result.value, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

main().catch(function(err) { console.error(err); process.exit(1); });
