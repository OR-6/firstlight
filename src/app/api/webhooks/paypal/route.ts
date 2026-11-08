import { handlePayPalWebhook } from '@/pipeline/webhooks';
import { firstlight, tracked } from '@/server/runtime';
import { readText } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PayPal sandbox webhook receiver. Register this URL on the sandbox app (SPEC §5.7). */
export async function POST(req: Request) {
  const rt = firstlight();
  if (Number(req.headers.get('content-length') ?? 0) > 256_000) return Response.json({ error: 'BODY_TOO_LARGE' }, { status: 413 });
  try {
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
