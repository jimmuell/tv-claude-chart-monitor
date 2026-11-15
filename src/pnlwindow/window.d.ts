import type { OrderImportState, SessionDetail, SessionListItem, MergedPnlState } from '../shared/types';

declare global {
  interface Window {
    pnlApi: {
      getState(): Promise<OrderImportState | null>;
      listSessions(): Promise<SessionListItem[]>;
      getDetail(sessionDate: string): Promise<SessionDetail>;
      onUpdate(cb: (state: OrderImportState) => void): () => void;
      getPaperMode(): Promise<{ paperMode: boolean; merged: MergedPnlState }>;
      setPaperMode(on: boolean): Promise<boolean>;
      onPaperMode(cb: (on: boolean) => void): () => void;
      close(): Promise<void>;
    };
  }
}

export {};
