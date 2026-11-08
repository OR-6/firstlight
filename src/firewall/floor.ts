import { eligibleRecipients } from './rules/r12-coverage';
import { sameDisasterEventIds } from './rules/shared';
import type { FirewallContext } from './types';
import { withEventBands } from './tiers';

/**
 * The firewall's own plan: every household it considers owed (verified,
 * enrolled before the cutoff, inside the radius, not already paid for this
 * disaster), at the highest tier its band allows. Drafted by deterministic
 * code, not the agent, for when the agent's plan blocks or shrinks aid
 * (a hold talked in by a hoax, a forged event id, a malformed plan, or
 * households left out). Decision is `escalate`, so it always needs a person.
 * Pure: same context, same plan.
 */
export function floorPlan(rawCtx: FirewallContext, reason: string) {
  const ctx = withEventBands(rawCtx);
  // If the pool can't cover everyone, fill it highest tier first (closest and uplifted households),
  // then by id for determinism; R12 then names whoever is left out, so a person sees the gap.
  const RANK = { A: 0, B: 1, C: 2 } as const;
  const owed = eligibleRecipients(ctx, sameDisasterEventIds(ctx)).sort(
    (a, b) => RANK[a.maxTier] - RANK[b.maxTier] || (a.recipientId < b.recipientId ? -1 : 1),
  );
  const budget = Math.min(ctx.ledger.poolBalanceCents, ctx.config.eventCapCents);
  let used = 0;
  const funded = owed.filter((e) => {
    const c = ctx.config.tierAmountsCents[e.maxTier];
    if (used + c > budget) return false;
    used += c;
    return true;
  });
  const short = owed.length - funded.length;
  const items = funded.map((e) => ({
    recipientId: e.recipientId,
    tier: e.maxTier,
    note: '',
    why: 'Owed under the programme rules (firewall floor plan)',
  }));
  return {
    eventId: ctx.event.id,
    decision: 'escalate' as const,
    rationale: `Firewall floor plan, drafted by deterministic code, not the agent: every enrolled household owed for this earthquake at its full tier${short ? ` (${short} left out because the pool can't cover them; highest tiers first)` : ''}. Reason: ${reason}`,
    items,
    exceptionRequests: [] as { recipientId: string; reason: string }[],
  };
}
