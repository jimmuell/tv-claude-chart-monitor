#!/usr/bin/env node
'use strict';

const CDP = require('../node_modules/chrome-remote-interface');
const PORT = parseInt(process.env.CDP_PORT || '9222', 10);

// Now that we know the class names, read every accountSummaryField
const PROBE2 = `
(() => {
  try {
    const results = {};

    // Read every accountSummaryField — contains a label div + a value div
    const fields = [...document.querySelectorAll('[class*="accountSummaryField"]')];
    results.fieldCount = fields.length;
    results.fields = fields.map(f => {
      const children = [...f.children];
      return {
        cls:   f.className,
        texts: children.map(c => c.textContent?.trim()),
        html:  f.innerHTML?.replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 120),
      };
    });

    // Also check the account manager header for account/balance info
    const header = document.querySelector('[class*="accountManager"]');
    results.headerText = header?.textContent?.trim().slice(0, 200);

    // Check for any element containing "Balance" or "Equity" or "P&L"
    const allEls = [...document.querySelectorAll('*')];
    const pnlEls = allEls.filter(el =>
      el.children.length === 0 &&
      /^(balance|equity|realized|unrealized|net p|open trade|ote|purchasing)/i.test(el.textContent?.trim() || '')
    );
    results.pnlLabelEls = pnlEls.slice(0, 15).map(el => ({
      tag:         el.tagName,
      cls:         el.className?.slice(0, 80),
      text:        el.textContent?.trim(),
      parentText:  el.parentElement?.textContent?.trim().slice(0, 80),
      parentCls:   el.parentElement?.className?.slice(0, 80),
      siblingText: el.nextElementSibling?.textContent?.trim(),
    }));

    return JSON.stringify(results, null, 2);
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
})()
`;

async function run() {
  let client;
  try {
    const targets = await CDP.List({ port: PORT });
    const target  = targets.find(t => t.type === 'page' && !t.url.startsWith('devtools://')) || targets[0];
    console.log('Target:', target.url?.slice(0, 80), '\n');

    client = await CDP({ port: PORT, target: target.id });
    await client.Runtime.enable();

    const result = await client.Runtime.evaluate({ expression: PROBE2, returnByValue: true });
    const raw = result.result?.value;
    try   { console.log(JSON.parse(raw)); }
    catch { console.log(raw); }
    console.log('\n--- raw ---\n', raw);
  } finally {
    if (client) await client.close().catch(() => {});
  }
}
run();
