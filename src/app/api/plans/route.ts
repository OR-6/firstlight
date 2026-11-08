import { json } from '@/server/http';
import { plansList } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return json({ plans: plansList() });
}
