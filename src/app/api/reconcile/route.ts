import { json } from '@/server/http';
import { reconcileView } from '@/server/views';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only: compare each submitted batch in the ledger with PayPal (batch GET,
 * and Transaction Search when the app has that scope). Per batch: "matches",
 * "differences" (listed), "in_progress", or "unavailable". Never a 500 for a
 * PayPal problem: the page shows what could and couldn't be checked.
 */
export async function GET() {
  try {
    return json(await reconcileView());
  } catch (e) {
    console.error(e);
    return json({ configured: false, batches: [], message: 'Reconciliation could not run on the server. Payout statuses above still come from PayPal.' });
  }
}
