/**
 * Register Firstlight's webhook on the PayPal SANDBOX app (SPEC §5.7 / §11).
 *
 *   npm run webhook:register -- https://firstlight.onrender.com
 *
 * Prints the webhook id to set as PAYPAL_WEBHOOK_ID on the server. If a
 * webhook for that URL already exists, prints its id instead.
 */
import { PayPalApiError, PayPalClient, loadPayPalConfig } from '../src/paypal/client';

const base = (process.argv[2] ?? process.env.APP_BASE_URL ?? '').replace(/\/$/, '');
if (!/^https:\/\//.test(base)) {
  console.error('Usage: npm run webhook:register -- https://your-app.onrender.com  (PayPal needs a public https URL)');
  process.exit(1);
}
const url = `${base}/api/webhooks/paypal`;

const EVENTS = [
  'PAYMENT.PAYOUTSBATCH.PROCESSING',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.HELD',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.REFUNDED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED',
  'PAYMENT.CAPTURE.COMPLETED',
];

const client = new PayPalClient(loadPayPalConfig());
try {
  const existing = await client.request<{ webhooks?: { id: string; url: string }[] }>('GET', '/v1/notifications/webhooks');
  const found = existing.body.webhooks?.find((w) => w.url === url);
  if (found) {
    console.log(`Already registered: ${url}\nPAYPAL_WEBHOOK_ID=${found.id}`);
  } else {
    const res = await client.request<{ id: string }>('POST', '/v1/notifications/webhooks', {
      body: { url, event_types: EVENTS.map((name) => ({ name })) },
    });
    console.log(`Registered ${url} for ${EVENTS.length} event types (sandbox).\nPAYPAL_WEBHOOK_ID=${res.body.id}`);
  }
} catch (e) {
  console.error(e instanceof PayPalApiError ? e.message : (e as Error).message);
  process.exitCode = 1;
}
