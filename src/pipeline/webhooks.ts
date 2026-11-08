import type { Db } from '../ledger/db';
import type { PayPalClient } from '../paypal/client';
import { payoutBatchIdOf, readWebhookHeaders, verifyWebhookSignature, type PayPalWebhookEvent } from '../paypal/webhooks';
import type { Pipeline } from './pipeline';

export type WebhookOutcome = { status: number; body: Record<string, unknown> };

/**
 * Handle one PayPal webhook delivery (SPEC §5.7):
 *  1. refuse if no webhook id is configured, headers are missing, or the body is not JSON;
 *  2. verify the signature with PayPal; unverified deliveries change nothing;
 *  3. de-duplicate on PayPal's event id;
 *  4. for payout events, GET the batch from PayPal (webhook payloads carry no item
 *     detail and no error objects) and update the ledger from that.
 */
export async function handlePayPalWebhook(input: {
  pipeline: Pipeline;
  db: Db;
  paypal: PayPalClient;
  webhookId: string | undefined;
  headers: { get(name: string): string | null };
  rawBody: string;
  now?: number;
  /** PAYMENT.CAPTURE.COMPLETED for a donation order. */
  onCaptureCompleted?: (orderId: string | undefined, captureId: string, amountCents: number | null) => unknown;
}): Promise<WebhookOutcome> {
  const { pipeline, db } = input;
  const reject = (status: number, reason: string, extra: Record<string, unknown> = {}): WebhookOutcome => {
    pipeline.audit.append('paypal.webhook.rejected', { reason, transmissionId: input.headers.get('paypal-transmission-id'), ...extra });
    return { status, body: { error: reason } };
  };

  if (!input.webhookId) return { status: 503, body: { error: 'WEBHOOK_NOT_CONFIGURED' } };
  if (input.rawBody.length > 256_000) return reject(413, 'BODY_TOO_LARGE');
  const headers = readWebhookHeaders(input.headers);
  if (!headers) return reject(400, 'MISSING_SIGNATURE_HEADERS');

  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(input.rawBody) as PayPalWebhookEvent;
    if (typeof event.id !== 'string' || typeof event.event_type !== 'string') throw new Error('shape');
  } catch {
    return reject(400, 'INVALID_JSON');
  }

  let verified = false;
  try {
    verified = await verifyWebhookSignature(input.paypal, headers, input.webhookId, input.rawBody);
  } catch (err) {
    return reject(502, 'VERIFICATION_UNAVAILABLE', { message: (err as Error).message.slice(0, 200) });
  }
  if (!verified) return reject(401, 'SIGNATURE_INVALID', { eventId: event.id, eventType: event.event_type });

  const inserted = db
    .prepare('INSERT OR IGNORE INTO webhook_events (id, event_type, resource_id, received_ms) VALUES (?, ?, ?, ?)')
    .run(event.id, event.event_type, payoutBatchIdOf(event) ?? event.resource?.id ?? null, input.now ?? Date.now());
  if (inserted.changes === 0) return { status: 200, body: { ok: true, duplicate: true } };

  pipeline.audit.append('paypal.webhook', { eventId: event.id, eventType: event.event_type, payoutBatchId: payoutBatchIdOf(event) });

  const paypalBatchId = payoutBatchIdOf(event);
  if (paypalBatchId) {
    const row = db.prepare('SELECT id FROM payout_batches WHERE paypal_batch_id = ?').get(paypalBatchId) as { id: number } | undefined;
    if (row) {
      const s = await pipeline.poll(row.id, input.paypal);
      return { status: 200, body: { ok: true, batchStatus: s.batch.status } };
    }
    return { status: 200, body: { ok: true, ignored: 'unknown batch' } };
  }
  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' && input.onCaptureCompleted) {
    const r = (event.resource ?? {}) as { id?: string; amount?: { value?: string }; supplementary_data?: { related_ids?: { order_id?: string } } };
    if (r.id) {
      const cents = r.amount?.value ? Math.round(Number(r.amount.value) * 100) : null;
      input.onCaptureCompleted(r.supplementary_data?.related_ids?.order_id, r.id, Number.isFinite(cents) ? cents : null);
    }
  }
  return { status: 200, body: { ok: true } };
}
