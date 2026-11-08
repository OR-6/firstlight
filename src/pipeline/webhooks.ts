import type { Db } from '../ledger/db';
import type { PayPalClient } from '../paypal/client';
import type { CaptureEvent, ReturnEvent } from '../donations/service';
import { donationWebhookOf, payoutBatchIdOf, readWebhookHeaders, verifyWebhookSignature, type PayPalWebhookEvent } from '../paypal/webhooks';
import type { Pipeline } from './pipeline';

export type WebhookOutcome = { status: number; body: Record<string, unknown> };

/** One `paypal.webhook.rejected` audit entry per this window at most. */
export const REJECTED_WINDOW_MS = 60_000;
const rejections = new WeakMap<Db, { lastWrittenMs: number; unwritten: number }>();

/**
 * Count a delivery PayPal's verify call refused. Returns the count to write (this one
 * plus any held back since the last entry), or null when an entry was written less
 * than a minute ago (the delivery is then counted into the next entry).
 */
function countRejection(db: Db, now: number): number | null {
  const s = rejections.get(db) ?? { lastWrittenMs: -Infinity, unwritten: 0 };
  rejections.set(db, s);
  if (now - s.lastWrittenMs < REJECTED_WINDOW_MS) {
    s.unwritten++;
    return null;
  }
  const count = s.unwritten + 1;
  s.lastWrittenMs = now;
  s.unwritten = 0;
  return count;
}

/** What the webhook handler needs from the donation side (DonationService implements it). */
export interface DonationWebhookSink {
  onCaptureCompleted(orderId: string | undefined, captureId: string, amountCents: number | null): unknown;
  onCapturePending(e: CaptureEvent): unknown;
  onCaptureDenied(e: CaptureEvent): unknown;
  onCaptureReturned(kind: 'refund' | 'reversal', e: ReturnEvent): unknown;
  onOrderApproved(orderId: string): Promise<unknown>;
}

/**
 * Handle one PayPal webhook delivery (SPEC §5.7):
 *  1. refuse if no webhook id is configured, headers are missing, or the body is not JSON;
 *  2. verify the signature with PayPal; unverified deliveries change nothing;
 *  3. de-duplicate on PayPal's event id;
 *  4. for payout events, GET the batch from PayPal (webhook payloads carry no item
 *     detail and no error objects) and update the ledger from that;
 *  5. for donation events (order approved, capture completed/pending/denied,
 *     refunded, reversed), hand them to the donation service.
 * If processing fails, the de-duplication row is removed so PayPal's retry is processed.
 */
export async function handlePayPalWebhook(input: {
  pipeline: Pipeline;
  db: Db;
  paypal: PayPalClient;
  webhookId: string | undefined;
  headers: { get(name: string): string | null };
  rawBody: string;
  now?: number;
  /** Donation lifecycle (DonationService). */
  donations?: DonationWebhookSink;
  /** PAYMENT.CAPTURE.COMPLETED only, when no `donations` sink is given (older callers). */
  onCaptureCompleted?: (orderId: string | undefined, captureId: string, amountCents: number | null) => unknown;
}): Promise<WebhookOutcome> {
  const { pipeline, db } = input;
  // Only deliveries PayPal itself checked and refused go in the audit log. Malformed or
  // unsigned requests are refused without a write, so they can't flood the chain.
  // Those are collapsed to at most one entry a minute, carrying how many were refused.
  const reject = (status: number, reason: string, extra: Record<string, unknown> = {}): WebhookOutcome => {
    if (reason === 'SIGNATURE_INVALID') {
      const count = countRejection(db, input.now ?? Date.now());
      if (count !== null) pipeline.audit.append('paypal.webhook.rejected', { reason, transmissionId: input.headers.get('paypal-transmission-id'), ...extra, count, windowMs: REJECTED_WINDOW_MS });
    }
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
  try {
    const paypalBatchId = payoutBatchIdOf(event);
    if (paypalBatchId) {
      const row = db.prepare('SELECT id FROM payout_batches WHERE paypal_batch_id = ?').get(paypalBatchId) as { id: number } | undefined;
      if (row) {
        const s = await pipeline.poll(row.id, input.paypal);
        return { status: 200, body: { ok: true, batchStatus: s.batch.status } };
      }
      return { status: 200, body: { ok: true, ignored: 'unknown batch' } };
    }
    const d = donationWebhookOf(event);
    if (d) {
      const sink = input.donations;
      switch (d.kind) {
        case 'capture_completed':
          if (sink) await sink.onCaptureCompleted(d.orderId ?? undefined, d.captureId, d.amountCents);
          else if (input.onCaptureCompleted) await input.onCaptureCompleted(d.orderId ?? undefined, d.captureId, d.amountCents);
          break;
        case 'capture_pending':
          await sink?.onCapturePending({ orderId: d.orderId, captureId: d.captureId, reason: d.reason });
          break;
        case 'capture_denied':
          await sink?.onCaptureDenied({ orderId: d.orderId, captureId: d.captureId, reason: d.reason });
          break;
        case 'refund':
        case 'reversal':
          await sink?.onCaptureReturned(d.kind, { captureId: d.captureId, orderId: d.orderId, refId: d.refId, eventId: event.id, amountCents: d.amountCents });
          break;
        case 'order_approved':
          // Same idempotent capture as the return URL, for donors who approved but never came back.
          await sink?.onOrderApproved(d.orderId);
          break;
      }
    }
    return { status: 200, body: { ok: true } };
  } catch (err) {
    // Forget the delivery so PayPal's retry is processed instead of answered as a duplicate.
    db.prepare('DELETE FROM webhook_events WHERE id = ?').run(event.id);
    throw err;
  }
}
