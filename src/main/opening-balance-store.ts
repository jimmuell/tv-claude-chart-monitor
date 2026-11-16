import fs   from 'fs';
import path from 'path';
import { sharedModule } from './shared-require';
import type { OpeningBalanceRecord, ResolvedOpeningBalance } from '../shared/types';

const openingBalance = sharedModule('opening-balance.js');

/**
 * What each trading session opened with, kept in the app's user-data folder — one file
 * per mode, so a paper balance can never reach a live calculation.
 *
 * The decision of WHETHER to record is not made here; it lives in the pure module, which
 * will only ever record before the session has traded. This class's whole job is to
 * remember the answer, including the answer "unknown", which matters just as much: a
 * session that was first seen after trading began must stay unknown for the rest of the
 * day rather than pick up a balance from a later flat moment.
 */
export class OpeningBalanceStore {
  private dir: string;
  private cache = new Map<'live' | 'paper', Record<string, OpeningBalanceRecord>>();
  private log: (line: string) => void;

  constructor(userDataDir: string, log?: (line: string) => void) {
    this.dir = userDataDir;
    this.log = log ?? ((l) => console.log(l));
  }

  /** One file per mode, named so it is obvious which account it describes. */
  private fileFor(mode: 'live' | 'paper'): string {
    return path.join(this.dir, `opening-balance-${mode}.json`);
  }

  /** Every session this mode has an answer for, read from disk once and then held. */
  private all(mode: 'live' | 'paper'): Record<string, OpeningBalanceRecord> {
    if (this.cache.has(mode)) return this.cache.get(mode)!;
    let rows: Record<string, OpeningBalanceRecord> = {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.fileFor(mode), 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) rows = raw;
    } catch { /* none yet, or unreadable — start empty */ }
    this.cache.set(mode, rows);
    return rows;
  }

  /** What was recorded for one session, or null when it has never been seen. */
  get(mode: 'live' | 'paper', sessionDate: string): OpeningBalanceRecord | null {
    return this.all(mode)[sessionDate] ?? null;
  }

  /** Everything recorded, newest session first, for Settings and the report. */
  list(mode: 'live' | 'paper'): OpeningBalanceRecord[] {
    return Object.values(this.all(mode)).sort((a, b) => (a.sessionDate < b.sessionDate ? 1 : -1));
  }

  /** Writes a mode's answers back, leaving the other mode's file untouched. */
  private save(mode: 'live' | 'paper', rows: Record<string, OpeningBalanceRecord>): void {
    this.cache.set(mode, rows);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.fileFor(mode), JSON.stringify(rows, null, 2));
    } catch (err) {
      this.log(`[opening-balance] TVCM-OB-WRITE: could not save — ${(err as Error).message}`);
    }
  }

  /**
   * Offers one feed reading to the rules. Called on every poll; writes at most once per
   * session, and logs that one line so the evening's capture is visible in the log.
   */
  observe(info: Record<string, unknown>): OpeningBalanceRecord | null {
    const mode = (info.mode === 'paper' ? 'paper' : 'live') as 'live' | 'paper';
    const sessionDate = String(info.sessionDate || '');
    if (!sessionDate) return null;
    const decision = openingBalance.observeReading({ ...info, existing: this.get(mode, sessionDate) });
    if (decision.action === 'keep') return null;
    const rows = { ...this.all(mode), [sessionDate]: decision.record };
    this.save(mode, rows);
    if (decision.action === 'record') {
      this.log(`[opening-balance] ${sessionDate} opened at $${decision.record.balance.toFixed(2)} (read while flat, before any fill)`);
    } else {
      this.log(`[opening-balance] TVCM-OB-UNKNOWN: ${sessionDate} — ${decision.record.reason}; the missing-fill banner will ask for a price instead of solving one`);
    }
    return decision.record;
  }

  /** The balance to use for a session, and where it came from. Never a guess. */
  resolve(mode: 'live' | 'paper', sessionDate: string,
          override: { sessionDate: string; balance: number } | null,
          legacy: number | null): ResolvedOpeningBalance {
    return openingBalance.resolveOpeningBalance({
      sessionDate, record: this.get(mode, sessionDate), override, legacy,
    });
  }
}
