import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types';
import type { OrderImportState, SessionDetail, SessionListItem, ScorecardView, LessonView, LessonExtractResult } from '../shared/types';

// The Order History & P&L window's only link to the app. It reads; it never writes,
// never touches TradingView, and never places an order.
contextBridge.exposeInMainWorld('pnlApi', {
  /** The current import state: which session is shown, when it was imported, any error. */
  getState: (): Promise<OrderImportState | null> =>
    ipcRenderer.invoke(IPC.ORDER_IMPORT_GET),
  /** Every session in the imported file, newest first. */
  listSessions: (): Promise<SessionListItem[]> =>
    ipcRenderer.invoke(IPC.ORDER_IMPORT_SESSIONS),
  /** One session's headline, trades and raw fills. */
  getDetail: (sessionDate: string): Promise<SessionDetail> =>
    ipcRenderer.invoke(IPC.ORDER_IMPORT_DETAIL, sessionDate),
  /** The recommendation scorecard for one call source and rules version. */
  getScorecard: (mode: 'live' | 'replay', rulesVersion: string | null): Promise<ScorecardView | null> =>
    ipcRenderer.invoke(IPC.SCORECARD_GET, mode, rulesVersion),
  /** Every extracted lesson, newest first, approved or not. */
  listLessons: (): Promise<LessonView[]> => ipcRenderer.invoke(IPC.LESSONS_LIST),
  /** Approves or un-approves one lesson; only approved ones reach the analyzer prompt. */
  setLessonApproved: (id: number, approved: boolean): Promise<LessonView[]> =>
    ipcRenderer.invoke(IPC.LESSONS_SET_APPROVED, id, approved),
  /** Removes a lesson the user rejected. */
  deleteLesson: (id: number): Promise<LessonView[]> => ipcRenderer.invoke(IPC.LESSONS_DELETE, id),
  /** Runs extraction over closed, critiqued trades that have no lesson yet. */
  extractLessons: (): Promise<LessonExtractResult> => ipcRenderer.invoke(IPC.LESSONS_EXTRACT),
  /** Closes this window, for the Close button and the Esc / Cmd-W shortcuts. */
  close: (): Promise<void> => ipcRenderer.invoke(IPC.PNL_WINDOW_CLOSE),
  /** Fires whenever a new export is imported, so the window refreshes itself. */
  onUpdate: (callback: (state: OrderImportState) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: OrderImportState) => callback(state);
    ipcRenderer.on(IPC.ORDER_IMPORT_PUSH, handler);
    return () => ipcRenderer.removeListener(IPC.ORDER_IMPORT_PUSH, handler);
  },
});
