import { z } from 'zod';
import { fail, json, readBody } from '@/server/http';
import { markReset, resetBlocker, resetDemo } from '@/server/runtime';
import { stateView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Takes no options: an empty body or {} (anything else is a 422). */
const ResetBody = z.strictObject({});

/** Start the demo over: fresh ledger, plans and audit log. Sandbox only. */
export async function POST(req: Request) {
  try {
    await readBody(req, ResetBody);
    const blocked = resetBlocker();
    if (blocked) return json({ error: 'RESET_BLOCKED', message: blocked }, 409);
    markReset();
    resetDemo();
    return json(stateView());
  } catch (e) {
    return fail(e);
  }
}
