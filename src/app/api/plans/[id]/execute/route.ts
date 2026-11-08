import { fail, json } from '@/server/http';
import { PipelineError } from '@/pipeline/pipeline';
import { firstlight, refundExecutionSlot, startPolling, takeExecutionSlot, tracked } from '@/server/runtime';
import { planView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Send the approved plan to the PayPal SANDBOX as one Payouts batch, then poll until it settles. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const planId = Number((await ctx.params).id);
  if (!Number.isSafeInteger(planId) || planId < 1) return json({ error: 'NOT_FOUND', message: 'No plan with that id.' }, 404);
  const rt = firstlight();
  const view = planView(planId);
  if (!view) return json({ error: 'NOT_FOUND', message: 'No plan with that id.' }, 404);
  const tookSlot = !view.batch;
  if (tookSlot && !takeExecutionSlot()) {
    return json({ error: 'RATE_LIMITED', message: 'The demo allows a few sandbox payout batches per hour. Try again later.' }, 429);
  }
  try {
    const batch = await tracked(() => rt.pipeline.execute(planId, rt.paypal(), rt.payees()));
    startPolling(batch.id);
    return json(planView(planId));
  } catch (e) {
    // Refused before PayPal was asked (needs approval, blocked, state changed, no payee): no slot used.
    if (tookSlot && e instanceof PipelineError) refundExecutionSlot();
    return fail(e);
  }
}
