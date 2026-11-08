import type { LedgerSnapshot, PaidEvent } from '../firewall/types';
import type { Db, LEDGER_KINDS } from './db';

export type LedgerKind = (typeof LEDGER_KINDS)[number];

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
export const RETURNS_TO_POOL: readonly ItemStatus[] = ['BLOCKED', 'FAILED', 'RETURNED', 'REFUNDED', 'REVERSED', 'DENIED', 'CANCELED'];

/** Which status an item may move to from each stored status (besides staying where it is). */
export type ItemTransitionTable = Readonly<Record<ItemStatus, readonly ItemStatus[]>>;

const IN_FLIGHT_NEXT: readonly ItemStatus[] = ITEM_STATUSES.filter((s) => s !== 'RESERVED');

/**
 * Payout item status only moves forward (D9x). PayPal answers every poll and webhook
 * with the item's status as it is then; a late or cached answer can be older than what
 * we already stored, so a reported status is applied only along these edges and any
 * other move is refused (the caller audits it as a regression).
 *
 *  - RESERVED (ours, before PayPal answered) can become anything PayPal reports.
 *  - PENDING and ONHOLD are in flight: they can become any PayPal status.
 *  - UNCLAIMED waits up to 30 days for the recipient: claimed (SUCCESS), returned or
 *    cancelled (RETURNED, CANCELED), held for review, blocked or failed. Never PENDING again.
 *  - SUCCESS can only be taken back afterwards: REFUNDED or REVERSED. Anything earlier
 *    (PENDING, ONHOLD, UNCLAIMED) is a stale answer.
 *  - REFUNDED and REVERSED are final: SUCCESS after them is the stale answer from before.
 *  - FAILED, RETURNED, BLOCKED, DENIED and CANCELED are final except for SUCCESS. SUCCESS
 *    never comes before them in PayPal's lifecycle, so it can't be a stale answer: it
 *    means PayPal now says the money reached the recipient. We believe it, because the
 *    other mistake is worse: an item shown as failed while paid invites a retry (D6) and
 *    leaves the pool counting money that is gone. CANCELED may also settle as RETURNED.
 *
 * Money follows the stored status: an item whose status is in RETURNS_TO_POOL has its
 * amount back in the pool exactly once, any other status has it out. So a move from a
 * pool-crediting status to SUCCESS books the matching debit (`setItemStatus`).
 */
export const ITEM_TRANSITIONS: ItemTransitionTable = {
  RESERVED: IN_FLIGHT_NEXT,
  PENDING: IN_FLIGHT_NEXT,
  ONHOLD: IN_FLIGHT_NEXT,
  UNCLAIMED: ['SUCCESS', 'RETURNED', 'CANCELED', 'ONHOLD', 'BLOCKED', 'FAILED'],
  SUCCESS: ['REFUNDED', 'REVERSED'],
  REFUNDED: [],
  REVERSED: [],
  FAILED: ['SUCCESS'],
  RETURNED: ['SUCCESS'],
  BLOCKED: ['SUCCESS'],
  DENIED: ['SUCCESS'],
  CANCELED: ['RETURNED', 'SUCCESS'],
};

/** True if an item stored as `from` may be recorded as `to` (staying put is always allowed). */
export function itemTransitionAllowed(from: ItemStatus, to: ItemStatus): boolean {
  return from === to || ITEM_TRANSITIONS[from].includes(to);
}

/** What `setItemStatus` did with a reported status. */
export type ItemStatusUpdate = {
  /** The item's stored status after the call (unchanged when the report was refused). */
  status: ItemStatus;
  /** What PayPal reported, normalised. */
  reported: ItemStatus;
  /** PayPal sent a status we don't know (treated as PENDING). */
  unknown: boolean;
  /** Stored status before the call. */
  from: ItemStatus;
  /** False when the report would have moved the item backwards and was ignored. */
  applied: boolean;
  /** Pool cents booked by this call: +amount when the money came back, -amount when it left again, else 0. */
  bookedCents: number;
  balanceAfterCents: number;
};

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

export type BatchRow = {
  id: number;
  event_id: string;
  plan_version: number;
  paypal_request_id: string;
  verdict_digest: string;
  paypal_batch_id: string | null;
  status: string;
  created_ms: number;
};

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

export type BatchItemRow = {
  event_id: string;
  recipient_id: string;
  amount_cents: number;
  status: string;
  paypal_item_id: string | null;
  transaction_id: string | null;
  error_name: string | null;
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

  /** Cents credited for a donation capture (0 if it was never credited). */
  donationCreditCents(captureId: string): number {
    const row = this.db.prepare("SELECT amount_cents FROM ledger_entries WHERE kind = 'donation_credit' AND ref = ?").get(captureId) as { amount_cents: number } | undefined;
    return row?.amount_cents ?? 0;
  }

  /**
   * Take money back out of the pool because PayPal returned a donation to the
   * donor (refund, reversal/chargeback, or a credited capture later denied).
   * Idempotent on (kind, ref). This is the one debit allowed to take the pool
   * below zero: the money has already left, so it is booked as it happened and
   * the shortfall is reported to the caller, who must flag it in the audit log.
   */
  debitDonation(kind: 'donation_refund' | 'donation_reversal', ref: string, amountCents: number): { debited: boolean; balanceBeforeCents: number; shortfallCents: number } {
    assertPositiveCents(amountCents);
    const tx = this.db.transaction(() => {
      const balanceBeforeCents = this.poolBalanceCents();
      const info = this.db
        .prepare('INSERT OR IGNORE INTO ledger_entries (kind, amount_cents, ref, created_ms) VALUES (?, ?, ?, ?)')
        .run(kind, -amountCents, ref, this.clock());
      const debited = info.changes === 1;
      const shortfallCents = debited ? Math.max(0, amountCents - Math.max(0, balanceBeforeCents)) : 0;
      return { debited, balanceBeforeCents, shortfallCents };
    });
    return tx.immediate();
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

  /**
   * Record PayPal's status for one item, forward only (see ITEM_TRANSITIONS): a report
   * that would move the item backwards changes nothing and comes back with
   * `applied: false`. Money follows the stored status: an item in RETURNS_TO_POOL is
   * re-credited exactly once (`payout_reversal`); a move out of such a status (PayPal
   * now says SUCCESS) debits the same amount again (`payout_debit`, ref `item:…`), even
   * below zero, since PayPal has already paid it out (the caller flags POOL_NEGATIVE).
   */
  setItemStatus(eventId: string, recipientId: string, rawStatus: unknown): ItemStatusUpdate {
    const norm = normaliseItemStatus(rawStatus);
    const tx = this.db.transaction((): ItemStatusUpdate => {
      const row = this.db
        .prepare('SELECT amount_cents, status FROM payout_items WHERE event_id = ? AND recipient_id = ?')
        .get(eventId, recipientId) as { amount_cents: number; status: string } | undefined;
      if (!row) throw new Error(`no payout item for ${eventId}/${recipientId}`);
      const from = normaliseItemStatus(row.status).status;
      const base = { reported: norm.status, unknown: norm.unknown, from };
      if (!itemTransitionAllowed(from, norm.status)) {
        return { ...base, status: from, applied: false, bookedCents: 0, balanceAfterCents: this.poolBalanceCents() };
      }
      if (from !== norm.status) this.db.prepare('UPDATE payout_items SET status = ? WHERE event_id = ? AND recipient_id = ?').run(norm.status, eventId, recipientId);
      const bookedCents = this.settleItemMoney(eventId, recipientId, row.amount_cents, RETURNS_TO_POOL.includes(norm.status));
      return { ...base, status: norm.status, applied: true, bookedCents, balanceAfterCents: this.poolBalanceCents() };
    });
    return tx.immediate();
  }

  /** Cents of one item's payout currently back in the pool: its amount, or 0. */
  itemCreditedCents(eventId: string, recipientId: string): number {
    const ref = `item:${eventId}:${recipientId}`;
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS c FROM ledger_entries
         WHERE kind IN ('payout_reversal', 'payout_debit') AND (ref = ? OR substr(ref, 1, ?) = ?)`,
      )
      .get(ref, ref.length + 1, `${ref}:`) as { c: number };
    return row.c;
  }

  /**
   * Make the ledger agree with where the item's money is. Credits are `payout_reversal`,
   * re-debits `payout_debit`, both with ref `item:<event>:<recipient>` the first time and
   * `…:<n>` after, so each move is booked once and the history stays readable.
   */
  private settleItemMoney(eventId: string, recipientId: string, amountCents: number, inPool: boolean): number {
    const delta = (inPool ? amountCents : 0) - this.itemCreditedCents(eventId, recipientId);
    if (delta === 0) return 0;
    const kind = delta > 0 ? 'payout_reversal' : 'payout_debit';
    const ref = `item:${eventId}:${recipientId}`;
    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM ledger_entries WHERE kind = ? AND (ref = ? OR substr(ref, 1, ?) = ?)')
      .get(kind, ref, ref.length + 1, `${ref}:`) as { n: number };
    this.db.prepare('INSERT INTO ledger_entries (kind, amount_cents, ref, created_ms) VALUES (?, ?, ?, ?)').run(kind, delta, n === 0 ? ref : `${ref}:${n + 1}`, this.clock());
    return delta;
  }

  /**
   * Book what PayPal says it charged for a payout batch (`batch_header.fees`), so the
   * pool tracks the real PayPal balance. Idempotent per PayPal batch id: the same
   * reported total books nothing. If PayPal later reports a different total (for
   * example a fee given back on a returned item), only the difference is booked, as a
   * numbered correction. Like a donation refund, the fee has already been taken, so it
   * is booked even if it takes the pool below zero; the caller flags that.
   */
  bookPayoutFee(paypalBatchId: string, reportedFeeCents: number): { bookedCents: number; totalFeeCents: number; balanceAfterCents: number } {
    if (!/^[A-Z0-9]{6,40}$/i.test(paypalBatchId)) throw new Error(`invalid payout_batch_id: ${paypalBatchId}`);
    if (!Number.isSafeInteger(reportedFeeCents) || reportedFeeCents < 0) throw new RangeError(`fee must be a non-negative integer number of cents, got ${reportedFeeCents}`);
    const tx = this.db.transaction(() => {
      const prior = this.feeEntries(paypalBatchId);
      const delta = reportedFeeCents - prior.feeCents;
      if (delta !== 0) {
        const ref = prior.entries === 0 ? `fee:${paypalBatchId}` : `fee:${paypalBatchId}:${prior.entries + 1}`;
        this.db.prepare("INSERT INTO ledger_entries (kind, amount_cents, ref, created_ms) VALUES ('payout_fee', ?, ?, ?)").run(-delta, ref, this.clock());
      }
      return { bookedCents: delta, totalFeeCents: reportedFeeCents, balanceAfterCents: this.poolBalanceCents() };
    });
    return tx.immediate();
  }

  /** PayPal fees booked for one batch so far (0 if none). */
  payoutFeeCents(paypalBatchId: string): number {
    return this.feeEntries(paypalBatchId).feeCents;
  }

  private feeEntries(paypalBatchId: string): { entries: number; feeCents: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(-SUM(amount_cents), 0) AS f FROM ledger_entries WHERE kind = 'payout_fee' AND (ref = ? OR ref LIKE ?)")
      .get(`fee:${paypalBatchId}`, `fee:${paypalBatchId}:%`) as { n: number; f: number };
    return { entries: row.n, feeCents: row.f };
  }

  getBatchByDigest(verdictDigest: string): BatchRow | undefined {
    return this.db.prepare('SELECT * FROM payout_batches WHERE verdict_digest = ?').get(verdictDigest) as BatchRow | undefined;
  }

  getBatch(id: number): BatchRow | undefined {
    return this.db.prepare('SELECT * FROM payout_batches WHERE id = ?').get(id) as BatchRow | undefined;
  }

  batchItems(batchId: number): BatchItemRow[] {
    return this.db
      .prepare('SELECT event_id, recipient_id, amount_cents, status, paypal_item_id, transaction_id, error_name FROM payout_items WHERE batch_id = ? ORDER BY id')
      .all(batchId) as BatchItemRow[];
  }

  /** PayPal's ids and failure reason for an item, as last reported by PayPal. */
  setItemDetails(eventId: string, recipientId: string, d: { paypalItemId?: string | null; transactionId?: string | null; errorName?: string | null }): void {
    this.db
      .prepare(
        `UPDATE payout_items SET paypal_item_id = COALESCE(?, paypal_item_id), transaction_id = COALESCE(?, transaction_id), error_name = ?
         WHERE event_id = ? AND recipient_id = ?`,
      )
      .run(d.paypalItemId ?? null, d.transactionId ?? null, d.errorName ?? null, eventId, recipientId);
  }

  setBatchStatus(id: number, status: string, paypalBatchId?: string): void {
    if (paypalBatchId) {
      this.db.prepare('UPDATE payout_batches SET status = ?, paypal_batch_id = COALESCE(paypal_batch_id, ?) WHERE id = ?').run(status, paypalBatchId, id);
    } else {
      this.db.prepare('UPDATE payout_batches SET status = ? WHERE id = ?').run(status, id);
    }
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
