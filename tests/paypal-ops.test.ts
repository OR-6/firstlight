import { ApiError } from '@paypal/paypal-server-sdk';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/ledger/db';
import { ScriptedLlm } from '../src/llm/scripted';
import { defaultFirewallConfig } from '../src/firewall/config';
import { PAYPAL_SANDBOX_BASE_URL, PayPalClient, type FetchLike } from '../src/paypal/client';
import { compareBatch, compareSearch, reconcileBatch, SEARCH_INDEX_LAG_MS, type LedgerBatchInput } from '../src/paypal/reconcile';
import { REPORTING_SCOPE, SdkReporting, parseUsdBalance, toCents, type PayPalReporting, type TransactionSearchApi } from '../src/paypal/reporting';
import { Pipeline } from '../src/pipeline/pipeline';
import { handlePayPalWebhook } from '../src/pipeline/webhooks';
import { parsePayees } from '../src/registry/payees';
import { loadRegistry } from '../src/registry/registry';
import { GOOD_PLAN, GOOD_PLAN_TOTAL_CENTS, PAYEES, fakePayPal, makePipeline, replayInput, scriptedAgent } from './helpers/pipeline-fixture';

const CONFIG = { baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: 'a', clientSecret: 'b' };

function reportingStub(balance: Awaited<ReturnType<PayPalReporting['usdBalance']>> | Error): PayPalReporting & { calls: number } {
  const r = {
    calls: 0,
    async usdBalance() {
      r.calls++;
      if (balance instanceof Error) throw balance;
      return balance;
    },
    async findTransactions() {
      return { available: false as const, reason: 'MISSING_SCOPE' as const, detail: 'stub' };
    },
  };
  return r;
}

async function approvedPlan() {
  const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
  const a = await pipeline.assess(replayInput());
  pipeline.decide(a.planId, 'approve', 'ops', 'ok');
  return { pipeline, planId: a.planId };
}

const reservedPayload = (p: Pipeline) => p.audit.entries().find((e) => e.type === 'payout.reserved')?.payload as { paypalBalance: Record<string, unknown> } | undefined;

describe('balance check before a new batch', () => {
  it('refuses with PAYPAL_BALANCE_LOW when PayPal holds less than the batch total; nothing reserved or sent', async () => {
    const { pipeline, planId } = await approvedPlan();
    const pp = fakePayPal();
    const reporting = reportingStub({ available: true, availableCents: GOOD_PLAN_TOTAL_CENTS - 1, totalCents: 10_000_00, asOf: null });
    await expect(pipeline.execute(planId, pp.client, PAYEES, { reporting })).rejects.toMatchObject({ code: 'PAYPAL_BALANCE_LOW' });
    expect(pp.sent).toHaveLength(0);
    expect(pipeline.ledger.poolBalanceCents()).toBe(5_000_00);
    const refused = pipeline.audit.entries().at(-1)!;
    expect(refused.type).toBe('execute.refused');
    expect(refused.payload).toMatchObject({ reason: 'PAYPAL_BALANCE_LOW', neededCents: GOOD_PLAN_TOTAL_CENTS, paypalBalance: { checked: true, availableCents: GOOD_PLAN_TOTAL_CENTS - 1 } });
  });

  it('sends when the balance covers the batch, and records the balance it saw', async () => {
    const { pipeline, planId } = await approvedPlan();
    const pp = fakePayPal();
    const reporting = reportingStub({ available: true, availableCents: GOOD_PLAN_TOTAL_CENTS, totalCents: GOOD_PLAN_TOTAL_CENTS, asOf: '2026-11-08T12:00:00Z' });
    const batch = await pipeline.execute(planId, pp.client, PAYEES, { reporting });
    expect(batch.paypal_batch_id).toBe('SIMBATCH1');
    expect(reservedPayload(pipeline)?.paypalBalance).toEqual({ checked: true, availableCents: GOOD_PLAN_TOTAL_CENTS, totalCents: GOOD_PLAN_TOTAL_CENTS, asOf: '2026-11-08T12:00:00Z' });
  });

  it.each([
    ['missing reporting scope (403)', { available: false as const, reason: 'MISSING_SCOPE' as const, detail: 'no scope' }, 'MISSING_SCOPE'],
    ['network failure', { available: false as const, reason: 'UNAVAILABLE' as const, detail: 'ECONNRESET' }, 'UNAVAILABLE'],
    ['a reporting client that throws', new Error('boom'), 'UNAVAILABLE'],
  ])('%s: records "not checked" and still sends', async (_n, answer, reason) => {
    const { pipeline, planId } = await approvedPlan();
    const pp = fakePayPal();
    await pipeline.execute(planId, pp.client, PAYEES, { reporting: reportingStub(answer) });
    expect(pp.sent).toHaveLength(7);
    expect(reservedPayload(pipeline)?.paypalBalance).toMatchObject({ checked: false, reason });
  });

  it('default reporting skips the call when the token has no reporting scope (no network)', async () => {
    const { pipeline, planId } = await approvedPlan();
    const pp = fakePayPal();
    await pipeline.execute(planId, pp.client, PAYEES);
    expect(reservedPayload(pipeline)?.paypalBalance).toMatchObject({ checked: false, reason: 'MISSING_SCOPE' });
    expect(pp.requests.some((r) => r.path.includes('reporting'))).toBe(false);
  });

  it('a resend is not re-checked against the balance (its money may already be at PayPal)', async () => {
    const { pipeline, planId } = await approvedPlan();
    const pp = fakePayPal();
    pp.failNextCreate = { status: 500, body: { name: 'INTERNAL_SERVICE_ERROR' } };
    const ok = reportingStub({ available: true, availableCents: 10_000_00, totalCents: 10_000_00, asOf: null });
    await expect(pipeline.execute(planId, pp.client, PAYEES, { reporting: ok })).rejects.toThrow();
    const low = reportingStub({ available: true, availableCents: 0, totalCents: 0, asOf: null });
    const batch = await pipeline.execute(planId, pp.client, PAYEES, { reporting: low });
    expect(batch.paypal_batch_id).toBe('SIMBATCH1');
    expect(low.calls).toBe(0);
  });
});

describe('SdkReporting (TransactionSearchController)', () => {
  const tokenStub = (scope: string): FetchLike => async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ access_token: 't', expires_in: 3600, scope }),
  });
  const apiError = (status: number) => new ApiError({ request: { method: 'GET', url: 'x' }, response: { statusCode: status, headers: {}, body: '' } } as never, `HTTP ${status}`);

  it('reads the USD available balance through the SDK when the scope is granted', async () => {
    const controller = {
      searchBalances: async () => ({ result: { balances: [{ currency: 'USD', totalBalance: { currencyCode: 'USD', value: '9320.00' }, availableBalance: { currencyCode: 'USD', value: '9300.50' } }], asOfTime: '2026-11-08T10:00:00Z' } }),
      searchTransactions: async () => ({ result: {} }),
    } as unknown as TransactionSearchApi;
    const r = new SdkReporting(new PayPalClient(CONFIG, tokenStub(`openid ${REPORTING_SCOPE}`)), CONFIG, controller);
    expect(await r.usdBalance()).toEqual({ available: true, availableCents: 930_050, totalCents: 932_000, asOf: '2026-11-08T10:00:00Z' });
  });

  it('a 403 from PayPal is MISSING_SCOPE; anything else is UNAVAILABLE', async () => {
    const make = (err: Error) =>
      new SdkReporting(new PayPalClient(CONFIG, tokenStub(REPORTING_SCOPE)), CONFIG, {
        searchBalances: async () => {
          throw err;
        },
        searchTransactions: async () => {
          throw err;
        },
      } as unknown as TransactionSearchApi);
    expect(await make(apiError(403)).usdBalance()).toMatchObject({ available: false, reason: 'MISSING_SCOPE' });
    expect(await make(apiError(503)).usdBalance()).toMatchObject({ available: false, reason: 'UNAVAILABLE' });
    expect(await make(new Error('socket hang up')).findTransactions(['T1'], { startMs: 0, endMs: 1 })).toMatchObject({ available: false, reason: 'UNAVAILABLE' });
  });

  it('filters a window search down to the wanted transaction ids, amounts as absolute cents', async () => {
    const seen: unknown[] = [];
    const controller = {
      searchBalances: async () => ({ result: {} }),
      searchTransactions: async (q: unknown) => {
        seen.push(q);
        return {
          result: {
            totalPages: 1,
            transactionDetails: [
              { transactionInfo: { transactionId: 'TX1', transactionStatus: 'S', transactionAmount: { currencyCode: 'USD', value: '-120.00' }, transactionEventCode: 'T0000' } },
              { transactionInfo: { transactionId: 'OTHER', transactionStatus: 'S', transactionAmount: { currencyCode: 'USD', value: '-5.00' } } },
            ],
          },
        };
      },
    } as unknown as TransactionSearchApi;
    const r = new SdkReporting(new PayPalClient(CONFIG, tokenStub(REPORTING_SCOPE)), CONFIG, controller);
    const out = await r.findTransactions(['TX1'], { startMs: Date.parse('2026-11-08T00:00:00Z'), endMs: Date.parse('2026-11-08T12:00:00Z') });
    expect(out).toEqual({ available: true, found: [{ transactionId: 'TX1', status: 'S', amountCents: 120_00, currency: 'USD', eventCode: 'T0000', updated: null }] });
    expect(seen[0]).toMatchObject({ startDate: '2026-11-08T00:00:00Z', endDate: '2026-11-08T12:00:00Z', fields: 'transaction_info' });
  });

  it('parsing helpers', () => {
    expect(toCents('120.5')).toBe(120_50);
    expect(toCents('-0.07')).toBe(-7);
    expect(toCents('1e3')).toBeNull();
    expect(parseUsdBalance({ balances: [{ currency: 'EUR', totalBalance: { currencyCode: 'EUR', value: '1.00' } }] })).toMatchObject({ available: false });
  });
});

describe('resend path checks every payee', () => {
  it('a SUBMIT_UNKNOWN batch is not resent while a payee is missing', async () => {
    const { pipeline, planId } = await approvedPlan();
    const pp = fakePayPal();
    pp.failNextCreate = { status: 500, body: { name: 'INTERNAL_SERVICE_ERROR' } };
    await expect(pipeline.execute(planId, pp.client, PAYEES, { reporting: null })).rejects.toThrow();
    const batch = pipeline.ledger.getBatchByDigest(pipeline.verdict(planId)!.digest)!;
    expect(batch.status).toBe('SUBMIT_UNKNOWN');
    const ids = new Set(loadRegistry().map((r) => r.recipientId));
    const partial = parsePayees(Object.fromEntries([...PAYEES].filter(([id]) => id !== 'rcp_03')), ids);
    const creates = pp.requests.filter((r) => r.method === 'POST' && r.path === '/v1/payments/payouts').length;
    await expect(pipeline.execute(planId, pp.client, partial, { reporting: null })).rejects.toMatchObject({ code: 'NO_PAYEE' });
    expect(pp.requests.filter((r) => r.method === 'POST' && r.path === '/v1/payments/payouts').length).toBe(creates);
    expect(pipeline.ledger.getBatch(batch.id)!.status).toBe('SUBMIT_UNKNOWN');
    // With the payee map fixed, the same batch goes out with the same PayPal-Request-Id.
    const sent = await pipeline.execute(planId, pp.client, PAYEES, { reporting: null });
    expect(sent.id).toBe(batch.id);
    expect(pp.sent).toHaveLength(7);
  });
});

// ── cancel an unclaimed item ─────────────────────────────────────────────────

function cancelStub(answer: { status: number; body: unknown }) {
  const calls: { method: string; path: string; body?: string; contentType?: string }[] = [];
  const impl: FetchLike = async (url, init) => {
    const path = url.replace(PAYPAL_SANDBOX_BASE_URL, '');
    calls.push({ method: init.method, path, body: init.body, contentType: init.headers['Content-Type'] });
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, headers: { get: () => 'dbg-1' }, text: async () => JSON.stringify(body) });
    if (path === '/v1/oauth2/token') return reply(200, { access_token: 't', expires_in: 3600 });
    if (init.method === 'POST' && path.endsWith('/cancel')) return reply(answer.status, answer.body);
    if (init.method === 'GET' && path.startsWith('/v1/payments/payouts/')) {
      return reply(200, { batch_header: { payout_batch_id: 'PB000001', batch_status: 'SUCCESS' }, items: [{ payout_item_id: 'ITEMUNCLAIMED1', transaction_status: 'UNCLAIMED', payout_item: { sender_item_id: 'us6000u18k:rcp_01' } }] });
    }
    return reply(404, {});
  };
  return { client: new PayPalClient(CONFIG, impl), calls };
}

function unclaimedSetup() {
  const db = openDb();
  const pipeline = new Pipeline({ db, llm: new ScriptedLlm([]), sentinelLlm: null, registry: loadRegistry(), config: defaultFirewallConfig() });
  pipeline.ledger.seedCredit('seed', 1_000_00);
  const { batchId } = pipeline.ledger.reservePayoutBatch({ eventId: 'us6000u18k', planVersion: 1, paypalRequestId: 'r', verdictDigest: 'd', items: [{ recipientId: 'rcp_01', amountCents: 120_00 }] });
  pipeline.ledger.setBatchStatus(batchId, 'SUCCESS', 'PB000001');
  pipeline.ledger.setItemStatus('us6000u18k', 'rcp_01', 'UNCLAIMED');
  pipeline.ledger.setItemDetails('us6000u18k', 'rcp_01', { paypalItemId: 'ITEMUNCLAIMED1', transactionId: 'TXUNCLAIMED00001' });
  return { db, pipeline, batchId };
}

describe('cancel an UNCLAIMED payout item', () => {
  it('calls PayPal with the payout_item_id, books RETURNED, puts the money back once, audits it', async () => {
    const { pipeline, batchId } = unclaimedSetup();
    expect(pipeline.ledger.poolBalanceCents()).toBe(880_00);
    const pp = cancelStub({ status: 200, body: { payout_item_id: 'ITEMUNCLAIMED1', transaction_id: 'TXUNCLAIMED00001', transaction_status: 'RETURNED', payout_batch_id: 'PB000001' } });
    const out = await pipeline.cancelItem(batchId, 'rcp_01', pp.client, 'ops');
    expect(out).toEqual({ recipientId: 'rcp_01', status: 'RETURNED', paypalItemId: 'ITEMUNCLAIMED1' });
    const post = pp.calls.find((c) => c.method === 'POST' && c.path !== '/v1/oauth2/token')!;
    expect(post.path).toBe('/v1/payments/payouts-item/ITEMUNCLAIMED1/cancel');
    expect(post.contentType).toBe('application/json');
    expect(pipeline.ledger.batchItems(batchId)[0]?.status).toBe('RETURNED');
    expect(pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    const e = pipeline.audit.entries().at(-1)!;
    expect(e.type).toBe('paypal.payout.item.canceled');
    expect(e.payload).toMatchObject({ batchId, recipientId: 'rcp_01', paypalItemId: 'ITEMUNCLAIMED1', by: 'ops', from: 'UNCLAIMED', to: 'RETURNED' });
    // A second cancel is refused locally (no longer UNCLAIMED) and credits nothing.
    await expect(pipeline.cancelItem(batchId, 'rcp_01', pp.client)).rejects.toMatchObject({ code: 'NOT_UNCLAIMED' });
    expect(pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
  });

  it('refuses items that are not UNCLAIMED or have no PayPal item id, without calling PayPal', async () => {
    const { pipeline, batchId } = unclaimedSetup();
    const pp = cancelStub({ status: 200, body: {} });
    await expect(pipeline.cancelItem(batchId, 'rcp_99', pp.client)).rejects.toMatchObject({ code: 'NO_ITEM' });
    pipeline.ledger.setItemStatus('us6000u18k', 'rcp_01', 'SUCCESS');
    await expect(pipeline.cancelItem(batchId, 'rcp_01', pp.client)).rejects.toMatchObject({ code: 'NOT_UNCLAIMED' });
    expect(pp.calls).toHaveLength(0);
  });

  it('when PayPal refuses, nothing is booked, the refusal is audited, and the batch is re-read', async () => {
    const { pipeline, batchId } = unclaimedSetup();
    const pp = cancelStub({ status: 422, body: { name: 'ITEM_ALREADY_CLAIMED', message: 'claimed' } });
    await expect(pipeline.cancelItem(batchId, 'rcp_01', pp.client)).rejects.toMatchObject({ status: 422 });
    expect(pipeline.ledger.batchItems(batchId)[0]?.status).toBe('UNCLAIMED');
    expect(pipeline.ledger.poolBalanceCents()).toBe(880_00);
    expect(pipeline.audit.entries().map((e) => e.type)).toContain('paypal.payout.item.cancel_failed');
    expect(pp.calls.some((c) => c.method === 'GET' && c.path === '/v1/payments/payouts/PB000001')).toBe(true);
  });

  it('a cancel answer that would move the item backwards books nothing and says so', async () => {
    const { pipeline, batchId } = unclaimedSetup();
    const pp = cancelStub({ status: 200, body: { payout_item_id: 'ITEMUNCLAIMED1', transaction_status: 'PENDING' } });
    const out = await pipeline.cancelItem(batchId, 'rcp_01', pp.client);
    expect(out.status).toBe('UNCLAIMED');
    expect(pipeline.ledger.poolBalanceCents()).toBe(880_00);
    expect(pipeline.audit.entries().at(-1)!.payload).toMatchObject({ from: 'UNCLAIMED', to: 'UNCLAIMED', regressionIgnored: true, reported: 'PENDING' });
  });

  it('after RETURNED, a stale UNCLAIMED poll neither re-opens Cancel nor touches the pool', async () => {
    const { pipeline, batchId } = unclaimedSetup();
    const pp = cancelStub({ status: 200, body: { payout_item_id: 'ITEMUNCLAIMED1', transaction_status: 'RETURNED' } });
    await pipeline.cancelItem(batchId, 'rcp_01', pp.client);
    await pipeline.poll(batchId, pp.client); // the stub's GET still says UNCLAIMED
    expect(pipeline.ledger.batchItems(batchId)[0]?.status).toBe('RETURNED');
    expect(pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(pipeline.audit.entries().at(-1)).toMatchObject({ type: 'paypal.payout.status_regression_ignored' });
    await expect(pipeline.cancelItem(batchId, 'rcp_01', pp.client)).rejects.toMatchObject({ code: 'NOT_UNCLAIMED' });
  });
});

// ── reconciliation ───────────────────────────────────────────────────────────

const CREATED = Date.parse('2026-11-08T12:00:00Z');
const LEDGER: LedgerBatchInput = {
  batchId: 1,
  eventId: 'ev1',
  paypalBatchId: 'PB000001',
  status: 'SUCCESS',
  createdMs: CREATED,
  items: [
    { recipientId: 'rcp_01', amountCents: 120_00, status: 'SUCCESS', paypalItemId: 'I1', transactionId: 'TX00000000000001' },
    { recipientId: 'rcp_02', amountCents: 80_00, status: 'SUCCESS', paypalItemId: 'I2', transactionId: 'TX00000000000002' },
  ],
};
const PAYPAL_BATCH = {
  batch_header: { payout_batch_id: 'PB000001', batch_status: 'SUCCESS', amount: { value: '200.00', currency: 'USD' }, fees: { value: '0.00', currency: 'USD' } },
  items: [
    { payout_item_id: 'I1', transaction_id: 'TX00000000000001', transaction_status: 'SUCCESS', payout_item: { sender_item_id: 'ev1:rcp_01', amount: { value: '120.00', currency: 'USD' } } },
    { payout_item_id: 'I2', transaction_id: 'TX00000000000002', transaction_status: 'SUCCESS', payout_item: { sender_item_id: 'ev1:rcp_02', amount: { value: '80.00', currency: 'USD' } } },
  ],
};

describe('reconciliation with PayPal', () => {
  it('a batch that agrees has no differences', () => {
    expect(compareBatch(LEDGER, PAYPAL_BATCH)).toEqual({ differences: [], terminal: true, feesCents: 0 });
  });

  it('lists amount, status, transaction id, missing and extra items', () => {
    const pp = structuredClone(PAYPAL_BATCH);
    pp.items[0]!.payout_item.amount.value = '119.00';
    pp.items[1]!.transaction_status = 'RETURNED';
    pp.items[1]!.transaction_id = 'TXDIFFERENT00002';
    pp.items.push({ payout_item_id: 'I3', transaction_id: 'TX3', transaction_status: 'SUCCESS', payout_item: { sender_item_id: 'ev1:rcp_09', amount: { value: '40.00', currency: 'USD' } } });
    const fields = compareBatch(LEDGER, pp).differences.map((d) => `${d.recipientId}:${d.field}`);
    expect(fields).toEqual(['rcp_01:amount', 'rcp_02:status', 'rcp_02:transaction_id', 'rcp_09:missing_in_ledger']);
  });

  it('Transaction Search: missing within 3 hours is "not indexed yet", after that a difference', () => {
    const one = [{ transactionId: 'TX00000000000001', status: 'S', amountCents: 120_00, currency: 'USD', eventCode: 'T0000', updated: null }];
    expect(compareSearch(LEDGER, one, CREATED + 60_000)).toEqual({ state: { state: 'not_indexed_yet', indexed: 1, waiting: 1 }, differences: [] });
    const late = compareSearch(LEDGER, one, CREATED + SEARCH_INDEX_LAG_MS + 1);
    expect(late.state.state).toBe('differences');
    expect(late.differences).toEqual([{ recipientId: 'rcp_02', field: 'search_missing', ledger: 'TX00000000000002', paypal: null }]);
    const both = [...one, { ...one[0]!, transactionId: 'TX00000000000002', amountCents: 80_00 }];
    expect(compareSearch(LEDGER, both, CREATED + 60_000).state).toEqual({ state: 'matches', indexed: 2 });
  });

  function batchClient(details: unknown, fail = false) {
    const impl: FetchLike = async (url) => {
      const path = url.replace(PAYPAL_SANDBOX_BASE_URL, '');
      const reply = (status: number, body: unknown) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
      if (path === '/v1/oauth2/token') return reply(200, { access_token: 't', expires_in: 3600 });
      if (fail) throw new Error('network down');
      return reply(200, details);
    };
    return new PayPalClient(CONFIG, impl);
  }

  it('reconcileBatch: matches with search unavailable (missing scope) is still "matches", said honestly', async () => {
    const r = await reconcileBatch(LEDGER, batchClient(PAYPAL_BATCH), reportingStub({ available: false, reason: 'MISSING_SCOPE', detail: 'x' }), CREATED + 60_000);
    expect(r.state).toBe('matches');
    expect(r.transactionSearch).toEqual({ state: 'missing_scope', detail: 'stub' });
  });

  it('reconcileBatch: a PayPal failure is "unavailable", never a throw', async () => {
    const r = await reconcileBatch(LEDGER, batchClient(null, true), null, CREATED);
    expect(r.state).toBe('unavailable');
    expect(r.detail).toBe("Couldn't read this batch from PayPal (network down).");
  });

  it('reconcileBatch: a batch PayPal is still processing is "in_progress"', async () => {
    const pp = structuredClone(PAYPAL_BATCH);
    pp.batch_header.batch_status = 'PROCESSING';
    const r = await reconcileBatch({ ...LEDGER, status: 'PROCESSING' }, batchClient(pp), null, CREATED);
    expect(r.state).toBe('in_progress');
  });

  it('reconcileBatch: an unsubmitted batch is not compared', async () => {
    const r = await reconcileBatch({ ...LEDGER, paypalBatchId: null }, batchClient(PAYPAL_BATCH), null, CREATED);
    expect(r.state).toBe('not_submitted');
  });
});

// ── rejected webhook deliveries are collapsed ────────────────────────────────

describe('rejected webhook audit entries', () => {
  const headers = (id: string) => {
    const m = new Map(
      Object.entries({
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
        'paypal-transmission-id': id,
        'paypal-transmission-sig': 'sig==',
        'paypal-transmission-time': '2026-11-08T12:00:00Z',
      }),
    );
    return { get: (k: string) => m.get(k.toLowerCase()) ?? null };
  };
  const failingVerify: FetchLike = async (url) => {
    const path = url.replace(PAYPAL_SANDBOX_BASE_URL, '');
    const body = path === '/v1/oauth2/token' ? { access_token: 't', expires_in: 3600 } : { verification_status: 'FAILURE' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };

  it('writes at most one entry a minute, with the count of refused deliveries', async () => {
    const db = openDb();
    const pipeline = new Pipeline({ db, llm: new ScriptedLlm([]), sentinelLlm: null, registry: loadRegistry(), config: defaultFirewallConfig() });
    const paypal = new PayPalClient(CONFIG, failingVerify);
    const raw = '{"id":"WH-1","event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED","resource":{}}';
    const t0 = Date.parse('2026-11-08T12:00:00Z');
    const send = (n: number, at: number) => handlePayPalWebhook({ pipeline, db, paypal, webhookId: 'WH-ID', headers: headers(`tx-${n}`), rawBody: raw, now: at });
    for (let n = 0; n < 5; n++) expect((await send(n, t0 + n * 1000)).status).toBe(401);
    let rejected = pipeline.audit.entries().filter((e) => e.type === 'paypal.webhook.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.payload).toMatchObject({ reason: 'SIGNATURE_INVALID', count: 1, transmissionId: 'tx-0' });
    await send(5, t0 + 61_000);
    rejected = pipeline.audit.entries().filter((e) => e.type === 'paypal.webhook.rejected');
    expect(rejected).toHaveLength(2);
    expect(rejected[1]!.payload).toMatchObject({ count: 5, transmissionId: 'tx-5' }); // 4 held back + this one
    expect(pipeline.audit.verify().ok).toBe(true);
  });
});
