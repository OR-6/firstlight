import { z } from 'zod';
import type { FirewallEvent, PagerAlert } from '../firewall/types';

/**
 * USGS earthquake ingestion (SPEC §5.1).
 * Live: real-time GeoJSON summary feeds (preferred by USGS for automated apps).
 * Replay/historical: FDSN event query by id.
 * URL patterns verified against the live service on 2026-11-08.
 */
export const USGS_FEED_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';
export const USGS_FDSN_BASE = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

export type UsgsFeedLevel = 'significant' | '4.5' | '2.5' | '1.0' | 'all';
export type UsgsFeedWindow = 'hour' | 'day' | 'week' | 'month';

export function usgsFeedUrl(level: UsgsFeedLevel, window: UsgsFeedWindow): string {
  return `${USGS_FEED_BASE}/${level}_${window}.geojson`;
}

export function usgsEventUrl(eventId: string): string {
  if (!/^[a-z0-9]{2,40}$/i.test(eventId)) throw new Error(`invalid USGS event id: ${JSON.stringify(eventId)}`);
  return `${USGS_FDSN_BASE}?eventid=${encodeURIComponent(eventId)}&format=geojson`;
}

/** Normalised event used across Firstlight. Times are epoch ms. */
export type SeismicEvent = {
  id: string;
  aliases: string[];
  time: number;
  updated: number;
  epicentre: { lat: number; lon: number };
  depthKm: number | null;
  mag: number;
  magType: string | null;
  place: string | null;
  title: string | null;
  /** PAGER alert level. Null for many smaller events. */
  alert: PagerAlert | null;
  /** In a tsunami-notification zone — NOT "a tsunami occurred". */
  tsunamiZone: boolean;
  sig: number | null;
  felt: number | null;
  cdi: number | null;
  mmi: number | null;
  status: string;
  url: string | null;
  detailUrl: string | null;
};

const nullableNum = z.number().finite().nullable().optional();

const FeatureSchema = z.object({
  type: z.literal('Feature'),
  id: z.string().min(1).max(64),
  geometry: z.object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).rest(z.number().nullable()),
  }),
  properties: z.object({
    mag: z.number().finite().nullable(),
    place: z.string().nullable().optional(),
    time: z.number().int(),
    updated: z.number().int(),
    url: z.string().nullable().optional(),
    detail: z.string().nullable().optional(),
    felt: nullableNum,
    cdi: nullableNum,
    mmi: nullableNum,
    alert: z.enum(['green', 'yellow', 'orange', 'red']).nullable().optional(),
    status: z.string(),
    tsunami: z.number().int().nullable().optional(),
    sig: nullableNum,
    ids: z.string().nullable().optional(),
    magType: z.string().nullable().optional(),
    type: z.string().optional(),
    title: z.string().nullable().optional(),
  }),
});

const FeedSchema = z.object({
  type: z.literal('FeatureCollection'),
  metadata: z.object({ generated: z.number().int(), title: z.string().optional(), count: z.number().int().optional() }),
  features: z.array(z.unknown()),
});

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Parse one GeoJSON Feature from a USGS feed or FDSN query. Rejects events without a magnitude. */
export function parseUsgsFeature(raw: unknown): ParseResult<SeismicEvent> {
  const f = FeatureSchema.safeParse(raw);
  if (!f.success) return { ok: false, error: f.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const { id, geometry, properties: p } = f.data;
  if (p.mag === null) return { ok: false, error: `${id}: no magnitude` };
  if (p.type !== undefined && p.type !== 'earthquake') return { ok: false, error: `${id}: type ${p.type} is not an earthquake` };
  const [lon, lat, depth] = geometry.coordinates;
  const aliases = (p.ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== id);
  return {
    ok: true,
    value: {
      id,
      aliases: [...new Set(aliases)].sort(),
      time: p.time,
      updated: p.updated,
      epicentre: { lat, lon },
      depthKm: typeof depth === 'number' ? depth : null,
      mag: p.mag,
      magType: p.magType ?? null,
      place: p.place ?? null,
      title: p.title ?? null,
      alert: p.alert ?? null,
      tsunamiZone: p.tsunami === 1,
      sig: p.sig ?? null,
      felt: p.felt ?? null,
      cdi: p.cdi ?? null,
      mmi: p.mmi ?? null,
      status: p.status,
      url: p.url ?? null,
      detailUrl: p.detail ?? null,
    },
  };
}

/** Parse a summary feed. Bad features are reported, not fatal; duplicates keep the latest revision. */
export function parseUsgsFeed(raw: unknown): {
  generatedAt: number;
  events: SeismicEvent[];
  rejected: { id: string | null; error: string }[];
} {
  const feed = FeedSchema.parse(raw);
  const byId = new Map<string, SeismicEvent>();
  const rejected: { id: string | null; error: string }[] = [];
  for (const raw of feed.features) {
    const r = parseUsgsFeature(raw);
    if (!r.ok) {
      const id = raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string' ? raw.id : null;
      rejected.push({ id, error: r.error });
      continue;
    }
    const prev = byId.get(r.value.id);
    if (!prev || r.value.updated > prev.updated) byId.set(r.value.id, r.value);
  }
  return { generatedAt: feed.metadata.generated, events: [...byId.values()].sort((a, b) => b.time - a.time), rejected };
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const USER_AGENT = 'Firstlight/0.1 (disaster-relief hackathon prototype)';

async function getJson(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`USGS ${url} → HTTP ${res.status}`);
  return res.json();
}

export async function fetchUsgsFeed(opts: {
  level: UsgsFeedLevel;
  window: UsgsFeedWindow;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}) {
  const raw = await getJson(usgsFeedUrl(opts.level, opts.window), opts.fetchImpl ?? (fetch as FetchLike), opts.timeoutMs ?? 10_000);
  return parseUsgsFeed(raw);
}

/** Fetch one event (current revision) via the FDSN query service. */
export async function fetchUsgsEvent(eventId: string, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<SeismicEvent> {
  const raw = await getJson(usgsEventUrl(eventId), opts.fetchImpl ?? (fetch as FetchLike), opts.timeoutMs ?? 10_000);
  const r = parseUsgsFeature(raw);
  if (!r.ok) throw new Error(`USGS event ${eventId}: ${r.error}`);
  return r.value;
}

/** The subset the firewall evaluates against. */
export function toFirewallEvent(e: SeismicEvent): FirewallEvent {
  return { id: e.id, aliases: e.aliases, time: e.time, epicentre: e.epicentre, mag: e.mag, alert: e.alert };
}
