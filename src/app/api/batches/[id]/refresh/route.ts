import { fail, json } from '@/server/http';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ask PayPal for the batch's current status now (same as the 2 s poller). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const rt = firstlight();
    const s = await rt.pipeline.poll(Number((await ctx.params).id), rt.paypal());
    return json({ status: s.batch.status, terminal: s.terminal, items: s.items });
  } catch (e) {
    return fail(e);
  }
}
