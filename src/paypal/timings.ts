import { TERMINAL_BATCH_STATUSES } from './payouts';

/**
 * End-to-end clock for one payout batch, measured from the audit log's own
 * timestamps (pure: the entries come in, nothing is read or written).
 *
 *   assessed  firewall.verdict for the plan
 *   approved  approval.decided for the plan (null when the firewall allowed it)
 *   sent      paypal.payout.created for the batch (PayPal accepted it)
 *   finished  the first paypal.payout.status after which the batch is terminal
 *             and no item is still pending at PayPal
 */

export type ClockEntry = { type: string; tsMs: number; payload: unknown };

export type BatchClock = {
  assessedMs: number | null;
  approvedMs: number | null;
  sentMs: number | null;
  finishedMs: number | null;
  /** True when every item ended SUCCESS at `finishedMs`. */
  allPaid: boolean;
  /** Verified PayPal webhook deliveries for the batch, and when the first one arrived. */
  webhooks: number;
  firstWebhookMs: number | null;
};

/** Item statuses that mean PayPal hasn't finished with the item. */
const NOT_FINAL = new Set(['RESERVED', 'PENDING', 'ONHOLD']);

/** PayPal returns an unclaimed payout to the sender after 30 days. */
export const UNCLAIMED_RETURN_MS = 30 * 86_400_000;

type StatusPayload = { batchId?: unknown; batchStatus?: unknown; changes?: { recipientId?: unknown; to?: unknown }[] };

export function batchClock(
  entries: readonly ClockEntry[],
  ref: { planId: number | null; batchId: number; paypalBatchId: string | null; recipientIds: readonly string[] },
): BatchClock {
  const p = (e: ClockEntry) => (e.payload ?? {}) as Record<string, unknown>;
  const first = (pred: (e: ClockEntry) => boolean) => entries.find(pred)?.tsMs ?? null;

  const assessedMs = ref.planId === null ? null : first((e) => e.type === 'firewall.verdict' && p(e).planId === ref.planId);
  const approvedMs = ref.planId === null ? null : first((e) => e.type === 'approval.decided' && p(e).planId === ref.planId && p(e).decision === 'approve');
  const sentMs = first((e) => e.type === 'paypal.payout.created' && p(e).batchId === ref.batchId);

  const items = new Map(ref.recipientIds.map((id) => [id, 'PENDING']));
  let finishedMs: number | null = null;
  let allPaid = false;
  for (const e of entries) {
    if (e.type !== 'paypal.payout.status') continue;
    const s = p(e) as StatusPayload;
    if (s.batchId !== ref.batchId) continue;
    for (const c of s.changes ?? []) if (typeof c.recipientId === 'string' && items.has(c.recipientId) && typeof c.to === 'string') items.set(c.recipientId, c.to);
    const terminal = typeof s.batchStatus === 'string' && (TERMINAL_BATCH_STATUSES as readonly string[]).includes(s.batchStatus);
    const statuses = [...items.values()];
    if (terminal && items.size > 0 && statuses.every((st) => !NOT_FINAL.has(st))) {
      finishedMs = e.tsMs;
      allPaid = statuses.every((st) => st === 'SUCCESS');
      break;
    }
  }

  const hooks = ref.paypalBatchId ? entries.filter((e) => e.type === 'paypal.webhook' && p(e).payoutBatchId === ref.paypalBatchId) : [];
  return { assessedMs, approvedMs, sentMs, finishedMs, allPaid, webhooks: hooks.length, firstWebhookMs: hooks[0]?.tsMs ?? null };
}
