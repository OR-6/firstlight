'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

/**
 * Live updates: one EventSource per tab. Every audit append bumps `version`,
 * and every useApi() hook refetches. `last` carries the latest audit type so
 * screens can react to specific steps.
 */
/** 'connecting' until the stream first opens or fails; 'offline' only after an error. */
export type LinkState = 'connecting' | 'live' | 'offline';
type Live = { version: number; connected: boolean; link: LinkState; last: { type: string; hash: string } | null; bump: () => void };
const LiveContext = createContext<Live>({ version: 0, connected: false, link: 'connecting', last: null, bump: () => {} });

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [version, setVersion] = useState(0);
  const [link, setLink] = useState<LinkState>('connecting');
  const connected = link === 'live';
  const [last, setLast] = useState<Live['last']>(null);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      es = new EventSource('/api/stream');
      es.onopen = () => {
        setLink('live');
        // Refetch everything on (re)connect: covers a cold start where the first fetch failed.
        bump();
      };
      es.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data) as { kind: string; entry?: { type: string; hash: string } };
          if (ev.entry) setLast({ type: ev.entry.type, hash: ev.entry.hash });
        } catch {
          /* ignore */
        }
        bump();
      };
      es.onerror = () => {
        setLink('offline');
        es?.close();
        retry = setTimeout(open, 3000);
      };
    };
    open();
    return () => {
      clearTimeout(retry);
      es?.close();
    };
  }, [bump]);

  return <LiveContext.Provider value={{ version, connected, link, last, bump }}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function call<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'ERROR', data.message ?? `Request failed (${res.status}).`);
  return data as T;
}

/** GET a JSON endpoint and keep it fresh on every live event. */
export function useApi<T>(url: string | null) {
  const { version } = useLive();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [retries, setRetries] = useState(0);
  // When the url changes, adjust state during render (React's pattern for
  // resetting state on a prop change) rather than in an effect. A null url
  // means the thing we were showing no longer exists (e.g. after a demo
  // reset), so it is cleared. A different url keeps the old data on screen
  // until the new response arrives.
  const [shownUrl, setShownUrl] = useState(url);
  if (url !== shownUrl) {
    setShownUrl(url);
    if (!url) {
      setData(null);
      setError(null);
    }
    setLoading(Boolean(url));
  }

  useEffect(() => {
    if (!url) return;
    // Only the latest request from this hook may write state.
    let current = true;
    call<T>(url).then(
      (d) => {
        if (!current) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!current) return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', "Couldn't reach the server. It may be waking up; this usually takes under a minute."));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [url, version, retries]);

  const reload = useCallback(() => setRetries((n) => n + 1), []);
  return { data, error, loading, reload };
}
