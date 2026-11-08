import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/ledger/db';
import { InsufficientPoolError, Ledger, RETURNS_TO_POOL, itemTransitionAllowed, normaliseItemStatus, type ItemStatus } from '../src/ledger/ledger';

/**
 * Seeded random walks over the pool ledger. Each run mixes seed credits, donations,
 * donation refunds and reversals, payout reservations, item status reports (stale ones
 * included) and fee bookings, replaying ids on purpose, and checks after every step that
 * the books add up against an independent model.
 */

/** mulberry32: small, fast, reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  return { next, int, pick };
}

type ModelItem = { eventId: string; recipientId: string; amount: number; status: ItemStatus };
type Model = {
  seeds: Map<string, number>;
  credits: Map<string, number>;
  donationDebits: Map<string, number>; // `${kind}:${ref}` → cents
  batches: { requestId: string; paypalBatchId: string; total: number; items: ModelItem[] }[];
  fees: Map<string, number>; // paypal batch id → total fee
};

const REPORTS = ['PENDING', 'ONHOLD', 'UNCLAIMED', 'SUCCESS', 'FAILED', 'RETURNED', 'REFUNDED', 'REVERSED', 'BLOCKED', 'DENIED', 'CANCELED', 'succeeded', 'SOMETHING_NEW'];
const RECIPIENTS = ['rcp_01', 'rcp_02', 'rcp_03', 'rcp_04', 'rcp_05', 'rcp_06'];

function expectedBalance(m: Model): number {
  const sum = (xs: Iterable<number>) => [...xs].reduce((s, x) => s + x, 0);
  const returned = sum(m.batches.flatMap((b) => b.items.filter((i) => RETURNS_TO_POOL.includes(i.status)).map((i) => i.amount)));
  return sum(m.seeds.values()) + sum(m.credits.values()) - sum(m.donationDebits.values()) - sum(m.batches.map((b) => b.total)) + returned - sum(m.fees.values());
}

function byKind(db: Db): Record<string, number> {
  const rows = db.prepare('SELECT kind, SUM(amount_cents) AS c FROM ledger_entries GROUP BY kind').all() as { kind: string; c: number }[];
  return Object.fromEntries(rows.map((r) => [r.kind, r.c]));
}

function run(seed: number, steps: number) {
  const r = rng(seed);
  const db = openDb();
  const ledger = new Ledger(db, () => 1);
  const m: Model = { seeds: new Map(), credits: new Map(), donationDebits: new Map(), batches: [], fees: new Map() };
  const cents = () => r.pick([r.int(1, 99), r.int(100, 5_000), r.int(5_000, 60_000)]);
  let events = 0;
  let wentNegative = 0;
  let staleRefused = 0;
  ledger.seedCredit('seed-initial', 2_000_00);
  m.seeds.set('seed-initial', 2_000_00);

  for (let step = 0; step < steps; step++) {
    const before = ledger.poolBalanceCents();
    const op = r.int(0, 9);
    let flagged = false; // this step went through a path allowed to take the pool below zero, and said so
    let label = '';
    let touched: ModelItem | undefined;

    if (op === 0) {
      const ref = `seed-${r.int(0, 3)}`;
      const amt = cents();
      label = `seed ${ref} ${amt}`;
      const res = ledger.seedCredit(ref, amt);
      expect(res.credited).toBe(!m.seeds.has(ref));
      if (res.credited) m.seeds.set(ref, amt);
    } else if (op <= 2) {
      const ref = `CAP${r.int(0, 15)}`;
      const amt = cents();
      label = `credit ${ref} ${amt}`;
      const res = ledger.creditDonation(ref, amt);
      expect(res.credited).toBe(!m.credits.has(ref));
      if (res.credited) m.credits.set(ref, amt);
    } else if (op === 3) {
      const kind = r.pick(['donation_refund', 'donation_reversal'] as const);
      const ref = `REF${r.int(0, 10)}`;
      const amt = cents();
      label = `${kind} ${ref} ${amt}`;
      const res = ledger.debitDonation(kind, ref, amt);
      const key = `${kind}:${ref}`;
      expect(res.debited).toBe(!m.donationDebits.has(key));
      expect(res.balanceBeforeCents).toBe(before);
      if (res.debited) {
        m.donationDebits.set(key, amt);
        expect(res.shortfallCents).toBe(Math.max(0, amt - Math.max(0, before)));
        flagged = res.shortfallCents > 0;
      }
    } else if (op <= 5) {
      // A reservation; sometimes a reused request id or an already-paid household.
      const reuse = m.batches.length > 0 && r.next() < 0.15;
      const prior = reuse ? r.pick(m.batches) : undefined;
      const eventId = prior && r.next() < 0.5 ? prior.items[0]!.eventId : `ev${++events}`;
      const requestId = prior && r.next() < 0.5 ? prior.requestId : `req-${seed}-${step}`;
      const recipients = [...RECIPIENTS].sort(() => r.next() - 0.5).slice(0, r.int(1, 3));
      const items = recipients.map((recipientId) => ({ recipientId, amountCents: cents() }));
      const total = items.reduce((s, i) => s + i.amountCents, 0);
      label = `reserve ${eventId} ${requestId} ${total}`;
      const dupRequest = m.batches.some((b) => b.requestId === requestId);
      const dupItem = m.batches.some((b) => b.items.some((i) => i.eventId === eventId && recipients.includes(i.recipientId)));
      let ok = false;
      try {
        ledger.reservePayoutBatch({ eventId, planVersion: 1, paypalRequestId: requestId, verdictDigest: requestId, items });
        ok = true;
      } catch (err) {
        if (total > before) expect(err).toBeInstanceOf(InsufficientPoolError);
        else expect(String((err as Error).message)).toMatch(/UNIQUE/);
      }
      expect(ok).toBe(total <= before && !dupRequest && !dupItem);
      if (ok) {
        const n = m.batches.length + 1;
        m.batches.push({ requestId, paypalBatchId: `PB${String(n).padStart(6, '0')}`, total, items: items.map((i) => ({ eventId, recipientId: i.recipientId, amount: i.amountCents, status: 'RESERVED' })) });
      }
    } else if (op <= 8) {
      if (m.batches.length === 0) continue;
      const it = r.pick(r.pick(m.batches).items);
      const raw = r.pick(REPORTS);
      const to = normaliseItemStatus(raw).status;
      label = `status ${it.eventId}/${it.recipientId} ${it.status} → ${raw}`;
      const res = ledger.setItemStatus(it.eventId, it.recipientId, raw);
      const allowed = itemTransitionAllowed(it.status, to);
      expect(res.applied).toBe(allowed);
      if (!allowed) staleRefused++;
      const wasIn = RETURNS_TO_POOL.includes(it.status);
      if (allowed) it.status = to;
      touched = it;
      const isIn = RETURNS_TO_POOL.includes(it.status);
      expect(res.bookedCents).toBe(isIn === wasIn ? 0 : isIn ? it.amount : -it.amount);
      flagged = res.bookedCents < 0 && res.balanceAfterCents < 0;
    } else {
      if (m.batches.length === 0) continue;
      const b = r.pick(m.batches);
      const fee = r.int(0, 2) === 0 ? (m.fees.get(b.paypalBatchId) ?? 0) : r.int(0, 500);
      label = `fee ${b.paypalBatchId} ${fee}`;
      const res = ledger.bookPayoutFee(b.paypalBatchId, fee);
      expect(res.bookedCents).toBe(fee - (m.fees.get(b.paypalBatchId) ?? 0));
      m.fees.set(b.paypalBatchId, fee);
      flagged = res.balanceAfterCents < 0;
    }

    // 1. The pool is the sum of its entries, by kind, and matches the model.
    const after = ledger.poolBalanceCents();
    const k = byKind(db);
    const v = (name: string) => k[name] ?? 0;
    expect(v('seed_credit') + v('donation_credit') + v('donation_refund') + v('donation_reversal') + v('payout_debit') + v('payout_reversal') + v('payout_fee'), label).toBe(after);
    expect(after, label).toBe(expectedBalance(m));
    // Signs per kind: credits positive, debits negative.
    expect(v('seed_credit')).toBeGreaterThanOrEqual(0);
    expect(v('donation_credit')).toBeGreaterThanOrEqual(0);
    expect(v('donation_refund')).toBeLessThanOrEqual(0);
    expect(v('donation_reversal')).toBeLessThanOrEqual(0);
    expect(v('payout_debit')).toBeLessThanOrEqual(0);
    expect(v('payout_reversal')).toBeGreaterThanOrEqual(0);

    // 2. No id is booked twice, and every item's money is where its status says.
    expect(db.prepare('SELECT kind, ref FROM ledger_entries GROUP BY kind, ref HAVING COUNT(*) > 1').all()).toEqual([]);
    if (touched) expect(ledger.itemCreditedCents(touched.eventId, touched.recipientId), label).toBe(RETURNS_TO_POOL.includes(touched.status) ? touched.amount : 0);

    // 3. Only a flagged path (POOL_NEGATIVE for the caller) takes the pool further below zero.
    if (after < 0 && before >= 0) wentNegative++;
    if (after < 0 && after < before) expect(flagged, `${label}: ${before} → ${after}`).toBe(true);
  }

  // At the end, every item: stored status and money agree with the model.
  const stored = db.prepare('SELECT event_id, recipient_id, status FROM payout_items').all() as { event_id: string; recipient_id: string; status: string }[];
  const all = m.batches.flatMap((b) => b.items);
  expect(stored.length).toBe(all.length);
  for (const i of all) {
    expect(stored.find((s) => s.event_id === i.eventId && s.recipient_id === i.recipientId)!.status).toBe(i.status);
    expect(ledger.itemCreditedCents(i.eventId, i.recipientId)).toBe(RETURNS_TO_POOL.includes(i.status) ? i.amount : 0);
  }
  expect(ledger.snapshot().poolBalanceCents).toBe(expectedBalance(m));
  const redebits = (db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE kind = 'payout_debit' AND ref LIKE 'item:%'").get() as { n: number }).n;
  const feeCorrections = (db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE kind = 'payout_fee' AND amount_cents > 0").get() as { n: number }).n;
  return { ledger, m, wentNegative, staleRefused, redebits, feeCorrections };
}

describe('pool ledger invariants (seeded random sequences)', () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => 1 + i * 7919);
  it.each(SEEDS)('seed %i: 250 steps keep the books consistent', (seed) => {
    const { m } = run(seed, 250);
    // The walk actually exercised the interesting paths across the seeds (checked below).
    expect(m.batches.length).toBeGreaterThan(0);
  });

  it('the walks cover reservations, stale reports, re-debits, refunds below zero and fee corrections', () => {
    let returned = 0;
    let success = 0;
    const seen = { wentNegative: 0, staleRefused: 0, redebits: 0, feeCorrections: 0 };
    for (const seed of SEEDS.slice(0, 10)) {
      const { m, ...counts } = run(seed, 250);
      for (const key of Object.keys(seen) as (keyof typeof seen)[]) seen[key] += counts[key];
      const items = m.batches.flatMap((b) => b.items);
      returned += items.filter((i) => RETURNS_TO_POOL.includes(i.status)).length;
      success += items.filter((i) => i.status === 'SUCCESS').length;
    }
    expect(returned).toBeGreaterThan(5);
    expect(success).toBeGreaterThan(5);
    for (const [key, n] of Object.entries(seen)) expect(n, key).toBeGreaterThan(0);
  });
});
