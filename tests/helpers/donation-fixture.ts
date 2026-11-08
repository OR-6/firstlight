import { DonationService } from '../../src/donations/service';
import type { Db } from '../../src/ledger/db';
import type { CapturedOrder, DonationOrders } from '../../src/paypal/orders';
import type { PayPalClient } from '../../src/paypal/client';
import { handlePayPalWebhook } from '../../src/pipeline/webhooks';
import { GOOD_PLAN, makePipeline, scriptedAgent } from './pipeline-fixture';

export const DNOW = Date.parse('2026-11-10T12:00:00Z');

/** Fake PayPal Orders API: create returns an approval link, capture is idempotent per order. */
export function fakeOrders(opts: { captureCents?: number; captureStatus?: string; failCapture?: boolean } = {}) {
  let n = 0;
  const calls = { create: [] as string[], capture: [] as string[] };
  const captured = new Map<string, CapturedOrder>();
  const orders: DonationOrders = {
    async create(input) {
      calls.create.push(input.requestId);
      const orderId = `ORDER${String(++n).padStart(8, '0')}`;
      return { orderId, status: 'PAYER_ACTION_REQUIRED', approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` };
    },
    async capture(orderId, requestId) {
      calls.capture.push(requestId);
      if (opts.failCapture) throw new Error('PayPal could not capture order (HTTP 503)');
      const prev = captured.get(orderId);
      if (prev) return prev;
      const r = { orderId, status: 'COMPLETED', captureId: `CAP${orderId.slice(5)}`, captureStatus: opts.captureStatus ?? 'COMPLETED', amountCents: opts.captureCents ?? null };
      captured.set(orderId, r);
      return r;
    },
  };
  return { orders, calls, opts };
}

/** Pipeline + donation service on an in-memory database, with a clock tests can move. */
export function donationSetup(o: { poolCents?: number; orders?: Parameters<typeof fakeOrders>[0] } = {}) {
  let now = DNOW;
  const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN), poolCents: o.poolCents ?? 1_000_00 });
  const fake = fakeOrders(o.orders);
  const db = (pipeline as unknown as { deps: { db: Db } }).deps.db;
  const svc = new DonationService({ db, audit: pipeline.audit, ledger: pipeline.ledger, orders: () => fake.orders, baseUrl: () => 'https://firstlight.test', clock: () => now });
  const allowance = (label = 'samaritan-agent', cap = 100, hours = 24) => svc.createAllowance({ label, cap_usd: cap, expires_in_hours: hours });
  return { pipeline, svc, fake, db, allowance, advance: (ms: number) => (now += ms), now: () => now };
}

const HEADERS = new Map([
  ['paypal-auth-algo', 'SHA256withRSA'],
  ['paypal-cert-url', 'https://api.sandbox.paypal.com/cert'],
  ['paypal-transmission-id', 't-1'],
  ['paypal-transmission-sig', 'sig'],
  ['paypal-transmission-time', '2026-11-10T12:00:00Z'],
]);

/** A PayPal client whose verify-webhook-signature says SUCCESS (or not). */
export function verifyingPayPal(verdict: 'SUCCESS' | 'FAILURE' = 'SUCCESS'): PayPalClient {
  return { request: async () => ({ status: 200, body: { verification_status: verdict }, debugId: null }) } as unknown as PayPalClient;
}

/** Deliver one webhook through the real handler, with the donation service as the sink. */
export function deliver(ctx: ReturnType<typeof donationSetup>, event: { id: string; event_type: string; resource: unknown }, paypal = verifyingPayPal()) {
  return handlePayPalWebhook({
    pipeline: ctx.pipeline,
    db: ctx.db,
    paypal,
    webhookId: 'WH-TEST',
    headers: { get: (k: string) => HEADERS.get(k) ?? null },
    rawBody: JSON.stringify(event),
    donations: ctx.svc,
  });
}

export const refundResource = (refundId: string, captureId: string, value: string) => ({
  id: refundId,
  status: 'COMPLETED',
  amount: { currency_code: 'USD', value },
  links: [
    { rel: 'self', method: 'GET', href: `https://api.sandbox.paypal.com/v2/payments/refunds/${refundId}` },
    { rel: 'up', method: 'GET', href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` },
  ],
});

export const captureResource = (captureId: string, orderId: string, value: string, status = 'COMPLETED', reason?: string) => ({
  id: captureId,
  status,
  amount: { currency_code: 'USD', value },
  ...(reason ? { status_details: { reason } } : {}),
  supplementary_data: { related_ids: { order_id: orderId } },
});
