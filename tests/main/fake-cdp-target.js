'use strict';

/**
 * A fake CDP target: enough of Chrome's debugging protocol for a real
 * chrome-remote-interface client to connect, enable domains and evaluate expressions.
 *
 * It exists so TVCM-41's reconnection can be tested against the behaviour that actually
 * broke — a socket going to readyState 3 while the process stays up — instead of against
 * a stub of our own reconnection logic. It can kill its sockets, swap its target id
 * (a TradingView page replaced), and be stopped and restarted (TradingView quit).
 *
 * Never used outside tests, and never points at Jim's TradingView.
 */

const http = require('http');
// ws 7 exports the server as `Server`; `WebSocketServer` is an 8+ alias.
const WebSocketServer = require('ws').Server;

/** Starts a fake target on an ephemeral port; resolves once it is listening. */
async function startFakeTarget(options) {
  const opts = options || {};
  let targetId = opts.targetId || 'FAKE-TARGET-1';
  let answer = opts.answer === undefined ? 'ok' : opts.answer;
  const sockets = new Set();
  let evaluations = 0;

  const server = http.createServer((req, res) => {
    const port = server.address().port;
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'FakeTV/1.0', 'Protocol-Version': '1.3' }));
      return;
    }
    if (req.url === '/json/protocol') {
      // chrome-remote-interface fetches the protocol descriptor before connecting; the
      // one it ships with is exactly what a real Chrome would hand back.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(require('chrome-remote-interface/lib/protocol.json')));
      return;
    }
    if (req.url === '/json' || req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{
        id: targetId,
        type: 'page',
        title: 'TradingView Chart',
        url: 'https://www.tradingview.com/chart/',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${targetId}`,
      }]));
      return;
    }
    res.writeHead(404); res.end('{}');
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      // Everything but an evaluation is an acknowledgement; that is all the reader needs.
      if (msg.method === 'Runtime.evaluate') {
        evaluations += 1;
        const value = typeof answer === 'function' ? answer(msg.params) : answer;
        // returnByValue puts the plain value in result.value, so an expression that
        // returns an object must be answered with one — the snapshot reader expects
        // an object where the live feed expects a JSON string.
        const type = value === null ? 'object' : typeof value;
        ws.send(JSON.stringify({ id: msg.id, result: { result: { type, value } } }));
        return;
      }
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
  });

  // An explicit port lets a test stop the target and bring it back where it was, which
  // is what TradingView quitting and relaunching looks like to TVCM.
  await new Promise((resolve) => server.listen(opts.port || 0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    port,
    /** How many evaluations have been served, so a resumed feed can be proved. */
    evaluations: () => evaluations,
    /** What Runtime.evaluate answers with. */
    setAnswer: (v) => { answer = v; },
    /** The id /json/list reports — changing it is TradingView opening a new page. */
    setTargetId: (id) => { targetId = id; },
    targetId: () => targetId,
    /** Drops every live socket without stopping the server: the TVCM-40 failure. */
    killSockets: () => { for (const ws of sockets) { try { ws.terminate(); } catch { /* gone */ } } sockets.clear(); },
    /** Stops listening entirely: TradingView quit. */
    stop: () => new Promise((resolve) => {
      for (const ws of sockets) { try { ws.terminate(); } catch { /* gone */ } }
      sockets.clear();
      wss.close(() => server.close(() => resolve()));
    }),
  };
}

module.exports = { startFakeTarget };
