/**
 * status-payload.ts
 *
 * Builds what the panel is told when an analysis fails.
 *
 * A scheduled bar-close failure used to send only the status 'error', so the
 * user saw a red dot and nothing else — the coded reason (TVCM-READ-EMPTY-BARS,
 * for instance) went to the console only, where nobody running the app as a
 * menubar tool will ever look. Manual refreshes showed the message; scheduled
 * runs, which are almost all of them, did not.
 */

/** Pull a readable message off anything thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const text = String(err ?? '').trim();
  return text.length > 0 ? text : 'Unknown error';
}

/** The status and message the panel receives when an analysis fails. */
export function analysisErrorPayload(err: unknown): { status: 'error'; message: string } {
  return { status: 'error', message: errorMessage(err) };
}
