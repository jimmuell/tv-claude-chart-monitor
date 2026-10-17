import React, { useCallback, useEffect, useState } from 'react';
import { TradeLesson } from '../types';
import { useAutoRefresh } from '../hooks/useAutoRefresh';

const dirColor = (d: string | null) =>
  d === 'long' ? 'var(--accent)' : d === 'short' ? 'var(--bearish)' : 'var(--text-secondary)';

const outcomeColor = (o: string | null) =>
  o === 'win' ? 'var(--accent)' : o === 'loss' ? 'var(--bearish)' : 'var(--text-secondary)';

function Chip({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      display: 'inline-block', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
      textTransform: 'uppercase', padding: '2px 7px', borderRadius: 4,
      border: `1px solid ${color}`, color, marginRight: 6,
    }}>
      {label}
    </span>
  );
}

function LessonCard({
  lesson,
  onApprove,
  onDelete,
}: {
  lesson: TradeLesson;
  onApprove: (id: number, approved: boolean) => void;
  onDelete: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(lesson.lesson_text);
  const [ctx, setCtx] = useState(lesson.context_text ?? '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(`/api/lessons/${lesson.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_text: text, context_text: ctx || null }),
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      background: 'var(--surface)', border: `1px solid ${lesson.approved ? 'var(--accent)' : 'var(--border)'}`,
      borderRadius: 'var(--radius)', padding: '0.75rem 1rem', marginBottom: '0.5rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
        {lesson.pattern && (
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
            {lesson.pattern}
          </span>
        )}
        {lesson.direction && <Chip label={lesson.direction} color={dirColor(lesson.direction)} />}
        {lesson.outcome   && <Chip label={lesson.outcome}   color={outcomeColor(lesson.outcome)} />}
        {lesson.approved
          ? <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700, marginLeft: 'auto' }}>✓ ACTIVE IN ENGINE</span>
          : <span style={{ fontSize: 10, color: '#f59e0b', fontWeight: 700, marginLeft: 'auto' }}>PENDING REVIEW</span>
        }
      </div>

      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={2}
            style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', padding: '0.3rem 0.5rem', fontSize: 13, fontFamily: 'var(--font)', resize: 'vertical' }}
          />
          <input
            value={ctx}
            onChange={e => setCtx(e.target.value)}
            placeholder="Conditions when this applies (optional)"
            style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', padding: '0.25rem 0.5rem', fontSize: 12, fontFamily: 'var(--font)' }}
          />
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <button className="btn-critique" onClick={handleSave} disabled={saving} style={{ fontSize: 11 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn-reset" onClick={() => { setText(lesson.lesson_text); setCtx(lesson.context_text ?? ''); setEditing(false); }} style={{ fontSize: 11 }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p style={{ fontSize: 13, color: 'var(--text-primary)', margin: '0 0 0.25rem' }}>{lesson.lesson_text}</p>
          {lesson.context_text && (
            <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 0.4rem', fontStyle: 'italic' }}>
              Applies when: {lesson.context_text}
            </p>
          )}
          {lesson.trade_id && (
            <p style={{ fontSize: 10, color: 'var(--text-secondary)', margin: '0 0 0.5rem' }}>
              Trade #{lesson.trade_id} · {lesson.symbol}
            </p>
          )}
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <button
              className="btn-critique"
              style={{ fontSize: 11, background: lesson.approved ? 'transparent' : 'var(--accent)', color: lesson.approved ? 'var(--accent)' : '#fff', borderColor: 'var(--accent)' }}
              onClick={() => onApprove(lesson.id, !lesson.approved)}
            >
              {lesson.approved ? 'Deactivate' : '✓ Approve & Activate'}
            </button>
            <button className="btn-critique" onClick={() => setEditing(true)} style={{ fontSize: 11 }}>
              Edit
            </button>
            <button
              className="btn-critique"
              onClick={() => onDelete(lesson.id)}
              style={{ fontSize: 11, color: 'var(--bearish)', borderColor: 'var(--bearish)' }}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Lessons() {
  const [lessons, setLessons] = useState<TradeLesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'active'>('all');

  const fetchLessons = useCallback(() => {
    fetch('/api/lessons')
      .then(r => r.json())
      .then((data: TradeLesson[]) => { setLessons(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { fetchLessons(); }, [fetchLessons]);
  useAutoRefresh(fetchLessons);

  const handleApprove = async (id: number, approved: boolean) => {
    await fetch(`/api/lessons/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    });
    setLessons(prev => prev.map(l => l.id === id ? { ...l, approved } : l));
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('Delete this lesson? It will no longer influence trading decisions.')) return;
    await fetch(`/api/lessons/${id}`, { method: 'DELETE' });
    setLessons(prev => prev.filter(l => l.id !== id));
  };

  const activeCount  = lessons.filter(l => l.approved).length;
  const pendingCount = lessons.filter(l => !l.approved).length;

  const visible = lessons.filter(l =>
    filter === 'all'     ? true :
    filter === 'pending' ? !l.approved :
    l.approved
  );

  if (loading) return <div className="loading">Loading…</div>;

  return (
    <div className="page">
      <div className="summary-bar" style={{ marginBottom: '0.75rem' }}>
        <span className="date-label">Trade Lessons</span>
        <div className="summary-chip">
          <span className="chip-label">Active in Engine</span>
          <span className="chip-value pos">{activeCount}</span>
        </div>
        <div className="summary-chip">
          <span className="chip-label">Pending Review</span>
          <span className="chip-value" style={{ color: pendingCount > 0 ? '#f59e0b' : 'var(--text-secondary)' }}>
            {pendingCount}
          </span>
        </div>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
        Lessons are extracted automatically when you run <strong>Ask Claude</strong> on a closed trade.
        <strong style={{ color: 'var(--accent)' }}> Approve</strong> a lesson to activate it — Claude will read it before every trade analysis.
        Edit to refine the wording before approving.
      </p>

      {pendingCount > 0 && (
        <div style={{ background: '#451a03', border: '1px solid #f59e0b', borderRadius: 'var(--radius)', padding: '0.5rem 0.75rem', marginBottom: '0.75rem', fontSize: 12, color: '#fef3c7' }}>
          <strong>{pendingCount} lesson{pendingCount > 1 ? 's' : ''} waiting for review</strong> — approve them to start influencing future trades.
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.75rem' }}>
        {(['all', 'pending', 'active'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              fontSize: 11, padding: '0.2rem 0.6rem', borderRadius: 'var(--radius)',
              border: '1px solid var(--border)', cursor: 'pointer',
              background: filter === f ? 'var(--accent)' : 'transparent',
              color: filter === f ? '#fff' : 'var(--text-secondary)',
            }}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="empty-state">
          {lessons.length === 0
            ? 'No lessons yet. Run Ask Claude on a closed trade to generate the first lesson.'
            : 'No lessons match this filter.'}
        </div>
      ) : (
        visible.map(lesson => (
          <LessonCard
            key={lesson.id}
            lesson={lesson}
            onApprove={handleApprove}
            onDelete={handleDelete}
          />
        ))
      )}
    </div>
  );
}
