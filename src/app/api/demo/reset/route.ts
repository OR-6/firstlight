import { json } from '@/server/http';
import { markReset, resetBlocker, resetDemo } from '@/server/runtime';
import { stateView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Start the demo over: fresh ledger, plans and audit log. Sandbox only. */
export function POST() {
  const blocked = resetBlocker();
  if (blocked) return json({ error: 'RESET_BLOCKED', message: blocked }, 409);
  markReset();
  resetDemo();
  return json(stateView());
}
