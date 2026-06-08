import type { AnalysisResult, AnalysisStatus, LevelAnnotation, AppSettings, KeyStatus, PnlSnapshot } from '../shared/types';

declare global {
  interface Window {
    api: {
      requestAnalysis(): Promise<AnalysisResult>;
      getSnapshot(): Promise<unknown>;
      onStatus(callback: (status: AnalysisStatus) => void): () => void;
      onAnalysis(cb: (result: AnalysisResult) => void): () => void;
      onNextTick(cb: (nextMs: number) => void): () => void;
      toggleLevel(slotIndex: number, price: number, kind: string, label: string, visible: number, priority: string): Promise<void>;
      drawAllLevels(levels: LevelAnnotation[]): Promise<void>;
      clearAllLevels(): Promise<void>;
      getSettings(): Promise<AppSettings>;
      updateSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
      pauseScheduler(): Promise<void>;
      resumeScheduler(): Promise<void>;
      reconnectBridge(): Promise<void>;
      getKeyStatus(): Promise<KeyStatus>;
      getAppVersion(): Promise<string>;
      writeTradePlan(entry: number, stop: number, target: number): Promise<void>;
      clearTradePlan(): Promise<void>;
      getPnl(): Promise<PnlSnapshot>;
      onPnlUpdate(cb: (snapshot: PnlSnapshot) => void): () => void;
      exportToDrive(): Promise<{ filePath?: string; cancelled?: boolean }>;
      writePatternMarkers(markers: import('../shared/types').PatternMarker[]): Promise<void>;
    };
  }
}
