import { fail, json, readJson } from '@/server/http';
import { eventView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Load a recorded real event (USGS + EMSC copies) for review before assessing. */
export async function POST(req: Request) {
  try {
    const { eventId } = await readJson<{ eventId?: string }>(req);
    return json(eventView(eventId ?? 'us6000u18k'));
  } catch (e) {
    return fail(e);
  }
}
