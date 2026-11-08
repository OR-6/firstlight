import { json } from '@/server/http';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A single-use nonce for the allowance form on /agents, valid 10 minutes.
 * No CORS headers, so script on another site can't read it.
 */
export function GET() {
  return json(firstlight().donations.humanGate.issue());
}
