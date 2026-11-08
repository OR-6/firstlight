import { DonationService } from '../../src/donations/service';
import type { Db } from '../../src/ledger/db';
import type { CapturedOrder, DonationOrders, OrderLookup, RefundResult } from '../../src/paypal/orders';
import type { PayPalClient } from '../../src/paypal/client';
import { handlePayPalWebhook } from '../../src/pipeline/webhooks';
import { GOOD_PLAN, makePipeline, scriptedAgent } from './pipeline-fixture';

export const DNOW = Date.parse('2026-11-10T12:00:00Z');

export type FakeOrderOpts = {
  captureCents?: number;
  captureStatus?: string;
  failCapture?: boolean;
  /** PayPal payer id that approves orders (change it to simulate another PayPal account). */
  payer?: string;
  /** Payer the capture response reports, if different from the approval (should never happen). */
  capturePayer?: string;
  failGet?: boolean;
  refundStatus?: string;
  failRefund?: boolean;
  /** When set, the fake has a confirm() like PayPalOrders (hosted MCP path). */
  confirmSource?: 'paypal_hosted_mcp' | 'paypal_orders_api';
};

/** Fake PayPal Orders API: create returns an approval link, capture is idempotent per order, refunds per PayPal-Request-Id. */
export function fakeOrders(opts: FakeOrderOpts = {}) {
  let n = 0;
  const calls = { create: [] as string[], capture: [] as string[], get: [] as string[], confirm: [] as string[], refund: [] as { captureId: string; amountCents: number; requestId: string }[] };
  const captured = new Map<string, CapturedOrder>();
  const approvedBy = new Map<string, string>();
  const amounts = new Map<string, number>();
  const refunds = new Map<string, RefundResult>();
  const lookup = (orderId: string): OrderLookup => {
    const c = captured.get(orderId);
    const payerId = approvedBy.get(orderId) ?? opts.payer ?? 'PAYERTESTA1';
    return c ? { ...c, payerId: c.payerId ?? payerId } : { orderId, status: 'APPROVED', payerId, captureId: null, captureStatus: null, amountCents: null };
  };
  const orders: DonationOrders = {
    async create(input) {
      calls.create.push(input.requestId);
      const orderId = `ORDER${String(++n).padStart(8, '0')}`;
      amounts.set(orderId, input.amountCents);
      return { orderId, status: 'PAYER_ACTION_REQUIRED', approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` };
    },
    async capture(orderId, requestId) {
      calls.capture.push(requestId);
      if (opts.failCapture) throw new Error('PayPal could not capture order (HTTP 503)');
      const prev = captured.get(orderId);
      if (prev) return prev;
      const payerId = opts.capturePayer ?? approvedBy.get(orderId) ?? opts.payer ?? 'PAYERTESTA1';
      const r: CapturedOrder = { orderId, status: 'COMPLETED', captureId: `CAP${orderId.slice(5)}`, captureStatus: opts.captureStatus ?? 'COMPLETED', amountCents: opts.captureCents ?? amounts.get(orderId) ?? null, payerId };
      captured.set(orderId, r);
      return r;
    },
    async get(orderId) {
      calls.get.push(orderId);
      if (opts.failGet) throw new Error('PayPal could not get order (HTTP 503)');
      const r = lookup(orderId);
      if (!captured.has(orderId)) approvedBy.set(orderId, r.payerId!);
      return r;
    },
    async refund(input) {
      calls.refund.push({ captureId: input.captureId, amountCents: input.amountCents, requestId: input.requestId });
      if (opts.failRefund) throw new Error('PayPal could not refund capture (HTTP 422, UNPROCESSABLE_ENTITY: CAPTURE_FULLY_REFUNDED)');
      const prev = refunds.get(input.requestId);
      if (prev) return prev; // PayPal-Request-Id idempotency
      const r = { refundId: `REF${String(refunds.size + 1).padStart(10, '0')}`, status: opts.refundStatus ?? 'COMPLETED', amountCents: input.amountCents };
      refunds.set(input.requestId, r);
      return r;
    },
  };
  if (opts.confirmSource) {
    orders.confirm = async (orderId) => {
      calls.confirm.push(orderId);
      if (opts.failGet) throw new Error('hosted MCP and SDK both failed');
      return { ...lookup(orderId), source: opts.confirmSource! };
    };
  }
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
