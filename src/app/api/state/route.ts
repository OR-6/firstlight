import { fail, json } from '@/server/http';
import { stateView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  try {
    return json(stateView());
  } catch (e) {
    return fail(e);
  }
}
