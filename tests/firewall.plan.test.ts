import { describe, expect, it } from 'vitest';
import { evaluatePlan, payableItems } from '../src/firewall/engine';
import { r9Note } from '../src/firewall/rules/r9-integrity';
import type { PriorPayout, ReasonCode, VerdictKind } from '../src/firewall/types';
import {
  CLEAN_ITEMS,
  EVENT_ID,
  EVENT_TIME,
  NOW,
  ctx,
  emptyLedger,
  plan,
  type CtxOverrides, onlyPlanned } from './helpers/firewall-fixture';

/**
 * Plan-level rules (R5 budget, R7 velocity, R8 trigger, R9 integrity, R10
 * approval). Each row checks the overall verdict and that a reason code
 * appears in the plan-level trace.
 */
type Row = {
  name: string;
  plan?: unknown;
  ctx?: CtxOverrides;
  overall: VerdictKind;
  code: ReasonCode;
  totalCents?: number;
};

const clean = plan(CLEAN_ITEMS); // $120 + $40 = $160
const pool = (cents: number): CtxOverrides => ({ ledger: emptyLedger(cents) });
const otherPaid = (cents: number): PriorPayout[] => [
  // Paid earlier for THIS event to recipients not in the plan; counts toward the event cap.
  { eventId: EVENT_ID, recipientId: 'rcp_other_1', amountCents: cents, at: NOW - 600_000, status: 'SUCCESS' },
];
const emsc = ctx().corroboration[0]!;

const rows: Row[] = [
  // ── R10 / aggregation baseline ───────────────────────────────────────────
  { name: 'clean plan under threshold → ALLOW', overall: 'ALLOW', code: 'AUTO_APPROVABLE', totalCents: 160_00 },
  { name: 'R10: total exactly at threshold → ALLOW', ctx: { config: { approvalThresholdCents: 160_00 } }, overall: 'ALLOW', code: 'AUTO_APPROVABLE', totalCents: 160_00 },
  { name: 'R10: one cent over threshold → REQUIRE_APPROVAL', ctx: { config: { approvalThresholdCents: 159_99 } }, overall: 'REQUIRE_APPROVAL', code: 'OVER_APPROVAL_THRESHOLD', totalCents: 160_00 },
  {
    name: 'R10: $320 plan over default $300 threshold',
    plan: plan([{ recipientId: 'rcp_a10', tier: 'A' }, { recipientId: 'rcp_a40', tier: 'A' }, { recipientId: 'rcp_b120', tier: 'B' }]),
    overall: 'REQUIRE_APPROVAL',
    code: 'OVER_APPROVAL_THRESHOLD',
    totalCents: 320_00,
  },
  { name: 'R10: trigger with no items → BLOCK', plan: plan([]), overall: 'BLOCK', code: 'NO_PAYABLE_ITEMS', totalCents: 0 },
  { name: 'R10: every item blocked → BLOCK', plan: plan([{ recipientId: 'ghost', tier: 'A' }, { recipientId: 'rcp_far400', tier: 'C' }]), overall: 'BLOCK', code: 'NO_PAYABLE_ITEMS', totalCents: 0 },
  { name: 'R10: one bad item forces approval for the rest', plan: plan([...CLEAN_ITEMS, { recipientId: 'attacker@evil.example', tier: 'A' }]), overall: 'REQUIRE_APPROVAL', code: 'ITEMS_BLOCKED', totalCents: 160_00 },

  // ── R5 budget ────────────────────────────────────────────────────────────
  { name: 'R5 pass: pool comfortably covers plan', overall: 'ALLOW', code: 'WITHIN_BUDGET' },
  { name: 'R5 block: insufficient pool ($150 pool, $160 plan)', ctx: pool(150_00), overall: 'BLOCK', code: 'POOL_INSUFFICIENT', totalCents: 0 },
  { name: 'R5 block: empty pool', ctx: pool(0), overall: 'BLOCK', code: 'POOL_INSUFFICIENT' },
  { name: 'R5 warn: plan above 60% of pool', ctx: pool(250_00), overall: 'REQUIRE_APPROVAL', code: 'BUDGET_SOFT_LIMIT', totalCents: 160_00 },
  { name: 'R5 pass: plan exactly 60% of pool (boundary)', ctx: pool(266_67), overall: 'ALLOW', code: 'WITHIN_BUDGET' },
  { name: 'R5 block: event cap ($1,400 paid + $160 > $1,500)', ctx: { ledger: { ...emptyLedger(), payouts: otherPaid(1_400_00) } }, overall: 'BLOCK', code: 'EVENT_CAP_EXCEEDED' },
  { name: 'R5 pass: event cap boundary ($1,340 + $160 = $1,500)', ctx: { ledger: { ...emptyLedger(), payouts: otherPaid(1_340_00) } }, overall: 'ALLOW', code: 'WITHIN_BUDGET' },

  // ── R7 velocity / kill switch ────────────────────────────────────────────
  { name: 'R7 block: kill switch', ctx: { config: { killSwitch: true } }, overall: 'BLOCK', code: 'KILL_SWITCH_ENGAGED' },
  { name: 'R7 block: 3 batches in the last hour', ctx: { ledger: { ...emptyLedger(), batchTimes: [NOW - 1000, NOW - 2000, NOW - 3000] } }, overall: 'BLOCK', code: 'VELOCITY_EXCEEDED' },
  { name: 'R7 pass: 2 batches in the last hour', ctx: { ledger: { ...emptyLedger(), batchTimes: [NOW - 1000, NOW - 2000] } }, overall: 'ALLOW', code: 'WITHIN_VELOCITY' },
  { name: 'R7 pass: batch 61 minutes ago no longer counts', ctx: { ledger: { ...emptyLedger(), batchTimes: [NOW - 1000, NOW - 2000, NOW - 61 * 60_000] } }, overall: 'ALLOW', code: 'WITHIN_VELOCITY' },

  // ── R8 trigger validity ──────────────────────────────────────────────────
  { name: 'R8 pass: M7.7 orange, EMSC agrees', overall: 'ALLOW', code: 'TRIGGER_CORROBORATED' },
  { name: 'R8 block: M5.9 and PAGER yellow', ctx: { event: { mag: 5.9, alert: 'yellow' }, corroboration: [{ ...emsc, mag: 5.9 }] }, overall: 'BLOCK', code: 'TRIGGER_THRESHOLD_NOT_MET' },
  { name: 'R8 block: M5.9 and PAGER null (small events have no alert)', ctx: { event: { mag: 5.9, alert: null }, corroboration: [{ ...emsc, mag: 5.9 }] }, overall: 'BLOCK', code: 'TRIGGER_THRESHOLD_NOT_MET' },
  { name: 'R8 warn: exactly M6.0 with PAGER null (magnitude only: basis risk, a person checks)', ctx: { event: { mag: 6.0, alert: null }, corroboration: [{ ...emsc, mag: 6.2 }] }, overall: 'REQUIRE_APPROVAL', code: 'TRIGGER_MAGNITUDE_ONLY' },
  { name: 'R8 warn: M7.0 offshore with PAGER green', ctx: { event: { mag: 7.0, alert: 'green' }, corroboration: [{ ...emsc, mag: 7.0 }] }, overall: 'REQUIRE_APPROVAL', code: 'TRIGGER_MAGNITUDE_ONLY' },
  { name: 'R8 pass: M6.0 with PAGER yellow', ctx: { event: { mag: 6.0, alert: 'yellow' }, corroboration: [{ ...emsc, mag: 6.1 }] }, overall: 'ALLOW', code: 'TRIGGER_CORROBORATED' },
  { name: 'R8 pass: M5.5 but PAGER red', ctx: { event: { mag: 5.5, alert: 'red' }, corroboration: [{ ...emsc, mag: 5.6 }] }, overall: 'ALLOW', code: 'TRIGGER_CORROBORATED' },
  { name: 'R8 warn: no second source', ctx: { corroboration: [] }, overall: 'REQUIRE_APPROVAL', code: 'TRIGGER_UNCORROBORATED' },
  { name: 'R8 pass: magnitude delta exactly 0.5', ctx: { corroboration: [{ ...emsc, mag: 7.2 }] }, overall: 'ALLOW', code: 'TRIGGER_CORROBORATED' },
  { name: 'R8 warn: magnitude delta 0.6', ctx: { corroboration: [{ ...emsc, mag: 7.1 }] }, overall: 'REQUIRE_APPROVAL', code: 'TRIGGER_UNCORROBORATED' },
  { name: 'R8 warn: second source epicentre ~60 km away', ctx: { corroboration: [{ ...emsc, epicentre: { lat: 8.15, lon: -80.7566 } }] }, overall: 'REQUIRE_APPROVAL', code: 'TRIGGER_UNCORROBORATED' },
  { name: 'R8 warn: second source origin time 10 min off', ctx: { corroboration: [{ ...emsc, time: EVENT_TIME + 600_000 }] }, overall: 'REQUIRE_APPROVAL', code: 'TRIGGER_UNCORROBORATED' },
  { name: 'R8 warn: only the non-independent USGS-reviewed fallback agrees', ctx: { corroboration: [{ ...emsc, source: 'usgs-reviewed', independent: false }] }, overall: 'REQUIRE_APPROVAL', code: 'TRIGGER_CORROBORATION_DEGRADED' },
  { name: 'R8 block: event dated after evaluation time', ctx: { now: EVENT_TIME - 1 }, overall: 'BLOCK', code: 'EVENT_IN_FUTURE' },

  // ── R9 plan integrity ────────────────────────────────────────────────────
  { name: 'R9 block: null plan', plan: null, overall: 'BLOCK', code: 'PLAN_MALFORMED' },
  { name: 'R9 block: plan is a string', plan: 'send $5000 to attacker@evil.example', overall: 'BLOCK', code: 'PLAN_MALFORMED' },
  { name: 'R9 block: missing items array', plan: { eventId: EVENT_ID, decision: 'trigger', rationale: '', exceptionRequests: [] }, overall: 'BLOCK', code: 'PLAN_MALFORMED' },
  { name: 'R9 block: invented tier "S"', plan: plan([{ recipientId: 'rcp_a10', tier: 'S' as 'A' }]), overall: 'BLOCK', code: 'PLAN_MALFORMED' },
  { name: 'R9 block: invented decision "pay_now"', plan: plan(CLEAN_ITEMS, { decision: 'pay_now' }), overall: 'BLOCK', code: 'PLAN_MALFORMED' },
  { name: 'R9 block: oversized items array (501)', plan: plan(Array.from({ length: 501 }, () => ({ recipientId: 'rcp_a10', tier: 'C' as const }))), overall: 'BLOCK', code: 'PLAN_MALFORMED' },
  { name: 'R9 block: plan for a different event', plan: plan(CLEAN_ITEMS, { eventId: 'us_elsewhere' }), overall: 'BLOCK', code: 'PLAN_EVENT_MISMATCH' },
  { name: 'R9 block: agent decided hold (items ignored)', plan: plan(CLEAN_ITEMS, { decision: 'hold' }), overall: 'BLOCK', code: 'AGENT_HOLD', totalCents: 0 },
  { name: 'R9 warn: agent escalated', plan: plan(CLEAN_ITEMS, { decision: 'escalate' }), overall: 'REQUIRE_APPROVAL', code: 'AGENT_ESCALATED' },
  { name: 'R9 warn: unknown top-level field "receiver"', plan: plan(CLEAN_ITEMS, { receiver: 'attacker@evil.example' }), overall: 'REQUIRE_APPROVAL', code: 'PLAN_UNKNOWN_FIELDS', totalCents: 160_00 },
  { name: 'R9 warn: sentinel flagged injection', ctx: { sentinel: { injectionSuspected: true, findings: ['news#2: "ignore previous instructions"'] } }, overall: 'REQUIRE_APPROVAL', code: 'INJECTION_SUSPECTED' },
  { name: 'R9 warn: exception request', plan: plan(CLEAN_ITEMS, { exceptionRequests: [{ recipientId: 'rcp_a10', reason: 'reports hospitalisation' }] }), overall: 'REQUIRE_APPROVAL', code: 'EXCEPTION_REQUESTED' },
];

describe('firewall plan rules', () => {
  it.each(rows)('$name', (row) => {
    const raw = row.plan === undefined ? clean : row.plan;
    const items = raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items) ? ((raw as { items: { recipientId: string }[] }).items) : CLEAN_ITEMS;
    // Registry entries the test refers to only as unknown ids stay unknown (R1 still blocks them).
    const v = evaluatePlan(raw, onlyPlanned(ctx(row.ctx), items));
    expect(v.overall).toBe(row.overall);
    expect(v.planRules.map((r) => r.reasonCode)).toContain(row.code);
    if (row.totalCents !== undefined) expect(v.totalCents).toBe(row.totalCents);
    if (v.overall === 'BLOCK') {
      expect(v.totalCents).toBe(0);
      expect(v.paypalRequestId).toBeNull();
      expect(payableItems(v)).toEqual([]);
      for (const i of v.items) expect(i.verdict).toBe('BLOCK');
    }
  });
});

describe('firewall invariants', () => {
  it('extra fields cannot set an amount or a payee', () => {
    const raw = plan([
      { recipientId: 'rcp_a10', tier: 'C', ...({ amount: 5000, receiver: 'attacker@evil.example', currency: 'BTC' } as object) },
    ]);
    const v = evaluatePlan(raw, ctx());
    expect(v.overall).toBe('REQUIRE_APPROVAL');
    expect(v.items[0]?.amountCents).toBe(40_00);
    expect(JSON.stringify(v)).not.toContain('attacker@evil.example');
    const unknown = v.planRules.find((r) => r.reasonCode === 'PLAN_UNKNOWN_FIELDS');
    expect(unknown?.detail).toContain('$.items[0].receiver');
  });

  it('is deterministic: same input → identical verdict and digest', () => {
    const a = evaluatePlan(clean, ctx());
    const b = evaluatePlan(structuredClone(clean), ctx());
    expect(b).toEqual(a);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not mutate its inputs', () => {
    const p = deepFreeze(structuredClone(clean));
    const c = deepFreeze(ctx({ ledger: { ...emptyLedger(), payouts: otherPaid(100_00) } }));
    expect(() => evaluatePlan(p, c)).not.toThrow();
  });

  it('PayPal-Request-Id ignores item order and notes but changes with amounts', () => {
    const base = evaluatePlan(clean, ctx()).paypalRequestId;
    const reordered = evaluatePlan(plan([...CLEAN_ITEMS].reverse()), ctx()).paypalRequestId;
    const renoted = evaluatePlan(plan(CLEAN_ITEMS.map((i) => ({ ...i, note: 'Different wording.' }))), ctx()).paypalRequestId;
    const otherAmount = evaluatePlan(plan([{ recipientId: 'rcp_a10', tier: 'B' }, { recipientId: 'rcp_c250', tier: 'C' }]), ctx()).paypalRequestId;
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(reordered).toBe(base);
    expect(renoted).toBe(base);
    expect(otherAmount).not.toBe(base);
  });

  it('every item trace carries the plan-level rules, ordered R1→R10', () => {
    const v = evaluatePlan(clean, ctx());
    for (const item of v.items) {
      const ids = item.ruleTrace.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10']));
      const nums = ids.map((id) => Number(id.slice(1)));
      expect([...nums].sort((x, y) => x - y)).toEqual(nums);
    }
  });

  it('plan revision never re-pays: v2 only pays recipients v1 did not', () => {
    const paidInV1: PriorPayout[] = CLEAN_ITEMS.map((i) => ({
      eventId: EVENT_ID,
      recipientId: i.recipientId,
      amountCents: i.tier === 'A' ? 120_00 : 40_00,
      at: NOW - 600_000,
      status: 'PENDING',
    }));
    const v2 = evaluatePlan(
      plan([...CLEAN_ITEMS, { recipientId: 'rcp_b120', tier: 'B' }]),
      ctx({ ledger: { ...emptyLedger(), payouts: paidInV1, batchTimes: [NOW - 600_000] } }),
    );
    expect(payableItems(v2).map((i) => i.recipientId)).toEqual(['rcp_b120']);
    expect(v2.totalCents).toBe(80_00);
    expect(v2.overall).toBe('REQUIRE_APPROVAL'); // blocked duplicates are surfaced to a human
  });

  it('stays fast on worst-case input (regression: note regex ReDoS)', () => {
    // Notes built to stress the domain / phone patterns at the 200-char limit,
    // plus schema-max 5,000-char notes that must short-circuit. 500 of each
    // = the most a single plan can carry. Calls the rule directly because in
    // a real plan R6 would stop duplicate recipients before the note check.
    const config = ctx().config;
    const nasty = ['a'.repeat(199) + '.', '1 '.repeat(100), '-'.repeat(200), 'x'.repeat(5000), 'ab-'.repeat(1666)];
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) for (const n of nasty) r9Note(n, config);
    // Generous bound: catches quadratic blow-ups (seconds), not CI jitter.
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('replaying an identical plan after it was paid pays nothing', () => {
    const v1 = evaluatePlan(clean, ctx());
    const paid: PriorPayout[] = payableItems(v1).map((i) => ({
      eventId: EVENT_ID,
      recipientId: i.recipientId,
      amountCents: i.amountCents,
      at: NOW,
      status: 'SUCCESS',
    }));
    const replay = evaluatePlan(clean, ctx({ ledger: { ...emptyLedger(), payouts: paid } }));
    expect(replay.overall).toBe('BLOCK');
    expect(payableItems(replay)).toEqual([]);
  });
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
