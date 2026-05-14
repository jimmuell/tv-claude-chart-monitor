import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types';

contextBridge.exposeInMainWorld('api', {
  requestAnalysis: () => ipcRenderer.invoke(IPC.ANALYZE_RUN),
  onStatus: (callback: (status: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: string) => callback(status);
    ipcRenderer.on(IPC.ANALYZE_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.ANALYZE_STATUS, handler);
  },
});
