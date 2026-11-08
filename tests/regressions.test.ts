/**
 * Regressions found in the pre-submission review (docs/decisions.md D59–D64).
 */
import { describe, expect, it } from 'vitest';
import { DonationService } from '../src/donations/service';
import { handlePayPalWebhook } from '../src/pipeline/webhooks';
import { PAYPAL_SANDBOX_BASE_URL, PayPalClient, type FetchLike } from '../src/paypal/client';
import { GOOD_PLAN, PAYEES, fakePayPal, makePipeline, replayInput, scriptedAgent } from './helpers/pipeline-fixture';
import type { Db } from '../src/ledger/db';

const dbOf = (p: unknown) => (p as { deps: { db: Db } }).deps.db;

describe('re-assessing an unchanged event', () => {
  it('gives a second plan with its own verdict instead of crashing', async () => {
    const { pipeline, advance } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    const a1 = await pipeline.assess(replayInput());
    advance(60_000);
    const a2 = await pipeline.assess(replayInput(), { llm: scriptedAgent(GOOD_PLAN) });
    expect(a2.planId).not.toBe(a1.planId);
    expect(a2.verdict?.digest).toBe(a1.verdict?.digest);
    expect(pipeline.verdict(a2.planId)).not.toBeNull();
  });

  it('paying one of two identical plans makes the other return the same batch, not a second payout', async () => {
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    const a1 = await pipeline.assess(replayInput());
    const a2 = await pipeline.assess(replayInput(), { llm: scriptedAgent(GOOD_PLAN) });
    for (const id of [a1.planId, a2.planId]) pipeline.decide(id, 'approve', 'Reviewer', 'ok');
    const pp = fakePayPal();
    const b1 = await pipeline.execute(a1.planId, pp.client, PAYEES);
    const sentAfterFirst = pp.sent.length;
    const b2 = await pipeline.execute(a2.planId, pp.client, PAYEES);
    expect(b2.id).toBe(b1.id);
    expect(pp.sent.length).toBe(sentAfterFirst);
  });
});

describe('execute-time re-check', () => {
  it('refuses an ALLOW plan whose fresh verdict now needs a human', async () => {
    const plan = { ...GOOD_PLAN, items: [GOOD_PLAN.items[0]] };
    const { pipeline } = makePipeline({ llm: scriptedAgent(plan) });
    const a = await pipeline.assess(replayInput());
    expect(a.verdict?.overall).toBe('ALLOW');
    // The pool shrinks so the same plan would now hit the soft budget limit (R5 warning).
    dbOf(pipeline).prepare("INSERT INTO ledger_entries (kind, amount_cents, ref, created_ms) VALUES ('payout_debit', ?, 'other', 0)").run(-4850_00);
    const pp = fakePayPal();
    await expect(pipeline.execute(a.planId, pp.client, PAYEES)).rejects.toMatchObject({ code: 'STATE_CHANGED' });
    expect(pp.sent).toHaveLength(0);
  });
});

describe('webhooks', () => {
  it('a delivery that failed while processing is processed when PayPal retries it', async () => {
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    const db = dbOf(pipeline);
    const { batchId } = pipeline.ledger.reservePayoutBatch({ eventId: 'us6000u18k', planVersion: 1, paypalRequestId: 'r', verdictDigest: 'd', items: [{ recipientId: 'rcp_01', amountCents: 120_00 }] });
    pipeline.ledger.setBatchStatus(batchId, 'PENDING', 'PB000001');
    let getFails = true;
    const impl: FetchLike = async (url) => {
      const path = url.replace(PAYPAL_SANDBOX_BASE_URL, '');
      const reply = (status: number, body: unknown) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
      if (path === '/v1/oauth2/token') return reply(200, { access_token: 't', expires_in: 3600 });
      if (path === '/v1/notifications/verify-webhook-signature') return reply(200, { verification_status: 'SUCCESS' });
      if (path.startsWith('/v1/payments/payouts/')) {
        if (getFails) return reply(503, { name: 'INTERNAL_SERVICE_ERROR' });
        return reply(200, { batch_header: { payout_batch_id: 'PB000001', batch_status: 'SUCCESS' }, items: [{ transaction_status: 'SUCCESS', payout_item: { sender_item_id: 'us6000u18k:rcp_01' } }] });
      }
      return reply(404, {});
    };
    const paypal = new PayPalClient({ baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: 'a', clientSecret: 'b' }, impl);
    const H: Record<string, string> = { 'paypal-auth-algo': 'a', 'paypal-cert-url': 'b', 'paypal-transmission-id': 'c', 'paypal-transmission-sig': 'd', 'paypal-transmission-time': 'e' };
    const headers = { get: (k: string) => H[k] ?? null };
    const rawBody = '{"id":"WH-9","event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED","resource":{"payout_batch_id":"PB000001"}}';
    await expect(handlePayPalWebhook({ pipeline, db, paypal, webhookId: 'W', headers, rawBody })).rejects.toThrow();
    getFails = false;
    const retry = await handlePayPalWebhook({ pipeline, db, paypal, webhookId: 'W', headers, rawBody });
    expect(retry.body).toMatchObject({ ok: true, batchStatus: 'SUCCESS' });
    expect(pipeline.ledger.batchItems(batchId)[0]?.status).toBe('SUCCESS');
  });

  it('unsigned requests are refused without writing to the audit log', async () => {
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    const before = pipeline.audit.entries().length;
    const out = await handlePayPalWebhook({ pipeline, db: dbOf(pipeline), paypal: fakePayPal().client, webhookId: 'W', headers: { get: () => null }, rawBody: '{}' });
    expect(out.status).toBe(400);
    expect(pipeline.audit.entries()).toHaveLength(before);
  });
});

describe('donations', () => {
  function service() {
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    let fail = true;
    const orders = {
      create: async () => {
        if (fail) throw new Error('ECONNRESET');
        return { orderId: 'ORDER12345', status: 'PAYER_ACTION_REQUIRED', approvalUrl: 'https://paypal.example/approve' };
      },
      capture: async () => ({ orderId: 'ORDER12345', status: 'COMPLETED', captureId: 'CAP1', captureStatus: 'COMPLETED', amountCents: 500 }),
    };
    const svc = new DonationService({ db: dbOf(pipeline), audit: pipeline.audit, ledger: pipeline.ledger, orders: () => orders as never, baseUrl: () => 'https://x' });
    const token = svc.createAllowance({ label: 'samaritan', cap_usd: 100, expires_in_hours: 24 }).allowanceToken;
    return { svc, pipeline, token, recover: () => (fail = false) };
  }

  it('a retry with the same idempotency key after PayPal failed goes through', async () => {
    const { svc, recover, token } = service();
    const req = { amount_usd: 5, allowance_token: token, idempotency_key: 'key-12345678' };
    await expect(svc.create(req, 'agent')).rejects.toMatchObject({ code: 'PAYPAL' });
    recover();
    const r = await svc.create(req, 'agent');
    expect(r).toMatchObject({ orderId: 'ORDER12345', status: 'AWAITING_APPROVAL' });
  });

  it('reusing an idempotency key for a different amount is refused', async () => {
    const { svc, recover, token } = service();
    recover();
    await svc.create({ amount_usd: 5, allowance_token: token, idempotency_key: 'key-12345678' }, 'agent');
    await expect(svc.create({ amount_usd: 50, allowance_token: token, idempotency_key: 'key-12345678' }, 'agent')).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('invalid donations are counted, not written to the audit chain', async () => {
    const { svc, pipeline } = service();
    const before = pipeline.audit.entries().length;
    await expect(svc.create({ amount_usd: 0, donor_ref: 'x' }, 'human')).rejects.toBeTruthy();
    expect(pipeline.audit.entries()).toHaveLength(before);
    expect(Object.values(svc.rejected).reduce((a, b) => a + b, 0)).toBe(1);
  });
});
