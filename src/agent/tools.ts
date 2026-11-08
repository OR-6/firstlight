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
  config: Pick<FirewallConfig, 'tierMaxDistanceKm' | 'tierAmountsCents' | 'vulnerabilityUpliftFlags'>;
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
        // Free text from USGS: wrapped like the news, never treated as instructions.
        title: untrustedField('usgs-title', 'USGS event title', e.title ?? ''),
        place: untrustedField('usgs-place', 'USGS place name', e.place ?? ''),
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
        note: untrustedField('corroboration-note', 'Corroboration status', world.corroboration.note),
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
        note: 'A household marked upliftEligible may get one tier above its distance band. Which condition qualifies it is not shared with you. Firstlight recomputes and enforces every tier.',
        recipients: world.registry
          .map((r) => {
            const d = round(distanceKm(e.epicentre, r.home), 1);
            return {
              recipientId: r.recipientId,
              town: r.town,
              distanceKm: d,
              distanceBandTier: distanceBandTier(d, world.config as FirewallConfig) ?? 'outside radius',
              // Data minimisation (D84): the agent learns that an uplift applies, not which health or care condition it is.
              upliftEligible: r.flags.some((f) => world.config.vulnerabilityUpliftFlags.includes(f)),
            };
          })
          .sort((a, b) => a.distanceKm - b.distanceKm),
      });
    default:
      return { isError: true, content: `Unknown tool ${name}` };
  }
}

function untrustedField(id: string, source: string, text: string): string {
  return wrapUntrusted([{ id, source, origin: 'usgs', text }]);
}

function ok(v: unknown): ToolOutcome {
  return { isError: false, content: JSON.stringify(v, null, 2) };
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
