// Types for the ESM range helper the window imports natively through Vite.
declare module '*/pnl-range.mjs' {
  export const PERIODS: { key: string; label: string }[];
  export function weekStartSession(sessionDate: string): string;
  export function monthStartSession(sessionDate: string): string;
  export function availableDates(sessions: unknown, mode?: string): string[];
  export function rangeFor(period: string, options: {
    today: string; available?: string[]; from?: string | null; to?: string | null;
  }): { period: string; dates: string[]; from: string | null; to: string | null };
  export function combineSessions(sessions: unknown, dates: string[]): {
    totals: { netPnl: number; grossPnl: number; fees: number; contractSides: number; roundTrips: number; tradeCount: number };
    perDay: { sessionDate: string; hasData: boolean; netPnl: number; grossPnl: number; fees: number;
              contractSides: number; tradeCount: number; openPositionAtEnd: number }[];
    dayCount: number;
  };
  export function rowsInRange<T>(rows: T[], dates: string[], kind: 'trades' | 'fills', mode?: string): T[];
  export const DAY_MODES: { key: string; label: string }[];
  export const CALENDAR_NOTE: string;
  export function chicagoToday(now?: number | Date): string;
  export function calendarDateOf(row: unknown, kind: 'trades' | 'fills'): string | null;
  export function sessionsCoveringCalendar(dates: string[]): string[];
  export function totalsFromRows(trades: unknown[]): {
    netPnl: number; grossPnl: number; fees: number; contractSides: number;
    roundTrips: number; tradeCount: number;
  };
  export function combineCalendarDays(trades: unknown[], dates: string[]): {
    totals: { netPnl: number; grossPnl: number; fees: number; contractSides: number; roundTrips: number; tradeCount: number };
    perDay: { sessionDate: string; hasData: boolean; netPnl: number; grossPnl: number; fees: number;
              contractSides: number; tradeCount: number; openPositionAtEnd: number }[];
    dayCount: number;
  };
  export function rangeWindowLabel(range: { dates: string[] }, mode: string): string;
  export function rangeLabel(range: { from: string | null; to: string | null; dates: string[] }): string;
}
