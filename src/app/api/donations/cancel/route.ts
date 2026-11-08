import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const url = new URL(req.url);
  const receipt = url.searchParams.get('receipt') ?? '';
  if (/^rcpt_[0-9a-f]{16}$/.test(receipt)) firstlight().donations.cancel(receipt);
  const to = new URL('/donate', url);
  to.searchParams.set('receipt', receipt);
  to.searchParams.set('canceled', '1');
  return Response.redirect(to, 303);
}
