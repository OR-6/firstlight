import { PAYPAL_SANDBOX_BASE_URL, PayPalClient, type FetchLike } from '../paypal/client';

/**
 * An in-process stand-in for the PayPal Payouts API, used ONLY by tests and
 * the red-team harness. It never touches the network; it records every item
 * the executor asked it to send, so attacks can be judged on what would
 * actually have left the system.
 */
export type SimulatedPayPal = {
  client: PayPalClient;
  sent: { receiver: string; value: string; senderItemId: string; note: string; requestId: string }[];
  requests: { method: string; path: string; requestId?: string }[];
  failNextCreate?: { status: number; body: unknown };
};

export function simulatedPayPal(finalItemStatus = 'SUCCESS'): SimulatedPayPal {
  const sim: SimulatedPayPal = { client: null as unknown as PayPalClient, sent: [], requests: [] };
  const batches = new Map<string, { items: { receiver: string; value: string; senderItemId: string }[]; polls: number }>();
  const byRequestId = new Map<string, string>();
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === 'paypal-debug-id' ? 'simulated' : null) },
    text: async () => JSON.stringify(body),
  });
  const impl: FetchLike = async (url, init) => {
    const path = url.replace(PAYPAL_SANDBOX_BASE_URL, '');
    const requestId = init.headers['PayPal-Request-Id'];
    sim.requests.push({ method: init.method, path, requestId });
    if (path === '/v1/oauth2/token') return reply(200, { access_token: 'simulated', expires_in: 32400, scope: 'https://uri.paypal.com/payments/payouts' });
    if (init.method === 'POST' && path === '/v1/payments/payouts') {
      if (sim.failNextCreate) {
        const f = sim.failNextCreate;
        sim.failNextCreate = undefined;
        return reply(f.status, f.body);
      }
      const existing = requestId ? byRequestId.get(requestId) : undefined;
      if (existing) return reply(201, { batch_header: { payout_batch_id: existing, batch_status: 'PENDING' } });
      const body = JSON.parse(init.body!) as { items: { receiver: string; amount: { value: string }; sender_item_id: string; note?: string }[] };
      const id = `SIMBATCH${batches.size + 1}`;
      const items = body.items.map((i) => ({ receiver: i.receiver, value: i.amount.value, senderItemId: i.sender_item_id, note: i.note ?? '' }));
      batches.set(id, { items, polls: 0 });
      if (requestId) byRequestId.set(requestId, id);
      for (const i of items) sim.sent.push({ ...i, requestId: requestId ?? '' });
      return reply(201, { batch_header: { payout_batch_id: id, batch_status: 'PENDING' } });
    }
    const m = /^\/v1\/payments\/payouts\/(\w+)$/.exec(path);
    if (init.method === 'GET' && m) {
      const b = batches.get(m[1]!);
      if (!b) return reply(404, { name: 'INVALID_RESOURCE_ID' });
      b.polls++;
      const done = b.polls >= 2;
      return reply(200, {
        batch_header: { payout_batch_id: m[1], batch_status: done ? 'SUCCESS' : 'PROCESSING' },
        items: b.items.map((i, n) => ({
          payout_item_id: `ITEM${n}`,
          transaction_status: done ? finalItemStatus : 'PENDING',
          payout_item: { receiver: i.receiver, sender_item_id: i.senderItemId, amount: { value: i.value, currency: 'USD' } },
        })),
      });
    }
    return reply(404, { name: 'NOT_FOUND' });
  };
  sim.client = new PayPalClient({ baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: 'simulated', clientSecret: 'simulated' }, impl);
  return sim;
}
