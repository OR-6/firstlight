import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrdersController,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type Order,
} from '@paypal/paypal-server-sdk';
import { toPayPalValue } from '../firewall/money';
import { loadPayPalConfig, type PayPalConfig } from './client';

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
export type CapturedOrder = { orderId: string; status: string; captureId: string | null; captureStatus: string | null; amountCents: number | null };

/** What the donation service needs from PayPal. Tests use a fake. */
export interface DonationOrders {
  create(input: { amountCents: number; receiptId: string; description: string; returnUrl: string; cancelUrl: string; requestId: string }): Promise<CreatedOrder>;
  capture(orderId: string, requestId: string): Promise<CapturedOrder>;
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

  constructor(config: PayPalConfig = loadPayPalConfig()) {
    const client = new Client({
      clientCredentialsAuthCredentials: { oAuthClientId: config.clientId, oAuthClientSecret: config.clientSecret },
      environment: Environment.Sandbox,
      timeout: 20_000,
      // No SDK logging: request/response logs would include bearer tokens and payer details.
    });
    this.orders = new OrdersController(client);
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
