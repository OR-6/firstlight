import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { corroborationFrom, type CorroborationReport } from './corroboration';
import { usgsTextsFromDetail, type UntrustedText } from './untrusted';
import { parseUsgsFeature, type SeismicEvent } from './usgs';

/**
 * Replay mode (SPEC §9): real past events, served from saved copies of the
 * real USGS and EMSC responses in /fixtures/events.
 */
const ManifestSchema = z.record(
  z.string(),
  z.object({ title: z.string(), usgs: z.string(), emsc: z.string().nullable() }),
);

export type ReplayBundle = {
  event: SeismicEvent;
  corroboration: CorroborationReport;
  untrusted: UntrustedText[];
};

export class ReplayEventNotFound extends Error {
  constructor(readonly eventId: string) {
    super(`no replay fixture for ${eventId}`);
    this.name = 'ReplayEventNotFound';
  }
}

export function listReplayEvents(dir = 'fixtures/events'): { id: string; title: string }[] {
  const m = ManifestSchema.parse(JSON.parse(readFileSync(join(dir, 'replay.json'), 'utf8')));
  return Object.entries(m).map(([id, v]) => ({ id, title: v.title }));
}

export function loadReplayEvent(eventId: string, dir = 'fixtures/events'): ReplayBundle {
  const m = ManifestSchema.parse(JSON.parse(readFileSync(join(dir, 'replay.json'), 'utf8')));
  const entry = Object.hasOwn(m, eventId) ? m[eventId] : undefined;
  if (!entry) throw new ReplayEventNotFound(eventId);
  const detail = JSON.parse(readFileSync(join(/*turbopackIgnore: true*/ dir, entry.usgs), 'utf8')) as unknown;
  const parsed = parseUsgsFeature(detail);
  if (!parsed.ok) throw new Error(`replay fixture ${entry.usgs}: ${parsed.error}`);
  const emsc = entry.emsc ? (JSON.parse(readFileSync(join(/*turbopackIgnore: true*/ dir, entry.emsc), 'utf8')) as unknown) : null;
  return {
    event: parsed.value,
    corroboration: corroborationFrom(parsed.value, emsc),
    untrusted: usgsTextsFromDetail(detail),
  };
}
