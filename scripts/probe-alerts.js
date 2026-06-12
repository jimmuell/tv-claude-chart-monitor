#!/usr/bin/env node
'use strict';

const CDP = require('../node_modules/chrome-remote-interface');

const PORT = parseInt(process.env.CDP_PORT || '9222', 10);

const PROBE = `
(async () => {
  const findings = {};

  try {
    // Walk the full prototype chain of _alertService
    const svc = window.TradingViewApi._alertService;
    var allSvcKeys = [];
    var proto = svc;
    var depth = 0;
    while (proto && depth < 5) {
      allSvcKeys = allSvcKeys.concat(Object.getOwnPropertyNames(proto));
      proto = Object.getPrototypeOf(proto);
      depth++;
    }
    findings.alertServiceAllKeys = allSvcKeys.filter(function(k) {
      return k !== 'constructor';
    }).slice(0, 50);

    // show() function source — tells us what args it expects
    const dlg = window.TradingViewApi._alertsWidgetDialog;
    findings.showFnSource = dlg && dlg.show ? dlg.show.toString().slice(0, 500) : 'n/a';
    findings.setTabFnSource = dlg && dlg.setTab ? dlg.setTab.toString().slice(0, 300) : 'n/a';

    // for..in on _alertService to catch enumerable props
    var forInKeys = [];
    for (var k in svc) { forInKeys.push(k); }
    findings.alertServiceForInKeys = forInKeys.slice(0, 40);

  } catch(e) {
    findings.error = String(e);
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
