'use strict';

// better-sqlite3 is rebuilt against Electron's ABI by the postinstall step, so a plain
// `node --test` run cannot load it. Files that need it are named *.electron.test.js:
// `npm test` excludes that pattern and `npm run test:electron` runs exactly it, so the
// split is by filename rather than by a hand-maintained list. The guard below is the
// safety net for someone running one of those files directly with node.

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
             'These tests are not excluded — run `npm run test:electron` (or `npm run test:all`) to execute them.';
    }
    return `better-sqlite3 could not be loaded: ${err && err.message ? err.message.split('\n')[0] : err}. ` +
           'Try `npm run test:electron`.';
  }
}

module.exports = { sqliteUnavailableReason };
