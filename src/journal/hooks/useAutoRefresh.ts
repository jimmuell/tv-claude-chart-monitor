import { useEffect } from 'react';

/**
 * Subscribes to the journal server's SSE stream (/api/events) and polls
 * every 10 seconds as a fallback in case SSE misses an event.
 * Calls `onRefresh` on any DB change notification.
 */
export function useAutoRefresh(onRefresh: () => void): void {
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type: string };
        if (msg.type === 'refresh') onRefresh();
      } catch { /* ignore malformed messages */ }
    };
    const poll = setInterval(onRefresh, 10_000);
    return () => { es.close(); clearInterval(poll); };
  }, [onRefresh]);
}
