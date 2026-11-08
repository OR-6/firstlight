import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PayPal sends the donor back here after approval. Capture, credit the pool, show the receipt. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const receipt = url.searchParams.get('receipt') ?? '';
  const token = url.searchParams.get('token') ?? undefined;
  const to = new URL('/donate', url);
  to.searchParams.set('receipt', receipt);
  if (!/^rcpt_[0-9a-f]{16}$/.test(receipt)) {
    to.searchParams.set('error', 'unknown');
    return Response.redirect(to, 303);
  }
  try {
    await firstlight().donations.capture(receipt, token);
  } catch (e) {
    to.searchParams.set('error', (e as Error).message.slice(0, 120));
  }
  return Response.redirect(to, 303);
}
