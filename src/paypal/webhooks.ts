import type { PayPalClient } from './client';

/**
 * PayPal webhooks (SPEC §5.7). Nothing in a webhook is trusted until PayPal's
 * own verify-webhook-signature endpoint says SUCCESS.
 *
 * The event JSON is forwarded byte-for-byte: re-serialising a parsed body can
 * change escaping or key order and make a genuine signature fail.
 */
export const REQUIRED_HEADERS = [
  'paypal-auth-algo',
  'paypal-cert-url',
  'paypal-transmission-id',
  'paypal-transmission-sig',
  'paypal-transmission-time',
] as const;

export type WebhookHeaders = Record<(typeof REQUIRED_HEADERS)[number], string>;

export function readWebhookHeaders(h: { get(name: string): string | null }): WebhookHeaders | null {
  const out: Partial<WebhookHeaders> = {};
  for (const k of REQUIRED_HEADERS) {
    const v = h.get(k);
    if (!v || v.length > 2048) return null;
    out[k] = v;
  }
  return out as WebhookHeaders;
}

export function verificationBody(headers: WebhookHeaders, webhookId: string, rawEvent: string): string {
  const prefix = JSON.stringify({
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: webhookId,
  });
  // Splice the raw event in as the last property.
  return `${prefix.slice(0, -1)},"webhook_event":${rawEvent}}`;
}

export async function verifyWebhookSignature(
  client: PayPalClient,
  headers: WebhookHeaders,
  webhookId: string,
  rawEvent: string,
): Promise<boolean> {
  const res = await client.request<{ verification_status?: string }>('POST', '/v1/notifications/verify-webhook-signature', {
    rawBody: verificationBody(headers, webhookId, rawEvent),
  });
  return res.body.verification_status === 'SUCCESS';
}

export type PayPalWebhookEvent = {
  id: string;
  event_type: string;
  resource?: {
    payout_batch_id?: string;
    batch_header?: { payout_batch_id?: string };
    payout_item_id?: string;
    id?: string;
    [k: string]: unknown;
  };
};

/** The payout batch a payout webhook refers to (batch events carry no item detail; we GET the batch). */
export function payoutBatchIdOf(ev: PayPalWebhookEvent): string | null {
  if (!ev.event_type.startsWith('PAYMENT.PAYOUTS')) return null;
  return ev.resource?.batch_header?.payout_batch_id ?? ev.resource?.payout_batch_id ?? null;
}

/** Donation lifecycle events Firstlight handles (Orders v2 / Payments v2). */
export const DONATION_EVENT_TYPES = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
] as const;

type Link = { rel?: string; href?: string };
type DonationResource = {
  id?: string;
  status?: string;
  amount?: { value?: string };
  links?: Link[];
  status_details?: { reason?: string };
  supplementary_data?: { related_ids?: { order_id?: string; capture_id?: string } };
};

const PAYPAL_ID = /^[A-Z0-9-]{6,40}$/;
const idOrNull = (v: unknown): string | null => (typeof v === 'string' && PAYPAL_ID.test(v) ? v : null);

/** Capture id from a `rel: up` (refund → capture) or `rel: self` (capture) link. */
function captureIdFromLinks(links: Link[] | undefined, rel: string): string | null {
  const href = Array.isArray(links) ? links.find((l) => l?.rel === rel)?.href : undefined;
  const m = typeof href === 'string' ? /\/v2\/payments\/captures\/([A-Z0-9-]+)/.exec(href) : null;
  return m ? idOrNull(m[1]) : null;
}

function centsOf(value: unknown): number | null {
  if (typeof value !== 'string' || !/^-?\d{1,9}(\.\d{1,2})?$/.test(value)) return null;
  return Math.abs(Math.round(Number(value) * 100));
}

export type DonationWebhook =
  | { kind: 'order_approved'; orderId: string }
  | { kind: 'capture_completed' | 'capture_pending' | 'capture_denied'; captureId: string; orderId: string | null; amountCents: number | null; reason: string | null }
  | { kind: 'refund' | 'reversal'; captureId: string | null; orderId: string | null; refId: string | null; amountCents: number | null };

/**
 * Read a (verified) donation webhook defensively. Capture events carry the
 * capture as the resource. Refund and reversal events carry the refund, whose
 * `rel: up` link points at the capture; some payloads carry the capture itself
 * or `supplementary_data.related_ids` instead, so those are accepted too.
 */
export function donationWebhookOf(ev: PayPalWebhookEvent): DonationWebhook | null {
  const r = (ev.resource ?? {}) as DonationResource;
  const related = r.supplementary_data?.related_ids;
  switch (ev.event_type) {
    case 'CHECKOUT.ORDER.APPROVED': {
      const orderId = idOrNull(r.id);
      return orderId ? { kind: 'order_approved', orderId } : null;
    }
    case 'PAYMENT.CAPTURE.COMPLETED':
    case 'PAYMENT.CAPTURE.PENDING':
    case 'PAYMENT.CAPTURE.DENIED': {
      const captureId = idOrNull(r.id);
      if (!captureId) return null;
      const kind = ev.event_type === 'PAYMENT.CAPTURE.COMPLETED' ? 'capture_completed' : ev.event_type === 'PAYMENT.CAPTURE.PENDING' ? 'capture_pending' : 'capture_denied';
      const reason = typeof r.status_details?.reason === 'string' ? r.status_details.reason.slice(0, 64) : null;
      return { kind, captureId, orderId: idOrNull(related?.order_id), amountCents: centsOf(r.amount?.value), reason };
    }
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED': {
      const up = captureIdFromLinks(r.links, 'up');
      // The resource is the refund (its `up` link names the capture) or, in some payloads, the capture itself.
      const captureId = up ?? idOrNull(related?.capture_id) ?? captureIdFromLinks(r.links, 'self');
      return {
        kind: ev.event_type === 'PAYMENT.CAPTURE.REFUNDED' ? 'refund' : 'reversal',
        captureId,
        orderId: idOrNull(related?.order_id),
        refId: up ? idOrNull(r.id) : null,
        // A capture-shaped resource carries the capture's amount, not the refund's: let the service use the remainder.
        amountCents: up ? centsOf(r.amount?.value) : null,
      };
    }
    default:
      return null;
  }
}
