import { describe, expect, it } from 'vitest';
import { PAYPAL_SANDBOX_BASE_URL, PayPalApiError, PayPalClient, loadPayPalConfig, type FetchLike } from '../src/paypal/client';
import { buildPayoutBatchBody, createPayoutBatch, getPayoutBatch } from '../src/paypal/payouts';

const CONFIG = { baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: 'test-client-id', clientSecret: 'test-client-secret' };

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakeFetch(responses: { status: number; body: unknown; debugId?: string }[]) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected request ${init.method} ${url}`);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (n: string) => (n.toLowerCase() === 'paypal-debug-id' ? (r.debugId ?? null) : null) },
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  };
  return { impl, calls };
}

const TOKEN = { status: 200, body: { access_token: 'tok-1', expires_in: 32400, scope: 'https://uri.paypal.com/payments/payouts openid', app_id: 'APP-1' } };

describe('PayPal config', () => {
  it.each([
    [{ PAYPAL_ENV: 'live', PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }, /sandbox-only/],
    [{ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }, /sandbox-only/],
    [{ PAYPAL_ENV: 'sandbox', PAYPAL_CLIENT_ID: 'a' }, /must be set/],
  ])('refuses %o', (env, msg) => {
    expect(() => loadPayPalConfig(env)).toThrow(msg);
  });

  it('always targets the sandbox host', () => {
    expect(loadPayPalConfig({ PAYPAL_ENV: 'sandbox', PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }).baseUrl).toBe(
      'https://api-m.sandbox.paypal.com',
    );
  });
});

describe('PayPal client', () => {
  it('gets a client-credentials token with HTTP Basic auth and caches it', async () => {
    const { impl, calls } = fakeFetch([TOKEN, { status: 200, body: { ok: 1 } }, { status: 200, body: { ok: 2 } }]);
    const c = new PayPalClient(CONFIG, impl, () => 0);
    await c.request('GET', '/v1/payments/payouts/ABC123');
    await c.request('GET', '/v1/payments/payouts/ABC123');
    expect(calls.map((x) => x.url)).toEqual([
      'https://api-m.sandbox.paypal.com/v1/oauth2/token',
      'https://api-m.sandbox.paypal.com/v1/payments/payouts/ABC123',
      'https://api-m.sandbox.paypal.com/v1/payments/payouts/ABC123',
    ]);
    expect(calls[0]?.headers.Authorization).toBe(`Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`);
    expect(calls[0]?.body).toBe('grant_type=client_credentials');
    expect(calls[1]?.headers.Authorization).toBe('Bearer tok-1');
  });

  it('refreshes the token 60 s before expiry', async () => {
    let now = 0;
    const short = { status: 200, body: { access_token: 'tok-a', expires_in: 120 } };
    const { impl, calls } = fakeFetch([short, { status: 200, body: {} }, { ...short, body: { access_token: 'tok-b', expires_in: 120 } }, { status: 200, body: {} }]);
    const c = new PayPalClient(CONFIG, impl, () => now);
    await c.request('GET', '/v1/x');
    now = 61_000;
    await c.request('GET', '/v1/x');
    expect(calls.filter((x) => x.url.endsWith('/oauth2/token'))).toHaveLength(2);
    expect(calls[3]?.headers.Authorization).toBe('Bearer tok-b');
  });

  it('sends PayPal-Request-Id and the payout body', async () => {
    const { impl, calls } = fakeFetch([TOKEN, { status: 201, body: { batch_header: { payout_batch_id: 'B1', batch_status: 'PENDING' } }, debugId: 'dbg' }]);
    const c = new PayPalClient(CONFIG, impl);
    const body = buildPayoutBatchBody({
      senderBatchId: 'firstlight-us6000u18k-v1',
      emailSubject: 's',
      emailMessage: 'm',
      items: [{ receiverEmail: 'r@personal.example.com', amountCents: 80_00, note: 'n', senderItemId: 'us6000u18k:rcp_1' }],
    });
    const res = await createPayoutBatch(c, body, 'req-abc');
    expect(res.debugId).toBe('dbg');
    expect(calls[1]?.headers['PayPal-Request-Id']).toBe('req-abc');
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      sender_batch_header: { sender_batch_id: 'firstlight-us6000u18k-v1', email_subject: 's', email_message: 'm' },
      items: [
        { recipient_type: 'EMAIL', amount: { value: '80.00', currency: 'USD' }, receiver: 'r@personal.example.com', note: 'n', sender_item_id: 'us6000u18k:rcp_1' },
      ],
    });
  });

  it('surfaces PayPal errors with name and debug_id, never the secret', async () => {
    const { impl } = fakeFetch([
      { status: 401, body: { error: 'invalid_client', error_description: 'Client Authentication failed' }, debugId: 'd1' },
    ]);
    const err = await new PayPalClient(CONFIG, impl).getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect((err as PayPalApiError).message).toContain('invalid_client');
    expect((err as PayPalApiError).message).toContain('d1');
    expect(JSON.stringify(err) + String(err)).not.toContain('test-client-secret');
  });

  it('rejects path and batch-id injection', async () => {
    const c = new PayPalClient(CONFIG, fakeFetch([]).impl);
    await expect(c.request('GET', 'https://evil.example/v1')).rejects.toThrow(/unexpected PayPal path/);
    expect(() => getPayoutBatch(c, '../../v1/oauth2/token')).toThrow(/invalid payout_batch_id/);
  });
});

describe('payout body builder', () => {
  const item = { receiverEmail: 'r@personal.example.com', amountCents: 40_00, note: 'n', senderItemId: 'e:r' };
  const base = { senderBatchId: 'b', emailSubject: 's', emailMessage: 'm' };
  it.each([
    ['no items', { ...base, items: [] }, /no items/],
    ['bad email', { ...base, items: [{ ...item, receiverEmail: 'not-an-email' }] }, /invalid receiver/],
    ['note > 200 chars', { ...base, items: [{ ...item, note: 'x'.repeat(201) }] }, /note too long/],
    ['duplicate sender_item_id', { ...base, items: [item, { ...item }] }, /duplicate/],
    ['fractional cents', { ...base, items: [{ ...item, amountCents: 40.5 }] }, /invalid cents/],
  ])('rejects %s', (_n, input, msg) => {
    expect(() => buildPayoutBatchBody(input)).toThrow(msg);
  });
});
