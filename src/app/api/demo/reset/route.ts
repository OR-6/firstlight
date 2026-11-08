import { json } from '@/server/http';
import { resetDemo } from '@/server/runtime';
import { stateView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Start the demo over: fresh ledger, plans and audit log. Sandbox only. */
export function POST() {
  resetDemo();
  return json(stateView());
}
