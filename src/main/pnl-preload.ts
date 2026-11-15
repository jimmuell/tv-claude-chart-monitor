import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types';
import type { OrderImportState, SessionDetail, SessionListItem, MergedPnlState } from '../shared/types';

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
  /** Closes this window, for the Close button and the Esc / Cmd-W shortcuts. */
  close: (): Promise<void> => ipcRenderer.invoke(IPC.PNL_WINDOW_CLOSE),
  /** Whether TVCM is reading the paper account, and the merged view behind the number. */
  getPaperMode: (): Promise<{ paperMode: boolean; merged: MergedPnlState }> =>
    ipcRenderer.invoke(IPC.PAPER_MODE_GET),
  /** Switches between the live and the paper account; the tray and Settings follow. */
  setPaperMode: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC.PAPER_MODE_SET, on),
  /** Fires when the toggle is changed anywhere, so all three places stay in step. */
  onPaperMode: (callback: (on: boolean) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, on: boolean) => callback(on);
    ipcRenderer.on(IPC.PAPER_MODE_PUSH, handler);
    return () => ipcRenderer.removeListener(IPC.PAPER_MODE_PUSH, handler);
  },
  /** Fires whenever a new export is imported, so the window refreshes itself. */
  onUpdate: (callback: (state: OrderImportState) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: OrderImportState) => callback(state);
    ipcRenderer.on(IPC.ORDER_IMPORT_PUSH, handler);
    return () => ipcRenderer.removeListener(IPC.ORDER_IMPORT_PUSH, handler);
  },
});
