import { json } from '@/server/http';
import { auditView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const n = Number(new URL(req.url).searchParams.get('limit') ?? 300);
  const limit = Number.isFinite(n) ? Math.max(1, Math.min(1000, Math.trunc(n))) : 300;
  return json(auditView(limit));
}
