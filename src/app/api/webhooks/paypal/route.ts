import { handlePayPalWebhook } from '@/pipeline/webhooks';
import { firstlight, tracked } from '@/server/runtime';
import { readText } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const recent: number[] = [];
/** PayPal sends a few deliveries per payout item; 60 a minute is plenty and caps verify calls and audit writes. */
function webhookBudget(now = Date.now(), perMinute = 60): boolean {
  while (recent.length && recent[0]! < now - 60_000) recent.shift();
  if (recent.length >= perMinute) return false;
  recent.push(now);
  return true;
}

/** Every real PayPal delivery carries these; without them a request can't be verified, so it isn't counted or verified. */
const TRANSMISSION_HEADERS = ['paypal-transmission-id', 'paypal-transmission-time', 'paypal-transmission-sig'] as const;

/** PayPal sandbox webhook receiver. Register this URL on the sandbox app (SPEC §5.7). */
export async function POST(req: Request) {
  if (Number(req.headers.get('content-length') ?? 0) > 256_000) return Response.json({ error: 'BODY_TOO_LARGE' }, { status: 413 });
  // Checked before the budget, so a flood of unsigned junk can't use up the minute's budget and crowd out real deliveries.
  if (TRANSMISSION_HEADERS.some((h) => !req.headers.get(h)?.trim())) {
    return Response.json({ error: 'MISSING_SIGNATURE_HEADERS', message: 'Not a PayPal webhook delivery: paypal-transmission-id, -time and -sig are required.' }, { status: 400 });
  }
  const rt = firstlight();
  try {
    // At most a burst of deliveries per minute go on to PayPal verification; junk floods stop here.
    if (!webhookBudget()) return Response.json({ error: 'RATE_LIMITED' }, { status: 429 });
    const rawBody = await readText(req, 256_000);
    // Tracked: CHECKOUT.ORDER.APPROVED captures with PayPal, so a demo reset must wait for it.
    const out = await tracked(() =>
      handlePayPalWebhook({
        pipeline: rt.pipeline,
        db: rt.db,
        paypal: rt.paypal(),
        webhookId: process.env.PAYPAL_WEBHOOK_ID,
        headers: req.headers,
        rawBody,
        donations: rt.donations,
      }),
    );
    return Response.json(out.body, { status: out.status });
  } catch (err) {
    console.error(err);
    // 5xx makes PayPal retry later.
    return Response.json({ error: 'PROCESSING_FAILED' }, { status: 500 });
  }
}
