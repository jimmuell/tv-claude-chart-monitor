import { contextBridge, ipcRenderer } from 'electron';
import { IPC, AnalysisResult, LevelAnnotation, AppSettings, KeyStatus, PnlSnapshot } from '../shared/types';

contextBridge.exposeInMainWorld('api', {
  requestAnalysis: () => ipcRenderer.invoke(IPC.ANALYZE_RUN),
  getSnapshot: () => ipcRenderer.invoke(IPC.SNAPSHOT_RAW),
  onStatus: (callback: (status: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: string) => callback(status);
    ipcRenderer.on(IPC.ANALYZE_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.ANALYZE_STATUS, handler);
  },
  onAnalysis: (callback: (result: AnalysisResult) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: AnalysisResult) => callback(result);
    ipcRenderer.on(IPC.ANALYSIS_PUSH, handler);
    return () => ipcRenderer.removeListener(IPC.ANALYSIS_PUSH, handler);
  },
  onNextTick: (callback: (nextMs: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, nextMs: number) => callback(nextMs);
    ipcRenderer.on(IPC.SCHEDULER_NEXT_TICK, handler);
    return () => ipcRenderer.removeListener(IPC.SCHEDULER_NEXT_TICK, handler);
  },
  toggleLevel: (slotIndex: number, price: number, kind: string, label: string, visible: number, priority: string) =>
    ipcRenderer.invoke(IPC.ANNOTATE_TOGGLE, slotIndex, price, kind, label, visible, priority),
  drawAllLevels: (levels: LevelAnnotation[]) =>
    ipcRenderer.invoke(IPC.ANNOTATE_DRAW_ALL, levels),
  clearAllLevels: () =>
    ipcRenderer.invoke(IPC.ANNOTATE_CLEAR_ALL),
  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.SETTINGS_GET),
  updateSettings: (partial: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.SETTINGS_UPDATE, partial),
  pauseScheduler: (): Promise<void> =>
    ipcRenderer.invoke(IPC.SCHEDULER_PAUSE),
  resumeScheduler: (): Promise<void> =>
    ipcRenderer.invoke(IPC.SCHEDULER_RESUME),
  reconnectBridge: (): Promise<void> =>
    ipcRenderer.invoke(IPC.BRIDGE_RECONNECT),
  getKeyStatus: (): Promise<KeyStatus> =>
    ipcRenderer.invoke(IPC.SETTINGS_KEY_STATUS),
  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke(IPC.APP_VERSION),
  writeTradePlan: (entry: number, stop: number, target: number): Promise<void> =>
    ipcRenderer.invoke(IPC.ANNOTATE_TRADE_PLAN, entry, stop, target),
  clearTradePlan: (): Promise<void> =>
    ipcRenderer.invoke(IPC.ANNOTATE_CLEAR_TRADE_PLAN),
  getPnl: (): Promise<PnlSnapshot> =>
    ipcRenderer.invoke(IPC.PNL_GET),
  onPnlUpdate: (callback: (snapshot: PnlSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snap: PnlSnapshot) => callback(snap);
    ipcRenderer.on(IPC.PNL_PUSH, handler);
    return () => ipcRenderer.removeListener(IPC.PNL_PUSH, handler);
  },
  exportToDrive: (): Promise<{ filePath?: string; cancelled?: boolean }> =>
    ipcRenderer.invoke(IPC.GDRIVE_EXPORT),
});
