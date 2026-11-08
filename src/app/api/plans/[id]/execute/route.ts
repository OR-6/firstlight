import { fail, json } from '@/server/http';
import { firstlight, startPolling, takeExecutionSlot } from '@/server/runtime';
import { planView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Send the approved plan to the PayPal SANDBOX as one Payouts batch, then poll until it settles. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const planId = Number((await ctx.params).id);
    const rt = firstlight();
    const existing = planView(planId)?.batch;
    if (!existing && !takeExecutionSlot()) {
      return json({ error: 'RATE_LIMITED', message: 'The demo allows a few sandbox payout batches per hour. Try again later.' }, 429);
    }
    const batch = await rt.pipeline.execute(planId, rt.paypal(), rt.payees());
    startPolling(batch.id);
    return json(planView(planId));
  } catch (e) {
    return fail(e);
  }
}
