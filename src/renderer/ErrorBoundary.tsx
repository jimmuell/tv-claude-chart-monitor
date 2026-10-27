// ErrorBoundary.tsx — the panel must never go blank.
//
// Without a boundary a single throw in render unmounts the whole React tree and
// leaves an empty window, which is exactly the symptom reported during live
// trading. This catches the throw, shows a card Jim can read and recover from,
// and pushes the error plus component stack to the main-process log so the
// cause is still there after the fact.

import React from 'react';

type Props = {
  /** Shown on the card so Jim knows which part failed. */
  section?: string;
  children: React.ReactNode;
};

type State = { error: Error | null; stack: string | null; at: string | null };

/** Clock time for the card — local, seconds precision, no date noise. */
function nowLabel(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, stack: null, at: null };

  /** React calls this on a render throw; swapping in the error card. */
  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, at: nowLabel() };
  }

  /** Record the component stack and get it into the always-on log file. */
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const section = this.props.section ?? 'panel';
    const stack   = info.componentStack ?? '';
    this.setState({ stack });
    // console.error is forwarded to the main log, so one call covers both.
    console.error(
      `[TVCM-UI-RENDER] ${section} render threw: ${error.name}: ${error.message}\n` +
      `${error.stack ?? ''}\ncomponent stack:${stack}`
    );
  }

  /** Drop the error and re-render the section; a reload is the last resort. */
  private retry = (): void => {
    this.setState({ error: null, stack: null, at: null });
  };

  /** Full renderer reload, for when re-rendering throws straight back. */
  private reload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error, at } = this.state;
    if (!error) return this.props.children;
    const section = this.props.section ?? 'panel';
    return (
      <div className="ui-error-card" role="alert">
        <div className="ui-error-head">
          <span className="ui-error-code">TVCM-UI-RENDER</span>
          <span className="ui-error-time">{at}</span>
        </div>
        <div className="ui-error-what">
          The {section} failed to draw. Everything else is still running.
        </div>
        <div className="ui-error-msg">{error.name}: {error.message}</div>
        <div className="ui-error-actions">
          <button className="ui-error-btn" onClick={this.retry}>Try again</button>
          <button className="ui-error-btn" onClick={this.reload}>Reload panel</button>
        </div>
        <div className="ui-error-hint">Details are in the log: tray → Open log folder.</div>
      </div>
    );
  }
}

export default ErrorBoundary;
