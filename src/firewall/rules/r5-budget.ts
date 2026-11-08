import { formatUsd } from '../money';
import type { FirewallContext, RuleResult } from '../types';
import { countsAgainstCaps, currentEventIds } from './shared';

/**
 * R5 — event budget.
 *  - plan total > pool balance                       → BLOCK (can't be paid)
 *  - already paid for event + plan total > event cap  → BLOCK (hard cap)
 *  - plan total > poolSoftFraction × pool balance     → WARN  (human approval)
 */
export function r5Budget(planTotalCents: number, ctx: FirewallContext): RuleResult {
  const pool = ctx.ledger.poolBalanceCents;
  const { eventCapCents, poolSoftFraction } = ctx.config;
  const ids = currentEventIds(ctx);
  const eventPrior = ctx.ledger.payouts
    .filter((p) => ids.has(p.eventId) && countsAgainstCaps(p))
    .reduce((s, p) => s + p.amountCents, 0);

  if (planTotalCents > pool) {
    return result('block', 'POOL_INSUFFICIENT', `plan ${formatUsd(planTotalCents)} > pool balance ${formatUsd(Math.max(0, pool))}`);
  }
  if (eventPrior + planTotalCents > eventCapCents) {
    return result(
      'block',
      'EVENT_CAP_EXCEEDED',
      `${formatUsd(eventPrior)} already paid + ${formatUsd(planTotalCents)} > event cap ${formatUsd(eventCapCents)}`,
    );
  }
  const soft = Math.floor(pool * poolSoftFraction);
  if (planTotalCents > soft) {
    return result(
      'warn',
      'BUDGET_SOFT_LIMIT',
      `plan ${formatUsd(planTotalCents)} > ${Math.round(poolSoftFraction * 100)}% of pool (${formatUsd(soft)})`,
    );
  }
  return result('pass', 'WITHIN_BUDGET', `plan ${formatUsd(planTotalCents)} within pool and event cap`);
}

function result(status: RuleResult['status'], reasonCode: RuleResult['reasonCode'], detail: string): RuleResult {
  return { id: 'R5', scope: 'plan', status, reasonCode, detail };
}
