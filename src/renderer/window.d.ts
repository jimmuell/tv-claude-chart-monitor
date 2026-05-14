import type { AnalysisResult, AnalysisStatus } from '../shared/types';

declare global {
  interface Window {
    api: {
      requestAnalysis(): Promise<AnalysisResult>;
      onStatus(callback: (status: AnalysisStatus) => void): () => void;
    };
  }
}
