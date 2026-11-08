import type { LlmRequest } from '../../src/llm/client';
import { ScriptedLlm, text, toolUse, type ScriptStep } from '../../src/llm/scripted';
import { defaultFirewallConfig } from '../../src/firewall/config';
import { openDb } from '../../src/ledger/db';
import { PAYPAL_SANDBOX_BASE_URL, PayPalClient, type FetchLike } from '../../src/paypal/client';
import { Pipeline } from '../../src/pipeline/pipeline';
import { parsePayees } from '../../src/registry/payees';
import { loadRegistry } from '../../src/registry/registry';
import { loadReplayEvent } from '../../src/signals/replay';
import type { UntrustedText } from '../../src/signals/untrusted';

export const EVENT_ID = 'us6000u18k';
/** Assessment time: 3 hours after the real Panama M7.7. */
export const NOW = Date.parse('2026-10-09T20:56:05Z');

export const PAYEES = parsePayees(
  Object.fromEntries(loadRegistry().map((r, i) => [r.recipientId, `sb-test${String(i + 1).padStart(2, '0')}@personal.example.com`])),
  new Set(loadRegistry().map((r) => r.recipientId)),
);

/** What a well-behaved agent submits for the Panama event. */
export const GOOD_PLAN = {
  eventId: EVENT_ID,
  decision: 'trigger',
  rationale: 'M7.7 with PAGER orange, confirmed by EMSC (same magnitude, ~4 km apart). USGS reports deaths and widespread damage.',
  items: [
    { recipientId: 'rcp_01', tier: 'A', note: 'Pago de ayuda de emergencia por el terremoto del 9 de octubre. No necesita hacer nada.', why: '26 km, band A' },
    { recipientId: 'rcp_02', tier: 'A', note: 'Pago de ayuda de emergencia por el terremoto del 9 de octubre. No necesita hacer nada.', why: '41 km, band A, sole caregiver' },
    { recipientId: 'rcp_03', tier: 'B', note: 'Emergency relief payment for the 9 October earthquake. You do not need to do anything.', why: '56 km, band B' },
    { recipientId: 'rcp_04', tier: 'A', note: 'Pago de ayuda de emergencia por el terremoto del 9 de octubre. No necesita hacer nada.', why: '53 km, band B, mobility impaired → A' },
    { recipientId: 'rcp_05', tier: 'B', note: 'अक्टोबर ९ को भूकम्पका लागि आपतकालीन राहत भुक्तानी। तपाईंले केही गर्नु पर्दैन।', why: '60 km, band B' },
    { recipientId: 'rcp_06', tier: 'A', note: 'Pembayaran bantuan darurat untuk gempa 9 Oktober. Anda tidak perlu melakukan apa pun.', why: '110 km, band B, elderly living alone → A' },
    { recipientId: 'rcp_07', tier: 'C', note: '10月9日の地震に対する緊急支援金です。手続きは不要です。', why: '205 km, band C' },
  ],
  exceptionRequests: [],
};
export const GOOD_PLAN_TOTAL_CENTS = 120_00 * 4 + 80_00 * 2 + 40_00; // $680

/** Scripted agent: reads every tool, then submits `plan` (or whatever `plan(req)` returns). */
export function scriptedAgent(plan: unknown | ((req: LlmRequest) => unknown)): ScriptedLlm {
  const steps: ScriptStep[] = [
    () => [text('Gathering facts.'), toolUse('get_event', { eventId: EVENT_ID }), toolUse('get_corroboration', { eventId: EVENT_ID })],
    () => [toolUse('read_news', { eventId: EVENT_ID }), toolUse('list_registry_near', { eventId: EVENT_ID })],
    (req) => [toolUse('submit_plan', typeof plan === 'function' ? (plan as (r: LlmRequest) => unknown)(req) : plan)],
  ];
  return new ScriptedLlm(steps);
}

export type FakePayPal = {
  client: PayPalClient;
  /** Every payout item PayPal was asked to send, across all batches. */
  sent: { receiver: string; value: string; senderItemId: string; requestId: string }[];
  requests: { method: string; path: string; requestId?: string }[];
  /** Override the next POST /payouts response. */
  failNextCreate?: { status: number; body: unknown };
};

export function fakePayPal(finalItemStatus = 'SUCCESS'): FakePayPal {
  const fake: FakePayPal = { client: null as unknown as PayPalClient, sent: [], requests: [] };
  const batches = new Map<string, { requestId: string; items: { receiver: string; value: string; senderItemId: string }[]; polls: number }>();
  const byRequestId = new Map<string, string>();
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === 'paypal-debug-id' ? 'fake-debug' : null) },
    text: async () => JSON.stringify(body),
  });
  const impl: FetchLike = async (url, init) => {
    const path = url.replace(PAYPAL_SANDBOX_BASE_URL, '');
    const requestId = init.headers['PayPal-Request-Id'];
    fake.requests.push({ method: init.method, path, requestId });
    if (path === '/v1/oauth2/token') return reply(200, { access_token: 'fake', expires_in: 32400, scope: 'https://uri.paypal.com/payments/payouts' });
    if (init.method === 'POST' && path === '/v1/payments/payouts') {
      if (fake.failNextCreate) {
        const f = fake.failNextCreate;
        fake.failNextCreate = undefined;
        return reply(f.status, f.body);
      }
      const existing = requestId ? byRequestId.get(requestId) : undefined;
      if (existing) return reply(201, { batch_header: { payout_batch_id: existing, batch_status: 'PENDING' } });
      const body = JSON.parse(init.body!) as { items: { receiver: string; amount: { value: string }; sender_item_id: string }[] };
      const id = `FAKEBATCH${batches.size + 1}`;
      const items = body.items.map((i) => ({ receiver: i.receiver, value: i.amount.value, senderItemId: i.sender_item_id }));
      batches.set(id, { requestId: requestId ?? '', items, polls: 0 });
      if (requestId) byRequestId.set(requestId, id);
      for (const i of items) fake.sent.push({ ...i, requestId: requestId ?? '' });
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
  fake.client = new PayPalClient({ baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: 'x', clientSecret: 'y' }, impl);
  return fake;
}

export function makePipeline(opts: { llm: ScriptedLlm; sentinelLlm?: ScriptedLlm | null; poolCents?: number; clock?: () => number }) {
  let now = NOW;
  const pipeline = new Pipeline({
    db: openDb(),
    llm: opts.llm,
    sentinelLlm: opts.sentinelLlm ?? null,
    registry: loadRegistry(),
    config: defaultFirewallConfig(),
    clock: opts.clock ?? (() => now),
  });
  pipeline.ledger.seedCredit('seed', opts.poolCents ?? 5_000_00);
  return { pipeline, advance: (ms: number) => (now += ms) };
}

export function replayInput(extraUntrusted: UntrustedText[] = []) {
  const b = loadReplayEvent(EVENT_ID);
  return { ...b, untrusted: [...b.untrusted, ...extraUntrusted] };
}
