// Ambient types for the ESM display-rules module, which is plain JavaScript so that
// the Node tests and the browser share exactly one implementation.
declare module '*/pnl-view.mjs' {
  export interface SummaryRow {
    key: string; label: string; value: string; tone: string;
    headline?: boolean; note?: boolean;
  }
  export interface TradeRowView {
    id: number; time: string; direction: string; size: string;
    avgEntry: string; avgExit: string; fees: string; net: string;
    tone: string; isOpen: boolean; crosses: boolean;
  }
  export function fmtMoney(value: number, opts?: { signed?: boolean }): string;
  export function moneyClass(value: number): string;
  export function fmtClock(fillTime: string | null | undefined): string;
  export function fmtStamp(fillTime: string | null | undefined): string;
  export function fmtImportedAt(ms: number | null | undefined): string;
  export function fmtContracts(contractSides: number): string;
  export function emptyMessage(state: unknown): string;
  export function summaryRows(detail: unknown, state: unknown): SummaryRow[];
  export function carriedExplanation(detail: unknown): string | null;
  export function tradeRow(trade: unknown): TradeRowView;
  export function tradeRows(trades: unknown[]): Array<TradeRowView & { number: number }>;
  export function fillsForTrade<T>(trade: unknown, fills: T[] | null | undefined): T[];
}
