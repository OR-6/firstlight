import { json } from '@/server/http';
import { auditView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const limit = Math.min(1000, Number(new URL(req.url).searchParams.get('limit') ?? 300));
  return json(auditView(limit));
}
