import { useEffect } from 'react';

/**
 * Subscribes to the journal server's SSE stream (/api/events).
 * Calls `onRefresh` whenever the server broadcasts a 'refresh' event
 * (triggered by any DB write — new trade, exit recorded, etc.).
 * EventSource reconnects automatically on network drops.
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
    return () => es.close();
  }, [onRefresh]);
}
