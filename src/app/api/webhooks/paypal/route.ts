import { handlePayPalWebhook } from '@/pipeline/webhooks';
import { firstlight } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PayPal sandbox webhook receiver. Register this URL on the sandbox app (SPEC §5.7). */
export async function POST(req: Request) {
  const rt = firstlight();
  try {
    const out = await handlePayPalWebhook({
      pipeline: rt.pipeline,
      db: rt.db,
      paypal: rt.paypal(),
      webhookId: process.env.PAYPAL_WEBHOOK_ID,
      headers: req.headers,
      rawBody: await req.text(),
    });
    return Response.json(out.body, { status: out.status });
  } catch (err) {
    console.error(err);
    // 5xx makes PayPal retry later.
    return Response.json({ error: 'PROCESSING_FAILED' }, { status: 500 });
  }
}
