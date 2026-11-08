import { baseUrl, donationFail, json, readText } from '@/server/http';
import { firstlight } from '@/server/runtime';
import { sameOriginBrowserRequest } from '@/donations/human-gate';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A person creates an allowance for one agent from the form on /agents:
 * {label, cap_usd, expires_in_hours, nonce}. Only a same-origin browser
 * request with a fresh nonce from GET /api/allowances/nonce gets through, so
 * an agent can't grant itself permission by following the docs.
 * The response carries the agent's token (allowanceToken) and the person's
 * manage key (manageKey) once; only their hashes are stored.
 */
export async function POST(req: Request) {
  try {
    if (!sameOriginBrowserRequest(req.headers, baseUrl(req))) {
      return json({ error: 'PERSON_ONLY', message: 'Allowances are created by a person, from the form at /agents.' }, 403);
    }
    const body = JSON.parse((await readText(req, 4_000)) || '{}') as unknown;
    const { nonce, ...request } = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const rt = firstlight();
    const check = rt.donations.humanGate.consume(nonce);
    if (!check.ok) return json({ error: check.code, message: check.message }, check.code === 'BUSY' ? 429 : 403);
    return json(rt.donations.createAllowance(request), 201);
  } catch (e) {
    return donationFail(e);
  }
}
