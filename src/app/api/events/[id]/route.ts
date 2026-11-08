import { fail, json } from '@/server/http';
import { eventView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    return json(eventView((await ctx.params).id));
  } catch (e) {
    return fail(e);
  }
}
