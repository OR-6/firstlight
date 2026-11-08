import { json } from '@/server/http';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = (await ctx.params).id;
  if (!/^rcpt_[0-9a-f]{16}$/.test(id)) return json({ error: 'NOT_FOUND', message: 'No donation with that receipt.' }, 404);
  const r = firstlight().donations.receipt(id);
  return r ? json(r) : json({ error: 'NOT_FOUND', message: 'No donation with that receipt.' }, 404);
}
