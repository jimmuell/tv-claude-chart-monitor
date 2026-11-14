import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types';
import type { OrderImportState, SessionDetail, SessionListItem } from '../shared/types';

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
  /** Fires whenever a new export is imported, so the window refreshes itself. */
  onUpdate: (callback: (state: OrderImportState) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: OrderImportState) => callback(state);
    ipcRenderer.on(IPC.ORDER_IMPORT_PUSH, handler);
    return () => ipcRenderer.removeListener(IPC.ORDER_IMPORT_PUSH, handler);
  },
});
