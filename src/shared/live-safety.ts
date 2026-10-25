/**
 * live-safety.ts
 *
 * One line in the panel header telling Jim whether the app in front of him can
 * place an order on a real account.
 *
 * Two paths can submit a live market order: `autoTrade`, and
 * `autoTradeTestMode`, which puts Long/Short buttons in the panel header that
 * fire a market order on a single click. Both default off, but a flag left on
 * from a paper session is invisible — exactly the kind of thing that costs
 * money on a live account.
 */

export interface LiveSafetyBanner {
  level: 'ok' | 'warn' | 'danger';
  /** Which order paths are armed, named for the message. */
  armed: string[];
  text:  string;
}

export interface LiveSafetyInput {
  accountType?: string | null;
  autoTrade?: unknown;
  autoTradeTestMode?: unknown;
}

/**
 * Banner for the panel header, or null when there is nothing worth saying
 * (a paper account with both order paths off).
 */
export function liveSafetyBanner(input: LiveSafetyInput = {}): LiveSafetyBanner | null {
  const { accountType, autoTrade, autoTradeTestMode } = input;
  const armed: string[] = [];
  // Only an exact `true` arms a path: settings arrive from JSON and a stray
  // truthy value must not be read as "armed".
  if (autoTrade === true) armed.push('auto-trade');
  if (autoTradeTestMode === true) armed.push('test-mode order buttons');
  const isLive = accountType === 'amp_live';

  if (armed.length > 0) {
    return {
      level: isLive ? 'danger' : 'warn',
      armed,
      text: isLive
        ? `LIVE ACCOUNT — ${armed.join(' and ')} ARMED. This app can place a real order.`
        : `${armed.join(' and ')} armed (paper account). Turn off before trading live.`,
    };
  }
  if (isLive) {
    return { level: 'ok', armed: [], text: 'LIVE ACCOUNT — auto-trade OFF' };
  }
  return null;
}
