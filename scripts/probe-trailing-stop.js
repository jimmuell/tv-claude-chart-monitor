/**
 * probe-trailing-stop.js
 *
 * Discovers TradingView's trailing-stop DOM selectors inside the Trade panel.
 * Run AFTER opening the Trade panel and the Buy/Sell bracket section is visible.
 *
 * Usage:
 *   node scripts/probe-trailing-stop.js
 */

const CDP = require('chrome-remote-interface');

(async () => {
  const targets = await CDP.List({ port: 9222 });
  const page = targets.find(t => t.type === 'page' && t.url.includes('tradingview'));
  if (!page) { console.error('No TradingView page found'); process.exit(1); }

  const client = await CDP({ target: page });
  await client.Runtime.enable();

  const { result } = await client.Runtime.evaluate({
    expression: `(() => {
      const out = {
        trailKeyword: [],
        slSection: [],
        slTypeControls: [],
        allDataQaIds: [],
        checkboxes: [],
      };

      // 1. Any element whose text or attributes mention "trail"
      out.trailKeyword = [...document.querySelectorAll('*')].filter(el => {
        const txt  = (el.textContent || '').toLowerCase();
        const qa   = (el.getAttribute('data-qa-id') || '').toLowerCase();
        const dn   = (el.getAttribute('data-name') || '').toLowerCase();
        return (txt.includes('trail') || qa.includes('trail') || dn.includes('trail'))
          && el.children.length < 6 && txt.length < 120;
      }).map(el => ({
        tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80),
        qa: el.getAttribute('data-qa-id'), dn: el.getAttribute('data-name'),
        cls: (el.className || '').slice(0, 80),
      })).slice(0, 20);

      // 2. The SL bracket checkbox and its siblings/nearby controls
      const slCb = document.querySelector('[data-qa-id="order-ticket-stop-loss-checkbox-bracket"]');
      if (slCb) {
        const parent = slCb.parentElement;
        out.slSection = [...(parent?.querySelectorAll('*') || [])].map(el => ({
          tag: el.tagName, text: (el.textContent || '').trim().slice(0, 60),
          qa: el.getAttribute('data-qa-id'), dn: el.getAttribute('data-name'),
          role: el.getAttribute('role'), type: el.getAttribute('type'),
          cls: (el.className || '').slice(0, 80),
        })).slice(0, 30);
      }

      // 3. All data-qa-id values in the order panel that mention stop / trail / type
      const panel = document.querySelector('[data-name="order-panel"]');
      if (panel) {
        out.allDataQaIds = [...panel.querySelectorAll('[data-qa-id]')]
          .map(el => el.getAttribute('data-qa-id'))
          .filter(v => v && /stop|trail|type|sl|bracket/i.test(v));
      }

      // 4. All checkboxes / radio buttons / selects in the panel
      if (panel) {
        out.checkboxes = [...panel.querySelectorAll('input[type="checkbox"], input[type="radio"], select, [role="checkbox"], [role="radio"], [role="switch"]')]
          .map(el => ({
            tag: el.tagName, type: el.type || el.getAttribute('type'),
            qa: el.getAttribute('data-qa-id'), dn: el.getAttribute('data-name'),
            checked: el.checked, text: (el.parentElement?.textContent || '').trim().slice(0, 60),
          }));
      }

      return JSON.stringify(out, null, 2);
    })()`,
    returnByValue: true,
  });

  console.log(result.value);
  await client.close();
})().catch(console.error);
