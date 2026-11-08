import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Allowance creation is for people, on /agents, not for agents (D10x). Two
 * checks, both cheap:
 *
 *  1. The request comes from this site's own page: the Origin header equals
 *     the site's base URL, and Sec-Fetch-Site (when the browser sends it) is
 *     same-origin. The allowance routes send no CORS headers, so script on
 *     another site can't read a nonce or a response either.
 *  2. It carries a short-lived, single-use nonce the page fetched from
 *     GET /api/allowances/nonce: HMAC-signed with a key made when the process
 *     starts (so a restart or demo reset voids old nonces), valid 10 minutes.
 *
 * This keeps agents that follow the docs (manifest, llms.txt, MCP) from
 * minting their own permission. It is not authentication: a program that
 * forges browser headers can still pass. A real deployment signs the person in.
 */
export const NONCE_TTL_MS = 10 * 60_000;
/** Consumed nonces remembered at once; beyond this the gate says busy rather than grow. */
const MAX_REMEMBERED = 5_000;
const SKEW_MS = 60_000;

export type NonceCheck = { ok: true } | { ok: false; code: 'NONCE_REQUIRED' | 'NONCE_INVALID' | 'NONCE_EXPIRED' | 'NONCE_USED' | 'BUSY'; message: string };

export class HumanGate {
  private readonly key = randomBytes(32);
  /** nonce → when it expires; pruned as it goes. */
  private readonly used = new Map<string, number>();

  constructor(private readonly clock: () => number = Date.now) {}

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }

  issue(): { nonce: string; expiresAt: string } {
    const now = this.clock();
    const body = `n1.${now.toString(36)}.${randomBytes(16).toString('base64url')}`;
    return { nonce: `${body}.${this.sign(body)}`, expiresAt: new Date(now + NONCE_TTL_MS).toISOString() };
  }

  /** Check and spend a nonce. Each one works once, whether or not the request it came with succeeds. */
  consume(nonce: unknown): NonceCheck {
    const now = this.clock();
    for (const [n, exp] of this.used) if (exp <= now) this.used.delete(n);
    if (typeof nonce !== 'string' || nonce === '') return { ok: false, code: 'NONCE_REQUIRED', message: 'Create allowances from the form at /agents.' };
    const m = /^(n1\.([0-9a-z]{1,12})\.[A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(nonce);
    if (!m) return { ok: false, code: 'NONCE_INVALID', message: 'This form has expired. Reload /agents and try again.' };
    const expected = Buffer.from(this.sign(m[1]!));
    const given = Buffer.from(m[3]!);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return { ok: false, code: 'NONCE_INVALID', message: 'This form has expired. Reload /agents and try again.' };
    }
    const issued = parseInt(m[2]!, 36);
    if (issued > now + SKEW_MS) return { ok: false, code: 'NONCE_INVALID', message: 'This form has expired. Reload /agents and try again.' };
    if (now - issued >= NONCE_TTL_MS) return { ok: false, code: 'NONCE_EXPIRED', message: 'This form was open for more than 10 minutes. Try again.' };
    if (this.used.has(nonce)) return { ok: false, code: 'NONCE_USED', message: 'This form was already submitted. Try again.' };
    if (this.used.size >= MAX_REMEMBERED) return { ok: false, code: 'BUSY', message: 'Too many allowances are being created right now. Try again shortly.' };
    this.used.set(nonce, issued + NONCE_TTL_MS);
    return { ok: true };
  }
}

/**
 * Is this a same-origin browser request to the site at `expectedOrigin`?
 * Origin must be present and match exactly (scheme, host, port).
 */
export function sameOriginBrowserRequest(headers: { get(name: string): string | null }, expectedOrigin: string): boolean {
  const origin = headers.get('origin');
  if (!origin || origin === 'null') return false;
  let a: string;
  let b: string;
  try {
    a = new URL(origin).origin;
    b = new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
  if (a !== b) return false;
  const site = headers.get('sec-fetch-site');
  return site === null || site === 'same-origin';
}
