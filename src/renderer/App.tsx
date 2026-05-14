import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import type { AnalysisResult } from '../shared/types';

const GearIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
  </svg>
);

type UIStatus = 'idle' | 'loading' | 'complete' | 'error';

const App: React.FC = () => {
  const [uiStatus, setUiStatus] = useState<UIStatus>('idle');
  const [loadingMessage, setLoadingMessage] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    // Subscribe to status updates from main process
    const unsubscribe = window.api.onStatus((status) => {
      if (status === 'capturing') setLoadingMessage('Capturing TradingView...');
      else if (status === 'analyzing') setLoadingMessage('Analyzing chart...');
      // 'complete' and 'error' handled by the requestAnalysis promise
    });
    return unsubscribe; // cleanup removes the listener
  }, []);

  const handleRefresh = async () => {
    setUiStatus('loading');
    setErrorMessage('');
    try {
      const analysisResult = await window.api.requestAnalysis();
      setResult(analysisResult);
      setUiStatus('complete');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Unknown error');
      setUiStatus('error');
    }
  };

  // Status dot class
  const dotClass = uiStatus === 'complete' ? 'status-dot active'
    : uiStatus === 'error' ? 'status-dot error'
    : 'status-dot';

  // Body content
  const bodyContent = () => {
    if (uiStatus === 'loading') return <p className="loading-text">{loadingMessage}</p>;
    if (uiStatus === 'error') return <p className="error-text">{errorMessage}</p>;
    if (uiStatus === 'complete' && result) return (
      <ReactMarkdown>{result.markdown_summary}</ReactMarkdown>
    );
    return <p className="placeholder-text">No analysis yet. Click refresh to capture.</p>;
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1 className="title">Trading Analyzer</h1>
          <span className={dotClass} aria-label={`Status: ${uiStatus}`} />
        </div>
        <button className="icon-btn" aria-label="Settings" title="Settings">
          <GearIcon />
        </button>
      </header>

      <main className={uiStatus === 'complete' ? 'markdown-body' : 'body'}>
        {bodyContent()}
      </main>

      <footer className="footer">
        <button
          className="refresh-btn"
          onClick={handleRefresh}
          disabled={uiStatus === 'loading'}
        >
          {uiStatus === 'loading' ? 'Loading...' : 'Refresh'}
        </button>
      </footer>
    </div>
  );
};

export default App;
