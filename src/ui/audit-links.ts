/**
 * Audit entry labels and links into the filtered audit log, shared by /audit
 * and /payouts. Pure: no fetching.
 */

/** Plain words for each audit event type. Unknown types show as they are. */
export const AUDIT_LABEL: Record<string, string> = {
  'signal.received': 'Earthquake signal received',
  'sentinel.pre': 'Sentinel scanned untrusted text',
  'agent.result': 'Agent submitted a plan',
  'sentinel.post': "Sentinel scanned the agent's output",
  'firewall.verdict': 'Firewall verdict recorded',
  'approval.decided': 'Human decision',
  'payout.reserved': 'Pool money reserved',
  'paypal.payout.created': 'PayPal accepted the batch',
  'paypal.payout.error': 'PayPal request failed',
  'paypal.payout.status': 'PayPal status update',
  'paypal.payout.item.canceled': 'Unclaimed payout cancelled',
  'paypal.payout.item.cancel_failed': 'Cancelling an unclaimed payout failed',
  'paypal.webhook': 'PayPal webhook (verified)',
  'paypal.webhook.rejected': 'PayPal webhook rejected',
  'execute.refused': 'Payout refused at execution',
  'payout.fee_booked': 'PayPal fee taken from the pool',
  'plan.floor_drafted': 'Firewall drafted its own plan (everyone owed)',
  'donation.created': 'Donation started (waiting for PayPal approval)',
  'donation.captured': 'Donation received into the pool',
  'donation.rejected': 'Donation refused by the donation rules',
  'donation.failed': 'Donation failed at PayPal',
  'donation.canceled': 'Donation cancelled by the donor',
  'donation.capture_pending': 'Donation approved, capture pending',
  'donation.refunded': 'Donation refunded to the donor (taken out of the pool)',
  'donation.reversed': 'Donation reversed by PayPal (taken out of the pool)',
  'donation.denied': 'Donation capture denied by PayPal',
  'allowance.created': 'Agent allowance created by a person',
  'allowance.revoked': 'Agent allowance revoked',
};

/** Short step names for a batch's trail on /payouts. */
const STEP: Record<string, [one: string, many: string]> = {
  'payout.reserved': ['money reserved', 'reservations'],
  'paypal.payout.created': ['PayPal accepted the batch', 'PayPal acceptances'],
  'paypal.payout.error': ['PayPal request failed', 'failed PayPal requests'],
  'paypal.webhook': ['verified webhook', 'verified webhooks'],
  'paypal.payout.status': ['status update', 'status updates'],
  'payout.fee_booked': ['fee booked', 'fees booked'],
  'paypal.payout.item.canceled': ['payout cancelled', 'payouts cancelled'],
  'paypal.payout.item.cancel_failed': ['cancel failed', 'cancels failed'],
};

export type TrailEntry = { seq: number; type: string };
export type TrailGroup = { type: string; label: string; count: number; firstSeq: number };

/** One group per event type, in the order each type first appears; the money steps keep their own order. */
export function trailGroups(entries: readonly TrailEntry[]): TrailGroup[] {
  const groups = new Map<string, TrailGroup>();
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const g = groups.get(e.type);
    if (g) g.count++;
    else groups.set(e.type, { type: e.type, label: '', count: 1, firstSeq: e.seq });
  }
  return [...groups.values()].map((g) => {
    const [one, many] = STEP[g.type] ?? [AUDIT_LABEL[g.type] ?? g.type, AUDIT_LABEL[g.type] ?? g.type];
    return { ...g, label: g.count === 1 ? one : `${g.count} ${many}` };
  });
}

export type AuditLinkFilter = { plan?: number | null; batch?: string | null; type?: string | null };

/** A link into /audit with the filter in the query string and, optionally, an entry to scroll to. */
export function auditHref(f: AuditLinkFilter, seq?: number): string {
  const q = new URLSearchParams();
  if (f.plan != null) q.set('plan', String(f.plan));
  if (f.batch) q.set('batch', f.batch);
  if (f.type) q.set('type', f.type);
  const qs = q.toString();
  return `/audit${qs ? `?${qs}` : ''}${seq !== undefined ? `#seq-${seq}` : ''}`;
}
