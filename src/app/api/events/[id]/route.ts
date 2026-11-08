import { fail, json, validate } from '@/server/http';
import { eventView } from '@/server/views';
import { EventId } from '../event-id';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    return json(eventView(validate(EventId, (await ctx.params).id, 'event id')));
  } catch (e) {
    return fail(e);
  }
}
