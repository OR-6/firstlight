import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as getRecorded } from '@/app/api/reconcile/recorded/route';
import { openDb } from '../src/ledger/db';
import { Ledger } from '../src/ledger/ledger';
import { PAYPAL_SANDBOX_BASE_URL, PayPalClient, type FetchLike } from '../src/paypal/client';
import type { PayoutBatchDetails } from '../src/paypal/payouts';
import { RECORDED_BATCHES, RecordedBatchChecker, compareRecorded, type RecordedView } from '../src/paypal/recorded';
import { UNCLAIMED_RETURN_MS, batchClock } from '../src/paypal/timings';
import { EVENT_ID, GOOD_PLAN, GOOD_PLAN_TOTAL_CENTS, PAYEES, fakePayPal, makePipeline, replayInput, scriptedAgent } from './helpers/pipeline-fixture';

const CONFIG = { baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: 'a', clientSecret: 'b' };
const RECIPIENTS = GOOD_PLAN.items.map((i) => i.recipientId);
const AMOUNTS: Record<string, string> = { rcp_01: '120.00', rcp_02: '120.00', rcp_03: '80.00', rcp_04: '120.00', rcp_05: '80.00', rcp_06: '120.00', rcp_07: '40.00' };

/** A batch GET shaped like the real sandbox answer for 9GE626X9SA3NE (probed 2026-11-08). */
function batchBody(o: { id?: string; status?: string; itemStatus?: string | ((r: string) => string); fees?: string | null; total?: string; items?: string[] } = {}): PayoutBatchDetails {
  const items = o.items ?? RECIPIENTS;
  return {
    batch_header: {
      payout_batch_id: o.id ?? 'SIMBATCH1',
      batch_status: o.status ?? 'SUCCESS',
      time_created: '2026-11-08T15:38:41Z',
      time_completed: '2026-11-08T15:39:15Z',
      amount: { currency: 'USD', value: o.total ?? '680.00' },
      ...(o.fees === null ? {} : { fees: { currency: 'USD', value: o.fees ?? '1.75' } }),
    } as PayoutBatchDetails['batch_header'],
    items: items.map((r, n) => ({
      payout_item_id: `ITEM${n}`,
      transaction_id: `TX${n}`,
      transaction_status: typeof o.itemStatus === 'function' ? o.itemStatus(r) : (o.itemStatus ?? 'SUCCESS'),
      payout_item: { sender_item_id: `${EVENT_ID}:${r}`, amount: { currency: 'USD', value: AMOUNTS[r] ?? '1.00' } },
    })),
  };
}

/** PayPal stub that answers OAuth and batch GETs from `answer(id)`, counting GETs. */
function stubPayPal(answer: (id: string) => { status: number; body: unknown }) {
  const gets: string[] = [];
  const impl: FetchLike = async (url, init) => {
    const path = url.replace(PAYPAL_SANDBOX_BASE_URL, '');
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (path === '/v1/oauth2/token') return reply(200, { access_token: 't', expires_in: 3600, scope: 'https://uri.paypal.com/payments/payouts' });
    const m = /^\/v1\/payments\/payouts\/(\w+)$/.exec(path);
    if (init.method === 'GET' && m) {
      gets.push(m[1]!);
      const a = answer(m[1]!);
      return reply(a.status, a.body);
    }
    return reply(404, { name: 'NOT_FOUND' });
  };
  return { client: new PayPalClient(CONFIG, impl), gets };
}

async function sentBatch() {
  const fx = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
  const a = await fx.pipeline.assess(replayInput());
  fx.advance(90_000);
  fx.pipeline.decide(a.planId, 'approve', 'ops', 'checked USGS');
  fx.advance(10_000);
  const batch = await fx.pipeline.execute(a.planId, fakePayPal().client, PAYEES, { reporting: null });
  return { ...fx, planId: a.planId, batch };
}

describe('PayPal fees in the pool ledger', () => {
  it('books a batch fee once, and only the difference when PayPal reports a new total', () => {
    const ledger = new Ledger(openDb());
    ledger.seedCredit('seed', 1_000_00);
    expect(ledger.bookPayoutFee('9GE626X9SA3NE', 175)).toEqual({ bookedCents: 175, totalFeeCents: 175, balanceAfterCents: 1_000_00 - 175 });
    expect(ledger.bookPayoutFee('9GE626X9SA3NE', 175).bookedCents).toBe(0);
    expect(ledger.poolBalanceCents()).toBe(1_000_00 - 175);
    // A fee given back on a returned item: the correction is a credit.
    expect(ledger.bookPayoutFee('9GE626X9SA3NE', 150).bookedCents).toBe(-25);
    expect(ledger.payoutFeeCents('9GE626X9SA3NE')).toBe(150);
    expect(ledger.poolBalanceCents()).toBe(1_000_00 - 150);
    expect(ledger.payoutFeeCents('DZCFDP9FFEUV8')).toBe(0);
    expect(ledger.snapshot().poolBalanceCents).toBe(1_000_00 - 150);
  });

  it('refuses a negative or fractional fee and a malformed batch id', () => {
    const ledger = new Ledger(openDb());
    expect(() => ledger.bookPayoutFee('9GE626X9SA3NE', -1)).toThrow(RangeError);
    expect(() => ledger.bookPayoutFee('9GE626X9SA3NE', 1.5)).toThrow(RangeError);
    expect(() => ledger.bookPayoutFee("x' OR 1=1 --", 1)).toThrow(/invalid/);
  });

  it('a database created before payout_fee existed is migrated in place, keeping its entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fl-fee-'));
    try {
      const path = join(dir, 'old.db');
      const old = new Database(path);
      old.exec(`CREATE TABLE ledger_entries (id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('donation_credit','donation_refund','donation_reversal','payout_debit','payout_reversal','seed_credit')),
        amount_cents INTEGER NOT NULL, ref TEXT NOT NULL, created_ms INTEGER NOT NULL, UNIQUE (kind, ref));
        INSERT INTO ledger_entries (kind, amount_cents, ref, created_ms) VALUES ('seed_credit', 500000, 'seed', 1);`);
      old.close();
      const ledger = new Ledger(openDb(path));
      expect(ledger.poolBalanceCents()).toBe(5_000_00);
      ledger.bookPayoutFee('9GE626X9SA3NE', 175);
      expect(ledger.poolBalanceCents()).toBe(5_000_00 - 175);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('poll() books batch_header.fees once per batch and audits it; the firewall sees the lower pool', async () => {
    const { pipeline, batch } = await sentBatch();
    const pp = stubPayPal(() => ({ status: 200, body: batchBody() }));
    await pipeline.poll(batch.id, pp.client);
    await pipeline.poll(batch.id, pp.client);
    await pipeline.poll(batch.id, pp.client);
    const after = 5_000_00 - GOOD_PLAN_TOTAL_CENTS - 175;
    expect(pipeline.ledger.poolBalanceCents()).toBe(after);
    expect(pipeline.ledger.snapshot().poolBalanceCents).toBe(after);
    const fees = pipeline.audit.entries().filter((e) => e.type === 'payout.fee_booked');
    expect(fees).toHaveLength(1);
    expect(fees[0]!.payload).toEqual({ batchId: batch.id, paypalBatchId: 'SIMBATCH1', feeCents: 175, bookedCents: 175, poolBalanceCents: after });
    expect(pipeline.audit.verify().ok).toBe(true);
  });

  it('no fees field, a zero fee or a non-USD fee books nothing', async () => {
    for (const body of [batchBody({ fees: null }), batchBody({ fees: '0.00' }), { ...batchBody(), batch_header: { ...batchBody().batch_header, fees: { currency: 'EUR', value: '1.00' } } }]) {
      const { pipeline, batch } = await sentBatch();
      await pipeline.poll(batch.id, stubPayPal(() => ({ status: 200, body })).client);
      expect(pipeline.ledger.poolBalanceCents()).toBe(5_000_00 - GOOD_PLAN_TOTAL_CENTS);
      expect(pipeline.audit.entries().some((e) => e.type === 'payout.fee_booked')).toBe(false);
    }
  });

  it('a fee that takes the pool below zero is still booked, and flagged', async () => {
    const fx = makePipeline({ llm: scriptedAgent(GOOD_PLAN), poolCents: GOOD_PLAN_TOTAL_CENTS });
    const a = await fx.pipeline.assess(replayInput());
    fx.pipeline.decide(a.planId, 'approve', 'ops', 'ok');
    const batch = await fx.pipeline.execute(a.planId, fakePayPal().client, PAYEES, { reporting: null });
    await fx.pipeline.poll(batch.id, stubPayPal(() => ({ status: 200, body: batchBody() })).client);
    expect(fx.pipeline.ledger.poolBalanceCents()).toBe(-175);
    expect(fx.pipeline.audit.entries().at(-1)!.payload).toMatchObject({ flag: 'POOL_NEGATIVE', poolBalanceCents: -175 });
  });
});

describe('end-to-end clock from the audit log', () => {
  it('measures assessed → approved → sent → all paid', async () => {
    const { pipeline, planId, batch, advance } = await sentBatch();
    const pp = stubPayPal(() => ({ status: 200, body: batchBody({ status: 'PROCESSING', itemStatus: 'PENDING' }) }));
    advance(5_000);
    await pipeline.poll(batch.id, pp.client); // batch status change only
    let clock = batchClock(pipeline.audit.entries(), { planId, batchId: batch.id, paypalBatchId: 'SIMBATCH1', recipientIds: RECIPIENTS });
    expect(clock.finishedMs).toBeNull();

    advance(20_000);
    await pipeline.poll(batch.id, stubPayPal(() => ({ status: 200, body: batchBody({ itemStatus: (r) => (r === 'rcp_07' ? 'PENDING' : 'SUCCESS') }) })).client);
    clock = batchClock(pipeline.audit.entries(), { planId, batchId: batch.id, paypalBatchId: 'SIMBATCH1', recipientIds: RECIPIENTS });
    expect(clock.finishedMs).toBeNull(); // terminal batch, one item still pending

    advance(4_000);
    await pipeline.poll(batch.id, stubPayPal(() => ({ status: 200, body: batchBody() })).client);
    clock = batchClock(pipeline.audit.entries(), { planId, batchId: batch.id, paypalBatchId: 'SIMBATCH1', recipientIds: RECIPIENTS });
    expect(clock.sentMs! - clock.approvedMs!).toBe(10_000);
    expect(clock.approvedMs! - clock.assessedMs!).toBe(90_000);
    expect(clock.finishedMs! - clock.sentMs!).toBe(29_000);
    expect(clock.allPaid).toBe(true);
  });

  it('an unclaimed item counts as final but not paid; webhooks are counted; a plan without approval has none', () => {
    const e = (type: string, tsMs: number, payload: unknown) => ({ type, tsMs, payload });
    const entries = [
      e('firewall.verdict', 1_000, { planId: 4 }),
      e('paypal.payout.created', 2_000, { planId: 4, batchId: 2 }),
      e('paypal.payout.status', 3_000, { batchId: 9, batchStatus: 'SUCCESS', changes: [{ recipientId: 'rcp_01', to: 'SUCCESS' }] }), // another batch
      e('paypal.webhook', 3_500, { payoutBatchId: 'B2' }),
      e('paypal.payout.status', 4_000, { batchId: 2, batchStatus: 'SUCCESS', changes: [{ recipientId: 'rcp_01', to: 'SUCCESS' }, { recipientId: 'rcp_02', to: 'UNCLAIMED' }] }),
      e('paypal.webhook', 4_500, { payoutBatchId: 'B2' }),
    ];
    expect(batchClock(entries, { planId: 4, batchId: 2, paypalBatchId: 'B2', recipientIds: ['rcp_01', 'rcp_02'] })).toEqual({
      assessedMs: 1_000,
      approvedMs: null,
      sentMs: 2_000,
      finishedMs: 4_000,
      allPaid: false,
      webhooks: 2,
      firstWebhookMs: 3_500,
    });
    expect(UNCLAIMED_RETURN_MS).toBe(30 * 24 * 3_600_000);
  });
});

describe('recorded sandbox batches compared with PayPal now', () => {
  const nineGe = RECORDED_BATCHES.find((b) => b.paypalBatchId === '9GE626X9SA3NE')!;

  it('matches when PayPal reports SUCCESS, 7 items, $680, every item SUCCESS; carries fees and PayPal timestamps', () => {
    const c = compareRecorded(nineGe, batchBody({ id: '9GE626X9SA3NE' }), 42);
    expect(c).toMatchObject({
      state: 'matches',
      batchStatus: 'SUCCESS',
      itemCount: 7,
      itemStatuses: { SUCCESS: 7 },
      totalCents: 680_00,
      feesCents: 175,
      createdMs: Date.parse('2026-11-08T15:38:41Z'),
      completedMs: Date.parse('2026-11-08T15:39:15Z'),
      differences: [],
      checkedMs: 42,
    });
  });

  it('lists what differs from the record', () => {
    const c = compareRecorded(nineGe, batchBody({ total: '560.00', items: RECIPIENTS.slice(1), itemStatus: (r) => (r === 'rcp_02' ? 'RETURNED' : 'SUCCESS') }), 0);
    expect(c.state).toBe('differences');
    if (c.state !== 'differences') return;
    expect(c.differences.map((d) => d.field).sort()).toEqual(['batch_total', 'item_count', 'status']);
    expect(c.differences.find((d) => d.field === 'status')).toMatchObject({ recipientId: 'rcp_02', paypal: 'RETURNED' });
    expect(c.itemStatuses).toEqual({ RETURNED: 1, SUCCESS: 5 });
  });

  it('a batch PayPal has not finished is in progress, not a difference', () => {
    expect(compareRecorded(nineGe, batchBody({ status: 'PROCESSING', itemStatus: 'PENDING' }), 0).state).toBe('in_progress');
  });

  it('caches answers for 10 minutes: one GET per batch however often it is asked', async () => {
    let now = 1_000_000;
    const pp = stubPayPal((id) => ({ status: 200, body: batchBody({ id }) }));
    const checker = new RecordedBatchChecker(() => pp.client, { clock: () => now });
    const [a, b] = await Promise.all([checker.view(), checker.view()]); // one refresh at a time
    expect(a).toBe(b);
    expect(pp.gets).toEqual(RECORDED_BATCHES.map((r) => r.paypalBatchId));
    now += 9 * 60_000;
    await checker.view();
    expect(pp.gets).toHaveLength(4);
    now += 2 * 60_000;
    const later = await checker.view();
    expect(pp.gets).toHaveLength(8);
    expect(later.configured).toBe(true);
    expect(later.batches.find((x) => x.paypalBatchId === 'DHSSBZRTMH9DW')).toMatchObject({ state: 'differences' }); // $680 body for the $1 batch
  });

  it('PayPal unreachable or refusing: each batch says so, nothing throws, retried after a minute (not before)', async () => {
    let now = 0;
    let fail = true;
    const pp = stubPayPal(() => (fail ? { status: 503, body: { name: 'SERVICE_UNAVAILABLE' } } : { status: 200, body: batchBody() }));
    const checker = new RecordedBatchChecker(() => pp.client, { clock: () => now });
    const v = await checker.view();
    expect(v.batches.every((b) => b.state === 'unavailable')).toBe(true);
    expect(v.batches[0]).toMatchObject({ detail: 'PayPal answered HTTP 503 SERVICE_UNAVAILABLE.' });
    now += 30_000;
    await checker.view();
    expect(pp.gets).toHaveLength(4);
    fail = false;
    now += 31_000;
    expect((await checker.view()).batches.every((b) => b.state !== 'unavailable')).toBe(true);
    expect(pp.gets).toHaveLength(8);
  });

  it('never sends more GETs a minute than the cap, keeping the last answer for the rest', async () => {
    let now = 0;
    const pp = stubPayPal(() => ({ status: 500, body: {} }));
    const checker = new RecordedBatchChecker(() => pp.client, { clock: () => now, failureTtlMs: 0, maxCallsPerMinute: 6 });
    await checker.view();
    now += 1;
    const v = await checker.view();
    expect(pp.gets).toHaveLength(6);
    expect(v.batches.slice(2).every((b) => b.state === 'unavailable')).toBe(true);
    now += 60_001;
    await checker.view();
    expect(pp.gets).toHaveLength(10);
  });

  it('without credentials (or a client that cannot be built) it makes no call and reports unavailable', async () => {
    for (const make of [() => null, () => { throw new Error('no creds'); }]) {
      const v = await new RecordedBatchChecker(make).view();
      expect(v.configured).toBe(false);
      expect(v.batches).toHaveLength(4);
      expect(v.batches.every((b) => b.state === 'unavailable' && b.detail === 'PayPal sandbox credentials are not set on this server.')).toBe(true);
    }
  });
});

describe('GET /api/reconcile/recorded', () => {
  beforeAll(() => {
    vi.stubEnv('FIRSTLIGHT_DB', ':memory:');
    vi.stubEnv('PAYPAL_ENV', '');
    vi.stubEnv('PAYPAL_CLIENT_ID', '');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', '');
  });
  afterAll(() => vi.unstubAllEnvs());

  it('answers 200 with every batch "unavailable" when PayPal is not configured (never an error page)', async () => {
    const res = await getRecorded();
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecordedView;
    expect(body.configured).toBe(false);
    expect(body.batches.map((b) => b.paypalBatchId)).toEqual(['9GE626X9SA3NE', 'DZCFDP9FFEUV8', '2BQ585TNCTVDA', 'DHSSBZRTMH9DW']);
    expect(body.batches.every((b) => b.state === 'unavailable')).toBe(true);
  });
});
