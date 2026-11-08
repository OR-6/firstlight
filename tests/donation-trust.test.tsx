import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildMcpServer } from '../src/agentapi/mcp';
import { evaluateAllowanceRequest, payerCheck } from '../src/donations/allowance';
import { evaluateDonation } from '../src/donations/policy';
import { RECEIPT_PROVES } from '../src/donations/service';
import { HOSTED_MCP_READ_ONLY_TOOLS, HostedMcpError, HostedPayPalMcp, parseOrderJson } from '../src/paypal/hosted-mcp';
import { PayPalOrders } from '../src/paypal/orders';
import { DonationFeed } from '../src/ui/DonationFeed';
import { DNOW, deliver, donationSetup, refundResource } from './helpers/donation-fixture';

type Ctx = ReturnType<typeof donationSetup>;
const types = (ctx: Ctx) => ctx.pipeline.audit.entries().map((e) => e.type);
const last = (ctx: Ctx, type: string) => ctx.pipeline.audit.entries().filter((e) => e.type === type).at(-1)?.payload as Record<string, unknown> | undefined;

async function agentCaptured(ctx: Ctx, token: string, usd: number) {
  const d = await ctx.svc.create({ amount_usd: usd, allowance_token: token }, 'agent');
  return ctx.svc.capture(d.receiptId, d.orderId);
}

async function humanCaptured(ctx: Ctx, usd: number, name = 'donor') {
  const d = await ctx.svc.create({ amount_usd: usd, donor_ref: name }, 'human');
  return ctx.svc.capture(d.receiptId, d.orderId);
}

// ── 1. no impersonation through labels ────────────────────────────────────

describe('allowance labels and per-agent limits', () => {
  it('labels are unique among active allowances, compared without case', () => {
    const ctx = donationSetup();
    ctx.allowance('Helper Bot', 20, 1);
    expect(() => ctx.allowance('helper bot')).toThrow(expect.objectContaining({ code: 'LABEL_TAKEN', status: 409 }));
    expect(() => ctx.allowance('  HELPER BOT ')).toThrow(expect.objectContaining({ code: 'LABEL_TAKEN' }));
    expect(ctx.svc.rejected.LABEL_TAKEN).toBe(2);
    // Once the first one expires, the name is free.
    ctx.advance(3_600_001);
    expect(ctx.allowance('helper bot').label).toBe('helper bot');
  });

  it('the pure check refuses a taken label', () => {
    const dec = evaluateAllowanceRequest({ label: 'Samaritan', cap_usd: 5, expires_in_hours: 1 }, { now: DNOW, createdLast10Min: 0, activeLabels: ['samaritan'] });
    expect(dec).toMatchObject({ ok: false, code: 'LABEL_TAKEN' });
  });

  it('per-donor limits key on the allowance, not the label', () => {
    const recent = Array.from({ length: 3 }, () => ({ donorRef: 'twin', amountCents: 500, at: DNOW - 60_000, status: 'CAPTURED', allowanceId: 'alid_aaaaaaaaaaaaaaaa' }));
    // The allowance that made them is rate-limited…
    expect(evaluateDonation({ amount_usd: 5, donor_ref: 'twin' }, { now: DNOW, recent, allowanceId: 'alid_aaaaaaaaaaaaaaaa' })).toMatchObject({ ok: false, code: 'DONOR_RATE_LIMIT' });
    // …another allowance that happens to have had the same label is not, and neither is a person called "twin".
    expect(evaluateDonation({ amount_usd: 5, donor_ref: 'twin' }, { now: DNOW, recent, allowanceId: 'alid_bbbbbbbbbbbbbbbb' }).ok).toBe(true);
    expect(evaluateDonation({ amount_usd: 5, donor_ref: 'twin' }, { now: DNOW, recent }).ok).toBe(true);
    // People are one donor per name, ignoring case.
    const people = recent.map((r) => ({ ...r, allowanceId: null, donorRef: 'Ana' }));
    expect(evaluateDonation({ amount_usd: 5, donor_ref: 'ANA' }, { now: DNOW, recent: people })).toMatchObject({ ok: false, code: 'DONOR_RATE_LIMIT' });
  });

  it("one agent can't use up another agent's daily limit by taking its name later", async () => {
    const ctx = donationSetup();
    const a = ctx.allowance('lookalike', 100);
    for (let i = 0; i < 3; i++) await ctx.svc.create({ amount_usd: 5, allowance_token: a.allowanceToken }, 'agent');
    await expect(ctx.svc.create({ amount_usd: 5, allowance_token: a.allowanceToken }, 'agent')).rejects.toMatchObject({ code: 'DONOR_RATE_LIMIT' });
    ctx.svc.revokeAllowance(a.allowanceId, a.manageKey);
    const b = ctx.allowance('lookalike', 100);
    expect((await ctx.svc.create({ amount_usd: 5, allowance_token: b.allowanceToken }, 'agent')).status).toBe('AWAITING_APPROVAL');
    // A person using the agent's name is a different donor too.
    expect((await ctx.svc.create({ amount_usd: 5, donor_ref: 'lookalike' }, 'human')).status).toBe('AWAITING_APPROVAL');
  });

  it('the feed marks agent donations with the allowance handle', async () => {
    const ctx = donationSetup();
    const a = ctx.allowance('samaritan', 20);
    await ctx.svc.create({ amount_usd: 5, allowance_token: a.allowanceToken }, 'agent');
    await ctx.svc.create({ amount_usd: 5, donor_ref: 'samaritan' }, 'human');
    const [human, agent] = ctx.svc.feed();
    expect(agent).toMatchObject({ source: 'agent', donorRef: 'samaritan', agentHandle: a.allowanceId.slice(0, 11) });
    expect(human).toMatchObject({ source: 'human', donorRef: 'samaritan', agentHandle: null });
    expect(a.handle).toMatch(/^alid_[0-9a-f]{6}$/);
    const html = renderToStaticMarkup(<DonationFeed items={[agent!, human!]} />);
    expect(html).toContain(`AI agent <span class="num">${a.handle}</span>`);
    expect(html).toContain('Person');
  });
});

// ── 2. one allowance, one PayPal account ──────────────────────────────────

describe('allowance tied to one PayPal payer', () => {
  it('the first approval ties the allowance; the same account keeps working', async () => {
    const ctx = donationSetup();
    const a = ctx.allowance('tied', 50);
    expect(ctx.svc.allowanceForToken(a.allowanceToken)?.paypalAccount).toMatchObject({ tied: false, heldForOtherAccount: 0 });
    const first = await agentCaptured(ctx, a.allowanceToken, 5);
    expect(first.status).toBe('CAPTURED');
    expect(ctx.svc.allowanceForToken(a.allowanceToken)?.paypalAccount).toMatchObject({ tied: true, note: expect.stringMatching(/same PayPal account/) });
    expect(types(ctx)).toContain('allowance.payer_tied');
    const second = await agentCaptured(ctx, a.allowanceToken, 5);
    expect(second.status).toBe('CAPTURED');
    expect(ctx.svc.receipt(second.receipt_id)?.approval).toMatchObject({ bySamePayPalAccount: true, note: expect.stringMatching(/same PayPal account/) });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_010_00);
  });

  it('a donation approved by a different PayPal account is held, never captured or credited, and audited', async () => {
    const ctx = donationSetup();
    const a = ctx.allowance('tied', 50);
    await agentCaptured(ctx, a.allowanceToken, 5);
    const captures = ctx.fake.calls.capture.length;

    ctx.fake.opts.payer = 'PAYEROTHER1';
    const d = await ctx.svc.create({ amount_usd: 20, allowance_token: a.allowanceToken }, 'agent');
    const held = await ctx.svc.capture(d.receiptId, d.orderId);
    expect(held.status).toBe('PAYER_MISMATCH');
    expect(ctx.fake.calls.capture.length).toBe(captures); // never captured: the payer isn't charged
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_005_00);
    expect(last(ctx, 'donation.payer_mismatch')).toMatchObject({ receiptId: d.receiptId, allowanceId: a.allowanceId, action: 'not_captured' });
    // Retries and the approval webhook change nothing.
    expect((await ctx.svc.capture(d.receiptId)).status).toBe('PAYER_MISMATCH');
    await deliver(ctx, { id: 'WH-PM1', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: d.orderId, status: 'APPROVED' } });
    expect(ctx.fake.calls.capture.length).toBe(captures);
    expect(types(ctx).filter((t) => t === 'donation.payer_mismatch')).toHaveLength(1);

    const view = ctx.svc.allowanceForToken(a.allowanceToken)!;
    expect(view.paypalAccount).toMatchObject({ tied: true, heldForOtherAccount: 1, note: expect.stringMatching(/1 approved by a different account was held/) });
    expect(view.remainingUsd).toBe('45.00'); // the held $20 doesn't use up the allowance
    expect(ctx.svc.receipt(d.receiptId)?.approval).toMatchObject({ bySamePayPalAccount: false });
    // The public audit log never holds a payer id (nor its hash).
    const log = JSON.stringify(ctx.pipeline.audit.entries());
    expect(log).not.toContain('PAYEROTHER1');
    expect(log).not.toContain('PAYERTESTA1');
    expect(log).not.toContain(ctx.svc.get(d.receiptId)!.payer_hash!);
  });

  it('if PayPal reports another payer at capture anyway, the capture is held uncredited and can be refunded without touching the pool', async () => {
    const ctx = donationSetup();
    const a = ctx.allowance('tied', 50);
    await agentCaptured(ctx, a.allowanceToken, 5);
    ctx.fake.opts.capturePayer = 'PAYERSWAP01';
    const d = await ctx.svc.create({ amount_usd: 10, allowance_token: a.allowanceToken }, 'agent');
    const held = await ctx.svc.capture(d.receiptId);
    expect(held).toMatchObject({ status: 'PAYER_MISMATCH', capture_id: expect.stringMatching(/^CAP/) });
    expect(ctx.pipeline.ledger.donationCreditCents(held.capture_id!)).toBe(0);
    expect(last(ctx, 'donation.payer_mismatch')).toMatchObject({ action: 'captured_not_credited_refund_needed' });
    // A late COMPLETED webhook still doesn't credit it.
    await ctx.svc.onCaptureCompleted(d.orderId, held.capture_id!, 1000);
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_005_00);

    const r = await ctx.svc.refund(d.receiptId, { reason: 'approved by another account' });
    expect(r).toMatchObject({ refundStatus: 'COMPLETED', refunded_cents: 1000 });
    expect(last(ctx, 'donation.refunded')).toMatchObject({ initiatedBy: 'operator', poolDebitedCents: 0, amountCents: 1000 });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_005_00);
    await expect(ctx.svc.refund(d.receiptId, {})).rejects.toMatchObject({ code: 'NOTHING_TO_REFUND' });
  });

  it('an agent capture is not made before PayPal says who approved it', async () => {
    const ctx = donationSetup({ orders: { failGet: true } });
    const a = ctx.allowance('cautious', 20);
    const d = await ctx.svc.create({ amount_usd: 5, allowance_token: a.allowanceToken }, 'agent');
    await expect(ctx.svc.capture(d.receiptId)).rejects.toMatchObject({ code: 'PAYPAL', status: 502 });
    expect(ctx.fake.calls.capture).toHaveLength(0);
    expect(ctx.svc.get(d.receiptId)?.status).toBe('AWAITING_APPROVAL');
  });

  it('the pure payer check', () => {
    expect(payerCheck(null, 'h1')).toBe('bind');
    expect(payerCheck('h1', 'h1')).toBe('match');
    expect(payerCheck('h1', 'h2')).toBe('mismatch');
  });
});

// ── 3. receipts confirmed by PayPal ───────────────────────────────────────

describe('receipts confirmed by PayPal', () => {
  it('adds what PayPal reports for the order, cached for 30 s', async () => {
    const ctx = donationSetup();
    const d = await humanCaptured(ctx, 12);
    const r = await ctx.svc.receiptWithPayPal(d.receipt_id);
    expect(r?.paypalConfirmed).toMatchObject({
      status: 'COMPLETED',
      captureId: d.capture_id,
      amount: { currency: 'USD', value: '12.00' },
      source: 'paypal_orders_api',
      matchesReceipt: true,
      checkedAt: new Date(DNOW).toISOString(),
    });
    const gets = ctx.fake.calls.get.length;
    await ctx.svc.receiptWithPayPal(d.receipt_id);
    expect(ctx.fake.calls.get.length).toBe(gets);
    ctx.advance(30_001);
    await ctx.svc.receiptWithPayPal(d.receipt_id);
    expect(ctx.fake.calls.get.length).toBe(gets + 1);
  });

  it("uses the orders client's confirm() (the hosted MCP path) when it has one", async () => {
    const ctx = donationSetup({ orders: { confirmSource: 'paypal_hosted_mcp' } });
    const d = await humanCaptured(ctx, 7);
    expect((await ctx.svc.receiptWithPayPal(d.receipt_id))?.paypalConfirmed).toMatchObject({ source: 'paypal_hosted_mcp', matchesReceipt: true });
    expect(ctx.fake.calls.confirm).toEqual([d.order_id]);
  });

  it('a failed lookup gives null and a reason, never an error', async () => {
    const ctx = donationSetup();
    const d = await humanCaptured(ctx, 7);
    ctx.fake.opts.failGet = true;
    const r = await ctx.svc.receiptWithPayPal(d.receipt_id);
    expect(r).toMatchObject({ receiptId: d.receipt_id, status: 'CAPTURED', paypalConfirmed: null, paypalConfirmedReason: expect.stringMatching(/^PAYPAL_UNAVAILABLE: /) });
  });

  it('caps PayPal lookups across everyone', async () => {
    const ctx = donationSetup();
    const ids: string[] = [];
    for (let i = 0; i < 31; i++) {
      ids.push((await ctx.svc.create({ amount_usd: 1 + i, donor_ref: `p${i}` }, 'human')).receiptId);
      ctx.advance(25_000); // stay under the 30-per-10-minutes donation limit
    }
    for (const id of ids.slice(0, 30)) expect((await ctx.svc.receiptWithPayPal(id))?.paypalConfirmed).not.toBeNull();
    expect(await ctx.svc.receiptWithPayPal(ids[30]!)).toMatchObject({ paypalConfirmed: null, paypalConfirmedReason: expect.stringMatching(/^RATE_LIMITED/) });
  });

  it('get_receipt over MCP returns paypalConfirmed and approval, and every refusal starts with a code', async () => {
    const ctx = donationSetup();
    const server = buildMcpServer({ db: ctx.db, donations: ctx.svc, pipeline: ctx.pipeline });
    const [x, y] = InMemoryTransport.createLinkedPair();
    await server.connect(x);
    const client = new Client({ name: 'trust-test', version: '1' });
    await client.connect(y);
    const a = ctx.allowance('mcp-agent', 20);
    const d = await agentCaptured(ctx, a.allowanceToken, 6);
    const r = (await client.callTool({ name: 'get_receipt', arguments: { receipt_id: d.receipt_id } })) as { structuredContent?: Record<string, unknown> };
    expect(r.structuredContent).toMatchObject({ paypalConfirmed: { matchesReceipt: true }, approval: { bySamePayPalAccount: true }, agentHandle: a.handle });
    const allowance = (await client.callTool({ name: 'get_allowance', arguments: { allowance_token: a.allowanceToken } })) as { structuredContent?: Record<string, unknown> };
    expect(allowance.structuredContent).toMatchObject({ paypalAccount: { tied: true } });

    const missing = (await client.callTool({ name: 'get_receipt', arguments: { receipt_id: 'rcpt_0000000000000000' } })) as { isError?: boolean; content: { text: string }[] };
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toMatch(/^NOT_FOUND: /);
    const none = (await client.callTool({ name: 'get_receipt', arguments: {} })) as { content: { text: string }[] };
    expect(none.content[0]!.text).toMatch(/^INVALID_REQUEST: /);

    // Every tool tells the agent what a person has to do.
    for (const t of (await client.listTools()).tools) expect(t.description, t.name).toMatch(/person/i);
    for (const t of (await client.listTools()).tools) expect(t.description, t.name).toMatch(/PayPal|\/agents/);
  });

  it('whatThisProves tells the donor to match the capture id in their own PayPal activity', () => {
    expect(RECEIPT_PROVES).toMatch(/paypal\.captureId/);
    expect(RECEIPT_PROVES).toMatch(/own PayPal account's activity/);
    expect(RECEIPT_PROVES).toMatch(/does not show where each dollar went/);
  });
});

// ── 4. operator refund ────────────────────────────────────────────────────

describe('staff refund', () => {
  it('refunds through PayPal, debits the pool once, and audits it', async () => {
    const ctx = donationSetup();
    const d = await humanCaptured(ctx, 30);
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_030_00);
    const r = await ctx.svc.refund(d.receipt_id, { reason: 'donor asked' });
    expect(r).toMatchObject({ status: 'REFUNDED', refunded_cents: 30_00, refundStatus: 'COMPLETED' });
    expect(ctx.fake.calls.refund).toEqual([{ captureId: d.capture_id, amountCents: 30_00, requestId: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(last(ctx, 'donation.refunded')).toMatchObject({ receiptId: d.receipt_id, initiatedBy: 'operator', reason: 'donor asked', amountCents: 30_00, paypalRefId: r.refundId });

    // PayPal's refund webhook for the same refund arrives later: nothing more.
    await deliver(ctx, { id: 'WH-OR1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refundResource(r.refundId, d.capture_id!, '30.00') });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(types(ctx).filter((t) => t === 'donation.refunded')).toHaveLength(1);
    await expect(ctx.svc.refund(d.receipt_id, {})).rejects.toMatchObject({ code: 'NOT_REFUNDABLE', status: 409 });
  });

  it('partial refunds, never more than was captured', async () => {
    const ctx = donationSetup();
    const d = await humanCaptured(ctx, 30);
    expect((await ctx.svc.refund(d.receipt_id, { amount_usd: 10 })).status).toBe('PARTIALLY_REFUNDED');
    await expect(ctx.svc.refund(d.receipt_id, { amount_usd: 25 })).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_CAPTURE' });
    expect((await ctx.svc.refund(d.receipt_id, {})).status).toBe('REFUNDED');
    expect(ctx.fake.calls.refund.map((c) => c.amountCents)).toEqual([10_00, 20_00]);
    expect(new Set(ctx.fake.calls.refund.map((c) => c.requestId)).size).toBe(2);
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
  });

  it('refuses when the pool would go below zero', async () => {
    const ctx = donationSetup({ poolCents: 1 });
    const d = await humanCaptured(ctx, 30);
    ctx.pipeline.ledger.debitDonation('donation_reversal', 'test:drain', 25_00); // the pool has paid most of it out
    await expect(ctx.svc.refund(d.receipt_id, {})).rejects.toMatchObject({ code: 'POOL_WOULD_GO_NEGATIVE', status: 409 });
    expect(ctx.fake.calls.refund).toHaveLength(0);
    expect((await ctx.svc.refund(d.receipt_id, { amount_usd: 5 })).status).toBe('PARTIALLY_REFUNDED');
  });

  it('refuses donations that were never received, unknown fields, and bad amounts', async () => {
    const ctx = donationSetup();
    const waiting = await ctx.svc.create({ amount_usd: 5, donor_ref: 'donor' }, 'human');
    await expect(ctx.svc.refund(waiting.receiptId, {})).rejects.toMatchObject({ code: 'NOT_REFUNDABLE' });
    await expect(ctx.svc.refund('rcpt_ffffffffffffffff', {})).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    const d = await humanCaptured(ctx, 5, 'other');
    await expect(ctx.svc.refund(d.receipt_id, { amount_usd: 5, to: 'someone-else@example.com' })).rejects.toMatchObject({ code: 'UNKNOWN_FIELDS' });
    await expect(ctx.svc.refund(d.receipt_id, { amount_usd: 1.234 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(ctx.svc.refund(d.receipt_id, { amount_usd: -1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(ctx.fake.calls.refund).toHaveLength(0);
  });

  it('a PayPal failure changes nothing in the pool and is audited', async () => {
    const ctx = donationSetup({ orders: { failRefund: true } });
    const d = await humanCaptured(ctx, 8);
    await expect(ctx.svc.refund(d.receipt_id, {})).rejects.toMatchObject({ code: 'PAYPAL', status: 502 });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_008_00);
    expect(ctx.svc.get(d.receipt_id)?.status).toBe('CAPTURED');
    expect(last(ctx, 'donation.refund_failed')).toMatchObject({ receiptId: d.receipt_id, initiatedBy: 'operator' });
  });

  it('a PENDING refund at PayPal is recorded, its debit held until the refund webhook books it', async () => {
    const ctx = donationSetup({ orders: { refundStatus: 'PENDING' } });
    const d = await humanCaptured(ctx, 8);
    const r = await ctx.svc.refund(d.receipt_id, {});
    expect(r).toMatchObject({ status: 'CAPTURED', refundStatus: 'PENDING', refunded_cents: 0 });
    // The money is on its way back to the donor: the pool can't spend it meanwhile.
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(types(ctx)).toContain('donation.refund_pending');
    const reserved = () => ctx.db.prepare("SELECT ref, amount_cents FROM ledger_entries WHERE ref LIKE 'reserve:%'").all();
    expect(reserved()).toEqual([{ ref: `reserve:refund:${r.refundId}`, amount_cents: -8_00 }]);

    // PayPal completes it later: the webhook books it and drops the reservation, so the pool is debited once.
    await deliver(ctx, { id: 'WH-PR1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refundResource(r.refundId, d.capture_id!, '8.00') });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(ctx.svc.get(d.receipt_id)).toMatchObject({ status: 'REFUNDED', refunded_cents: 8_00 });
    expect(reserved()).toEqual([]);
  });

  it('a PayPal failure releases the reservation', async () => {
    const ctx = donationSetup({ orders: { failRefund: true } });
    const d = await humanCaptured(ctx, 8);
    await expect(ctx.svc.refund(d.receipt_id, {})).rejects.toMatchObject({ code: 'PAYPAL' });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE ref LIKE 'reserve:%'").get()).toEqual({ n: 0 });
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_008_00);
  });

  it('a payout reserved while PayPal handles the refund cannot take the pool negative', async () => {
    // The pool holds exactly the donation. Staff refund it; while PayPal is answering, a payout batch tries to reserve it.
    const ctx = donationSetup({ poolCents: 1 });
    ctx.pipeline.ledger.debitDonation('donation_reversal', 'test:to-zero', 1); // pool = 0 before the donation
    const d = await humanCaptured(ctx, 30);
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(30_00);
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const realRefund = ctx.fake.orders.refund.bind(ctx.fake.orders);
    ctx.fake.orders.refund = async (input) => {
      await gate;
      return realRefund(input);
    };
    const refunding = ctx.svc.refund(d.receipt_id, {});
    await Promise.resolve();
    // During the await: the refund's debit is already held, so the batch sees an empty pool.
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(0);
    expect(() =>
      ctx.pipeline.ledger.reservePayoutBatch({ eventId: 'us6000u18k', planVersion: 1, paypalRequestId: 'race-1', verdictDigest: 'race-digest', items: [{ recipientId: 'rcp_01', amountCents: 30_00 }] }),
    ).toThrow(/pool has 0 cents/);
    release();
    expect((await refunding).status).toBe('REFUNDED');
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(0);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE ref LIKE 'reserve:%'").get()).toEqual({ n: 0 });
    expect(last(ctx, 'donation.refunded')).toMatchObject({ amountCents: 30_00 });
    expect(last(ctx, 'donation.refunded')?.flag).toBeUndefined();
  });

  it('two refunds of one donation at once: only one reaches PayPal', async () => {
    const ctx = donationSetup();
    const d = await humanCaptured(ctx, 8);
    const [a, b] = await Promise.allSettled([ctx.svc.refund(d.receipt_id, {}), ctx.svc.refund(d.receipt_id, {})]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(ctx.fake.calls.refund).toHaveLength(1);
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
  });

  it('the feed shows a Refund button only when onRefund is passed, and only for received donations', () => {
    const item = { receiptId: 'rcpt_0000000000000001', source: 'human' as const, donorRef: 'x', message: null, amountUsd: '5.00', status: 'CAPTURED', createdAt: new Date(DNOW).toISOString() };
    expect(renderToStaticMarkup(<DonationFeed items={[item]} />)).not.toContain('Refund');
    expect(renderToStaticMarkup(<DonationFeed items={[item]} onRefund={async () => 'ok'} />)).toContain('>Refund<');
    expect(renderToStaticMarkup(<DonationFeed items={[{ ...item, status: 'AWAITING_APPROVAL' }]} onRefund={async () => 'ok'} />)).not.toContain('>Refund<');
    expect(renderToStaticMarkup(<DonationFeed items={[{ ...item, status: 'PAYER_MISMATCH' }]} />)).toContain('Held: different PayPal account');
  });
});

// ── 5. atomic credit ──────────────────────────────────────────────────────

describe('credit is atomic', () => {
  it('a crash between the ledger credit and the audit entry leaves nothing credited, and a retry books it once', async () => {
    const ctx = donationSetup();
    const d = await ctx.svc.create({ amount_usd: 9, donor_ref: 'donor' }, 'human');
    const append = ctx.pipeline.audit.append.bind(ctx.pipeline.audit);
    let crash = true;
    ctx.pipeline.audit.append = ((type: string, payload: unknown) => {
      if (crash && type === 'donation.captured') throw new Error('simulated crash');
      return append(type, payload);
    }) as typeof ctx.pipeline.audit.append;

    await expect(ctx.svc.capture(d.receiptId)).rejects.toThrow('simulated crash');
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_000_00);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE kind = 'donation_credit'").get()).toEqual({ n: 0 });
    expect(ctx.svc.get(d.receiptId)).toMatchObject({ status: 'AWAITING_APPROVAL', capture_id: null });

    crash = false;
    expect((await ctx.svc.capture(d.receiptId)).status).toBe('CAPTURED');
    expect(ctx.pipeline.ledger.poolBalanceCents()).toBe(1_009_00);
    expect(types(ctx).filter((t) => t === 'donation.captured')).toHaveLength(1);
    expect(ctx.pipeline.audit.verify().ok).toBe(true);
  });
});

// ── 6. human idempotency keys ─────────────────────────────────────────────

describe('idempotency keys are for agents only', () => {
  it("a person can't send one, so two Anonymous donors can never get each other's approval link", async () => {
    const ctx = donationSetup();
    await expect(ctx.svc.create({ amount_usd: 5, donor_ref: 'Anonymous', idempotency_key: 'shared-key-1' }, 'human')).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_AGENT_ONLY', status: 400 });
    const one = await ctx.svc.create({ amount_usd: 5, donor_ref: 'Anonymous' }, 'human');
    const two = await ctx.svc.create({ amount_usd: 5, donor_ref: 'Anonymous' }, 'human');
    expect(one.receiptId).not.toBe(two.receiptId);
    expect(one.approvalUrl).not.toBe(two.approvalUrl);
  });
});

// ── hosted PayPal MCP client (no network) ─────────────────────────────────

describe('hosted PayPal MCP client', () => {
  it('only get_order is allowed, checked before any token is fetched', async () => {
    let tokens = 0;
    const mcp = new HostedPayPalMcp(async () => {
      tokens++;
      return 'not-a-real-token';
    });
    expect(HOSTED_MCP_READ_ONLY_TOOLS).toEqual(['get_order']);
    for (const tool of ['create_refund', 'pay_order', 'create_order', 'list_transactions']) {
      await expect(mcp.callReadOnly(tool, {})).rejects.toMatchObject({ name: 'HostedMcpError', stage: 'allowlist' });
    }
    await expect(mcp.getOrder('not an id')).rejects.toBeInstanceOf(HostedMcpError);
    expect(tokens).toBe(0);
  });

  it('is sandbox only', () => {
    expect(() => new HostedPayPalMcp(async () => 't', 'https://mcp.paypal.com/sse')).toThrow(/sandbox-only/);
  });

  it('parses the REST order body get_order returns', () => {
    const body = {
      id: '7RH43955W8798551N',
      status: 'COMPLETED',
      payment_source: { paypal: { account_id: 'PAYERTESTA1', email_address: 'never-shown@example.com' } },
      purchase_units: [{ payments: { captures: [{ id: '2M270176F8691393V', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.00' } }] } }],
    };
    expect(parseOrderJson(JSON.stringify(body), '7RH43955W8798551N')).toEqual({
      orderId: '7RH43955W8798551N',
      status: 'COMPLETED',
      payerId: 'PAYERTESTA1',
      captureId: '2M270176F8691393V',
      captureStatus: 'COMPLETED',
      amountCents: 500,
    });
    expect(() => parseOrderJson(JSON.stringify(body), 'OTHERORDER0000001')).toThrow(/different order/);
    expect(() => parseOrderJson('not json', '7RH43955W8798551N')).toThrow(HostedMcpError);
  });

  it('PayPalOrders.confirm falls back to the Server SDK and says why', async () => {
    const orders = new PayPalOrders({ baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'id', clientSecret: 'secret' }, { hostedMcp: true });
    (orders as unknown as { mcp: { getOrder: () => Promise<never> } }).mcp = {
      getOrder: async () => {
        throw new HostedMcpError('connect', 'SSE error: Non-200 status code (401)');
      },
    };
    orders.get = async (id) => ({ orderId: id, status: 'COMPLETED', payerId: null, captureId: 'CAP1', captureStatus: 'COMPLETED', amountCents: 500 });
    expect(await orders.confirm('7RH43955W8798551N')).toMatchObject({ source: 'paypal_orders_api', fallbackReason: 'hosted MCP: SSE error: Non-200 status code (401)' });
    const noMcp = new PayPalOrders({ baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'id', clientSecret: 'secret' }, { hostedMcp: false });
    noMcp.get = orders.get;
    expect(await noMcp.confirm('7RH43955W8798551N')).toEqual(expect.not.objectContaining({ fallbackReason: expect.anything() }));
  });
});
