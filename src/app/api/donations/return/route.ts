import { baseUrl } from '@/server/http';
import { DonationError } from '@/donations/service';
import { firstlight, tracked } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PayPal sends the donor back here after approval. Capture, credit the pool, show the receipt. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const receipt = url.searchParams.get('receipt') ?? '';
  const token = url.searchParams.get('token') ?? undefined;
  // Redirect to the PUBLIC origin; req.url is the proxy's internal address on Render.
  const to = new URL('/donate', baseUrl(req));
  if (!/^rcpt_[0-9a-f]{16}$/.test(receipt)) {
    to.searchParams.set('error', 'UNKNOWN_RECEIPT');
    return Response.redirect(to, 303);
  }
  to.searchParams.set('receipt', receipt);
  try {
    await tracked(() => firstlight().donations.capture(receipt, token));
  } catch (e) {
    // Only a code goes in the URL; the page maps it to fixed text (no attacker-written messages).
    to.searchParams.set('error', e instanceof DonationError ? e.code : 'CAPTURE_FAILED');
  }
  return Response.redirect(to, 303);
}
