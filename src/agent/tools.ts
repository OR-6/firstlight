import { distanceKm } from '../firewall/geo';
import { distanceBandTier } from '../firewall/tiers';
import type { FirewallConfig } from '../firewall/types';
import type { RegistryProfile } from '../registry/registry';
import type { CorroborationReport } from '../signals/corroboration';
import { wrapUntrusted, type UntrustedText } from '../signals/untrusted';
import type { SeismicEvent } from '../signals/usgs';

/**
 * Everything the agent can see, assembled by the pipeline. Note what is NOT
 * here: payee emails, the ledger, PayPal, credentials.
 */
export type AgentWorld = {
  event: SeismicEvent;
  corroboration: CorroborationReport;
  untrusted: readonly UntrustedText[];
  registry: readonly RegistryProfile[];
  config: Pick<FirewallConfig, 'tierMaxDistanceKm' | 'tierAmountsCents'>;
};

export type ToolOutcome = { content: string; isError: boolean };

/** Execute a read-only tool. Pure function of (world, name, input). */
export function runReadOnlyTool(world: AgentWorld, name: string, input: unknown): ToolOutcome {
  const eventId = (input as { eventId?: unknown } | null)?.eventId;
  if (typeof eventId !== 'string' || ![world.event.id, ...world.event.aliases].includes(eventId)) {
    return { isError: true, content: `Unknown eventId ${JSON.stringify(eventId)}. Only ${world.event.id} can be assessed in this run.` };
  }
  const e = world.event;
  switch (name) {
    case 'get_event':
      return ok({
        id: e.id,
        title: e.title,
        place: e.place,
        time: new Date(e.time).toISOString(),
        magnitude: e.mag,
        magType: e.magType,
        pagerAlert: e.alert ?? 'none (no PAGER alert issued)',
        reviewStatus: e.status,
        depthKm: e.depthKm,
        epicentre: e.epicentre,
        inTsunamiNotificationZone: e.tsunamiZone,
        feltReports: e.felt,
        maxMMI: e.mmi,
        url: e.url,
      });
    case 'get_corroboration':
      return ok({
        mode: world.corroboration.mode,
        note: world.corroboration.note,
        observations: world.corroboration.observations.map((o) => ({
          source: o.source,
          independentOfUsgs: o.independent,
          ref: o.ref,
          magnitude: o.mag,
          magnitudeDifference: round(o.mag - e.mag, 2),
          epicentreDistanceFromUsgsKm: round(distanceKm(o.epicentre, e.epicentre), 1),
          originTimeDifferenceSec: round((o.time - e.time) / 1000, 1),
        })),
      });
    case 'read_news':
      return { isError: false, content: wrapUntrusted(world.untrusted) };
    case 'list_registry_near':
      return ok({
        tierTableUsd: Object.fromEntries(Object.entries(world.config.tierAmountsCents).map(([k, v]) => [k, v / 100])),
        bandsKm: world.config.tierMaxDistanceKm,
        note: 'A vulnerability flag may justify one tier above the distance band. Firstlight recomputes and enforces every tier.',
        recipients: world.registry
          .map((r) => {
            const d = round(distanceKm(e.epicentre, r.home), 1);
            return {
              recipientId: r.recipientId,
              town: r.town,
              distanceKm: d,
              distanceBandTier: distanceBandTier(d, world.config as FirewallConfig) ?? 'outside radius',
              vulnerabilityFlags: r.flags,
              locale: r.locale,
            };
          })
          .sort((a, b) => a.distanceKm - b.distanceKm),
      });
    default:
      return { isError: true, content: `Unknown tool ${name}` };
  }
}

function ok(v: unknown): ToolOutcome {
  return { isError: false, content: JSON.stringify(v, null, 2) };
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
