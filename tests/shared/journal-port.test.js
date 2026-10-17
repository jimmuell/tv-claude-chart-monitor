'use strict';

// Guards the EADDRINUSE path in scripts/start-journal.js.
//
// Regression: an unrelated Next.js dev server held port 3001, and the journal
// server treated any EADDRINUSE as "we're already running" and exited 0. The
// journal API silently never started while `npm run journal` looked healthy.

const test   = require('node:test');
const assert = require('node:assert');

const {
  probeJournalHealth,
  detectHostnameHijack,
  JOURNAL_SERVICE_ID,
} = require('../../scripts/start-journal.js');

test('probeJournalHealth: true when the port serves our own journal', async () => {
  const ours = async () => ({
    ok: true,
    json: async () => ({ service: JOURNAL_SERVICE_ID, port: 3001 }),
  });
  assert.strictEqual(await probeJournalHealth(3001, ours), true);
});

test('probeJournalHealth: false when a foreign app returns non-JSON (Next.js dev server)', async () => {
  const nextServer = async () => ({
    ok: true,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
  });
  assert.strictEqual(await probeJournalHealth(3001, nextServer), false);
});

test('probeJournalHealth: false when a foreign app returns JSON without our service id', async () => {
  const otherApi = async () => ({
    ok: true,
    json: async () => ({ service: 'some-other-app', status: 'ok' }),
  });
  assert.strictEqual(await probeJournalHealth(3001, otherApi), false);
});

test('probeJournalHealth: false on a non-OK response', async () => {
  const notFound = async () => ({
    ok: false,
    json: async () => ({ service: JOURNAL_SERVICE_ID }),
  });
  assert.strictEqual(await probeJournalHealth(3001, notFound), false);
});

test('probeJournalHealth: false when the probe request throws', async () => {
  const refused = async () => { throw new Error('ECONNREFUSED'); };
  assert.strictEqual(await probeJournalHealth(3001, refused), false);
});

test('probeJournalHealth: probes the health endpoint on the given port', async () => {
  let seen = null;
  const spy = async (url) => {
    seen = url;
    return { ok: true, json: async () => ({ service: JOURNAL_SERVICE_ID }) };
  };
  await probeJournalHealth(3002, spy);
  assert.match(seen, /^http:\/\/127\.0\.0\.1:3002\/api\/health$/);
});

// The bug that actually blanked the dashboard: we bind IPv4 127.0.0.1 and never
// see EADDRINUSE, but `localhost` resolves to ::1 where an unrelated Next.js dev
// server answers instead. Every /api call went to the wrong process.
test('detectHostnameHijack: probes via localhost, not the bind address', async () => {
  let seen = null;
  const spy = async (url) => {
    seen = url;
    return { ok: true, json: async () => ({ service: JOURNAL_SERVICE_ID }) };
  };
  await detectHostnameHijack(3001, spy, () => {});
  assert.match(seen, /^http:\/\/localhost:3001\/api\/health$/);
});

test('detectHostnameHijack: false when localhost reaches our own server', async () => {
  const ours = async () => ({
    ok: true,
    json: async () => ({ service: JOURNAL_SERVICE_ID, port: 3001 }),
  });
  assert.strictEqual(await detectHostnameHijack(3001, ours, () => {}), false);
});

test('detectHostnameHijack: true and warns when a foreign IPv6 listener answers', async () => {
  const nextServerOnIpv6 = async () => ({
    ok: false, // Next.js 404s /api/health
    json: async () => ({}),
  });
  const lines = [];
  const hijacked = await detectHostnameHijack(3001, nextServerOnIpv6, (m) => lines.push(m));

  assert.strictEqual(hijacked, true);
  assert.ok(
    lines.some(l => l.includes('is NOT reaching this server')),
    `expected a loud warning, got: ${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some(l => l.includes('JOURNAL_PORT=3002')),
    'warning should tell the user how to recover',
  );
});
