import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/ledger/db';
import { DONATION_EVENT_TYPES, donationWebhookOf } from '../src/paypal/webhooks';
import { captureResource, deliver, donationSetup, refundResource, verifyingPayPal } from './helpers/donation-fixture';

/** Create and capture a donation through the return-URL path. */
async function captured(ctx: ReturnType<typeof donationSetup>, usd: number) {
  const d = await ctx.svc.create({ amount_usd: usd, donor_ref: 'donor' }, 'human');
  const row = await ctx.svc.capture(d.receiptId, d.orderId);
  return { ...d, captureId: row.capture_id! };
}

const types = (ctx: ReturnType<typeof donationSetup>) => ctx.pipeline.audit.entries().map((e) => e.type);
const last = (ctx: ReturnType<typeof donationSetup>, type: string) => ctx.pipeline.audit.entries().filter((e) => e.type === type).at(-1)?.payload as Record<string, unknown> | undefined;

// ── parsing (defensive) ────────────────────────────────────────────────────

describe('donation webhook parsing', () => {
  it.each([
    ['refund with an up link', { id: 'E1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refundResource('REF123456', 'CAP123456', '5.00') }, { kind: 'refund', captureId: 'CAP123456', refId: 'REF123456', amountCents: 500 }],
    ['reversal with a negative amount', { id: 'E2', event_type: 'PAYMENT.CAPTURE.REVERSED', resource: refundResource('REV123456', 'CAP123456', '-2.50') }, { kind: 'reversal', captureId: 'CAP123456', amountCents: 250 }],
    [
      'refund shaped as the capture itself',
      { id: 'E3', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'CAP777777', status: 'REFUNDED', amount: { value: '9.00' }, links: [{ rel: 'self', href: 'https://api.sandbox.paypal.com/v2/payments/captures/CAP777777' }] } },
      { kind: 'refund', captureId: 'CAP777777', refId: null, amountCents: null },
    ],
    ['order approved', { id: 'E4', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORDER00000001', status: 'APPROVED' } }, { kind: 'order_approved', orderId: 'ORDER00000001' }],
    ['capture denied with reason', { id: 'E5', event_type: 'PAYMENT.CAPTURE.DENIED', resource: captureResource('CAP555555', 'ORDER00000001', '5.00', 'DECLINED', 'RISK') }, { kind: 'capture_denied', captureId: 'CAP555555', orderId: 'ORDER00000001', reason: 'RISK' }],
  ])('%s', (_n, ev, expected) => {
    expect(donationWebhookOf(ev)).toMatchObject(expected);
  });

  it.each([
    ['capture id with odd characters', { id: 'E6', event_type: 'PAYMENT.CAPTURE.DENIED', resource: { id: '../../etc' } }],
    ['no order id', { id: 'E7', event_type: 'CHECKOUT.ORDER.APPROVED', resource: {} }],
    ['unrelated event', { id: 'E8', event_type: 'BILLING.SUBSCRIPTION.CREATED', resource: { id: 'SUB1234567' } }],
  ])('ignores %s', (_n, ev) => {
    expect(donationWebhookOf(ev)).toBeNull();
  });

  it('every handled event type is registered by the webhook script', async () => {
    const src = (await import('node:fs')).readFileSync(join(import.meta.dirname, '..', 'scripts', 'register-webhook.ts'), 'utf8');
    expect(src).toContain('...DONATION_EVENT_TYPES');
    expect(DONATION_EVENT_TYPES).toEqual(expect.arrayContaining(['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED']));
  });
});

// ── refunds and reversals ──────────────────────────────────────────────────

describe('refunds and reversals', () => {
  it('a full refund debits the pool once per PayPal refund id and marks the donation refunded', async () => {
    const ctx = donationSetup();
    const d = await captured(ctx, 20);
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_020_00);

    await deliver(ctx, { id: 'WH-R1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refundResource('REF000001', d.captureId, '20.00') });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(ctx.svc.get(d.receiptId)).toMatchObject({ status: 'REFUNDED', refunded_cents: 20_00 });
    expect(last(ctx, 'donation.refunded')).toMatchObject({ receiptId: d.receiptId, captureId: d.captureId, paypalRefId: 'REF000001', amountCents: 20_00, totalReturnedCents: 20_00 });

    // Same delivery retried, and the same refund under a new event id: no second debit.
    expect((await deliver(ctx, { id: 'WH-R1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refundResource('REF000001', d.captureId, '20.00') })).body).toMatchObject({ duplicate: true });
    await deliver(ctx, { id: 'WH-R1-again', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refundResource('REF000001', d.captureId, '20.00') });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(types(ctx).filter((t) => t === 'donation.refunded')).toHaveLength(1);

    // The receipt and pool totals reflect it.
    expect(ctx.svc.receipt(d.receiptId)).toMatchObject({ status: 'REFUNDED', refundedUsd: '20.00' });
    expect(ctx.svc.receipt(d.receiptId)!.audit.lifecycle.map((e) => e.type)).toEqual(['donation.refunded']);
    expect(ctx.svc.poolStatus()).toMatchObject({ donationsCents: 0, donationsCount: 0 });
  });

  it('partial refunds add up, and never more than was donated is taken back', async () => {
    const ctx = donationSetup();
    const d = await captured(ctx, 20);
    await deliver(ctx, { id: 'WH-P1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refundResource('REF000010', d.captureId, '5.00') });
    expect(ctx.svc.get(d.receiptId)).toMatchObject({ status: 'PARTIALLY_REFUNDED', refunded_cents: 5_00 });
    expect(ctx.svc.poolStatus().donationsCents).toBe(15_00);

    await deliver(ctx, { id: 'WH-P2', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refundResource('REF000011', d.captureId, '15.00') });
    expect(ctx.svc.get(d.receiptId)).toMatchObject({ status: 'REFUNDED', refunded_cents: 20_00 });

    await deliver(ctx, { id: 'WH-P3', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refundResource('REF000012', d.captureId, '5.00') });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(last(ctx, 'donation.refunded')).toMatchObject({ amountCents: 0, exceedsDonation: { askedCents: 5_00, recordedCents: 0 } });
  });

  it('a reversal (chargeback) debits the pool and marks the donation reversed', async () => {
    const ctx = donationSetup();
    const d = await captured(ctx, 12.5);
    await deliver(ctx, { id: 'WH-V1', event_type: 'PAYMENT.CAPTURE.REVERSED', resource: refundResource('REV000001', d.captureId, '-12.50') });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(ctx.svc.get(d.receiptId)?.status).toBe('REVERSED');
    expect(last(ctx, 'donation.reversed')).toMatchObject({ amountCents: 12_50, paypalRefId: 'REV000001' });
  });

  it('a refund that the pool can no longer cover is booked and flagged, not hidden', async () => {
    const ctx = donationSetup({ poolCents: 1_00 });
    const d = await captured(ctx, 50);
    // Pay everything out, so the pool is empty when the refund lands.
    ctx.pipeline.ledger.reservePayoutBatch({ eventId: 'us6000u18k', planVersion: 1, paypalRequestId: 'req-drain', verdictDigest: 'digest-drain', items: [{ recipientId: 'rcp_01', amountCents: 51_00 }] });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(0);

    await deliver(ctx, { id: 'WH-N1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refundResource('REF000020', d.captureId, '50.00') });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(-50_00);
    expect(last(ctx, 'donation.refunded')).toMatchObject({ flag: 'POOL_NEGATIVE', poolShortfallCents: 50_00, poolBalanceAfterCents: -50_00 });
    // And the firewall's ledger reserve refuses anything while the pool is negative.
    expect(() =>
      ctx.pipeline.ledger.reservePayoutBatch({ eventId: 'us6000u18k', planVersion: 2, paypalRequestId: 'req-next', verdictDigest: 'digest-next', items: [{ recipientId: 'rcp_02', amountCents: 1_00 }] }),
    ).toThrow(/pool has/);
  });

  it('a late COMPLETED after a refund does not undo the refund', async () => {
    const ctx = donationSetup();
    const d = await captured(ctx, 10);
    await deliver(ctx, { id: 'WH-L1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refundResource('REF000030', d.captureId, '10.00') });
    await deliver(ctx, { id: 'WH-L2', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: captureResource(d.captureId, d.orderId, '10.00') });
    expect(ctx.svc.get(d.receiptId)?.status).toBe('REFUNDED');
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
  });

  it('a refund for a capture we only knew as pending books the credit first, then the refund', async () => {
    const ctx = donationSetup();
    const d = await ctx.svc.create({ amount_usd: 8, donor_ref: 'donor' }, 'human');
    await deliver(ctx, { id: 'WH-Q1', event_type: 'PAYMENT.CAPTURE.PENDING', resource: captureResource('CAPQ00001', d.orderId, '8.00', 'PENDING', 'PENDING_REVIEW') });
    await deliver(ctx, { id: 'WH-Q2', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refundResource('REF000040', 'CAPQ00001', '8.00') });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(ctx.svc.get(d.receiptId)?.status).toBe('REFUNDED');
    expect(types(ctx)).toEqual(expect.arrayContaining(['donation.capture_pending', 'donation.captured', 'donation.refunded']));
  });

  it('refunds for captures Firstlight never saw are ignored', async () => {
    const ctx = donationSetup();
    const out = await deliver(ctx, { id: 'WH-U1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refundResource('REF000050', 'CAPUNKNOWN1', '5.00') });
    expect(out.status).toBe(200);
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
  });
});

// ── pending and denied captures ────────────────────────────────────────────

describe('pending and denied captures', () => {
  it('PENDING records the status and credits nothing; COMPLETED later credits once', async () => {
    const ctx = donationSetup();
    const d = await ctx.svc.create({ amount_usd: 15, donor_ref: 'donor' }, 'human');
    await deliver(ctx, { id: 'WH-PE1', event_type: 'PAYMENT.CAPTURE.PENDING', resource: captureResource('CAPPEND01', d.orderId, '15.00', 'PENDING', 'PENDING_REVIEW') });
    expect(ctx.svc.get(d.receiptId)).toMatchObject({ status: 'PENDING', capture_id: 'CAPPEND01' });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(last(ctx, 'donation.capture_pending')).toMatchObject({ receiptId: d.receiptId, reason: 'PENDING_REVIEW' });

    await deliver(ctx, { id: 'WH-PE2', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: captureResource('CAPPEND01', d.orderId, '15.00') });
    expect(ctx.svc.get(d.receiptId)?.status).toBe('CAPTURED');
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_015_00);
  });

  it('a return-URL capture that PayPal leaves PENDING is recorded as pending, not credited', async () => {
    const ctx = donationSetup({ orders: { captureStatus: 'PENDING' } });
    const d = await ctx.svc.create({ amount_usd: 15, donor_ref: 'donor' }, 'human');
    expect((await ctx.svc.capture(d.receiptId)).status).toBe('PENDING');
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
  });

  it('DENIED after PENDING: never credited, and the allowance gets its room back', async () => {
    const ctx = donationSetup();
    const a = ctx.allowance('agent', 20);
    const d = await ctx.svc.create({ amount_usd: 15, allowance_token: a.allowanceToken }, 'agent');
    await deliver(ctx, { id: 'WH-D1', event_type: 'PAYMENT.CAPTURE.PENDING', resource: captureResource('CAPDENY01', d.orderId, '15.00', 'PENDING') });
    expect(ctx.svc.allowanceForToken(a.allowanceToken)?.remainingUsd).toBe('5.00');
    await deliver(ctx, { id: 'WH-D2', event_type: 'PAYMENT.CAPTURE.DENIED', resource: captureResource('CAPDENY01', d.orderId, '15.00', 'DECLINED') });
    expect(ctx.svc.get(d.receiptId)?.status).toBe('DENIED');
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(last(ctx, 'donation.denied')).toMatchObject({ receiptId: d.receiptId, creditReversedCents: 0, allowanceId: a.allowanceId });
    expect(ctx.svc.allowanceForToken(a.allowanceToken)?.remainingUsd).toBe('20.00');
    await expect(ctx.svc.capture(d.receiptId)).rejects.toMatchObject({ code: 'NOT_CAPTURABLE' });
  });

  it('DENIED for a capture that was already credited reverses the credit', async () => {
    const ctx = donationSetup();
    const d = await captured(ctx, 30);
    await deliver(ctx, { id: 'WH-D3', event_type: 'PAYMENT.CAPTURE.DENIED', resource: captureResource(d.captureId, d.orderId, '30.00', 'DECLINED') });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(last(ctx, 'donation.denied')).toMatchObject({ creditReversedCents: 30_00 });
    // Delivered again under a new event id: nothing more.
    await deliver(ctx, { id: 'WH-D4', event_type: 'PAYMENT.CAPTURE.DENIED', resource: captureResource(d.captureId, d.orderId, '30.00', 'DECLINED') });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(types(ctx).filter((t) => t === 'donation.denied')).toHaveLength(1);
  });
});

// ── approved on PayPal, never came back ────────────────────────────────────

describe('CHECKOUT.ORDER.APPROVED', () => {
  it('captures server-side through the same idempotent path as the return URL', async () => {
    const ctx = donationSetup();
    const d = await ctx.svc.create({ amount_usd: 25, donor_ref: 'walked-away' }, 'human');
    await deliver(ctx, { id: 'WH-A1', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: d.orderId, status: 'APPROVED' } });
    expect(ctx.svc.get(d.receiptId)?.status).toBe('CAPTURED');
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_025_00);

    // The donor comes back after all, and PayPal also sends COMPLETED: still one credit, one capture call.
    await ctx.svc.capture(d.receiptId, d.orderId);
    await deliver(ctx, { id: 'WH-A2', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: captureResource(ctx.svc.get(d.receiptId)!.capture_id!, d.orderId, '25.00') });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_025_00);
    expect(ctx.fake.calls.capture).toHaveLength(1);
    expect(types(ctx).filter((t) => t === 'donation.captured')).toHaveLength(1);
  });

  it('does nothing for a cancelled donation (e.g. its allowance was revoked)', async () => {
    const ctx = donationSetup();
    const a = ctx.allowance('revoked-agent', 20);
    const d = await ctx.svc.create({ amount_usd: 5, allowance_token: a.allowanceToken }, 'agent');
    ctx.svc.revokeAllowance(a.allowanceId, a.allowanceToken);
    const out = await deliver(ctx, { id: 'WH-A3', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: d.orderId, status: 'APPROVED' } });
    expect(out.status).toBe(200);
    expect(ctx.fake.calls.capture).toHaveLength(0);
    expect(ctx.svc.get(d.receiptId)?.status).toBe('CANCELED');
  });

  it('if the capture fails, the delivery is forgotten so PayPal’s retry is processed', async () => {
    const ctx = donationSetup({ orders: { failCapture: true } });
    const d = await ctx.svc.create({ amount_usd: 5, donor_ref: 'donor' }, 'human');
    const ev = { id: 'WH-A4', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: d.orderId, status: 'APPROVED' } };
    await expect(deliver(ctx, ev)).rejects.toThrow(/capture/);
    expect(ctx.db.prepare('SELECT 1 FROM webhook_events WHERE id = ?').get('WH-A4')).toBeUndefined();

    ctx.fake.opts.failCapture = false;
    const retry = await deliver(ctx, ev);
    expect(retry.body).toMatchObject({ ok: true });
    expect(ctx.svc.get(d.receiptId)?.status).toBe('CAPTURED');
  });

  it('an unverified delivery changes nothing', async () => {
    const ctx = donationSetup();
    const d = await ctx.svc.create({ amount_usd: 5, donor_ref: 'donor' }, 'human');
    const out = await deliver(ctx, { id: 'WH-A5', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: d.orderId } }, verifyingPayPal('FAILURE'));
    expect(out.status).toBe(401);
    expect(ctx.fake.calls.capture).toHaveLength(0);
  });
});

// ── migration of an older database ────────────────────────────────────────

describe('ledger and donation migrations', () => {
  it('widens the ledger kind CHECK and adds the donation columns, keeping the data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'firstlight-migrate-'));
    const path = join(dir, 'old.db');
    try {
      const old = new Database(path);
      old.exec(`
        CREATE TABLE ledger_entries (id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL CHECK (kind IN ('donation_credit','payout_debit','payout_reversal','seed_credit')),
          amount_cents INTEGER NOT NULL, ref TEXT NOT NULL, created_ms INTEGER NOT NULL, UNIQUE (kind, ref));
        INSERT INTO ledger_entries (kind, amount_cents, ref, created_ms) VALUES ('seed_credit', 500000, 'seed', 1), ('donation_credit', 500, 'CAP1', 2);
        CREATE TABLE donations (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id TEXT NOT NULL UNIQUE,
          source TEXT NOT NULL CHECK (source IN ('human','agent')), donor_ref TEXT NOT NULL, message TEXT,
          amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), idempotency_key TEXT, order_id TEXT UNIQUE, approval_url TEXT,
          capture_id TEXT UNIQUE, status TEXT NOT NULL, created_ms INTEGER NOT NULL, captured_ms INTEGER, UNIQUE (donor_ref, idempotency_key));
        INSERT INTO donations (receipt_id, source, donor_ref, amount_cents, status, created_ms) VALUES ('rcpt_0000000000000001', 'agent', 'samaritan-agent', 500, 'CAPTURED', 2);
      `);
      old.close();

      const db = openDb(path);
      expect((db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS b FROM ledger_entries').get() as { b: number }).b).toBe(500_500);
      db.prepare("INSERT INTO ledger_entries (kind, amount_cents, ref, created_ms) VALUES ('donation_refund', -500, 'refund:R1', 3)").run();
      expect(db.prepare('SELECT allowance_id, refunded_cents FROM donations').get()).toEqual({ allowance_id: null, refunded_cents: 0 });
      db.close();
      // Opening again is a no-op.
      openDb(path).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
