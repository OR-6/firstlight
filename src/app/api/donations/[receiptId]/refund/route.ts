import { donationFail, json, readText } from '@/server/http';
import { firstlight, tracked } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Staff refund a captured donation: body {"amount_usd"?: number, "reason"?: string}
 * (no amount = everything not yet returned). Same openness as the other console
 * actions in this demo (no sign-in); a real deployment puts it behind staff auth.
 * Refused if it exceeds what was captured or would take the pool below zero.
 */
export async function POST(req: Request, ctx: { params: Promise<{ receiptId: string }> }) {
  try {
    const receiptId = (await ctx.params).receiptId;
    if (!/^rcpt_[0-9a-f]{16}$/.test(receiptId)) return json({ error: 'NOT_FOUND', message: 'No donation with that receipt.' }, 404);
    const body = JSON.parse((await readText(req, 2_000)) || '{}') as unknown;
    const d = await tracked(() => firstlight().donations.refund(receiptId, body));
    return json({ receiptId: d.receipt_id, status: d.status, refundedUsd: (d.refunded_cents / 100).toFixed(2), refundId: d.refundId, refundStatus: d.refundStatus });
  } catch (e) {
    return donationFail(e);
  }
}
