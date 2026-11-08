import { canonicalJson, sha256Hex } from '../lib/canonical';
import { payoutBatchRequestId } from './idempotency';
import { parsePlan } from './plan';
import { r1Registry } from './rules/r1-registry';
import { r2TierBand } from './rules/r2-tier-band';
import { r3Amount } from './rules/r3-amount';
import { r4RecipientCaps } from './rules/r4-recipient-caps';
import { r5Budget } from './rules/r5-budget';
import { r6Duplicates } from './rules/r6-duplicates';
import { r7Velocity } from './rules/r7-velocity';
import { r8Trigger } from './rules/r8-trigger';
import { r9Note, r9PlanIntegrity } from './rules/r9-integrity';
import { r10Approval } from './rules/r10-approval';
import { r12Coverage } from './rules/r12-coverage';
import { payoutNoteFor } from './notes';
import { sameDisasterEventIds } from './rules/shared';
import type { FirewallContext, ItemVerdict, RuleResult, RuleStatus, Verdict, VerdictKind } from './types';

/**
 * Evaluate an untrusted agent plan against a snapshot of the world.
 *
 * Pure and deterministic: same (rawPlan, ctx) → same Verdict, byte for byte.
 * `rawPlan` is `unknown` on purpose — the firewall does its own parsing and
 * never trusts that the caller validated anything.
 *
 * R11 (audit) is the caller's job: append `verdict` to the audit log before
 * acting on it. The executor must refuse any verdict whose `digest` is not in
 * the log.
 */
export function evaluatePlan(rawPlan: unknown, ctx: FirewallContext): Verdict {
  const parsed = parsePlan(rawPlan);
  const planRules: RuleResult[] = [...r9PlanIntegrity(parsed, ctx), r8Trigger(ctx), r7Velocity(ctx)];

  const plan = parsed.ok ? parsed.plan : null;
  const items: ItemVerdict[] = [];
  const seen = new Set<string>();
  const twins = sameDisasterEventIds(ctx);

  for (const [index, item] of (plan?.items ?? []).entries()) {
    const trace: RuleResult[] = [];
    const out: ItemVerdict = {
      index,
      recipientId: item.recipientId,
      requestedTier: item.tier,
      allowedTier: null,
      distanceKm: null,
      amountCents: 0,
      note: ctx.config.fallbackNote,
      agentNote: '',
      verdict: 'BLOCK',
      ruleTrace: trace,
    };
    items.push(out);

    // Item rules short-circuit on the first BLOCK: later rules need data the
    // earlier ones establish (a registry record, an allowed tier).
    const r1 = r1Registry(item.recipientId, ctx);
    trace.push(r1.result);
    if (r1.result.status === 'block' || !r1.recipient) continue;

    const r6 = r6Duplicates(item.recipientId, seen, twins, ctx);
    seen.add(item.recipientId);
    trace.push(r6);
    if (r6.status === 'block') continue;

    const r2 = r2TierBand(item.tier, r1.recipient, ctx);
    out.distanceKm = round1(r2.distanceKm);
    trace.push(r2.result);
    if (r2.result.status === 'block' || !r2.allowedTier) continue;
    out.allowedTier = r2.allowedTier;

    const r3 = r3Amount(r2.allowedTier, ctx.config);
    trace.push(r3.result);

    const r4 = r4RecipientCaps(item.recipientId, r3.amountCents, ctx);
    trace.push(r4);
    if (r4.status === 'block') continue;

    const r9 = r9Note(item.note, ctx.config);
    trace.push(r9.result);
    out.agentNote = r9.note;
    out.note = payoutNoteFor(r1.recipient.locale, r3.amountCents, ctx.config);
    out.amountCents = r3.amountCents;
  }

  const itemBlocked = (i: ItemVerdict) => i.ruleTrace.some((r) => r.status === 'block');
  const payable = items.filter((i) => !itemBlocked(i));
  const total = payable.reduce((s, i) => s + i.amountCents, 0);
  for (const i of items) if (itemBlocked(i)) i.amountCents = 0;

  planRules.push(r5Budget(total, ctx));
  const triggerMet = planRules.some((r) => r.id === 'R8' && r.status === 'pass');
  planRules.push(...r12Coverage({ decision: plan?.decision ?? null, items, triggerMet, sameDisasterIds: twins }, ctx));
  const anyWarn = planRules.some((r) => r.status === 'warn') || items.some((i) => i.ruleTrace.some((r) => r.status === 'warn'));
  planRules.push(
    r10Approval({ payableCount: payable.length, blockedCount: items.length - payable.length, totalCents: total, anyWarn }, ctx),
  );

  const planWorst = worst(planRules.map((r) => r.status));
  const overall: VerdictKind = toVerdict(planWorst);

  for (const i of items) {
    i.ruleTrace = sortTrace([...i.ruleTrace, ...planRules]);
    i.verdict = toVerdict(worst(i.ruleTrace.map((r) => r.status)));
    if (i.verdict === 'BLOCK') i.amountCents = 0;
  }

  const payableFinal = overall === 'BLOCK' ? [] : items.filter((i) => i.verdict !== 'BLOCK');
  const body: Omit<Verdict, 'digest'> = {
    overall,
    eventId: ctx.event.id,
    decision: plan?.decision ?? null,
    totalCents: payableFinal.reduce((s, i) => s + i.amountCents, 0),
    planRules: sortTrace(planRules),
    items,
    paypalRequestId: payableFinal.length > 0 ? payoutBatchRequestId(ctx.event.id, payableFinal) : null,
  };
  return { ...body, digest: sha256Hex(canonicalJson(body)) };
}

/** Items that may be sent to PayPal once the verdict is ALLOW or human-approved. */
export function payableItems(v: Verdict): ItemVerdict[] {
  if (v.overall === 'BLOCK') return [];
  return v.items.filter((i) => i.verdict !== 'BLOCK' && i.amountCents > 0 && i.allowedTier !== null);
}

const RANK: Record<RuleStatus, number> = { pass: 0, warn: 1, block: 2 };

function worst(statuses: RuleStatus[]): RuleStatus {
  return statuses.reduce<RuleStatus>((w, s) => (RANK[s] > RANK[w] ? s : w), 'pass');
}

function toVerdict(s: RuleStatus): VerdictKind {
  return s === 'block' ? 'BLOCK' : s === 'warn' ? 'REQUIRE_APPROVAL' : 'ALLOW';
}

function sortTrace(trace: RuleResult[]): RuleResult[] {
  const n = (r: RuleResult) => Number(r.id.slice(1));
  // Stable sort keeps multiple R9 findings in the order they were produced.
  return [...trace].sort((a, b) => n(a) - n(b) || (a.scope === b.scope ? 0 : a.scope === 'item' ? -1 : 1));
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

