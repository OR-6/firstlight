import { formatUsd } from '../money';
import { amountForTier } from '../tiers';
import type { FirewallConfig, RuleResult, Tier } from '../types';

/** R3 — the amount is the tier table value. The agent never supplies a number. */
export function r3Amount(tier: Tier, config: FirewallConfig): { result: RuleResult; amountCents: number } {
  const amountCents = amountForTier(tier, config);
  return {
    amountCents,
    result: {
      id: 'R3',
      scope: 'item',
      status: 'pass',
      reasonCode: 'AMOUNT_FROM_TIER_TABLE',
      detail: `tier ${tier} = ${formatUsd(amountCents)} (tier table)`,
    },
  };
}
