import type { OrderImportState, SessionDetail, SessionListItem, ScorecardView, LessonView, LessonExtractResult } from '../shared/types';

declare global {
  interface Window {
    pnlApi: {
      getState(): Promise<OrderImportState | null>;
      listSessions(): Promise<SessionListItem[]>;
      getDetail(sessionDate: string): Promise<SessionDetail>;
      onUpdate(cb: (state: OrderImportState) => void): () => void;
      close(): Promise<void>;
      getScorecard(mode: 'live' | 'replay', rulesVersion: string | null): Promise<ScorecardView | null>;
      listLessons(): Promise<LessonView[]>;
      setLessonApproved(id: number, approved: boolean): Promise<LessonView[]>;
      deleteLesson(id: number): Promise<LessonView[]>;
      extractLessons(): Promise<LessonExtractResult>;
    };
  }
}

export {};
