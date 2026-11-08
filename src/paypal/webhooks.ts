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
  };
};

/** The payout batch a payout webhook refers to (batch events carry no item detail; we GET the batch). */
export function payoutBatchIdOf(ev: PayPalWebhookEvent): string | null {
  if (!ev.event_type.startsWith('PAYMENT.PAYOUTS')) return null;
  return ev.resource?.batch_header?.payout_batch_id ?? ev.resource?.payout_batch_id ?? null;
}
