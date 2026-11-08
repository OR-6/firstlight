import { json } from '@/server/http';
import { batchesView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return json({ batches: batchesView() });
}
