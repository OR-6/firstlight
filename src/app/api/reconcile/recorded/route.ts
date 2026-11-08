import { json } from '@/server/http';
import { recordedBatchesView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only: the sandbox payout batches we made while building, as PayPal
 * reports them now (status, items, total, fees, PayPal's own timestamps),
 * compared with what docs/decisions.md recorded. Cached 10 minutes. Never a
 * 500: if PayPal can't be reached, each batch says so.
 */
export async function GET() {
  try {
    return json(await recordedBatchesView());
  } catch (e) {
    console.error(e);
    return json({ configured: false, checkedMs: null, batches: [] });
  }
}
