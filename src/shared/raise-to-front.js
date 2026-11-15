'use strict';

/**
 * Bringing a window in front of every other application's windows on macOS.
 *
 * Every lever the Order History window used before — `show()`, `focus()` and
 * `app.focus({ steal: true })` — asks macOS to make TVCM the ACTIVE APPLICATION. Since
 * macOS 14 that is a request, not a command: activation is cooperative and the system
 * may refuse it. TVCM asks from a weak position, because `app.dock.hide()` makes it an
 * accessory app with no Dock icon and no menu bar of its own. When the request is
 * refused the window is still ordered front, but only within TVCM's own windows — which
 * is invisible to anyone looking at another app's window on top of it, and looks exactly
 * like the menu item having done nothing.
 *
 * That is why adding `app.focus({ steal: true })` in TVCM-20 did not make it reliable:
 * the three calls are three spellings of the same request, not a request plus a fallback.
 *
 * So the ordering here is done the one way that is not a request. The window's LEVEL is
 * lifted to floating, which the window server applies globally no matter which app is
 * active, and dropped back to a normal level once the window is in front — the window
 * keeps the front position it just took, and only the "stay above everything" goes.
 * Activation is still asked for afterwards, because that is what moves the keyboard.
 */

/**
 * How long the window stays at the floating level. Long enough for the raise to reach
 * the window server as its own change, short enough that nobody sees it hover.
 */
const RAISE_SETTLE_MS = 400;

/**
 * Brings `win` in front of all apps and gives it keyboard focus. `activateApp` is the
 * app-level activation call (Electron's `app.focus({ steal: true })`); `options.schedule`
 * exists so tests can run the level restore without waiting on a timer.
 */
function raiseToFront(win, activateApp, options) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
  const opts     = options || {};
  const settleMs = opts.settleMs == null ? RAISE_SETTLE_MS : opts.settleMs;
  const schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));

  // A minimized window would otherwise be shown without ever leaving the Dock.
  if (win.isMinimized()) win.restore();

  // Already pinned on top by the user: it is in front by definition, and unpinning it
  // afterwards would quietly undo a choice they made.
  const pinned = win.isAlwaysOnTop();
  if (!pinned) win.setAlwaysOnTop(true, 'floating');

  win.show();
  win.focus();
  if (typeof activateApp === 'function') activateApp();

  if (!pinned) {
    schedule(() => {
      if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return;
      win.setAlwaysOnTop(false);
    }, settleMs);
  }
}

module.exports = { raiseToFront, RAISE_SETTLE_MS };
