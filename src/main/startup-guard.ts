/**
 * startup-guard.ts
 *
 * Makes a failed startup visible.
 *
 * Everything the app sets up — schema init, stores, scheduler — runs inside
 * app.whenReady(). An exception there used to kill the rest of startup silently:
 * the tray appeared and nothing worked, with no error anywhere a user would look.
 * That is exactly how TVCM-8's dedup-index bug hid for a whole session.
 *
 * Coded errors: TVCM-START-SCHEMA, TVCM-START-STORE, TVCM-START-SCHEDULER,
 * TVCM-START-UNKNOWN.
 */

/** A startup step that failed, in a form the panel and a notification can show. */
export interface StartupFailure {
  code:    string;
  step:    string;
  message: string;
  /** One line a non-engineer can act on. */
  advice:  string;
}

const CODES: Record<string, { code: string; advice: string }> = {
  schema:    { code: 'TVCM-START-SCHEMA',
               advice: 'The journal database could not be prepared. Restore the latest trades.db backup.' },
  store:     { code: 'TVCM-START-STORE',
               advice: 'The journal database could not be opened. Check it is not locked or missing.' },
  scheduler: { code: 'TVCM-START-SCHEDULER',
               advice: 'Analysis will not run on its own. Restart the app; if it repeats, check TradingView is open.' },
};

/** Turn a thrown value from a named startup step into a reportable failure. */
export function describeStartupFailure(step: string, err: unknown): StartupFailure {
  const known = CODES[step];
  const message = err instanceof Error && err.message ? err.message : String(err ?? 'unknown error');
  return {
    code:    known ? known.code : 'TVCM-START-UNKNOWN',
    step,
    message,
    advice:  known ? known.advice : 'Startup did not complete. Restart the app and check the log.',
  };
}

/** The single line shown in the panel and the notification body. */
export function startupFailureText(f: StartupFailure): string {
  return `${f.code}: ${f.step} failed — ${f.message}. ${f.advice}`;
}

/**
 * Run a startup step, reporting any failure instead of letting it kill the rest
 * of startup. Returns true when the step succeeded.
 */
export function runStartupStep(
  step: string,
  fn: () => void,
  report: (f: StartupFailure) => void,
): boolean {
  try {
    fn();
    return true;
  } catch (err) {
    const failure = describeStartupFailure(step, err);
    report(failure);
    return false;
  }
}
