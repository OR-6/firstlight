import { z } from 'zod';
import { fail, json, readBody } from '@/server/http';
import { eventView } from '@/server/views';
import { EventId } from '../event-id';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ReplayBody = z.object({ eventId: EventId.default('us6000u18k') });

/** Load a recorded real event (USGS + EMSC copies) for review before assessing. */
export async function POST(req: Request) {
  try {
    const { eventId } = await readBody(req, ReplayBody);
    return json(eventView(eventId));
  } catch (e) {
    return fail(e);
  }
}
