import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pipeline, PipelineError, idempotencyScopeFromEnv } from '../src/pipeline/pipeline';
import { PAYPAL_SANDBOX_BASE_URL, PayPalClient, type FetchLike } from '../src/paypal/client';
import { EVENT_ID, GOOD_PLAN, GOOD_PLAN_TOTAL_CENTS, PAYEES, fakePayPal, makePipeline, replayInput, scriptedAgent, type FakePayPal } from './helpers/pipeline-fixture';

const RECIPIENTS = GOOD_PLAN.items.map((i) => i.recipientId);
const createCalls = (pp: FakePayPal) => pp.requests.filter((r) => r.method === 'POST' && r.path === '/v1/payments/payouts');

/** An assessed and approved Panama plan, ready to execute. */
async function approvedPlan() {
  const fx = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
  const a = await fx.pipeline.assess(replayInput());
  fx.pipeline.decide(a.planId, 'approve', 'ops', 'checked USGS');
  return { ...fx, planId: a.planId, verdict: a.verdict! };
}

/** A second pipeline on the same database: stands in for another process or instance. */
function sibling(p: Pipeline): Pipeline {
  const deps = (p as unknown as { deps: ConstructorParameters<typeof Pipeline>[0] }).deps;
  return new Pipeline({ ...deps });
}

/** PayPal stub answering batch GETs with each recipient's status from `status()`. */
function pollStub(status: () => Record<string, string>, batchStatus = 'SUCCESS') {
  const impl: FetchLike = async (url, init) => {
    const path = url.replace(PAYPAL_SANDBOX_BASE_URL, '');
    const reply = (code: number, body: unknown) => ({ ok: code < 300, status: code, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (path === '/v1/oauth2/token') return reply(200, { access_token: 't', expires_in: 3600 });
    if (init.method === 'GET' && path.startsWith('/v1/payments/payouts/')) {
      const s = status();
      return reply(200, {
        batch_header: { payout_batch_id: 'SIMBATCH1', batch_status: batchStatus },
        items: RECIPIENTS.map((r, n) => ({ payout_item_id: `ITEM${n}`, transaction_status: s[r] ?? 'SUCCESS', payout_item: { sender_item_id: `${EVENT_ID}:${r}` } })),
      });
    }
    return reply(404, {});
  };
  return new PayPalClient({ baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: 'a', clientSecret: 'b' }, impl);
}

afterEach(() => vi.unstubAllEnvs());

describe('poll: stale statuses are ignored and audited', () => {
  it('UNCLAIMED or PENDING after SUCCESS changes nothing, is audited once, and money stays put', async () => {
    const { pipeline, planId } = await approvedPlan();
    const batch = await pipeline.execute(planId, fakePayPal().client, PAYEES, { reporting: null });
    await pipeline.poll(batch.id, pollStub(() => ({})));
    const pool = pipeline.ledger.poolBalanceCents();

    const stale = pollStub(() => ({ rcp_01: 'UNCLAIMED', rcp_02: 'PENDING' }), 'PROCESSING');
    const out = await pipeline.poll(batch.id, stale);
    expect(out.items.every((i) => i.status === 'SUCCESS')).toBe(true);
    expect(out.batch.status).toBe('SUCCESS');
    expect(out.terminal).toBe(true);
    expect(pipeline.ledger.poolBalanceCents()).toBe(pool);
    const ignored = pipeline.audit.entries().filter((e) => e.type === 'paypal.payout.status_regression_ignored');
    expect(ignored).toHaveLength(1);
    expect(ignored[0]!.payload).toEqual({
      batchId: batch.id,
      paypalBatchId: 'SIMBATCH1',
      batch: { stored: 'SUCCESS', reported: 'PROCESSING' },
      items: [
        { recipientId: 'rcp_01', stored: 'SUCCESS', reported: 'UNCLAIMED', raw: 'UNCLAIMED', unknown: false },
        { recipientId: 'rcp_02', stored: 'SUCCESS', reported: 'PENDING', raw: 'PENDING', unknown: false },
      ],
    });
    // The same stale answer again is not re-audited.
    await pipeline.poll(batch.id, stale);
    expect(pipeline.audit.entries().filter((e) => e.type === 'paypal.payout.status_regression_ignored')).toHaveLength(1);
    expect(pipeline.audit.verify().ok).toBe(true);
  });

  it('FAILED then SUCCESS takes the credit back out and audits the re-debit', async () => {
    const { pipeline, planId } = await approvedPlan();
    const batch = await pipeline.execute(planId, fakePayPal().client, PAYEES, { reporting: null });
    await pipeline.poll(batch.id, pollStub(() => ({ rcp_07: 'FAILED' })));
    expect(pipeline.ledger.poolBalanceCents()).toBe(5_000_00 - GOOD_PLAN_TOTAL_CENTS + 40_00);
    await pipeline.poll(batch.id, pollStub(() => ({})));
    expect(pipeline.ledger.poolBalanceCents()).toBe(5_000_00 - GOOD_PLAN_TOTAL_CENTS);
    const e = pipeline.audit.entries().find((x) => x.type === 'payout.item_redebited')!;
    expect(e.payload).toEqual({ batchId: batch.id, recipientId: 'rcp_07', from: 'FAILED', to: 'SUCCESS', cents: 40_00, poolBalanceCents: 5_000_00 - GOOD_PLAN_TOTAL_CENTS });
  });
});

describe('concurrent execute', () => {
  it('two execute() calls on the same plan at once: one createPayoutBatch, the same batch for both', async () => {
    const { pipeline, planId } = await approvedPlan();
    const pp = fakePayPal();
    const [a, b] = await Promise.all([pipeline.execute(planId, pp.client, PAYEES, { reporting: null }), pipeline.execute(planId, pp.client, PAYEES, { reporting: null })]);
    expect(createCalls(pp)).toHaveLength(1);
    expect(a).toEqual(b);
    expect(pp.sent).toHaveLength(7);
    expect(pipeline.ledger.poolBalanceCents()).toBe(5_000_00 - GOOD_PLAN_TOTAL_CENTS);
    // A later call returns the stored batch without calling PayPal again.
    await pipeline.execute(planId, pp.client, PAYEES, { reporting: null });
    expect(createCalls(pp)).toHaveLength(1);
  });

  it('two processes on one database: one createPayoutBatch, the other is refused ALREADY_PAID', async () => {
    const { pipeline, planId } = await approvedPlan();
    const other = sibling(pipeline);
    const pp = fakePayPal();
    const results = await Promise.allSettled([pipeline.execute(planId, pp.client, PAYEES, { reporting: null }), other.execute(planId, pp.client, PAYEES, { reporting: null })]);
    expect(createCalls(pp)).toHaveLength(1);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(PipelineError);
    expect((refused.reason as PipelineError).code).toBe('ALREADY_PAID');
    expect(pipeline.ledger.poolBalanceCents()).toBe(5_000_00 - GOOD_PLAN_TOTAL_CENTS);
  });

  it('two concurrent resends of a SUBMIT_UNKNOWN batch use the same PayPal-Request-Id, and PayPal pays once', async () => {
    const { pipeline, planId } = await approvedPlan();
    const pp = fakePayPal();
    pp.failNextCreate = { status: 503, body: { name: 'SERVICE_UNAVAILABLE' } };
    await expect(pipeline.execute(planId, pp.client, PAYEES, { reporting: null })).rejects.toMatchObject({ status: 503 });
    const stuck = pipeline.ledger.getBatchByDigest(pipeline.verdict(planId)!.digest)!;
    expect(stuck.status).toBe('SUBMIT_UNKNOWN');

    // Same process: the second resend joins the first.
    const [a, b] = await Promise.all([pipeline.execute(planId, pp.client, PAYEES, { reporting: null }), pipeline.execute(planId, pp.client, PAYEES, { reporting: null })]);
    expect(a).toEqual(b);
    expect(createCalls(pp)).toHaveLength(2); // the failed attempt and one resend

    // Two processes: each resends, with the stored key.
    const pp2 = fakePayPal();
    pp2.failNextCreate = { status: 503, body: { name: 'SERVICE_UNAVAILABLE' } };
    const fx = await approvedPlan();
    await expect(fx.pipeline.execute(fx.planId, pp2.client, PAYEES, { reporting: null })).rejects.toMatchObject({ status: 503 });
    const other = sibling(fx.pipeline);
    const [c, d] = await Promise.all([fx.pipeline.execute(fx.planId, pp2.client, PAYEES, { reporting: null }), other.execute(fx.planId, pp2.client, PAYEES, { reporting: null })]);
    const calls = createCalls(pp2);
    expect(calls).toHaveLength(3);
    const key = fx.pipeline.ledger.getBatch(c.id)!.paypal_request_id;
    expect(calls.every((r) => r.requestId === key)).toBe(true);
    expect(c.paypal_batch_id).toBe(d.paypal_batch_id);
    expect(pp2.sent).toHaveLength(7); // PayPal de-duplicated the request id
    expect(fx.pipeline.ledger.poolBalanceCents()).toBe(5_000_00 - GOOD_PLAN_TOTAL_CENTS);
  });
});

describe('idempotency keys: per database in the demo, from the verdict elsewhere', () => {
  it.each([
    [{}, 'database'],
    [{ DEMO_MODE: 'replay' }, 'database'],
    [{ DEMO_MODE: 'live' }, 'verdict'],
    [{ DEMO_MODE: 'live', FIRSTLIGHT_RESETTABLE_DEMO: 'true' }, 'database'],
    [{ DEMO_MODE: 'replay', FIRSTLIGHT_RESETTABLE_DEMO: 'false' }, 'verdict'],
    [{ FIRSTLIGHT_RESETTABLE_DEMO: '0' }, 'verdict'],
    [{ DEMO_MODE: 'live', FIRSTLIGHT_RESETTABLE_DEMO: 'maybe' }, 'verdict'],
  ] as const)('env %j → %s', (env, scope) => {
    expect(idempotencyScopeFromEnv(env)).toBe(scope);
  });

  /** Execute the same approved plan on a brand-new database, against `pp`. */
  async function freshRun(pp: FakePayPal) {
    const { pipeline, planId, verdict } = await approvedPlan();
    const batch = await pipeline.execute(planId, pp.client, PAYEES, { reporting: null });
    const created = pipeline.audit.entries().find((e) => e.type === 'paypal.payout.created')!;
    const senderBatchId = (created.payload as { request: { sender_batch_header: { sender_batch_id: string } } }).request.sender_batch_header.sender_batch_id;
    return { batch, verdict, senderBatchId };
  }

  it('demo (default): a reset database gets fresh keys, so the replayed quake pays again in the sandbox', async () => {
    vi.stubEnv('DEMO_MODE', 'replay');
    vi.stubEnv('FIRSTLIGHT_RESETTABLE_DEMO', '');
    const pp = fakePayPal();
    const one = await freshRun(pp);
    const two = await freshRun(pp);
    expect(one.batch.paypal_request_id).not.toBe(two.batch.paypal_request_id);
    expect(one.batch.paypal_request_id).not.toBe(one.verdict.paypalRequestId);
    expect(one.senderBatchId).toMatch(new RegExp(`^firstlight-${EVENT_ID}-v1-[0-9a-f]{8}$`));
    expect(one.senderBatchId).not.toBe(two.senderBatchId);
    expect(pp.sent).toHaveLength(14);
  });

  it('not a demo: a lost database derives the same keys, so PayPal answers with the first batch and pays once', async () => {
    vi.stubEnv('DEMO_MODE', 'live');
    vi.stubEnv('FIRSTLIGHT_RESETTABLE_DEMO', '');
    const pp = fakePayPal();
    const one = await freshRun(pp);
    const two = await freshRun(pp);
    expect(one.batch.paypal_request_id).toBe(one.verdict.paypalRequestId);
    expect(two.batch.paypal_request_id).toBe(one.batch.paypal_request_id);
    expect(one.senderBatchId).toBe(`firstlight-${EVENT_ID}-${one.verdict.paypalRequestId!.slice(0, 32)}`);
    expect(two.senderBatchId).toBe(one.senderBatchId);
    expect(two.batch.paypal_batch_id).toBe(one.batch.paypal_batch_id);
    expect(pp.sent).toHaveLength(7);
  });

  it('PayPal saying the batch is a duplicate keeps the money reserved instead of marking it failed', async () => {
    vi.stubEnv('DEMO_MODE', 'live');
    const { pipeline, planId } = await approvedPlan();
    const pp = fakePayPal();
    pp.failNextCreate = { status: 400, body: { name: 'DUPLICATE_REQUEST_ID', message: 'already used' } };
    await expect(pipeline.execute(planId, pp.client, PAYEES, { reporting: null })).rejects.toMatchObject({ status: 400 });
    const batch = pipeline.ledger.getBatchByDigest(pipeline.verdict(planId)!.digest)!;
    expect(batch.status).toBe('SUBMIT_UNKNOWN');
    expect(pipeline.ledger.batchItems(batch.id).every((i) => i.status === 'RESERVED')).toBe(true);
    expect(pipeline.ledger.poolBalanceCents()).toBe(5_000_00 - GOOD_PLAN_TOTAL_CENTS);
    expect(pipeline.audit.entries().at(-1)!.payload).toMatchObject({ definitive: false, duplicateAtPayPal: true });
  });
});
