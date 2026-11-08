import { toPayPalValue } from '../firewall/money';
import type { PayPalClient, PayPalResponse } from './client';

/** Payouts API v1 (SPEC §5.5). Pure body builder + two thin calls. */

export type PayoutItemInput = {
  receiverEmail: string;
  amountCents: number;
  note: string;
  /** Must be unique; Firstlight uses `<eventId>:<recipientId>`. */
  senderItemId: string;
};

export type PayoutBatchInput = {
  senderBatchId: string;
  emailSubject: string;
  emailMessage: string;
  items: PayoutItemInput[];
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function buildPayoutBatchBody(input: PayoutBatchInput) {
  if (input.items.length === 0) throw new Error('payout batch has no items');
  if (input.items.length > 15_000) throw new Error('payout batch exceeds 15,000 items');
  const ids = new Set<string>();
  for (const i of input.items) {
    // Defence in depth: the firewall already guarantees these.
    if (!EMAIL.test(i.receiverEmail)) throw new Error(`invalid receiver email for ${i.senderItemId}`);
    if ([...i.note].length > 200) throw new Error(`note too long for ${i.senderItemId}`);
    if (ids.has(i.senderItemId)) throw new Error(`duplicate sender_item_id ${i.senderItemId}`);
    ids.add(i.senderItemId);
  }
  return {
    sender_batch_header: {
      sender_batch_id: input.senderBatchId,
      email_subject: input.emailSubject,
      email_message: input.emailMessage,
    },
    items: input.items.map((i) => ({
      recipient_type: 'EMAIL',
      amount: { value: toPayPalValue(i.amountCents), currency: 'USD' },
      receiver: i.receiverEmail,
      note: i.note,
      sender_item_id: i.senderItemId,
    })),
  };
}

export type CreatePayoutResponse = {
  batch_header: { payout_batch_id: string; batch_status: string; sender_batch_header?: { sender_batch_id?: string } };
  links?: { href: string; rel: string; method?: string }[];
};

export type PayoutBatchDetails = {
  batch_header: {
    payout_batch_id: string;
    batch_status: string;
    amount?: { value: string; currency: string };
    fees?: { value: string; currency: string };
  };
  items?: {
    payout_item_id: string;
    transaction_id?: string;
    transaction_status?: string;
    payout_item: { receiver?: string; amount?: { value: string; currency: string }; sender_item_id?: string; note?: string };
    errors?: { name?: string; message?: string };
  }[];
};

export function createPayoutBatch(
  client: PayPalClient,
  body: ReturnType<typeof buildPayoutBatchBody>,
  requestId: string,
): Promise<PayPalResponse<CreatePayoutResponse>> {
  return client.request<CreatePayoutResponse>('POST', '/v1/payments/payouts', { body, requestId });
}

export function getPayoutBatch(client: PayPalClient, payoutBatchId: string): Promise<PayPalResponse<PayoutBatchDetails>> {
  if (!/^[A-Z0-9]{6,40}$/i.test(payoutBatchId)) throw new Error(`invalid payout_batch_id: ${payoutBatchId}`);
  return client.request<PayoutBatchDetails>('GET', `/v1/payments/payouts/${payoutBatchId}`);
}

/** Batch statuses after which polling can stop. */
export const TERMINAL_BATCH_STATUSES = ['SUCCESS', 'DENIED', 'CANCELED'] as const;

/** One payout item as PayPal reports it (GET or cancel of /v1/payments/payouts-item/{id}). */
export type PayoutItemDetails = {
  payout_item_id: string;
  payout_batch_id?: string;
  transaction_id?: string;
  transaction_status?: string;
  payout_item?: { receiver?: string; amount?: { value: string; currency: string }; sender_item_id?: string };
  errors?: { name?: string; message?: string };
};

const ITEM_ID = /^[A-Z0-9]{6,40}$/i;

/**
 * Cancel an UNCLAIMED payout item (POST /v1/payments/payouts-item/{id}/cancel).
 * PayPal only accepts this while the item is unclaimed; the money goes back to
 * the sender and the item comes back as RETURNED. Not in the Server SDK.
 */
export function cancelPayoutItem(client: PayPalClient, payoutItemId: string): Promise<PayPalResponse<PayoutItemDetails>> {
  if (!ITEM_ID.test(payoutItemId)) throw new Error(`invalid payout_item_id: ${payoutItemId}`);
  // Empty body with a JSON Content-Type, as PayPal's reference shows (some POSTs refuse a missing type).
  return client.request<PayoutItemDetails>('POST', `/v1/payments/payouts-item/${payoutItemId}/cancel`, { rawBody: '' });
}
