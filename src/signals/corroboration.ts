import { z } from 'zod';
import type { CorroborationObservation } from '../firewall/types';
import type { SeismicEvent } from './usgs';

/**
 * Second source (SPEC §5.1). EMSC SeismicPortal FDSN is independent of USGS
 * (verified 2026-11-08). If it is unreachable or silent, fall back to
 * "USGS reviewed + PAGER alert", flagged as NOT independent so the firewall
 * (R8) asks a human, and say so in the report.
 */
export const EMSC_FDSN_BASE = 'https://www.seismicportal.eu/fdsnws/event/1/query';

export type CorroborationReport = {
  mode: 'emsc' | 'fallback' | 'none';
  observations: (CorroborationObservation & { ref: string })[];
  note: string;
};

export function emscQueryUrl(e: SeismicEvent): string {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19);
  const p = new URLSearchParams({
    format: 'json',
    start: iso(e.time - 5 * 60_000),
    end: iso(e.time + 5 * 60_000),
    lat: String(e.epicentre.lat),
    lon: String(e.epicentre.lon),
    maxradius: '1',
    minmag: String(Math.max(0, e.mag - 1).toFixed(1)),
    limit: '10',
  });
  return `${EMSC_FDSN_BASE}?${p.toString()}`;
}

const EmscFeature = z.object({
  id: z.string(),
  properties: z.object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    mag: z.number(),
    time: z.string(),
    flynn_region: z.string().optional(),
  }),
});

/** Accepts both a FeatureCollection (query) and a single Feature (lookup by id). */
export function parseEmsc(raw: unknown): (CorroborationObservation & { ref: string })[] {
  const features: unknown[] =
    raw && typeof raw === 'object' && 'features' in raw && Array.isArray((raw as { features: unknown }).features)
      ? (raw as { features: unknown[] }).features
      : [raw];
  const out: (CorroborationObservation & { ref: string })[] = [];
  for (const f of features) {
    const r = EmscFeature.safeParse(f);
    if (!r.success) continue;
    const time = Date.parse(r.data.properties.time);
    if (!Number.isFinite(time)) continue;
    out.push({
      source: 'emsc',
      independent: true,
      ref: r.data.id,
      mag: r.data.properties.mag,
      epicentre: { lat: r.data.properties.lat, lon: r.data.properties.lon },
      time,
    });
  }
  return out;
}

export function usgsReviewedFallback(e: SeismicEvent): CorroborationReport {
  if (e.status === 'reviewed' && e.alert !== null) {
    return {
      mode: 'fallback',
      observations: [{ source: 'usgs-reviewed', independent: false, ref: e.id, mag: e.mag, epicentre: e.epicentre, time: e.time }],
      note: 'EMSC unavailable; using USGS reviewed status + PAGER alert. This is NOT an independent source.',
    };
  }
  return { mode: 'none', observations: [], note: 'No second source available and USGS event is not reviewed with a PAGER alert.' };
}

export function corroborationFrom(e: SeismicEvent, emscRaw: unknown): CorroborationReport {
  const obs = parseEmsc(emscRaw);
  if (obs.length > 0) return { mode: 'emsc', observations: obs, note: `EMSC SeismicPortal: ${obs.length} candidate event(s).` };
  return usgsReviewedFallback(e);
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function fetchCorroboration(
  e: SeismicEvent,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<CorroborationReport> {
  try {
    const res = await fetchImpl(emscQueryUrl(e), { signal: AbortSignal.timeout(10_000) });
    // EMSC answers 204 No Content when nothing matches.
    if (res.status === 204) return usgsReviewedFallback(e);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return corroborationFrom(e, await res.json());
  } catch (err) {
    const fb = usgsReviewedFallback(e);
    return { ...fb, note: `EMSC request failed (${(err as Error).message}). ${fb.note}` };
  }
}
