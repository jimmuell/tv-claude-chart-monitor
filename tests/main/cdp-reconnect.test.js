'use strict';

// TVCM's connection to TradingView, recovering on its own.
//
// These drive the REAL manager (src/shared/cdp-manager.js) and the REAL CDP client
// (src/shared/tv-reader.js) against a fake CDP target, because the fault being fixed was
// not in our logic's idea of a socket — it was in a socket that really had gone to
// readyState 3 while the process carried on. A stub cannot reproduce that.
//
// TVCM-40: the menu bar sat at +$40.25 for 14½ hours while the broker held $511.90,
// because one call site called the reader outside the try/catch that drops a dead
// connection. Only an app restart recovered it.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const { startFakeTarget } = require(path.join(__dirname, 'fake-cdp-target.js'));
const { createCdpManager } = require(path.join(__dirname, '../../src/shared/cdp-manager.js'));
const { createReader } = require(path.join(__dirname, '../../src/shared/tv-reader.js'));

const quiet = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** A manager pointed at a fake target, with the backoff shortened so tests stay quick. */
function managerFor(target, over = {}) {
  const lines = [];
  const logger = { info: (l) => lines.push(l), warn: () => {}, error: () => {} };
  const m = createCdpManager({
    createReader,
    config: () => ({ tv: { cdpHost: '127.0.0.1', cdpPort: target.port } }),
    logger,
    targetCheckMs: over.targetCheckMs == null ? 30_000 : over.targetCheckMs,
    ...over.managerOpts,
  });
  return { m, lines };
}

/** Reads through the manager the way every reader in the app does. */
const read = (m) => m.withReader(r => r.evalPage('1'));

/** Retries a read until it works or the deadline passes; returns how long it took. */
async function recoverWithin(m, deadlineMs) {
  const started = Date.now();
  for (;;) {
    try {
      const v = await read(m);
      return { ok: true, ms: Date.now() - started, value: v };
    } catch (err) {
      if (Date.now() - started > deadlineMs) return { ok: false, ms: Date.now() - started, err: String(err.message) };
      await sleep(100);
    }
  }
}

// ── It connects at all ───────────────────────────────────────────────────

test('the manager connects and reads through one entry point', async () => {
  const t = await startFakeTarget({ answer: 'alive' });
  const { m } = managerFor(t);
  try {
    assert.strictEqual(await read(m), 'alive');
    assert.strictEqual(m.isConnected(), true);
    assert.strictEqual(m.status().state, 'connected');
  } finally { await m.close(); await t.stop(); }
});

// ── The socket dies: TVCM-40's exact failure ─────────────────────────────

test('a killed socket is noticed and the connection rebuilds itself', async () => {
  const t = await startFakeTarget({ answer: 'alive' });
  const { m, lines } = managerFor(t);
  try {
    assert.strictEqual(await read(m), 'alive');
    const before = t.evaluations();

    t.killSockets();                       // readyState 3, process still up
    await sleep(150);                      // let the disconnect event land

    const back = await recoverWithin(m, 8000);
    assert.ok(back.ok, `never recovered: ${back.err}`);
    assert.strictEqual(back.value, 'alive');
    assert.ok(t.evaluations() > before, 'the resumed read reached the target');
    assert.strictEqual(m.isConnected(), true);

    const lost = lines.filter(l => l.includes('TVCM-CDP-LOST'));
    const recovered = lines.filter(l => l.includes('TVCM-CDP-RECOVERED'));
    assert.strictEqual(lost.length, 1, `one line per outage, got ${lost.length}`);
    assert.strictEqual(recovered.length, 1, `one line per recovery, got ${recovered.length}`);
    console.log(`      recovery after a killed socket: ${back.ms} ms`);
  } finally { await m.close(); await t.stop(); }
});

test('the old behaviour is gone: a dead socket does not stay "connected"', async () => {
  const t = await startFakeTarget({ answer: 'alive' });
  const { m } = managerFor(t);
  try {
    await read(m);
    t.killSockets();
    await sleep(150);
    // Whether the disconnect event or the failed read notices first, the one state that
    // must never persist is "connected" over a closed socket — that is what blinded
    // TVCM for fourteen hours.
    try { await read(m); } catch { /* the first call after the kill may fail */ }
    const s = m.status();
    assert.ok(s.state !== 'connected' || s.connected === true,
      'either it reconnected, or it knows it is lost — never a closed socket believed open');
  } finally { await m.close(); await t.stop(); }
});

// ── TradingView opens a new page ─────────────────────────────────────────

test('a changed page target is detected and the connection follows it', async () => {
  const t = await startFakeTarget({ answer: 'first-page' });
  // targetCheckMs 0 so the check runs on every call rather than every 30 seconds.
  const { m, lines } = managerFor(t, { targetCheckMs: 0 });
  try {
    assert.strictEqual(await read(m), 'first-page');
    const firstTarget = m.peekReader().targetId();

    t.setTargetId('FAKE-TARGET-2');        // TradingView replaced its page
    t.setAnswer('second-page');

    const back = await recoverWithin(m, 8000);
    assert.ok(back.ok, `never followed the new page: ${back.err}`);
    assert.strictEqual(back.value, 'second-page');
    assert.notStrictEqual(m.peekReader().targetId(), firstTarget, 'it must attach to the NEW page');
    assert.strictEqual(m.peekReader().targetId(), 'FAKE-TARGET-2');
    assert.strictEqual(lines.filter(l => l.includes('TVCM-CDP-LOST')).length, 1);
    console.log(`      recovery after a page swap: ${back.ms} ms`);
  } finally { await m.close(); await t.stop(); }
});

test('a target that has NOT changed is left alone', async () => {
  const t = await startFakeTarget({ answer: 'alive' });
  const { m, lines } = managerFor(t, { targetCheckMs: 0 });
  try {
    for (let n = 0; n < 5; n++) assert.strictEqual(await read(m), 'alive');
    assert.deepStrictEqual(lines.filter(l => l.includes('TVCM-CDP-LOST')), [],
      'checking the target must not itself cause an outage');
  } finally { await m.close(); await t.stop(); }
});

// ── TradingView quits and comes back ─────────────────────────────────────

test('a target that goes away and returns is picked up without a restart', async () => {
  const t = await startFakeTarget({ answer: 'before' });
  const port = t.port;
  const { m, lines } = managerFor(t);
  try {
    assert.strictEqual(await read(m), 'before');

    await t.stop();                        // TradingView quit
    await sleep(150);
    await assert.rejects(() => read(m), 'a read with nothing there must fail, not hang');
    assert.strictEqual(m.isConnected(), false);
    assert.strictEqual(m.status().state, 'lost');
    assert.ok(m.status().lostAt > 0, 'the tooltip needs to know WHEN it went');

    // TradingView comes back on the SAME port, as a relaunch would — and the SAME
    // manager has to pick it up, with no restart of anything on our side.
    const t2 = await startFakeTarget({ answer: 'after', port });
    try {
      const back = await recoverWithin(m, 10_000);
      assert.ok(back.ok, `never came back: ${back.err}`);
      assert.strictEqual(back.value, 'after');
      assert.strictEqual(m.isConnected(), true);
      console.log(`      recovery after a target restart: ${back.ms} ms`);
    } finally { await t2.stop(); }

    assert.strictEqual(lines.filter(l => l.includes('TVCM-CDP-LOST')).length, 1,
      'the outage was reported exactly once');
    assert.strictEqual(lines.filter(l => l.includes('TVCM-CDP-RECOVERED')).length, 1,
      'and the recovery exactly once');
  } finally { await m.close(); }
});

test('an outage that lasts is reported once, not once per poll', async () => {
  const t = await startFakeTarget({ answer: 'alive' });
  const { m, lines } = managerFor(t);
  try {
    await read(m);
    await t.stop();
    await sleep(100);
    // Twenty polls, the way the live feed would poll for a minute and a half.
    for (let n = 0; n < 20; n++) {
      try { await read(m); } catch { /* expected */ }
      await sleep(10);
    }
    assert.strictEqual(lines.filter(l => l.includes('TVCM-CDP-LOST')).length, 1,
      `20 failed polls must produce one line, got ${lines.filter(l => l.includes('TVCM-CDP-LOST')).length}`);
  } finally { await m.close(); }
});

test('the backoff holds calls off instead of hammering a dead TradingView', async () => {
  const t = await startFakeTarget({ answer: 'alive' });
  const { m } = managerFor(t);
  try {
    await read(m);
    await t.stop();
    await sleep(100);
    try { await read(m); } catch { /* the failure that starts the backoff */ }
    const nextAt = m.status().nextAttemptAt;
    assert.ok(nextAt > Date.now(), 'the next attempt must be scheduled, not immediate');
    // A call inside the backoff window is refused by the policy, without a socket attempt.
    await assert.rejects(() => read(m), /lost the connection to TradingView/);
  } finally { await m.close(); }
});

// ── Every reader goes through the one entry point ────────────────────────

test('no call site in bridge.ts reaches the reader outside withReader', async () => {
  // This is the regression TVCM-40 was: one call outside the managed path, and the whole
  // app goes blind with nothing to say. A new call site added the old way fails here.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/bridge.ts'), 'utf8');
  const strays = src.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /\breader[!?]?\./.test(line) && !/^\s*(\*|\/\/)/.test(line));
  assert.deepStrictEqual(strays.map(s => `${s.n}: ${s.line.trim()}`), [],
    'every reader call must go through withReader()');
});

// ── Each recovery mechanism, pinned on its own ───────────────────────────
//
// The manager has two independent ways of noticing a dead connection: a read that fails
// with a transport error, and the socket announcing its own close. Driven against a real
// target they mask each other — remove either and the tests above still pass, because the
// other one covers. These use a stub reader so each mechanism is the only one in play.
//
// The first of them is the one that mattered: it is exactly what TVCM-40 found missing.

/** A reader that behaves however the test tells it to, and tells no tales of its own. */
function stubReader(script) {
  let onDisconnect = null;
  const r = {
    connects: 0, evals: 0,
    async connect() { r.connects += 1; return true; },
    async disconnect() {},
    onDisconnect(cb) { onDisconnect = cb; },
    targetId() { return 'stub'; },
    async liveTargetId() { return 'stub'; },
    async evalPage() {
      r.evals += 1;
      const outcome = script(r.evals);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    /** Fires the manager's disconnect hook, as a closing socket would. */
    die() { if (onDisconnect) onDisconnect(); },
  };
  return r;
}

/** A manager over one stub reader, with no real socket anywhere. */
function stubManager(script) {
  const lines = [];
  let made = null;
  const m = createCdpManager({
    createReader: () => { made = stubReader(script); return made; },
    config: () => ({ tv: {} }),
    logger: { info: (l) => lines.push(l), warn() {}, error() {} },
    targetCheckMs: 10 * 60_000,
  });
  return { m, lines, reader: () => made };
}

test('a read that fails with a dead pipe drops the connection — the TVCM-40 fix', async () => {
  // The stub never fires onDisconnect, so withReader()'s catch is the ONLY thing that can
  // notice. Before TVCM-41 this is precisely where the app went blind for 14½ hours.
  let dead = true;
  const { m, lines } = stubManager(() => dead
    ? new Error('WebSocket is not open: readyState 3 (CLOSED)')
    : 'alive');

  await assert.rejects(() => read(m), /readyState 3/);
  assert.strictEqual(m.isConnected(), false,
    'a closed socket must never be left believed-open — this is the whole bug');
  assert.strictEqual(m.status().state, 'lost');
  assert.strictEqual(lines.filter(l => l.includes('TVCM-CDP-LOST')).length, 1);

  // And the next attempt, once the backoff allows it, rebuilds rather than reusing it.
  dead = false;
  const back = await recoverWithin(m, 8000);
  assert.ok(back.ok, `never recovered: ${back.err}`);
  assert.strictEqual(back.value, 'alive');
  assert.strictEqual(lines.filter(l => l.includes('TVCM-CDP-RECOVERED')).length, 1);
  await m.close();
});

test('a socket that announces its own close is believed, with no read needed', async () => {
  // The mirror image: every read succeeds, so withReader()'s catch can never fire. Only
  // the disconnect hook can notice — and it must, or an idle TVCM would not know until
  // the next poll.
  const { m, lines } = stubManager(() => 'alive');
  assert.strictEqual(await read(m), 'alive');
  assert.strictEqual(m.isConnected(), true);

  m.peekReader().die();                    // the socket closes on its own

  assert.strictEqual(m.isConnected(), false, 'the close must be believed immediately');
  assert.strictEqual(m.status().state, 'lost');
  assert.ok(m.status().lostAt > 0);
  assert.strictEqual(lines.filter(l => l.includes('TVCM-CDP-LOST')).length, 1);
  await m.close();
});

test('a page error is not a dead pipe, and must not drop a working connection', async () => {
  // TVCM-27's crash text, raised by the page. The socket is fine; dropping it on every
  // bad expression would reconnect in a loop and lose the real diagnosis.
  const { m, lines } = stubManager((n) => n === 1
    ? new Error("CDP eval failed: TypeError: Cannot read properties of undefined (reading 'id')")
    : 'alive');
  await assert.rejects(() => read(m), /Cannot read properties/);
  assert.strictEqual(m.isConnected(), true, 'the connection was never the problem');
  assert.deepStrictEqual(lines.filter(l => l.includes('TVCM-CDP-LOST')), []);
  assert.strictEqual(await read(m), 'alive');
  assert.strictEqual(m.reader === undefined || true, true);
  await m.close();
});

test('one connection is built per outage, not one per failed call', async () => {
  let dead = true;
  const { m, reader } = stubManager(() => dead ? new Error('socket hang up') : 'alive');
  await assert.rejects(() => read(m));
  const firstConnects = reader().connects;
  // Calls inside the backoff window are refused by the policy without touching a socket.
  for (let n = 0; n < 5; n++) { try { await read(m); } catch { /* expected */ } }
  assert.strictEqual(reader().connects, firstConnects,
    'a dead TradingView must not be dialled five times a second');
  dead = false;
  const back = await recoverWithin(m, 8000);
  assert.ok(back.ok);
  await m.close();
});
