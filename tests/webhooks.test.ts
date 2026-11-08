import { describe, expect, it } from 'vitest';
import { openDb } from '../src/ledger/db';
import { PAYPAL_SANDBOX_BASE_URL, PayPalClient, type FetchLike } from '../src/paypal/client';
import { verificationBody } from '../src/paypal/webhooks';
import { handlePayPalWebhook } from '../src/pipeline/webhooks';
import { Pipeline } from '../src/pipeline/pipeline';
import { defaultFirewallConfig } from '../src/firewall/config';
import { loadRegistry } from '../src/registry/registry';
import { ScriptedLlm } from '../src/llm/scripted';

const HEADERS: Record<string, string> = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': 'tx-1',
  'paypal-transmission-sig': 'sig==',
  'paypal-transmission-time': '2026-11-08T12:00:00Z',
};
const h = (over: Record<string, string | null> = {}) => {
  const m = new Map(Object.entries({ ...HEADERS, ...over }));
  return { get: (k: string) => m.get(k.toLowerCase()) ?? null };
};

/** PayPal stand-in: answers token + verify (with the given status) + batch GETs. */
function paypalStub(verification: string) {
  const verifyBodies: string[] = [];
  const impl: FetchLike = async (url, init) => {
    const path = url.replace(PAYPAL_SANDBOX_BASE_URL, '');
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (path === '/v1/oauth2/token') return reply(200, { access_token: 't', expires_in: 3600 });
    if (path === '/v1/notifications/verify-webhook-signature') {
      verifyBodies.push(init.body!);
      return reply(200, { verification_status: verification });
    }
    if (path.startsWith('/v1/payments/payouts/')) {
      return reply(200, { batch_header: { payout_batch_id: 'PB000001', batch_status: 'SUCCESS' }, items: [{ payout_item_id: 'I1', transaction_status: 'SUCCESS', payout_item: { sender_item_id: 'us6000u18k:rcp_01' } }] });
    }
    return reply(404, {});
  };
  return { client: new PayPalClient({ baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: 'a', clientSecret: 'b' }, impl), verifyBodies };
}

function setup() {
  const db = openDb();
  const pipeline = new Pipeline({ db, llm: new ScriptedLlm([]), sentinelLlm: null, registry: loadRegistry(), config: defaultFirewallConfig() });
  pipeline.ledger.seedCredit('seed', 1_000_00);
  const { batchId } = pipeline.ledger.reservePayoutBatch({ eventId: 'us6000u18k', planVersion: 1, paypalRequestId: 'r', verdictDigest: 'd', items: [{ recipientId: 'rcp_01', amountCents: 120_00 }] });
  pipeline.ledger.setBatchStatus(batchId, 'PENDING', 'PB000001');
  return { db, pipeline, batchId };
}

// Unusual spacing/escaping on purpose: must reach PayPal byte-for-byte.
const RAW = '{"id":"WH-1","event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED","resource":{"payout_batch_id":"PB000001","note":"caf\\u00e9 / ok"}}';

describe('PayPal webhooks', () => {
  it('verified payout event: fetches the batch and updates the ledger', async () => {
    const { db, pipeline, batchId } = setup();
    const pp = paypalStub('SUCCESS');
    const out = await handlePayPalWebhook({ pipeline, db, paypal: pp.client, webhookId: 'WH-ID', headers: h(), rawBody: RAW });
    expect(out).toEqual({ status: 200, body: { ok: true, batchStatus: 'SUCCESS' } });
    expect(pipeline.ledger.batchItems(batchId)[0]?.status).toBe('SUCCESS');
    expect(pp.verifyBodies[0]).toContain(`"webhook_event":${RAW}}`);
    expect(JSON.parse(pp.verifyBodies[0]!)).toMatchObject({ webhook_id: 'WH-ID', transmission_id: 'tx-1', auth_algo: 'SHA256withRSA' });
  });

  it('signature failure changes nothing and is audited', async () => {
    const { db, pipeline, batchId } = setup();
    const out = await handlePayPalWebhook({ pipeline, db, paypal: paypalStub('FAILURE').client, webhookId: 'WH-ID', headers: h(), rawBody: RAW });
    expect(out.status).toBe(401);
    expect(pipeline.ledger.batchItems(batchId)[0]?.status).toBe('RESERVED');
    expect(pipeline.audit.entries().at(-1)?.type).toBe('paypal.webhook.rejected');
  });

  it.each([
    ['no webhook id configured', { webhookId: undefined }, 503],
    ['missing signature header', { headers: h({ 'paypal-transmission-sig': null }) }, 400],
    ['body is not JSON', { rawBody: 'not json' }, 400],
  ])('rejects: %s', async (_n, over, status) => {
    const { db, pipeline } = setup();
    const pp = paypalStub('SUCCESS');
    const out = await handlePayPalWebhook({ pipeline, db, paypal: pp.client, webhookId: 'WH-ID', headers: h(), rawBody: RAW, ...over });
    expect(out.status).toBe(status);
    expect(pp.verifyBodies).toEqual([]); // never even asked PayPal
  });

  it('replayed delivery is acknowledged once', async () => {
    const { db, pipeline } = setup();
    const pp = paypalStub('SUCCESS');
    await handlePayPalWebhook({ pipeline, db, paypal: pp.client, webhookId: 'WH-ID', headers: h(), rawBody: RAW });
    const again = await handlePayPalWebhook({ pipeline, db, paypal: pp.client, webhookId: 'WH-ID', headers: h(), rawBody: RAW });
    expect(again.body).toEqual({ ok: true, duplicate: true });
    expect(pipeline.audit.entries().filter((e) => e.type === 'paypal.webhook')).toHaveLength(1);
  });

  it('verification body is valid JSON with the raw event spliced in', () => {
    const body = verificationBody(HEADERS as never, 'W', RAW);
    expect(JSON.parse(body).webhook_event.resource.note).toBe('café / ok');
  });
});
