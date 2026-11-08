import { eligibleRecipients } from './rules/r12-coverage';
import { sameDisasterEventIds } from './rules/shared';
import type { FirewallContext } from './types';

/**
 * The firewall's own plan: every household it considers owed (verified,
 * enrolled before the cutoff, inside the radius, not already paid for this
 * disaster), at the highest tier its band allows. Drafted by deterministic
 * code, not the agent, for when the agent's plan blocks or shrinks aid
 * (a hold talked in by a hoax, a forged event id, a malformed plan, or
 * households left out). Decision is `escalate`, so it always needs a person.
 * Pure: same context, same plan.
 */
export function floorPlan(ctx: FirewallContext, reason: string) {
  const items = eligibleRecipients(ctx, sameDisasterEventIds(ctx)).map((e) => ({
    recipientId: e.recipientId,
    tier: e.maxTier,
    note: '',
    why: 'Owed under the programme rules (firewall floor plan)',
  }));
  return {
    eventId: ctx.event.id,
    decision: 'escalate' as const,
    rationale: `Firewall floor plan, drafted by deterministic code, not the agent: every enrolled household owed for this earthquake at its full tier. Reason: ${reason}`,
    items,
    exceptionRequests: [] as { recipientId: string; reason: string }[],
  };
}
