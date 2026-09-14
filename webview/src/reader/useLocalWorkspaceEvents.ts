import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type LocalWorkspaceWatchStatus = {
  state: 'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'unsupported';
  message?: string;
};

/** Local server only. One stream and at most one trailing read, never a request per event. */
export function useLocalWorkspaceEvents(busy: boolean, refresh: () => void): LocalWorkspaceWatchStatus {
  const [status, setStatus] = useState<LocalWorkspaceWatchStatus>({ state: 'connecting' });
  const committed = useRef({ busy, refresh });
  const wake = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { committed.current = { busy, refresh }; wake.current?.(); }, [busy, refresh]);
  useEffect(() => {
    let active = true;
    let source: EventSource | undefined;
    let timer: number | undefined;
    let pending = false;
    let lastRevision: string | undefined;
    let mustRevalidate = true;
    const schedule = (): void => {
      if (!active || !pending || committed.current.busy || timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        if (!active || !pending || committed.current.busy) return;
        pending = false;
        // Close the interval before React commits the refresh/loading state.
        committed.current.busy = true;
        committed.current.refresh();
      }, 100);
    };
    const unavailable = (message?: string): void => {
      if (!active) return;
      mustRevalidate = true;
      setStatus({ state: 'unavailable', message });
    };
    const change: EventListener = event => {
      if (!active) return;
      try {
        const data: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (!data || typeof data !== 'object' || !('revision' in data) || typeof data.revision !== 'string' || !data.revision) {
          unavailable(); return;
        }
        setStatus({ state: 'connected' });
        // The first change also rereads: it may arrive after an older initial fetch.
        // A broken stream/watch invalidates dedupe even if the server revision repeats.
        if (!mustRevalidate && data.revision === lastRevision) return;
        mustRevalidate = false;
        lastRevision = data.revision;
        pending = true;
        schedule();
      } catch { unavailable(); }
    };
    const watchUnavailable: EventListener = event => {
      if (!active) return;
      try {
        const data: unknown = JSON.parse((event as MessageEvent<string>).data);
        unavailable(data && typeof data === 'object' && 'message' in data && typeof data.message === 'string' ? data.message : undefined);
      } catch { unavailable(); }
    };
    const error: EventListener = () => {
      if (!active) return;
      mustRevalidate = true;
      setStatus({ state: 'reconnecting' });
      // EventSource owns network reconnection; don't create competing retry streams.
    };
    const listeners: Array<[string, EventListener]> = [['change', change], ['unavailable', watchUnavailable], ['error', error]];
    const disconnect = (): void => {
      for (const [type, listener] of listeners) {
        try { source?.removeEventListener(type, listener); } catch { /* Partial/failed setup still releases the connection. */ }
      }
      try { source?.close(); } catch { /* Teardown must remain terminal. */ }
    };
    wake.current = schedule;
    if (typeof EventSource !== 'function') setStatus({ state: 'unsupported' });
    else {
      try {
        source = new EventSource('/__snl/api/events');
        for (const [type, listener] of listeners) source.addEventListener(type, listener);
      } catch {
        unavailable();
        active = false;
        disconnect();
        source = undefined;
      }
    }
    return () => {
      active = false;
      wake.current = null;
      pending = false;
      if (timer !== undefined) window.clearTimeout(timer);
      disconnect();
    };
  }, []);
  return status;
}
