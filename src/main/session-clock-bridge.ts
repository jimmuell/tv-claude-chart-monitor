// Typed doorway to the shared CommonJS session clock, which tsc does not compile.
// Keeping the require in one place stops every caller needing its own cast.
import { sharedModule } from './shared-require';

const clock = sharedModule('session-clock.js');

/** The trading session an instant falls in, named for the day that session ends. */
export const currentSessionDate: (d: Date | number) => string = clock.currentSessionDate;
/** True while the futures market is trading (Sun 17:00 – Fri 16:00 CT, less the daily break). */
export const isMarketOpen: (d: Date | number) => boolean = clock.isMarketOpen;
/** Plain-English reason the market is shut, or null when it is trading. */
export const marketClosedReason: (d: Date | number) => string | null = clock.marketClosedReason;
/** A short Chicago clock reading like "9:41 AM CT". */
export const chicagoTimeLabel: (d: Date | number) => string = clock.chicagoTimeLabel;
