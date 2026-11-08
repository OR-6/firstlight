import { json } from '@/server/http';
import { listReplayEvents } from '@/signals/replay';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return json({ events: listReplayEvents() });
}
