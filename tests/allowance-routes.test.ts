/**
 * The allowance and webhook routes, called as plain functions against a real
 * in-memory runtime with no PayPal credentials.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as createAllowance } from '@/app/api/allowances/route';
import { GET as getNonce } from '@/app/api/allowances/nonce/route';
import { POST as listMine } from '@/app/api/allowances/manage/route';
import { POST as revoke } from '@/app/api/allowances/[id]/revoke/route';
import { POST as webhook } from '@/app/api/webhooks/paypal/route';

beforeAll(() => {
  vi.stubEnv('FIRSTLIGHT_DB', ':memory:');
  vi.stubEnv('DEMO_MODE', 'replay');
  vi.stubEnv('PAYPAL_ENV', '');
  vi.stubEnv('PAYPAL_CLIENT_ID', '');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', '');
  vi.stubEnv('APP_BASE_URL', '');
  vi.stubEnv('RENDER_EXTERNAL_URL', '');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const SITE = 'http://localhost';
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${SITE}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const nonce = async () => ((await getNonce().json()) as { nonce: string }).nonce;
const form = { label: 'route-test-bot', cap_usd: 20, expires_in_hours: 24 };

describe('POST /api/allowances is for the /agents form only', () => {
  it('an agent with no Origin header is refused, even with a valid nonce', async () => {
    const res = await createAllowance(post('/api/allowances', { ...form, nonce: await nonce() }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'PERSON_ONLY', message: expect.stringMatching(/\/agents/) });
  });

  it('script on another site is refused', async () => {
    const res = await createAllowance(post('/api/allowances', { ...form, nonce: await nonce() }, { Origin: 'https://agent.example' }));
    expect(res.status).toBe(403);
  });

  it('same origin without a nonce, or with a used one, is refused', async () => {
    const none = await createAllowance(post('/api/allowances', form, { Origin: SITE }));
    expect(await none.json()).toMatchObject({ error: 'NONCE_REQUIRED' });
    expect(none.status).toBe(403);

    const n = await nonce();
    const ok = await createAllowance(post('/api/allowances', { ...form, label: 'once-bot', nonce: n }, { Origin: SITE, 'Sec-Fetch-Site': 'same-origin' }));
    expect(ok.status).toBe(201);
    const again = await createAllowance(post('/api/allowances', { ...form, label: 'twice-bot', nonce: n }, { Origin: SITE }));
    expect(await again.json()).toMatchObject({ error: 'NONCE_USED' });
  });

  it('the form gets both keys; the person lists and revokes with the manage key, not the agent token', async () => {
    const res = await createAllowance(post('/api/allowances', { ...form, nonce: await nonce() }, { Origin: SITE }));
    expect(res.status).toBe(201);
    const a = (await res.json()) as { allowanceId: string; allowanceToken: string; manageKey: string; label: string };
    expect(a.allowanceToken).toMatch(/^alw_/);
    expect(a.manageKey).toMatch(/^alm_/);

    const listed = (await (await listMine(post('/api/allowances/manage', { manage_keys: [a.manageKey, a.allowanceToken] }))).json()) as { allowances: ({ label: string; status: string } | null)[] };
    expect(listed.allowances).toEqual([expect.objectContaining({ label: 'route-test-bot', status: 'active' }), null]);

    const byAgent = await revoke(post(`/api/allowances/${a.allowanceId}/revoke`, { allowance_token: a.allowanceToken }), params({ id: a.allowanceId }));
    expect(byAgent.status).toBe(403);
    expect(await byAgent.json()).toMatchObject({ error: 'MANAGE_KEY_REQUIRED' });

    const byPerson = await revoke(post(`/api/allowances/${a.allowanceId}/revoke`, { manage_key: a.manageKey }), params({ id: a.allowanceId }));
    expect(byPerson.status).toBe(200);
    expect(await byPerson.json()).toMatchObject({ status: 'revoked' });
  });

  it('the nonce endpoint sends no CORS headers, so another site cannot read it', () => {
    const res = getNonce();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('PayPal webhook budget', () => {
  it('unsigned junk is turned away before it counts, so real deliveries still get through', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let i = 0; i < 80; i++) {
        const junk = await webhook(post('/api/webhooks/paypal', { id: `junk-${i}` }));
        expect(junk.status).toBe(400);
        expect(((await junk.json()) as { error: string }).error).toBe('MISSING_SIGNATURE_HEADERS');
      }
      const signed = {
        'paypal-transmission-id': 't-1',
        'paypal-transmission-time': '2026-11-10T12:00:00Z',
        'paypal-transmission-sig': 'sig',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
        'paypal-auth-algo': 'SHA256withRSA',
      };
      // Not rate-limited: it reaches the handler (which fails here only because this test has no PayPal credentials).
      const real = await webhook(post('/api/webhooks/paypal', { id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }, signed));
      expect(real.status).not.toBe(429);
      // The budget itself still applies to signed requests.
      let last = 0;
      for (let i = 0; i < 61; i++) last = (await webhook(post('/api/webhooks/paypal', { id: `WH-${i + 2}` }, signed))).status;
      expect(last).toBe(429);
    } finally {
      quiet.mockRestore();
    }
  });
});
