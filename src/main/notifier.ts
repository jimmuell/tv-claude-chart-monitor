import { Notification, shell } from 'electron';
import type { SetupVerdict } from '../shared/types';

const ACTIONABLE: ReadonlySet<SetupVerdict> = new Set(['valid_long', 'valid_short']);

let prevVerdict: SetupVerdict | null = null;

export function notifyVerdict(verdict: SetupVerdict, headline: string): void {
  const isActionable = ACTIONABLE.has(verdict);
  const changed      = verdict !== prevVerdict;
  prevVerdict = verdict;

  if (!isActionable || !changed) return;

  shell.beep();
  if (Notification.isSupported()) {
    new Notification({
      title:  verdict === 'valid_long' ? 'LONG Setup' : 'SHORT Setup',
      body:   headline,
      silent: true, // beep already fired above
    }).show();
  }
}

export function resetNotifier(): void {
  prevVerdict = null;
}
