import { distanceKm } from '../geo';
import { NEVER_SENT_STATUSES, type FirewallContext, type PriorPayout } from '../types';

/** All ids under which the current event may appear in the ledger. */
export function currentEventIds(ctx: FirewallContext): Set<string> {
  return new Set([ctx.event.id, ...ctx.event.aliases]);
}

/** Payouts that count against caps: anything except ones that never left the pool. */
export function countsAgainstCaps(p: PriorPayout): boolean {
  return !(NEVER_SENT_STATUSES as readonly string[]).includes(p.status.toUpperCase());
}

/**
 * Previously paid events that are the same physical disaster as the current
 * one: shared ids/aliases, or close in both space and time. A spoofed or
 * re-issued event id therefore can't unlock a second payout.
 */
export function sameDisasterEventIds(ctx: FirewallContext): Set<string> {
  const ours = currentEventIds(ctx);
  const { radiusKm, windowHours } = ctx.config.sameDisaster;
  const out = new Set<string>();
  for (const pe of ctx.ledger.paidEvents) {
    if (ours.has(pe.eventId)) continue; // that's this event, handled separately
    const sharesId = pe.aliases.some((a) => ours.has(a)) || [...ours].some((id) => pe.aliases.includes(id));
    const near =
      distanceKm(pe.epicentre, ctx.event.epicentre) <= radiusKm &&
      Math.abs(pe.time - ctx.event.time) <= windowHours * 3_600_000;
    if (sharesId || near) out.add(pe.eventId);
  }
  return out;
}
