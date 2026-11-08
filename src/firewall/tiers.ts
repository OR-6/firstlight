import type { FirewallConfig, FirewallContext, PagerAlert, Tier } from './types';

const TIER_RANK: Record<Tier, number> = { A: 3, B: 2, C: 1 };
const RANK_TIER: Record<number, Tier> = { 3: 'A', 2: 'B', 1: 'C' };

/** true if `a` pays more than `b`. */
export function tierAbove(a: Tier, b: Tier): boolean {
  return TIER_RANK[a] > TIER_RANK[b];
}

/** Highest tier a recipient's distance alone allows, or null outside the max radius. */
export function distanceBandTier(distanceKm: number, config: FirewallConfig): Tier | null {
  const bands = config.tierMaxDistanceKm;
  if (distanceKm <= bands.A) return 'A';
  if (distanceKm <= bands.B) return 'B';
  if (distanceKm <= bands.C) return 'C';
  return null;
}

/**
 * Highest tier the firewall will pay this recipient. Distance sets the band;
 * a configured vulnerability flag lifts it by one tier (never from "outside
 * the radius" into eligibility). The agent's judgement of vulnerability can
 * therefore matter, but only inside a ceiling a human configured.
 */
export function maxAllowedTier(distanceKm: number, flags: readonly string[], config: FirewallConfig): Tier | null {
  const band = distanceBandTier(distanceKm, config);
  if (band === null) return null;
  const uplift = flags.some((f) => config.vulnerabilityUpliftFlags.includes(f));
  if (!uplift) return band;
  return RANK_TIER[Math.min(3, TIER_RANK[band] + 1)] ?? band;
}

export function amountForTier(tier: Tier, config: FirewallConfig): number {
  return config.tierAmountsCents[tier];
}

const PAGER_RANK: Record<PagerAlert, number> = { green: 1, yellow: 2, orange: 3, red: 4 };

export function pagerAtLeast(alert: PagerAlert | null, min: PagerAlert): boolean {
  return alert !== null && PAGER_RANK[alert] >= PAGER_RANK[min];
}

/** The distance bands for an event of this magnitude (base bands × the configured factor). */
export function bandsFor(mag: number, config: Pick<FirewallConfig, 'tierMaxDistanceKm' | 'bandScaleByMagnitude'>): Record<Tier, number> {
  const rule = config.bandScaleByMagnitude.find((b) => mag >= b.minMagnitude);
  const f = rule ? rule.factor : 1;
  const b = config.tierMaxDistanceKm;
  return { A: Math.round(b.A * f), B: Math.round(b.B * f), C: Math.round(b.C * f) };
}

/** The context with distance bands scaled to this event's magnitude. Every rule uses this. */
export function withEventBands(ctx: FirewallContext): FirewallContext {
  const bands = bandsFor(ctx.event.mag, ctx.config);
  const same = bands.A === ctx.config.tierMaxDistanceKm.A && bands.B === ctx.config.tierMaxDistanceKm.B && bands.C === ctx.config.tierMaxDistanceKm.C;
  return same ? ctx : { ...ctx, config: { ...ctx.config, tierMaxDistanceKm: bands } };
}
