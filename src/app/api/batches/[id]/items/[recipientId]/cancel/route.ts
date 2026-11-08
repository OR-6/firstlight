import { fail, json } from '@/server/http';
import { firstlight, tracked } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RECIPIENT = /^[a-z0-9_]{1,40}$/i;

/**
 * Operator action: cancel an UNCLAIMED payout item at PayPal
 * (POST /v1/payments/payouts-item/{payout_item_id}/cancel). The money comes back
 * to the pool through the ledger's usual return path; both outcomes are audited.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string; recipientId: string }> }) {
  const { id, recipientId } = await ctx.params;
  const batchId = Number(id);
  if (!Number.isSafeInteger(batchId) || batchId < 1 || !RECIPIENT.test(recipientId)) {
    return json({ error: 'NOT_FOUND', message: 'No payout item with that id.' }, 404);
  }
  try {
    const rt = firstlight();
    const out = await tracked(() => rt.pipeline.cancelItem(batchId, recipientId, rt.paypal()));
    return json(out);
  } catch (e) {
    return fail(e);
  }
}
