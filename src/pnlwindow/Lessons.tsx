import React, { useEffect, useState, useCallback } from 'react';
import type { LessonView } from '../shared/types';

/** A lesson's date, short, in Central — the clock the rest of the window uses. */
function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US',
    { timeZone: 'America/Chicago', month: 'short', day: 'numeric' });
}

/**
 * Lessons extracted from critiqued trades, and the approval step that decides which
 * of them the analyzer actually sees.
 *
 * Nothing here is automatic: extraction only runs when asked, and a lesson reaches
 * the prompt only once a human approves it. getApprovedLessons() returns exactly the
 * rows marked approved on this screen.
 */
export const Lessons: React.FC = () => {
  const [lessons, setLessons] = useState<LessonView[] | null>(null);
  const [busy, setBusy]       = useState(false);
  const [note, setNote]       = useState<string | null>(null);

  const load = useCallback(() => {
    window.pnlApi.listLessons().then(setLessons).catch(() => setLessons([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  /** Asks the main process to turn critiqued trades into new, unapproved lessons. */
  const extract = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await window.pnlApi.extractLessons();
      const bits = [`${r.extracted} extracted`];
      if (r.skipped)   bits.push(`${r.skipped} skipped`);
      if (r.remaining) bits.push(`${r.remaining} still waiting`);
      setNote(r.errors.length ? `${bits.join(' · ')} — ${r.errors[0]}` : bits.join(' · '));
      setLessons(await window.pnlApi.listLessons());
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const approved = (lessons ?? []).filter(l => l.approved).length;

  return (
    <section className="lessons">
      <div className="sc-head">
        <div>
          <h3 className="sc-title">Lessons</h3>
          <p className="sc-sub">
            Extracted from critiqued trades. Only the ones you approve are given to the
            analyzer — {approved} approved of {(lessons ?? []).length}.
          </p>
        </div>
        <div className="sc-controls">
          <button className="btn" onClick={extract} disabled={busy}>
            {busy ? 'Extracting…' : 'Extract from trades'}
          </button>
        </div>
      </div>

      {note && <div className="sc-banner">{note}</div>}

      {lessons === null && <p className="sc-empty">Loading…</p>}
      {lessons !== null && lessons.length === 0 && (
        <p className="sc-empty">
          No lessons yet. They come from closed trades that have a critique — press
          “Extract from trades” once there are some.
        </p>
      )}

      {(lessons ?? []).map(l => (
        <article key={l.id} className={`lesson${l.approved ? ' approved' : ''}`}>
          <div className="lesson-top">
            <span className={`tag ${l.approved ? 'open' : 'cross'}`}>
              {l.approved ? 'APPROVED' : 'NOT APPROVED'}
            </span>
            {l.pattern && <span className="lesson-pattern">{l.pattern}</span>}
            {l.direction && <span className={`dir ${l.direction === 'short' ? 'short' : 'long'}`}>{l.direction}</span>}
            {l.outcome && <span className="dim">{l.outcome}</span>}
            <span className="dim lesson-when">{fmtDate(l.created_at)}{l.trade_id != null ? ` · trade #${l.trade_id}` : ''}</span>
          </div>
          <p className="lesson-text">{l.lesson_text}</p>
          {l.context_text && <p className="lesson-context">{l.context_text}</p>}
          <div className="lesson-actions">
            <button
              className="btn small"
              onClick={async () => setLessons(await window.pnlApi.setLessonApproved(l.id, !l.approved))}
            >{l.approved ? 'Un-approve' : 'Approve'}</button>
            <button
              className="btn small danger"
              onClick={async () => setLessons(await window.pnlApi.deleteLesson(l.id))}
            >Reject</button>
          </div>
        </article>
      ))}
    </section>
  );
};
