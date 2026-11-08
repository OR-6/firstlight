import { baseUrl } from '@/server/http';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PayPal sends the donor here after they cancel, with `token` set to the order id.
 * Only a request that carries the matching order id can cancel, so receipt ids
 * seen in the public feed aren't enough to cancel someone else's donation.
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const receipt = url.searchParams.get('receipt') ?? '';
  const token = url.searchParams.get('token') ?? '';
  const to = new URL('/donate', baseUrl(req));
  if (/^rcpt_[0-9a-f]{16}$/.test(receipt)) {
    to.searchParams.set('receipt', receipt);
    if (firstlight().donations.cancel(receipt, token)) to.searchParams.set('canceled', '1');
  }
  return Response.redirect(to, 303);
}
