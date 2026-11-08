import { defaultFirewallConfig } from '../../src/firewall/config';
import { EARTH_RADIUS_KM } from '../../src/firewall/geo';
import type {
  FirewallConfig,
  FirewallContext,
  GeoPoint,
  LedgerSnapshot,
  RegistryRecipient,
} from '../../src/firewall/types';

/**
 * Base scenario: the real USGS M7.7 Panama event us6000u18k (PAGER orange,
 * 2026-10-09) corroborated by the real EMSC record 20261009_0000264.
 * Recipients are synthetic and placed due north of the epicentre at exact
 * distances so tier-band boundaries can be tested precisely.
 */
export const EVENT_ID = 'us6000u18k';
export const EVENT_TIME = 1791568565537; // 2026-10-09T17:56:05.537Z
export const EPICENTRE: GeoPoint = { lat: 7.6069, lon: -80.7566 };
export const NOW = EVENT_TIME + 2 * 3_600_000; // assessed two hours after the quake
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Point exactly `km` due north of `origin` (great-circle). */
export function north(origin: GeoPoint, km: number): GeoPoint {
  return { lat: origin.lat + (km / EARTH_RADIUS_KM) * (180 / Math.PI), lon: origin.lon };
}

export function recipient(id: string, km: number, extra: Partial<RegistryRecipient> = {}): RegistryRecipient {
  return {
    recipientId: id,
    verified: true,
    registeredAt: EVENT_TIME - 30 * DAY,
    home: north(EPICENTRE, km),
    locale: 'es',
    flags: [],
    ...extra,
  };
}

export const REGISTRY: RegistryRecipient[] = [
  recipient('rcp_a10', 10), // band A
  recipient('rcp_a40', 40), // band A
  recipient('rcp_b120', 120), // band B
  recipient('rcp_b120_vuln', 120, { flags: ['sole_caregiver'] }), // band B, uplift → A
  recipient('rcp_c250', 250), // band C
  recipient('rcp_c250_vuln', 250, { flags: ['mobility_impaired'] }), // band C, uplift → B
  recipient('rcp_far400', 400), // outside radius
  recipient('rcp_far400_vuln', 400, { flags: ['sole_caregiver'] }), // outside, uplift can't help
  recipient('rcp_unverified', 10, { verified: false }),
  recipient('rcp_late', 10, { registeredAt: EVENT_TIME - 71 * HOUR }),
  recipient('rcp_edge72', 10, { registeredAt: EVENT_TIME - 72 * HOUR }), // exactly on the cutoff
];

export function emptyLedger(poolBalanceCents = 10_000_00): LedgerSnapshot {
  return { poolBalanceCents, payouts: [], batchTimes: [], paidEvents: [] };
}

export type CtxOverrides = Partial<Omit<FirewallContext, 'config' | 'event'>> & {
  config?: Partial<FirewallConfig>;
  event?: Partial<FirewallContext['event']>;
};

export function ctx(o: CtxOverrides = {}): FirewallContext {
  const base: FirewallContext = {
    event: {
      id: EVENT_ID,
      aliases: ['pt26282000'],
      time: EVENT_TIME,
      epicentre: EPICENTRE,
      mag: 7.7,
      alert: 'orange',
    },
    corroboration: [
      {
        source: 'emsc',
        independent: true,
        mag: 7.7,
        epicentre: { lat: 7.5794, lon: -80.7741 },
        time: Date.parse('2026-10-09T17:56:07.68Z'),
      },
    ],
    registry: REGISTRY,
    ledger: emptyLedger(),
    sentinel: { injectionSuspected: false, findings: [] },
    now: NOW,
    config: defaultFirewallConfig(),
  };
  return {
    ...base,
    ...o,
    event: { ...base.event, ...o.event },
    config: { ...base.config, ...o.config },
  };
}

export type ItemInput = { recipientId: string; tier: 'A' | 'B' | 'C'; note?: string; why?: string };

export function plan(items: ItemInput[], extra: Record<string, unknown> = {}) {
  return {
    eventId: EVENT_ID,
    decision: 'trigger',
    rationale: 'M7.7, PAGER orange, corroborated by EMSC.',
    items: items.map((i) => ({ note: 'Pago de ayuda de emergencia.', why: 'near epicentre', ...i })),
    exceptionRequests: [],
    ...extra,
  };
}

/** A small clean plan that should be ALLOW under the default config ($120 + $40 = $160). */
export const CLEAN_ITEMS: ItemInput[] = [
  { recipientId: 'rcp_a10', tier: 'A' },
  { recipientId: 'rcp_c250', tier: 'C' },
];
