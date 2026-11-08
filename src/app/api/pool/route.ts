import { poolStatusView } from '@/agentapi/catalog';
import { json } from '@/server/http';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return json(poolStatusView(firstlight().donations));
}
