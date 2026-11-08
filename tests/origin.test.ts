import { describe, expect, it } from 'vitest';
import { requestOrigin } from '../src/lib/origin';

const h = (m: Record<string, string>) => ({ get: (k: string) => m[k.toLowerCase()] ?? null });
const INTERNAL = 'http://localhost:10000/api/donations/cancel?receipt=x';

describe('requestOrigin (regression: PayPal back link went to localhost:10000)', () => {
  it.each([
    ['Render proxy headers', { 'x-forwarded-host': 'firstlight.onrender.com', 'x-forwarded-proto': 'https', host: 'localhost:10000' }, 'https://firstlight.onrender.com'],
    ['multiple forwarded values: first wins', { 'x-forwarded-host': 'firstlight.onrender.com, internal', 'x-forwarded-proto': 'https, http' }, 'https://firstlight.onrender.com'],
    ['only Host', { host: 'localhost:3000' }, 'http://localhost:10000'.replace('10000', '3000')],
    ['forged host with a path is ignored', { 'x-forwarded-host': 'evil.example/path', 'x-forwarded-proto': 'https' }, 'http://localhost:10000'],
    ['forged protocol is ignored', { 'x-forwarded-host': 'firstlight.onrender.com', 'x-forwarded-proto': 'javascript' }, 'http://localhost:10000'],
    ['no headers', {}, 'http://localhost:10000'],
  ])('%s', (_n, headers, expected) => {
    expect(requestOrigin(h(headers), INTERNAL)).toBe(expected);
  });
});
