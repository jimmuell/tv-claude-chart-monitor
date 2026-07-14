/**
 * probe-sl-dropdown.js
 *
 * Opens the Trade panel, enables the SL bracket, clicks the SL dropdown button,
 * then captures what options appear (to find the Trailing Stop selector).
 *
 * Usage: node scripts/probe-sl-dropdown.js
 * TradingView must be open with --remote-debugging-port=9222
 */

const CDP = require('chrome-remote-interface');

(async () => {
  const targets = await CDP.List({ port: 9222 });
  const page = targets.find(t => t.type === 'page' && t.url.includes('tradingview'));
  if (!page) { console.error('No TradingView page found'); process.exit(1); }

  const client = await CDP({ target: page });
  await client.Runtime.enable();

  const { result } = await client.Runtime.evaluate({
    expression: `(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      // 1. Open Trade panel if not already open
      const isPanelOpen = () => !!document.querySelector('[data-name="order-panel"]');
      if (!isPanelOpen()) {
        const tradeBtn = [...document.querySelectorAll('button')].find(b =>
          (b.textContent || '').trim() === 'Trade' && (b.className || '').includes('activeArea-')
        );
        if (!tradeBtn) return JSON.stringify({ error: 'trade-button-not-found' });
        tradeBtn.click();
        await sleep(900);
      }
      if (!isPanelOpen()) return JSON.stringify({ error: 'panel-did-not-open' });

      // 2. Enable SL checkbox if unchecked
      const slCb = document.querySelector('[data-qa-id="order-ticket-stop-loss-checkbox-bracket"]');
      if (slCb && !slCb.checked) {
        slCb.click();
        await sleep(400);
      }

      // 3. Click the SL dropdown button
      const slDropdown = document.querySelector('[data-qa-id="order-ticket-stop-loss-dropdown-button"]');
      if (!slDropdown) return JSON.stringify({ error: 'sl-dropdown-button-not-found' });
      slDropdown.click();
      await sleep(500);

      // 4. Capture everything that appeared (dropdown items, menus, options)
      const out = { dropdownItems: [], anyNewElements: [], portalElements: [] };

      // Look for dropdown/menu items that appeared
      out.dropdownItems = [...document.querySelectorAll(
        '[role="option"], [role="menuitem"], [role="listitem"], .item-jFqVJoPk, [data-qa-id*="dropdown"], [data-qa-id*="option"]'
      )].map(el => ({
        tag: el.tagName, role: el.getAttribute('role'),
        qa: el.getAttribute('data-qa-id'), dn: el.getAttribute('data-name'),
        text: (el.textContent || '').trim().slice(0, 80),
        cls: (el.className || '').slice(0, 80),
      }));

      // Look for anything mentioning trail/trailing
      out.anyNewElements = [...document.querySelectorAll('*')].filter(el => {
        const t = (el.textContent || '').toLowerCase();
        const q = (el.getAttribute('data-qa-id') || '').toLowerCase();
        return (t.includes('trail') || q.includes('trail')) && el.children.length < 5 && t.length < 100;
      }).map(el => ({
        tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80),
        qa: el.getAttribute('data-qa-id'), cls: (el.className || '').slice(0, 60),
      }));

      // Look for any portal/overlay elements (TV often renders dropdowns in portals)
      out.portalElements = [...document.querySelectorAll('[class*="popup"], [class*="dropdown"], [class*="menu"], [class*="portal"]')]
        .filter(el => el.children.length > 0 && el.children.length < 15)
        .map(el => ({
          tag: el.tagName, cls: (el.className || '').slice(0, 80),
          childCount: el.children.length,
          text: (el.textContent || '').trim().slice(0, 120),
          children: [...el.children].map(c => ({
            tag: c.tagName, text: (c.textContent || '').trim().slice(0, 60),
            qa: c.getAttribute('data-qa-id'), role: c.getAttribute('role'),
          })),
        })).slice(0, 10);

      return JSON.stringify(out, null, 2);
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(result.value);
  await client.close();
})().catch(console.error);
