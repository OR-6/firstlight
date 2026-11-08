import { describe, expect, it } from 'vitest';
import { PipelineError } from '../src/pipeline/pipeline';
import { ScriptedLlm, text, toolUse } from '../src/llm/scripted';
import {
  EVENT_ID,
  GOOD_PLAN,
  GOOD_PLAN_TOTAL_CENTS,
  PAYEES,
  fakePayPal,
  makePipeline,
  replayInput,
  scriptedAgent,
} from './helpers/pipeline-fixture';

describe('pipeline: assess → approve → execute → poll', () => {
  it('runs the full loop on the real Panama replay data', async () => {
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    const a = await pipeline.assess(replayInput());

    expect(a.agent.ok).toBe(true);
    expect(a.sentinel.findings).toEqual([]); // the real USGS text is clean
    expect(a.verdict?.overall).toBe('REQUIRE_APPROVAL'); // $680 > $300 auto-approve limit
    expect(a.verdict?.totalCents).toBe(GOOD_PLAN_TOTAL_CENTS);
    expect(a.verdict?.planRules.map((r) => r.reasonCode)).toEqual(
      expect.arrayContaining(['TRIGGER_CORROBORATED', 'OVER_APPROVAL_THRESHOLD']),
    );

    const pp = fakePayPal();
    await expect(pipeline.execute(a.planId, pp.client, PAYEES)).rejects.toMatchObject({ code: 'NEEDS_APPROVAL' });
    pipeline.decide(a.planId, 'approve', 'ops@firstlight.test', 'Verified on USGS event page');

    const batch = await pipeline.execute(a.planId, pp.client, PAYEES);
    expect(batch.paypal_batch_id).toBe('SIMBATCH1');
    expect(pp.sent).toHaveLength(7);
    expect(pp.sent.every((s) => s.requestId === batch.paypal_request_id)).toBe(true);
    expect(batch.paypal_request_id).not.toBe(a.verdict!.paypalRequestId); // scoped to this database instance
    expect(pp.sent.map((s) => s.senderItemId)).toContain(`${EVENT_ID}:rcp_01`);
    expect(pipeline.ledger.poolBalanceCents()).toBe(5_000_00 - GOOD_PLAN_TOTAL_CENTS);

    let status = await pipeline.poll(batch.id, pp.client);
    expect(status.terminal).toBe(false);
    status = await pipeline.poll(batch.id, pp.client);
    expect(status.terminal).toBe(true);
    expect(status.items.every((i) => i.status === 'SUCCESS')).toBe(true);

    expect(pipeline.audit.verify().ok).toBe(true);
    const types = pipeline.audit.entries().map((e) => e.type);
    expect(types).toEqual([
      'signal.received',
      'sentinel.pre',
      'agent.result',
      'sentinel.post',
      'firewall.verdict',
      'approval.decided',
      'payout.reserved',
      'paypal.payout.created',
      'paypal.payout.status',
      'paypal.payout.status',
    ]);
    // Full payee addresses never land in the audit log.
    expect(JSON.stringify(pipeline.audit.entries())).not.toContain('sb-test01@personal.example.com');
  });

  it('executing twice sends nothing new', async () => {
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    const a = await pipeline.assess(replayInput());
    pipeline.decide(a.planId, 'approve', 'ops', 'ok');
    const pp = fakePayPal();
    const b1 = await pipeline.execute(a.planId, pp.client, PAYEES);
    const b2 = await pipeline.execute(a.planId, pp.client, PAYEES);
    expect(b2.id).toBe(b1.id);
    expect(pp.sent).toHaveLength(7);
  });

  it('a re-assessment of a paid event pays no one twice', async () => {
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    const a = await pipeline.assess(replayInput());
    pipeline.decide(a.planId, 'approve', 'ops', 'ok');
    const pp = fakePayPal();
    await pipeline.execute(a.planId, pp.client, PAYEES);

    // Same event again (e.g. a USGS revision): new plan version, nothing payable.
    (pipeline as unknown as { deps: { llm: ScriptedLlm } }).deps.llm = scriptedAgent(GOOD_PLAN);
    const again = await pipeline.assess(replayInput());
    expect(again.version).toBe(2);
    expect(again.verdict?.overall).toBe('BLOCK');
    expect(again.verdict?.items.every((i) => i.ruleTrace.some((r) => r.reasonCode === 'ALREADY_PAID_FOR_EVENT'))).toBe(true);
    await expect(pipeline.execute(again.planId, pp.client, PAYEES)).rejects.toMatchObject({ code: 'BLOCKED' });
  });

  it('denied plans cannot be executed, and a decision is final', async () => {
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    const a = await pipeline.assess(replayInput());
    pipeline.decide(a.planId, 'deny', 'ops', 'looks wrong');
    expect(() => pipeline.decide(a.planId, 'approve', 'someone-else', 'override')).toThrow(PipelineError);
    await expect(pipeline.execute(a.planId, fakePayPal().client, PAYEES)).rejects.toMatchObject({ code: 'DENIED' });
  });

  it.each([
    ['', 'reason'],
    ['ops', '   '],
  ])('approval needs an approver and a reason (%j, %j)', async (who, why) => {
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    const a = await pipeline.assess(replayInput());
    expect(() => pipeline.decide(a.planId, 'approve', who, why)).toThrow(/required/);
  });

  it('refuses a verdict missing from the audit log (R11)', async () => {
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    const a = await pipeline.assess(replayInput());
    pipeline.decide(a.planId, 'approve', 'ops', 'ok');
    // Simulate a verdict row inserted without going through the audited path.
    const db = (pipeline as unknown as { deps: { db: import('../src/ledger/db').Db } }).deps.db;
    const v = pipeline.verdict(a.planId)!;
    db.prepare('UPDATE verdicts SET verdict_json = ? WHERE plan_id = ?').run(JSON.stringify({ ...v, digest: 'f'.repeat(64) }), a.planId);
    await expect(pipeline.execute(a.planId, fakePayPal().client, PAYEES)).rejects.toMatchObject({ code: 'NOT_AUDITED' });
  });

  it('re-checks the ledger at execution time (approval can be stale)', async () => {
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    const a = await pipeline.assess(replayInput());
    pipeline.decide(a.planId, 'approve', 'ops', 'ok');
    // Meanwhile, rcp_01 got paid through another batch.
    pipeline.ledger.reservePayoutBatch({
      eventId: EVENT_ID,
      planVersion: 99,
      paypalRequestId: 'other',
      verdictDigest: 'other',
      items: [{ recipientId: 'rcp_01', amountCents: 120_00 }],
    });
    const pp = fakePayPal();
    await expect(pipeline.execute(a.planId, pp.client, PAYEES)).rejects.toMatchObject({ code: 'STATE_CHANGED' });
    expect(pp.sent).toEqual([]);
  });

  it('fails closed when a payee address is missing', async () => {
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    const a = await pipeline.assess(replayInput());
    pipeline.decide(a.planId, 'approve', 'ops', 'ok');
    const partial = new Map([...PAYEES].filter(([id]) => id !== 'rcp_03'));
    const pp = fakePayPal();
    await expect(pipeline.execute(a.planId, pp.client, partial)).rejects.toMatchObject({ code: 'NO_PAYEE' });
    expect(pp.sent).toEqual([]);
    expect(pipeline.ledger.poolBalanceCents()).toBe(5_000_00);
  });

  it('a definitive PayPal rejection returns the money to the pool', async () => {
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    const a = await pipeline.assess(replayInput());
    pipeline.decide(a.planId, 'approve', 'ops', 'ok');
    const pp = fakePayPal();
    pp.failNextCreate = { status: 403, body: { name: 'PAYOUT_NOT_AVAILABLE', message: 'country' } };
    await expect(pipeline.execute(a.planId, pp.client, PAYEES)).rejects.toThrow(/PAYOUT_NOT_AVAILABLE/);
    expect(pipeline.ledger.poolBalanceCents()).toBe(5_000_00);
  });

  it('an unknown PayPal outcome (5xx) is retried with the same idempotency key', async () => {
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN) });
    const a = await pipeline.assess(replayInput());
    pipeline.decide(a.planId, 'approve', 'ops', 'ok');
    const pp = fakePayPal();
    pp.failNextCreate = { status: 503, body: { name: 'SERVICE_UNAVAILABLE' } };
    await expect(pipeline.execute(a.planId, pp.client, PAYEES)).rejects.toThrow(/503/);
    const batch = await pipeline.execute(a.planId, pp.client, PAYEES);
    expect(batch.paypal_batch_id).toBe('SIMBATCH1');
    const posts = pp.requests.filter((r) => r.method === 'POST' && r.path === '/v1/payments/payouts');
    expect(new Set(posts.map((p) => p.requestId)).size).toBe(1);
    expect(pp.sent).toHaveLength(7);
  });

  it('records agent failure and pays nothing', async () => {
    const llm = new ScriptedLlm([() => [text('I will not use tools.')], () => [text('Still no plan.')]]);
    const { pipeline } = makePipeline({ llm });
    const a = await pipeline.assess(replayInput());
    expect(a.agent.ok).toBe(false);
    expect(a.verdict).toBeNull();
    await expect(pipeline.execute(a.planId, fakePayPal().client, PAYEES)).rejects.toMatchObject({ code: 'NO_VERDICT' });
  });

  it('a small ALLOW plan executes without approval', async () => {
    const plan = { ...GOOD_PLAN, items: [GOOD_PLAN.items[0], GOOD_PLAN.items[6]] }; // $160
    // Only these two households are enrolled, so R12 has nobody else to miss.
    const { pipeline } = makePipeline({ llm: scriptedAgent(plan), onlyRecipients: plan.items.map((i) => i!.recipientId) });
    const a = await pipeline.assess(replayInput());
    expect(a.verdict?.overall).toBe('ALLOW');
    const pp = fakePayPal();
    await pipeline.execute(a.planId, pp.client, PAYEES);
    expect(pp.sent.map((s) => s.value).sort()).toEqual(['120.00', '40.00']);
  });

  it('the sentinel LLM layer is consulted and failures fail closed', async () => {
    const sentinel = new ScriptedLlm(() => {
      throw new Error('classifier down');
    });
    const { pipeline } = makePipeline({ llm: scriptedAgent(GOOD_PLAN), sentinelLlm: sentinel });
    const a = await pipeline.assess(replayInput());
    expect(a.sentinel.injectionSuspected).toBe(true);
    expect(a.verdict?.planRules.map((r) => r.reasonCode)).toContain('INJECTION_SUSPECTED');
  });

  it('agent tools never reveal payee emails', async () => {
    const llm = scriptedAgent(GOOD_PLAN);
    const { pipeline } = makePipeline({ llm });
    await pipeline.assess(replayInput());
    const everythingTheModelSaw = JSON.stringify(llm.requests);
    expect(everythingTheModelSaw).not.toMatch(/sb-test\d+@/);
    expect(everythingTheModelSaw).not.toContain('personal.example.com');
    expect(everythingTheModelSaw).toContain('<untrusted_text');
    void toolUse; // imported for parity with other tests
  });
});
