'use client';

import { useSyncExternalStore } from 'react';

const never = () => () => {};

/**
 * A value only the browser knows (window.location, localStorage), read without
 * a mount effect: the server render and the first client render use
 * `serverValue`, then React switches to `read()` after hydration. `read` must
 * return a primitive (or the same object) each time it is called.
 */
export function useBrowserValue<T>(read: () => T, serverValue: T): T {
  return useSyncExternalStore(never, read, () => serverValue);
}

/** Read a localStorage key, or null when storage is blocked. */
export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
