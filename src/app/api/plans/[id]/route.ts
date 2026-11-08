import { fail, json, planIdParam } from '@/server/http';
import { planView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const v = planView(await planIdParam(ctx));
    return v ? json(v) : json({ error: 'NOT_FOUND', message: 'No plan with that id.' }, 404);
  } catch (e) {
    return fail(e);
  }
}
