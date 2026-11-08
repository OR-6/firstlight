import { z } from 'zod';
import { fail, json, queryOf, validate } from '@/server/http';
import { auditView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** ?limit=1..1000 newest entries (default 300). */
const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});

export function GET(req: Request) {
  try {
    return json(auditView(validate(AuditQuery, queryOf(req), 'query').limit));
  } catch (e) {
    return fail(e);
  }
}
