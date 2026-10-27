import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './ErrorBoundary';
import './styles.css';

/**
 * Send renderer console errors and warnings to the main-process log file, so a
 * blank panel or a bad IPC payload leaves evidence behind instead of vanishing
 * into a devtools console nobody had open.
 */
function forwardConsoleToLog(): void {
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        const text = args.map((a) => {
          if (typeof a === 'string') return a;
          if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
        window.api?.logRenderer?.(level, text);
      } catch { /* logging must never break the panel */ }
    };
  }
  // Anything that escapes React entirely still has to be recorded.
  window.addEventListener('error', (e) => {
    console.error(`[TVCM-UI-WINDOW] ${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error(`[TVCM-UI-REJECTION] ${String((e as PromiseRejectionEvent).reason)}`);
  });
}

forwardConsoleToLog();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary section="panel">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
