import { describe, expect, it } from 'vitest';
import { openDb } from '../src/ledger/db';
import { ITEM_STATUSES, ITEM_TRANSITIONS, Ledger, RETURNS_TO_POOL, itemTransitionAllowed, type ItemStatus } from '../src/ledger/ledger';

const EVENT = 'us6000u18k';
const AMOUNT = 120_00;
const POOL = 1_000_00;

/** One reserved item of $120 in a $1,000 pool, optionally walked to `status` first. */
function item(status?: ItemStatus) {
  const db = openDb();
  const ledger = new Ledger(db, () => 1);
  ledger.seedCredit('seed', POOL);
  ledger.reservePayoutBatch({ eventId: EVENT, planVersion: 1, paypalRequestId: 'req', verdictDigest: 'd', items: [{ recipientId: 'rcp_01', amountCents: AMOUNT }] });
  if (status && status !== 'RESERVED') expect(ledger.setItemStatus(EVENT, 'rcp_01', status).applied).toBe(true);
  const set = (s: unknown) => ledger.setItemStatus(EVENT, 'rcp_01', s);
  const stored = () => ledger.batchItems(1)[0]!.status;
  return { db, ledger, set, stored };
}

/** What the pool should hold for an item that ends in `status`. */
const expectedPool = (status: ItemStatus) => POOL - AMOUNT + (RETURNS_TO_POOL.includes(status) ? AMOUNT : 0);

describe('payout item status only moves forward', () => {
  describe('every (stored, reported) pair', () => {
    const pairs = ITEM_STATUSES.flatMap((from) => ITEM_STATUSES.filter((to) => to !== 'RESERVED').map((to) => [from, to] as const));
    it.each(pairs)('%s then %s', (from, to) => {
      const { ledger, set, stored } = item(from);
      const u = set(to);
      const allowed = itemTransitionAllowed(from, to);
      expect(u.applied).toBe(allowed);
      expect(u.from).toBe(from);
      expect(u.reported).toBe(to);
      const final = allowed ? to : from;
      expect(u.status).toBe(final);
      expect(stored()).toBe(final);
      // Money follows the stored status, whatever happened before.
      expect(ledger.poolBalanceCents()).toBe(expectedPool(final));
      expect(ledger.itemCreditedCents(EVENT, 'rcp_01')).toBe(RETURNS_TO_POOL.includes(final) ? AMOUNT : 0);
      // Saying it again changes nothing.
      const again = set(to);
      expect(again.bookedCents).toBe(0);
      expect(ledger.poolBalanceCents()).toBe(expectedPool(final));
    });
  });

  it('in flight: RESERVED → PENDING → ONHOLD → PENDING → SUCCESS all apply, nothing is credited', () => {
    const { ledger, set } = item();
    for (const s of ['PENDING', 'ONHOLD', 'PENDING', 'SUCCESS'] as const) expect(set(s)).toMatchObject({ applied: true, status: s, bookedCents: 0 });
    expect(ledger.poolBalanceCents()).toBe(POOL - AMOUNT);
  });

  it.each(['UNCLAIMED', 'ONHOLD', 'PENDING', 'SOMETHING_NEW', undefined])('a stale %s after SUCCESS is refused', (stale) => {
    const { ledger, set, stored } = item('SUCCESS');
    expect(set(stale)).toMatchObject({ applied: false, status: 'SUCCESS', bookedCents: 0 });
    expect(stored()).toBe('SUCCESS');
    expect(ledger.poolBalanceCents()).toBe(POOL - AMOUNT);
  });

  it.each(['UNCLAIMED', 'ONHOLD', 'PENDING'] as const)('a stale %s after RETURNED is refused and the credit stays booked once', (stale) => {
    const { ledger, set, stored } = item('UNCLAIMED');
    expect(set('RETURNED')).toMatchObject({ applied: true, bookedCents: AMOUNT });
    expect(set(stale)).toMatchObject({ applied: false, status: 'RETURNED', bookedCents: 0 });
    expect(stored()).toBe('RETURNED');
    expect(ledger.poolBalanceCents()).toBe(POOL);
  });

  it('UNCLAIMED → SUCCESS (claimed) and UNCLAIMED → RETURNED (30 days or cancelled) are genuine', () => {
    const claimed = item('UNCLAIMED');
    expect(claimed.set('SUCCESS')).toMatchObject({ applied: true, bookedCents: 0 });
    expect(claimed.ledger.poolBalanceCents()).toBe(POOL - AMOUNT);
    const returned = item('UNCLAIMED');
    expect(returned.set('RETURNED')).toMatchObject({ applied: true, bookedCents: AMOUNT });
    expect(returned.ledger.poolBalanceCents()).toBe(POOL);
  });

  it.each(['REFUNDED', 'REVERSED'] as const)('SUCCESS → %s credits the pool once; the SUCCESS seen before it is then stale', (s) => {
    const { ledger, set } = item('SUCCESS');
    expect(set(s)).toMatchObject({ applied: true, bookedCents: AMOUNT });
    expect(set('SUCCESS')).toMatchObject({ applied: false, status: s, bookedCents: 0 });
    expect(ledger.poolBalanceCents()).toBe(POOL);
  });

  it.each(['FAILED', 'RETURNED', 'BLOCKED', 'DENIED', 'CANCELED'] as const)('%s → SUCCESS takes the credit back out (no over-credited pool)', (s) => {
    const { ledger, set } = item(s);
    expect(ledger.poolBalanceCents()).toBe(POOL);
    const u = set('SUCCESS');
    expect(u).toMatchObject({ applied: true, status: 'SUCCESS', bookedCents: -AMOUNT, balanceAfterCents: POOL - AMOUNT });
    expect(ledger.poolBalanceCents()).toBe(POOL - AMOUNT);
    // And if PayPal then takes it back, the credit is booked again, under a new ref.
    expect(set('REVERSED')).toMatchObject({ applied: true, bookedCents: AMOUNT });
    expect(ledger.poolBalanceCents()).toBe(POOL);
  });

  it('a re-debit is booked even below zero (the money has already gone), and says so', () => {
    const { ledger, set } = item('FAILED');
    // The credited $120 is spent on another batch before PayPal changes its mind.
    ledger.reservePayoutBatch({ eventId: 'other', planVersion: 1, paypalRequestId: 'req2', verdictDigest: 'd2', items: [{ recipientId: 'rcp_02', amountCents: POOL }] });
    expect(ledger.poolBalanceCents()).toBe(0);
    expect(set('SUCCESS')).toMatchObject({ applied: true, bookedCents: -AMOUNT, balanceAfterCents: -AMOUNT });
  });

  it('refs stay unique: credits and re-debits are numbered', () => {
    const { db, set } = item('FAILED');
    set('SUCCESS');
    set('REFUNDED');
    const refs = db.prepare("SELECT kind, ref, amount_cents FROM ledger_entries WHERE ref LIKE 'item:%' ORDER BY id").all();
    expect(refs).toEqual([
      { kind: 'payout_reversal', ref: `item:${EVENT}:rcp_01`, amount_cents: AMOUNT },
      { kind: 'payout_debit', ref: `item:${EVENT}:rcp_01`, amount_cents: -AMOUNT },
      { kind: 'payout_reversal', ref: `item:${EVENT}:rcp_01:2`, amount_cents: AMOUNT },
    ]);
  });

  it('an item whose id is a prefix of another does not share its money', () => {
    const db = openDb();
    const ledger = new Ledger(db, () => 1);
    ledger.seedCredit('seed', POOL);
    ledger.reservePayoutBatch({ eventId: EVENT, planVersion: 1, paypalRequestId: 'r', verdictDigest: 'd', items: [{ recipientId: 'rcp_1', amountCents: 10_00 }, { recipientId: 'rcp_10', amountCents: 20_00 }] });
    ledger.setItemStatus(EVENT, 'rcp_10', 'FAILED');
    expect(ledger.itemCreditedCents(EVENT, 'rcp_1')).toBe(0);
    ledger.setItemStatus(EVENT, 'rcp_1', 'FAILED');
    expect(ledger.poolBalanceCents()).toBe(POOL);
  });

  it('the table never sends an item back to RESERVED and keeps REFUNDED and REVERSED final', () => {
    for (const s of ITEM_STATUSES) expect(ITEM_TRANSITIONS[s]).not.toContain('RESERVED');
    expect(ITEM_TRANSITIONS.REFUNDED).toEqual([]);
    expect(ITEM_TRANSITIONS.REVERSED).toEqual([]);
  });
});
