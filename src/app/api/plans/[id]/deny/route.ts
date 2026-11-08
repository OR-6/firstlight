import { fail, json, readJson } from '@/server/http';
import { firstlight } from '@/server/runtime';
import { planView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const planId = Number((await ctx.params).id);
    const { approver, reason } = await readJson<{ approver?: string; reason?: string }>(req);
    firstlight().pipeline.decide(planId, 'deny', approver ?? '', reason ?? '');
    return json(planView(planId));
  } catch (e) {
    return fail(e);
  }
}
