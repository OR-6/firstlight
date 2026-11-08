import { fail, json, planIdParam } from '@/server/http';
import { firstlight } from '@/server/runtime';
import { planView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Draft the firewall's own plan for this plan's earthquake (D91): every enrolled household
 * owed, at its full tier, written by deterministic code. Always needs a person to approve.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const planId = await planIdParam(ctx);
    if (!planView(planId)) return json({ error: 'NOT_FOUND', message: 'No plan with that id.' }, 404);
    const { planId: newId } = firstlight().pipeline.draftFloorPlan(planId);
    return json(planView(newId), 201);
  } catch (e) {
    return fail(e);
  }
}
