import { paypalConfigured } from '@/paypal/client';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Readiness check for Render: the database opens and answers, and the response says what this
 * instance can do (replay or live agent, whether PayPal sandbox credentials are configured).
 * 503 if the database can't be read, so a broken instance is never marked healthy.
 */
export function GET() {
  try {
    const rt = firstlight();
    const auditEntries = (rt.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    return Response.json({ ok: true, sandbox: true, db: 'ok', llmMode: rt.llmMode, paypalConfigured: paypalConfigured(), auditEntries });
  } catch {
    return Response.json({ ok: false, sandbox: true, db: 'unavailable' }, { status: 503 });
  }
}
