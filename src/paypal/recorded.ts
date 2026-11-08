import { PayPalApiError, type PayPalClient } from './client';
import { TERMINAL_BATCH_STATUSES, getPayoutBatch, type PayoutBatchDetails } from './payouts';
import type { Difference } from './reconcile';
import { toCents } from './reporting';

/**
 * Live PayPal evidence without sending money: the payout batches we made in the
 * sandbox while building (docs/decisions.md, "Runs already made" on /payouts),
 * read back from PayPal with a read-only GET and compared with what we recorded.
 * The hosted database resets, so there is no ledger for these; the comparison is
 * against the recorded expectation (status, item count, total, every item paid).
 */

export type RecordedExpectation = { paypalBatchId: string; items: number; totalCents: number; status: 'SUCCESS' };

/** What docs/decisions.md records for each run (7 households, $680; the $1 smoke test). */
export const RECORDED_BATCHES: readonly RecordedExpectation[] = [
  { paypalBatchId: '9GE626X9SA3NE', items: 7, totalCents: 680_00, status: 'SUCCESS' },
  { paypalBatchId: 'DZCFDP9FFEUV8', items: 7, totalCents: 680_00, status: 'SUCCESS' },
  { paypalBatchId: '2BQ585TNCTVDA', items: 7, totalCents: 680_00, status: 'SUCCESS' },
  { paypalBatchId: 'DHSSBZRTMH9DW', items: 1, totalCents: 1_00, status: 'SUCCESS' },
];

export type RecordedDifference = Omit<Difference, 'field' | 'ledger'> & { field: Difference['field'] | 'item_count'; ledger: string | null };

export type RecordedCheck =
  | {
      paypalBatchId: string;
      /** matches: PayPal agrees with what we recorded. in_progress: PayPal reports the batch as not finished. */
      state: 'matches' | 'differences' | 'in_progress';
      checkedMs: number;
      batchStatus: string;
      itemCount: number;
      /** Item count per PayPal transaction_status, e.g. { SUCCESS: 7 }. */
      itemStatuses: Record<string, number>;
      totalCents: number | null;
      feesCents: number | null;
      /** PayPal's own batch timestamps (time_created / time_completed). */
      createdMs: number | null;
      completedMs: number | null;
      differences: RecordedDifference[];
    }
  | { paypalBatchId: string; state: 'unavailable'; checkedMs: number; detail: string };

/** Pure: compare PayPal's batch GET with what we recorded about the run. */
export function compareRecorded(expected: RecordedExpectation, paypal: PayoutBatchDetails, checkedMs: number): RecordedCheck {
  const h = paypal.batch_header as PayoutBatchDetails['batch_header'] & { time_created?: string; time_completed?: string };
  const items = paypal.items ?? [];
  const itemStatuses: Record<string, number> = {};
  for (const it of items) {
    const s = (it.transaction_status ?? 'UNKNOWN').toUpperCase();
    itemStatuses[s] = (itemStatuses[s] ?? 0) + 1;
  }
  const totalCents = h.amount?.currency === 'USD' || h.amount?.currency === undefined ? toCents(h.amount?.value) : null;
  const diffs: RecordedDifference[] = [];
  if (h.batch_status !== expected.status) diffs.push({ recipientId: null, field: 'batch_status', ledger: expected.status, paypal: h.batch_status });
  if (h.amount?.currency && h.amount.currency !== 'USD') diffs.push({ recipientId: null, field: 'currency', ledger: 'USD', paypal: h.amount.currency });
  if (totalCents === null || totalCents !== expected.totalCents) diffs.push({ recipientId: null, field: 'batch_total', ledger: dollars(expected.totalCents), paypal: h.amount?.value ?? null });
  if (items.length !== expected.items) diffs.push({ recipientId: null, field: 'item_count', ledger: String(expected.items), paypal: String(items.length) });
  for (const it of items) {
    if ((it.transaction_status ?? '').toUpperCase() !== 'SUCCESS') {
      diffs.push({ recipientId: it.payout_item.sender_item_id?.split(':')[1] ?? it.payout_item_id, field: 'status', ledger: 'SUCCESS', paypal: it.transaction_status ?? null });
    }
  }
  const terminal = (TERMINAL_BATCH_STATUSES as readonly string[]).includes(h.batch_status);
  return {
    paypalBatchId: expected.paypalBatchId,
    state: !terminal ? 'in_progress' : diffs.length > 0 ? 'differences' : 'matches',
    checkedMs,
    batchStatus: h.batch_status,
    itemCount: items.length,
    itemStatuses,
    totalCents,
    feesCents: h.fees?.currency === 'USD' || h.fees?.currency === undefined ? toCents(h.fees?.value) : null,
    createdMs: parseTime(h.time_created),
    completedMs: parseTime(h.time_completed),
    differences: diffs,
  };
}

export type RecordedView = { configured: boolean; checkedMs: number | null; batches: RecordedCheck[] };

export type RecordedCheckerOptions = {
  /** Answers are reused this long (default 10 minutes). */
  ttlMs?: number;
  /** A failed read is retried no sooner than this (default 1 minute). */
  failureTtlMs?: number;
  /** Hard cap on batch GETs sent to PayPal in any 60 s window (default 8). */
  maxCallsPerMinute?: number;
  clock?: () => number;
  batches?: readonly RecordedExpectation[];
};

/**
 * Reads the recorded batches from PayPal, at most once per `ttlMs` (one refresh
 * at a time, however many viewers), and never more than `maxCallsPerMinute`
 * GETs a minute. Never throws: a missing client or a PayPal failure becomes
 * `unavailable` for that batch.
 */
export class RecordedBatchChecker {
  private cache: { at: number; ok: boolean; view: RecordedView } | null = null;
  private inflight: Promise<RecordedView> | null = null;
  private calls: number[] = [];
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly maxCalls: number;
  private readonly clock: () => number;
  private readonly batches: readonly RecordedExpectation[];

  constructor(
    /** null when PayPal isn't configured on this server; may throw if it can't be built. */
    private readonly client: () => PayPalClient | null,
    opts: RecordedCheckerOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.failureTtlMs = opts.failureTtlMs ?? 60_000;
    this.maxCalls = opts.maxCallsPerMinute ?? 8;
    this.clock = opts.clock ?? Date.now;
    this.batches = opts.batches ?? RECORDED_BATCHES;
  }

  async view(): Promise<RecordedView> {
    const now = this.clock();
    if (this.cache && now - this.cache.at < (this.cache.ok ? this.ttlMs : this.failureTtlMs)) return this.cache.view;
    return (this.inflight ??= this.refresh().finally(() => (this.inflight = null)));
  }

  private async refresh(): Promise<RecordedView> {
    const now = this.clock();
    let client: PayPalClient | null;
    try {
      client = this.client();
    } catch {
      client = null;
    }
    if (!client) {
      const view = this.allUnavailable(now, 'PayPal sandbox credentials are not set on this server.', false);
      this.cache = { at: now, ok: false, view };
      return view;
    }
    const previous = new Map((this.cache?.view.batches ?? []).map((b) => [b.paypalBatchId, b]));
    const batches: RecordedCheck[] = [];
    for (const expected of this.batches) {
      if (!this.takeCall(now)) {
        // Over the per-minute cap: keep the last answer for this batch if there is one.
        batches.push(previous.get(expected.paypalBatchId) ?? { paypalBatchId: expected.paypalBatchId, state: 'unavailable', checkedMs: now, detail: 'Checked too often; try again in a minute.' });
        continue;
      }
      try {
        const { body } = await getPayoutBatch(client, expected.paypalBatchId);
        batches.push(compareRecorded(expected, body, this.clock()));
      } catch (err) {
        batches.push({ paypalBatchId: expected.paypalBatchId, state: 'unavailable', checkedMs: this.clock(), detail: describe(err) });
      }
    }
    const view: RecordedView = { configured: true, checkedMs: now, batches };
    this.cache = { at: now, ok: batches.every((b) => b.state !== 'unavailable'), view };
    return view;
  }

  private takeCall(now: number): boolean {
    this.calls = this.calls.filter((t) => now - t < 60_000);
    if (this.calls.length >= this.maxCalls) return false;
    this.calls.push(now);
    return true;
  }

  private allUnavailable(now: number, detail: string, configured: boolean): RecordedView {
    return { configured, checkedMs: now, batches: this.batches.map((b) => ({ paypalBatchId: b.paypalBatchId, state: 'unavailable' as const, checkedMs: now, detail })) };
  }
}

function describe(err: unknown): string {
  if (err instanceof PayPalApiError) return `PayPal answered HTTP ${err.status}${err.paypalName ? ` ${err.paypalName}` : ''}.`;
  const msg = String((err as Error)?.message ?? err);
  return /timeout|abort/i.test(msg) ? 'PayPal did not answer in time.' : 'PayPal could not be reached.';
}

function parseTime(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}
