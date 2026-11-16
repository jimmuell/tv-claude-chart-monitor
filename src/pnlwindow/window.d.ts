import type { OrderImportState, SessionDetail, SessionListItem, MergedPnlState,
              Correction, MissingFillSuggestion } from '../shared/types';

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
      listCorrections(): Promise<Correction[]>;
      getSuggestion(): Promise<MissingFillSuggestion | null>;
      addCorrection(c: unknown): Promise<Correction | null>;
      removeCorrection(id: string): Promise<void>;
      close(): Promise<void>;
    };
  }
}

export {};
