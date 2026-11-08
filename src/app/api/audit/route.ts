import { z } from 'zod';
import { fail, json, queryOf, validate } from '@/server/http';
import { auditView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** An empty query value (e.g. from a GET form left blank) means "not given". */
const optional = <S extends z.ZodType>(s: S) => z.preprocess((v) => (v === '' ? undefined : v), s.optional());

/**
 * ?limit=1..1000 newest entries (default 300), optionally narrowed (read-only):
 *   plan=<plan id>         entries for that plan, including its batch's PayPal entries
 *   batch=<id>             our batch id, or PayPal's payout_batch_id
 *   type=<t>[,<t>…]        exact event types, or a prefix such as paypal.*
 */
const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(300),
  plan: optional(z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER)),
  batch: optional(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be a batch id (letters, digits, _ or -)')),
  type: optional(z.string().regex(/^[a-z_]+(\.[a-z_]+)*(\.\*)?(,[a-z_]+(\.[a-z_]+)*(\.\*)?){0,19}$/, 'must be event types like paypal.webhook, comma-separated, or a prefix like paypal.*')),
});

export function GET(req: Request) {
  try {
    const q = validate(AuditQuery, queryOf(req), 'query');
    return json(auditView(q.limit, { plan: q.plan, batch: q.batch, types: q.type?.split(',') }));
  } catch (e) {
    return fail(e);
  }
}
