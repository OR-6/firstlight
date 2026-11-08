import type { FirewallContext, RuleResult } from '../types';
import { currentEventIds } from './shared';

/**
 * R6 — at most one payout per (disaster, recipient).
 * Any prior ledger record for this event (or its aliases, or a near-identical
 * event already paid) blocks, whatever its status: retrying a failed payout is
 * an operator action, never something a plan revision can trigger.
 */
export function r6Duplicates(
  recipientId: string,
  seenInPlan: ReadonlySet<string>,
  sameDisasterIds: ReadonlySet<string>,
  ctx: FirewallContext,
): RuleResult {
  if (seenInPlan.has(recipientId)) {
    return block('DUPLICATE_IN_PLAN', 'recipient appears earlier in this plan; only the first entry is evaluated');
  }
  const ids = currentEventIds(ctx);
  const prior = ctx.ledger.payouts.find((p) => p.recipientId === recipientId && ids.has(p.eventId));
  if (prior) {
    return block('ALREADY_PAID_FOR_EVENT', `payout already recorded for ${prior.eventId} (status ${prior.status})`);
  }
  const twin = ctx.ledger.payouts.find((p) => p.recipientId === recipientId && sameDisasterIds.has(p.eventId));
  if (twin) {
    return block(
      'ALREADY_PAID_FOR_SAME_DISASTER',
      `paid under event ${twin.eventId}, which matches this event by id alias or location/time`,
    );
  }
  return { id: 'R6', scope: 'item', status: 'pass', reasonCode: 'FIRST_PAYOUT', detail: 'no prior payout for this disaster' };
}

function block(reasonCode: RuleResult['reasonCode'], detail: string): RuleResult {
  return { id: 'R6', scope: 'item', status: 'block', reasonCode, detail };
}
