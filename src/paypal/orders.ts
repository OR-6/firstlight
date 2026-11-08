import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrdersController,
  PaymentsController,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type Order,
} from '@paypal/paypal-server-sdk';
import { toPayPalValue } from '../firewall/money';
import { PayPalClient, loadPayPalConfig, type PayPalConfig } from './client';
import { HostedPayPalMcp, type OrderLookup } from './hosted-mcp';

export type { OrderLookup } from './hosted-mcp';

/**
 * Donations through PayPal Orders v2 (SPEC §5.6), built on the official
 * PayPal Server SDK. Integration details (createOrder / captureOrder,
 * paypalRequestId, PaypalWalletExperienceContext) were taken from the APIMatic
 * Context Plugin (ContextMatic). Payouts stay on plain fetch in client.ts:
 * the SDK does not cover them.
 *
 * Sandbox only: loadPayPalConfig refuses anything but PAYPAL_ENV=sandbox.
 */
export type CreatedOrder = { orderId: string; status: string; approvalUrl: string };
export type CapturedOrder = {
  orderId: string;
  status: string;
  captureId: string | null;
  captureStatus: string | null;
  amountCents: number | null;
  /** PayPal account that approved the order (payment_source.paypal.account_id). Never shown publicly. */
  payerId?: string | null;
};
export type RefundResult = { refundId: string; status: string; amountCents: number | null };
/** An order as PayPal reports it right now, and which PayPal interface said so. */
export type OrderConfirmation = OrderLookup & { source: 'paypal_hosted_mcp' | 'paypal_orders_api'; fallbackReason?: string };

/** What the donation service needs from PayPal. Tests use a fake. */
export interface DonationOrders {
  create(input: { amountCents: number; receiptId: string; description: string; returnUrl: string; cancelUrl: string; requestId: string }): Promise<CreatedOrder>;
  capture(orderId: string, requestId: string): Promise<CapturedOrder>;
  /** Orders v2 get: status, payer and capture of an order. Read-only. */
  get(orderId: string): Promise<OrderLookup>;
  /** Refund (part of) a capture. `requestId` is the PayPal-Request-Id, so a retry never refunds twice. */
  refund(input: { captureId: string; amountCents: number; requestId: string; note: string }): Promise<RefundResult>;
  /** Read-only confirmation for receipts; falls back to `get` when absent. */
  confirm?(orderId: string): Promise<OrderConfirmation>;
}

export class OrdersError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'OrdersError';
  }
}

export class PayPalOrders implements DonationOrders {
  private readonly orders: OrdersController;
  private readonly payments: PaymentsController;
  private readonly mcp: HostedPayPalMcp | null;

  /**
   * `hostedMcp` (default on unless PAYPAL_HOSTED_MCP=off): receipts are
   * confirmed through PayPal's hosted sandbox MCP server (get_order only),
   * falling back to the Server SDK when it fails.
   */
  constructor(config: PayPalConfig = loadPayPalConfig(), opts: { hostedMcp?: boolean } = {}) {
    const client = new Client({
      clientCredentialsAuthCredentials: { oAuthClientId: config.clientId, oAuthClientSecret: config.clientSecret },
      environment: Environment.Sandbox,
      timeout: 20_000,
      // No SDK logging: request/response logs would include bearer tokens and payer details.
    });
    this.orders = new OrdersController(client);
    this.payments = new PaymentsController(client);
    const useMcp = opts.hostedMcp ?? process.env.PAYPAL_HOSTED_MCP !== 'off';
    const rest = new PayPalClient(config);
    this.mcp = useMcp ? new HostedPayPalMcp(async () => (await rest.getToken()).accessToken) : null;
  }

  async create(input: Parameters<DonationOrders['create']>[0]): Promise<CreatedOrder> {
    try {
      const res = await this.orders.createOrder({
        body: {
          intent: CheckoutPaymentIntent.Capture,
          purchaseUnits: [
            {
              referenceId: input.receiptId,
              customId: input.receiptId,
              description: input.description.slice(0, 127),
              amount: { currencyCode: 'USD', value: toPayPalValue(input.amountCents) },
            },
          ],
          paymentSource: {
            paypal: {
              experienceContext: {
                brandName: 'Firstlight relief pool (sandbox)',
                userAction: PaypalExperienceUserAction.PayNow,
                shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
                returnUrl: input.returnUrl,
                cancelUrl: input.cancelUrl,
              },
            },
          },
        },
        paypalRequestId: input.requestId,
        prefer: 'return=minimal',
      });
      const order = res.result;
      const approval = order.links?.find((l) => l.rel === 'payer-action') ?? order.links?.find((l) => l.rel === 'approve');
      if (!order.id || !approval) throw new OrdersError(res.statusCode, 'PayPal created the order but returned no approval link');
      return { orderId: order.id, status: order.status ?? 'CREATED', approvalUrl: approval.href };
    } catch (err) {
      throw toOrdersError(err, 'create order');
    }
  }

  async capture(orderId: string, requestId: string): Promise<CapturedOrder> {
    if (!/^[A-Z0-9]{8,36}$/.test(orderId)) throw new OrdersError(null, 'invalid order id');
    try {
      const res = await this.orders.captureOrder({ id: orderId, paypalRequestId: requestId, prefer: 'return=representation' });
      return summarise(res.result);
    } catch (err) {
      throw toOrdersError(err, 'capture order');
    }
  }

  async get(orderId: string): Promise<OrderLookup> {
    if (!/^[A-Z0-9]{8,36}$/.test(orderId)) throw new OrdersError(null, 'invalid order id');
    try {
      const res = await this.orders.getOrder({ id: orderId });
      const s = summarise(res.result);
      return { ...s, payerId: s.payerId ?? null };
    } catch (err) {
      throw toOrdersError(err, 'get order');
    }
  }

  async refund(input: { captureId: string; amountCents: number; requestId: string; note: string }): Promise<RefundResult> {
    if (!/^[A-Z0-9]{8,36}$/.test(input.captureId)) throw new OrdersError(null, 'invalid capture id');
    try {
      const res = await this.payments.refundCapturedPayment({
        captureId: input.captureId,
        paypalRequestId: input.requestId,
        prefer: 'return=representation',
        body: { amount: { currencyCode: 'USD', value: toPayPalValue(input.amountCents) }, noteToPayer: input.note.slice(0, 255) },
      });
      const r = res.result;
      if (!r.id) throw new OrdersError(res.statusCode, 'PayPal accepted the refund but returned no refund id');
      const value = r.amount?.value;
      return { refundId: r.id, status: r.status ?? 'UNKNOWN', amountCents: value ? Math.round(Number(value) * 100) : null };
    } catch (err) {
      throw toOrdersError(err, 'refund capture');
    }
  }

  /** Hosted MCP get_order first, Server SDK getOrder if that fails (the reason is kept). */
  async confirm(orderId: string): Promise<OrderConfirmation> {
    let fallbackReason: string | undefined;
    if (this.mcp) {
      try {
        return { ...(await this.mcp.getOrder(orderId)), source: 'paypal_hosted_mcp' };
      } catch (err) {
        fallbackReason = `hosted MCP: ${(err as Error).message}`.slice(0, 200);
      }
    }
    return { ...(await this.get(orderId)), source: 'paypal_orders_api', ...(fallbackReason ? { fallbackReason } : {}) };
  }
}

export function summarise(order: Order): CapturedOrder {
  const capture = order.purchaseUnits?.[0]?.payments?.captures?.[0];
  const value = capture?.amount?.value;
  return {
    orderId: order.id ?? '',
    status: order.status ?? 'UNKNOWN',
    captureId: capture?.id ?? null,
    captureStatus: capture?.status ?? null,
    amountCents: value ? Math.round(Number(value) * 100) : null,
    // payer.payer_id is deprecated in favour of payment_source.paypal.account_id (ContextMatic, Order model).
    payerId: order.paymentSource?.paypal?.accountId ?? order.payer?.payerId ?? null,
  };
}

function toOrdersError(err: unknown, what: string): OrdersError {
  if (err instanceof OrdersError) return err;
  if (err instanceof ApiError) {
    let detail = '';
    try {
      const body = typeof err.body === 'string' ? (JSON.parse(err.body) as { name?: string; details?: { issue?: string }[] }) : null;
      detail = [body?.name, body?.details?.[0]?.issue].filter(Boolean).join(': ');
    } catch {
      /* body not JSON */
    }
    return new OrdersError(err.statusCode, `PayPal could not ${what} (HTTP ${err.statusCode}${detail ? `, ${detail}` : ''})`);
  }
  return new OrdersError(null, `PayPal could not ${what}: ${(err as Error).message}`);
}
