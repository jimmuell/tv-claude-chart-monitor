import type { OrderImportState, SessionDetail, SessionListItem, ScorecardView } from '../shared/types';

declare global {
  interface Window {
    pnlApi: {
      getState(): Promise<OrderImportState | null>;
      listSessions(): Promise<SessionListItem[]>;
      getDetail(sessionDate: string): Promise<SessionDetail>;
      onUpdate(cb: (state: OrderImportState) => void): () => void;
      close(): Promise<void>;
      getScorecard(mode: 'live' | 'replay', rulesVersion: string | null): Promise<ScorecardView | null>;
    };
  }
}

export {};
