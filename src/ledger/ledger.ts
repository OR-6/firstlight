import type { LedgerSnapshot, PaidEvent } from '../firewall/types';
import type { Db } from './db';

/**
 * Internal pool ledger: the policy engine's source of truth for money
 * (SPEC §5.6), not a PayPal balance query. Integer cents throughout.
 */

export const ITEM_STATUSES = [
  'RESERVED', // booked locally, not yet accepted by PayPal
  'PENDING',
  'SUCCESS',
  'UNCLAIMED',
  'ONHOLD',
  'BLOCKED',
  'FAILED',
  'RETURNED',
  'REFUNDED',
  'REVERSED',
  'DENIED',
  'CANCELED',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Statuses whose money is back in (or never left) the pool. */
const RETURNS_TO_POOL: readonly ItemStatus[] = ['BLOCKED', 'FAILED', 'RETURNED', 'REFUNDED', 'REVERSED', 'DENIED', 'CANCELED'];

/**
 * Map a PayPal `transaction_status` defensively (SPEC §5.5): unknown values
 * become PENDING and are reported so the caller can log them.
 */
export function normaliseItemStatus(raw: unknown): { status: ItemStatus; unknown: boolean } {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  const alias: Record<string, ItemStatus> = { SUCCEEDED: 'SUCCESS', HELD: 'ONHOLD', CANCELLED: 'CANCELED' };
  const mapped = alias[s] ?? s;
  return (ITEM_STATUSES as readonly string[]).includes(mapped)
    ? { status: mapped as ItemStatus, unknown: false }
    : { status: 'PENDING', unknown: true };
}

export class InsufficientPoolError extends Error {
  constructor(
    readonly neededCents: number,
    readonly availableCents: number,
  ) {
    super(`pool has ${availableCents} cents, batch needs ${neededCents}`);
  }
}

export type ReserveBatchInput = {
  eventId: string;
  planVersion: number;
  paypalRequestId: string;
  verdictDigest: string;
  items: { recipientId: string; amountCents: number }[];
};

export class Ledger {
  constructor(
    private readonly db: Db,
    private readonly clock: () => number = Date.now,
  ) {}

  poolBalanceCents(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS b FROM ledger_entries').get() as { b: number };
    return row.b;
  }

  /** Book a captured donation. Idempotent on `ref` (the PayPal capture id): a replay credits nothing. */
  creditDonation(ref: string, amountCents: number): { credited: boolean } {
    return this.credit('donation_credit', ref, amountCents);
  }

  /** Initial pool funding for the demo (sandbox only). Idempotent on `ref`. */
  seedCredit(ref: string, amountCents: number): { credited: boolean } {
    return this.credit('seed_credit', ref, amountCents);
  }

  private credit(kind: 'donation_credit' | 'seed_credit', ref: string, amountCents: number): { credited: boolean } {
    assertPositiveCents(amountCents);
    const info = this.db
      .prepare('INSERT OR IGNORE INTO ledger_entries (kind, amount_cents, ref, created_ms) VALUES (?, ?, ?, ?)')
      .run(kind, amountCents, ref, this.clock());
    return { credited: info.changes === 1 };
  }

  /**
   * Reserve a firewall-approved batch: debit the pool and record one row per
   * item, atomically. Fails (and writes nothing) if the pool is short, the
   * request id was used before, or any (event, recipient) was already paid.
   */
  reservePayoutBatch(input: ReserveBatchInput): { batchId: number } {
    if (input.items.length === 0) throw new Error('empty batch');
    for (const i of input.items) assertPositiveCents(i.amountCents);
    const total = input.items.reduce((s, i) => s + i.amountCents, 0);
    const now = this.clock();

    const tx = this.db.transaction(() => {
      const available = this.poolBalanceCents();
      if (total > available) throw new InsufficientPoolError(total, available);
      const batch = this.db
        .prepare(
          `INSERT INTO payout_batches (event_id, plan_version, paypal_request_id, verdict_digest, status, created_ms)
           VALUES (?, ?, ?, ?, 'RESERVED', ?)`,
        )
        .run(input.eventId, input.planVersion, input.paypalRequestId, input.verdictDigest, now);
      const batchId = Number(batch.lastInsertRowid);
      const insertItem = this.db.prepare(
        `INSERT INTO payout_items (batch_id, event_id, recipient_id, amount_cents, status, created_ms)
         VALUES (?, ?, ?, ?, 'RESERVED', ?)`,
      );
      for (const i of input.items) insertItem.run(batchId, input.eventId, i.recipientId, i.amountCents, now);
      this.db
        .prepare("INSERT INTO ledger_entries (kind, amount_cents, ref, created_ms) VALUES ('payout_debit', ?, ?, ?)")
        .run(-total, `batch:${input.paypalRequestId}`, now);
      return { batchId };
    });
    return tx.immediate();
  }

  /** Record a status update for one item; money that comes back is re-credited exactly once. */
  setItemStatus(eventId: string, recipientId: string, rawStatus: unknown): { status: ItemStatus; unknown: boolean } {
    const norm = normaliseItemStatus(rawStatus);
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT amount_cents FROM payout_items WHERE event_id = ? AND recipient_id = ?')
        .get(eventId, recipientId) as { amount_cents: number } | undefined;
      if (!row) throw new Error(`no payout item for ${eventId}/${recipientId}`);
      this.db.prepare('UPDATE payout_items SET status = ? WHERE event_id = ? AND recipient_id = ?').run(norm.status, eventId, recipientId);
      if (RETURNS_TO_POOL.includes(norm.status)) {
        this.db
          .prepare("INSERT OR IGNORE INTO ledger_entries (kind, amount_cents, ref, created_ms) VALUES ('payout_reversal', ?, ?, ?)")
          .run(row.amount_cents, `item:${eventId}:${recipientId}`, this.clock());
      }
    });
    tx.immediate();
    return norm;
  }

  /** Everything the firewall needs, as plain data. */
  snapshot(): LedgerSnapshot {
    const payouts = (
      this.db.prepare('SELECT event_id, recipient_id, amount_cents, created_ms, status FROM payout_items ORDER BY id').all() as {
        event_id: string;
        recipient_id: string;
        amount_cents: number;
        created_ms: number;
        status: string;
      }[]
    ).map((r) => ({ eventId: r.event_id, recipientId: r.recipient_id, amountCents: r.amount_cents, at: r.created_ms, status: r.status }));

    const batchTimes = (this.db.prepare('SELECT created_ms FROM payout_batches ORDER BY id').all() as { created_ms: number }[]).map(
      (r) => r.created_ms,
    );

    const paidEvents: PaidEvent[] = (
      this.db
        .prepare(
          `SELECT e.id, e.aliases, e.time_ms, e.lat, e.lon FROM events e
           WHERE e.id IN (SELECT DISTINCT event_id FROM payout_items) ORDER BY e.id`,
        )
        .all() as { id: string; aliases: string; time_ms: number; lat: number; lon: number }[]
    ).map((r) => ({
      eventId: r.id,
      aliases: JSON.parse(r.aliases) as string[],
      time: r.time_ms,
      epicentre: { lat: r.lat, lon: r.lon },
    }));

    return { poolBalanceCents: this.poolBalanceCents(), payouts, batchTimes, paidEvents };
  }
}

function assertPositiveCents(c: number): void {
  if (!Number.isSafeInteger(c) || c <= 0) throw new RangeError(`amount must be a positive integer number of cents, got ${c}`);
}
