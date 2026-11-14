'use strict';

// better-sqlite3 is rebuilt against Electron's ABI by the postinstall step, so a
// plain `node --test` run cannot load it. Tests that need a real database ask here
// first and skip with a reason rather than failing the suite for an environment
// difference that says nothing about the code.

/** Why better-sqlite3 cannot be loaded under this runtime, or null when it can. */
function sqliteUnavailableReason() {
  try {
    // The package itself resolves fine; the ABI mismatch only bites when the
    // native binding is actually opened, so open one.
    const Database = require('better-sqlite3');
    new Database(':memory:').close();
    return null;
  } catch (err) {
    const m = /NODE_MODULE_VERSION (\d+)\. This version of Node\.js requires\s+NODE_MODULE_VERSION (\d+)/s.exec(String(err && err.message));
    if (m) {
      return `better-sqlite3 is built for Electron (NODE_MODULE_VERSION ${m[1]}), this is Node ${process.versions.node} (${m[2]}). ` +
             'Run under Electron, or `npx @electron/rebuild -f -w better-sqlite3 --version <node>` to test here.';
    }
    return `better-sqlite3 could not be loaded: ${err && err.message ? err.message.split('\n')[0] : err}`;
  }
}

module.exports = { sqliteUnavailableReason };
