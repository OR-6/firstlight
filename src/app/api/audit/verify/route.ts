import { json } from '@/server/http';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Recompute the hash chain. ?upTo=<hash> verifies a prefix (donor receipts, SPEC §5.6b). */
function verify(req: Request) {
  const upTo = new URL(req.url).searchParams.get('upTo') ?? undefined;
  if (upTo && !/^[0-9a-f]{64}$/.test(upTo)) return json({ ok: false, reason: 'upTo must be a 64-character hex hash' }, 400);
  return json(firstlight().pipeline.audit.verify(upTo));
}
export const GET = verify;
export const POST = verify;
