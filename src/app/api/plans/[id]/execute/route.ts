import { NotConfiguredError, fail, json, planIdParam } from '@/server/http';
import { PipelineError } from '@/pipeline/pipeline';
import { firstlight, refundExecutionSlot, startPolling, takeExecutionSlot, tracked, withPlanLock } from '@/server/runtime';
import { planView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Send the approved plan to the PayPal SANDBOX as one Payouts batch, then poll until it settles. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let slot: number | null = null;
  try {
    const planId = await planIdParam(ctx);
    const rt = firstlight();
    const view = planView(planId);
    if (!view) return json({ error: 'NOT_FOUND', message: 'No plan with that id.' }, 404);
    slot = view.batch ? null : takeExecutionSlot();
    if (!view.batch && slot === null) {
      return json({ error: 'RATE_LIMITED', message: 'The demo allows a few sandbox payout batches per hour. Try again later.' }, 429);
    }
    const batch = await withPlanLock(planId, () => tracked(() => rt.pipeline.execute(planId, rt.paypal(), rt.payees())));
    if (batch === 'BUSY') {
      if (slot !== null) refundExecutionSlot(slot);
      return json({ error: 'IN_PROGRESS', message: 'This plan is already being sent. Its status will update here.' }, 409);
    }
    startPolling(batch.id);
    return json(planView(planId));
  } catch (e) {
    // Refused before PayPal was asked (needs approval, blocked, state changed, no payee,
    // PayPal or payee map not configured): give the slot back.
    if (slot !== null && (e instanceof PipelineError || e instanceof NotConfiguredError)) refundExecutionSlot(slot);
    return fail(e);
  }
}
