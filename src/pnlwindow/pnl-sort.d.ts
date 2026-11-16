// Types for the ESM sorting rules the window imports natively through Vite.
declare module '*/pnl-sort.mjs' {
  export interface SortChoice { key: string; dir: string }
  export interface SortColumn {
    key: string; label: string; type: 'datetime' | 'number' | 'money' | 'text';
    align?: string; firstDir?: string; pick: (row: any) => unknown;
  }
  export const SORT_STORAGE_PREFIX: string;
  export const COLUMNS: Record<string, SortColumn[]>;
  export const DEFAULT_SORT: Record<string, SortChoice>;
  export function columnsFor(tab: string): SortColumn[];
  export function columnFor(tab: string, key: string): SortColumn | null;
  export function normaliseValue(value: unknown, type: string): number | string | null;
  export function compareValues(a: unknown, b: unknown, type: string): number;
  export function sortRows<T>(rows: T[] | null | undefined, tab: string, sort: SortChoice | null): T[];
  export function nextSort(current: SortChoice | null, tab: string, key: string): SortChoice;
  export function arrowFor(sort: SortChoice | null, key: string): string;
  export function readSort(storage: Storage | null, tab: string): SortChoice;
  export function writeSort(storage: Storage | null, tab: string, sort: SortChoice): void;
}
