import { canonicalJson, sha256Hex } from '../lib/canonical';

/**
 * Deterministic `PayPal-Request-Id` for a payout batch (R6).
 * Derived only from what moves money — event, recipients, amounts — so the
 * same payout always hashes to the same key and PayPal rejects a resend, no
 * matter how the agent rewrote its notes or reordered items.
 */
export function payoutBatchRequestId(
  eventId: string,
  items: ReadonlyArray<{ recipientId: string; amountCents: number }>,
): string {
  const body = {
    v: 1,
    eventId,
    items: [...items]
      .map((i) => ({ recipientId: i.recipientId, amountCents: i.amountCents }))
      .sort((a, b) => (a.recipientId < b.recipientId ? -1 : a.recipientId > b.recipientId ? 1 : 0)),
  };
  return sha256Hex(canonicalJson(body));
}
