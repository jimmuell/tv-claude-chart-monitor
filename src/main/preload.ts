import { contextBridge, ipcRenderer } from 'electron';

// Channel strings hardcoded to avoid rootDir conflict with src/shared/types.ts.
// Canonical values live in IPC.ANALYZE_RUN and IPC.ANALYZE_STATUS in src/shared/types.ts.
const ANALYZE_RUN = 'analyze:run';
const ANALYZE_STATUS = 'analyze:status';

contextBridge.exposeInMainWorld('api', {
  requestAnalysis: () => ipcRenderer.invoke(ANALYZE_RUN),
  onStatus: (callback: (status: string) => void) => {
    ipcRenderer.on(ANALYZE_STATUS, (_event, status) => callback(status));
  },
});
