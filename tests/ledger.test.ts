import { describe, expect, it } from 'vitest';
import { evaluatePlan, payableItems } from '../src/firewall/engine';
import { openDb } from '../src/ledger/db';
import { InsufficientPoolError, Ledger, normaliseItemStatus } from '../src/ledger/ledger';
import { EventStore } from '../src/signals/event-store';
import { parseUsgsFeature, toFirewallEvent } from '../src/signals/usgs';
import { CLEAN_ITEMS, EVENT_ID, NOW, ctx, plan, onlyPlanned } from './helpers/firewall-fixture';
import panama from '../fixtures/events/us6000u18k.fdsn.json' with { type: 'json' };

function setup(pool = 1_000_00) {
  let t = NOW;
  const db = openDb();
  const ledger = new Ledger(db, () => t);
  if (pool > 0) ledger.seedCredit('seed', pool);
  return { db, ledger, tick: (ms: number) => (t += ms) };
}

const batch = (over: Partial<Parameters<Ledger['reservePayoutBatch']>[0]> = {}) => ({
  eventId: EVENT_ID,
  planVersion: 1,
  paypalRequestId: 'req-1',
  verdictDigest: 'd'.repeat(64),
  items: [
    { recipientId: 'rcp_a10', amountCents: 120_00 },
    { recipientId: 'rcp_c250', amountCents: 40_00 },
  ],
  ...over,
});

describe('pool ledger', () => {
  it('a replayed donation capture does not double-credit', () => {
    const { ledger } = setup(0);
    expect(ledger.creditDonation('CAPTURE-9XY', 25_00)).toEqual({ credited: true });
    expect(ledger.creditDonation('CAPTURE-9XY', 25_00)).toEqual({ credited: false });
    expect(ledger.poolBalanceCents()).toBe(25_00);
  });

  it.each([0, -5, 1.5, Number.NaN])('rejects non-positive / non-integer amount %s', (amt) => {
    const { ledger } = setup(0);
    expect(() => ledger.creditDonation('x', amt)).toThrow(RangeError);
  });

  it('reserving a batch debits the pool atomically', () => {
    const { ledger } = setup();
    ledger.reservePayoutBatch(batch());
    expect(ledger.poolBalanceCents()).toBe(1_000_00 - 160_00);
    const snap = ledger.snapshot();
    expect(snap.payouts.map((p) => [p.recipientId, p.status])).toEqual([
      ['rcp_a10', 'RESERVED'],
      ['rcp_c250', 'RESERVED'],
    ]);
    expect(snap.batchTimes).toHaveLength(1);
  });

  it('insufficient pool: throws and writes nothing', () => {
    const { ledger } = setup(100_00);
    expect(() => ledger.reservePayoutBatch(batch())).toThrow(InsufficientPoolError);
    expect(ledger.poolBalanceCents()).toBe(100_00);
    expect(ledger.snapshot().payouts).toEqual([]);
  });

  it('database enforces one payout per (event, recipient) even if the firewall were bypassed', () => {
    const { ledger } = setup();
    ledger.reservePayoutBatch(batch());
    expect(() => ledger.reservePayoutBatch(batch({ paypalRequestId: 'req-2', items: [{ recipientId: 'rcp_a10', amountCents: 40_00 }] }))).toThrow(
      /UNIQUE/,
    );
    expect(ledger.poolBalanceCents()).toBe(1_000_00 - 160_00); // rolled back
  });

  it('database rejects a reused PayPal-Request-Id', () => {
    const { ledger } = setup();
    ledger.reservePayoutBatch(batch());
    expect(() => ledger.reservePayoutBatch(batch({ eventId: 'other', items: [{ recipientId: 'rcp_b120', amountCents: 80_00 }] }))).toThrow(/UNIQUE/);
  });

  it('failed or returned items are re-credited exactly once', () => {
    const { ledger } = setup();
    ledger.reservePayoutBatch(batch());
    ledger.setItemStatus(EVENT_ID, 'rcp_a10', 'FAILED');
    ledger.setItemStatus(EVENT_ID, 'rcp_a10', 'FAILED');
    ledger.setItemStatus(EVENT_ID, 'rcp_c250', 'SUCCESS');
    expect(ledger.poolBalanceCents()).toBe(1_000_00 - 40_00);
  });

  it.each([
    ['SUCCESS', 'SUCCESS', false],
    ['succeeded', 'SUCCESS', false], // webhook name vs transaction_status value
    ['HELD', 'ONHOLD', false],
    ['UNCLAIMED', 'UNCLAIMED', false],
    ['SOMETHING_NEW', 'PENDING', true],
    [undefined, 'PENDING', true],
  ])('normalises PayPal status %s → %s', (raw, status, unknown) => {
    expect(normaliseItemStatus(raw)).toEqual({ status, unknown });
  });

  it('snapshot feeds the firewall: a paid recipient cannot be paid again', () => {
    const { db, ledger } = setup();
    const ev = parseUsgsFeature(panama);
    if (!ev.ok) throw new Error(ev.error);
    new EventStore(db).upsert(ev.value);

    const c = onlyPlanned(ctx({ event: toFirewallEvent(ev.value), ledger: ledger.snapshot() }), CLEAN_ITEMS);
    const v1 = evaluatePlan(plan(CLEAN_ITEMS), c);
    expect(v1.overall).toBe('ALLOW');
    ledger.reservePayoutBatch(batch({ paypalRequestId: v1.paypalRequestId!, verdictDigest: v1.digest, items: payableItems(v1) }));

    const snap = ledger.snapshot();
    expect(snap.paidEvents.map((e) => e.eventId)).toEqual([EVENT_ID]);
    const v2 = evaluatePlan(plan(CLEAN_ITEMS), onlyPlanned(ctx({ event: toFirewallEvent(ev.value), ledger: snap }), CLEAN_ITEMS));
    expect(v2.overall).toBe('BLOCK');
    expect(v2.items.flatMap((i) => i.ruleTrace.map((r) => r.reasonCode))).toContain('ALREADY_PAID_FOR_EVENT');
  });
});
