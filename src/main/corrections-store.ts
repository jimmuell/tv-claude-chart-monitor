import fs   from 'fs';
import path from 'path';
import { sharedModule } from './shared-require';
import type { Correction } from '../shared/types';

const corrections = sharedModule('corrections.js');

/**
 * Jim's recorded missing fills, kept in the app's user-data folder — never in the repo,
 * and never mixed between live and paper. Corrections are added on top of TradingView's
 * data and can be removed; nothing TradingView reported is ever altered or deleted.
 */
export class CorrectionsStore {
  private dir: string;
  private cache = new Map<'live' | 'paper', Correction[]>();
  private log: (line: string) => void;

  constructor(userDataDir: string, log?: (line: string) => void) {
    this.dir = userDataDir;
    this.log = log ?? ((l) => console.log(l));
  }

  /** One file per mode, so a paper correction can never reach a live calculation. */
  private fileFor(mode: 'live' | 'paper'): string {
    return path.join(this.dir, `corrections-${mode}.json`);
  }

  /** Every correction for a mode, read from disk once and then held in memory. */
  list(mode: 'live' | 'paper'): Correction[] {
    if (this.cache.has(mode)) return this.cache.get(mode)!.slice();
    let rows: Correction[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.fileFor(mode), 'utf8'));
      if (Array.isArray(raw)) rows = raw.filter(Boolean);
    } catch { /* none yet, or unreadable — start empty */ }
    this.cache.set(mode, rows);
    return rows.slice();
  }

  /** Writes a mode's corrections back, leaving the other mode's file untouched. */
  private save(mode: 'live' | 'paper', rows: Correction[]): void {
    this.cache.set(mode, rows);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.fileFor(mode), JSON.stringify(rows, null, 2));
    } catch (err) {
      this.log(`[corrections] TVCM-CORR-WRITE: could not save — ${(err as Error).message}`);
    }
  }

  /** Records a correction Jim has accepted; a repeat of the same one is not duplicated. */
  add(mode: 'live' | 'paper', input: unknown): Correction | null {
    const made = corrections.makeCorrection({ ...(input as object), mode, status: 'added',
                                              createdAt: Date.now() });
    if (!made) { this.log('[corrections] TVCM-CORR-INVALID: refused a correction that made no sense'); return null; }
    const rows = this.list(mode).filter(c => c.id !== made.id);
    rows.push(made);
    this.save(mode, rows);
    this.log(`[corrections] added ${made.side} ${made.qty} @ ${made.price} at ${made.fillTime} (${made.source})`);
    return made;
  }

  /** Removes one correction, which restores the numbers exactly as they were. */
  remove(mode: 'live' | 'paper', id: string): void {
    const rows = corrections.removeCorrection(this.list(mode), id);
    this.save(mode, rows);
    this.log(`[corrections] removed ${id}`);
  }
}
