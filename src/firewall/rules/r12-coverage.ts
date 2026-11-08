import { distanceKm } from '../geo';
import { maxAllowedTier, tierAbove } from '../tiers';
import type { FirewallContext, ItemVerdict, RuleResult, Tier } from '../types';
import { currentEventIds } from './shared';

const HOUR_MS = 3_600_000;

/**
 * Who the firewall itself considers owed a payout for this event: verified,
 * enrolled before the cutoff, inside the max radius, not already paid for
 * this disaster. Computed from the registry and ledger only, never from the plan.
 */
export function eligibleRecipients(ctx: FirewallContext, sameDisasterIds: ReadonlySet<string>): { recipientId: string; maxTier: Tier }[] {
  const cutoff = ctx.event.time - ctx.config.minRegistrationLeadHours * HOUR_MS;
  const ids = currentEventIds(ctx);
  const out: { recipientId: string; maxTier: Tier }[] = [];
  for (const r of ctx.registry) {
    if (!r.verified || r.registeredAt > cutoff) continue;
    const d = Math.round(distanceKm(ctx.event.epicentre, r.home) * 1000) / 1000;
    const maxTier = maxAllowedTier(d, r.flags, ctx.config);
    if (maxTier === null) continue;
    const paid = ctx.ledger.payouts.some((p) => p.recipientId === r.recipientId && (ids.has(p.eventId) || sameDisasterIds.has(p.eventId)));
    if (paid) continue;
    out.push({ recipientId: r.recipientId, maxTier });
  }
  return out;
}

/**
 * R12 — coverage floor. R1–R10 stop the agent paying too much or the wrong
 * person; R12 stops it quietly paying too little. A plan that leaves out an
 * eligible household, pays one below its band, or holds everything although
 * the trigger is confirmed needs a person (WARN). It never adds anyone or
 * raises an amount by itself: the reviewer decides.
 */
export function r12Coverage(
  input: { decision: 'trigger' | 'hold' | 'escalate' | null; items: readonly ItemVerdict[]; triggerMet: boolean; sameDisasterIds: ReadonlySet<string> },
  ctx: FirewallContext,
): RuleResult[] {
  if (input.decision === null || !input.triggerMet) {
    return [r('pass', 'ALL_ELIGIBLE_COVERED', 'not checked: no valid plan or the trigger is not met')];
  }
  const eligible = eligibleRecipients(ctx, input.sameDisasterIds);
  if (input.decision === 'hold') {
    return eligible.length > 0
      ? [r('warn', 'HOLD_ON_MET_TRIGGER', `agent held although the trigger is confirmed and ${eligible.length} enrolled household(s) are eligible; a person should review`)]
      : [r('pass', 'ALL_ELIGIBLE_COVERED', 'hold, and no household is eligible')];
  }
  const out: RuleResult[] = [];
  const inPlan = new Set(input.items.filter((i) => i.allowedTier !== null).map((i) => i.recipientId));
  const omitted = eligible.filter((e) => !inPlan.has(e.recipientId)).map((e) => e.recipientId);
  if (omitted.length > 0) {
    out.push(r('warn', 'ELIGIBLE_OMITTED', `${omitted.length} eligible household(s) left out of the plan: ${omitted.slice(0, 10).join(', ')}`));
  }
  const max = new Map(eligible.map((e) => [e.recipientId, e.maxTier]));
  const under = input.items
    .filter((i) => i.allowedTier !== null && max.has(i.recipientId) && tierAbove(max.get(i.recipientId)!, i.allowedTier))
    .map((i) => `${i.recipientId} tier ${i.allowedTier} (band allows ${max.get(i.recipientId)})`);
  if (under.length > 0) {
    out.push(r('warn', 'TIER_BELOW_BAND', `${under.length} household(s) planned below their band: ${under.slice(0, 10).join('; ')}`));
  }
  if (out.length === 0) out.push(r('pass', 'ALL_ELIGIBLE_COVERED', `all ${eligible.length} eligible household(s) planned at their band`));
  return out;
}

function r(status: RuleResult['status'], reasonCode: RuleResult['reasonCode'], detail: string): RuleResult {
  return { id: 'R12', scope: 'plan', status, reasonCode, detail };
}
