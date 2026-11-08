import { distanceKm } from '../geo';
import { distanceBandTier, maxAllowedTier, tierAbove } from '../tiers';
import type { FirewallContext, RegistryRecipient, RuleResult, Tier } from '../types';

/**
 * R2 — the firewall recomputes the distance band itself and caps the tier.
 * Asking for a higher tier than allowed is downgraded (WARN → human approval);
 * outside the max radius there is no payout.
 */
export function r2TierBand(
  requestedTier: Tier,
  recipient: RegistryRecipient,
  ctx: FirewallContext,
): { result: RuleResult; allowedTier: Tier | null; distanceKm: number } {
  // Rounded to 1 m so band edges are not decided by floating-point noise.
  const d = Math.round(distanceKm(ctx.event.epicentre, recipient.home) * 1000) / 1000;
  const max = maxAllowedTier(d, recipient.flags, ctx.config);
  const band = distanceBandTier(d, ctx.config);
  const uplift = max !== null && band !== null && max !== band ? `band ${band}, +1 tier for ${recipient.flags.filter((f) => ctx.config.vulnerabilityUpliftFlags.includes(f)).join(', ').replaceAll('_', ' ')}` : null;
  const km = `${d.toFixed(1)} km`;
  if (max === null) {
    return {
      distanceKm: d,
      allowedTier: null,
      result: {
        id: 'R2',
        scope: 'item',
        status: 'block',
        reasonCode: 'OUTSIDE_MAX_RADIUS',
        detail: `${km} from epicentre; max radius ${ctx.config.tierMaxDistanceKm.C} km`,
      },
    };
  }
  if (tierAbove(requestedTier, max)) {
    return {
      distanceKm: d,
      allowedTier: max,
      result: {
        id: 'R2',
        scope: 'item',
        status: 'warn',
        reasonCode: 'TIER_DOWNGRADED',
        detail: `agent requested tier ${requestedTier}; ${km} allows at most ${max}${uplift ? ` (${uplift})` : ''}`,
      },
    };
  }
  return {
    distanceKm: d,
    allowedTier: requestedTier,
    result: {
      id: 'R2',
      scope: 'item',
      status: 'pass',
      reasonCode: 'TIER_WITHIN_BAND',
      detail: `tier ${requestedTier} at ${km}; max ${max}${uplift ? ` (${uplift})` : ''}`,
    },
  };
}
