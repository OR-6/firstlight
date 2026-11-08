import { canonicalJson } from '../lib/canonical';
import type { Db } from '../ledger/db';
import type { SeismicEvent } from './usgs';

export type UpsertAction = 'inserted' | 'revised' | 'unchanged' | 'stale';

/**
 * Pure: what to do with an incoming observation of an event we may already
 * know. A newer `updated` is a revision (new plan version later — never a
 * second payout; R6 handles that). An older one is a stale replay.
 */
export function classifyIncoming(existing: { updated: number } | undefined, incoming: { updated: number }): UpsertAction {
  if (!existing) return 'inserted';
  if (incoming.updated > existing.updated) return 'revised';
  if (incoming.updated === existing.updated) return 'unchanged';
  return 'stale';
}

type Row = { id: string; aliases: string; updated_ms: number; revision: number; raw: string };

/**
 * De-duplicates on event id AND on USGS alias ids, so the same quake arriving
 * from a different contributing network maps onto one stored event.
 */
export class EventStore {
  constructor(private readonly db: Db) {}

  /** Find a stored event by its id or any alias it (or the incoming event) carries. */
  private findCanonical(e: Pick<SeismicEvent, 'id' | 'aliases'>): Row | undefined {
    const ids = [e.id, ...e.aliases];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT id, aliases, updated_ms, revision, raw FROM events
         WHERE id IN (${placeholders})
            OR EXISTS (SELECT 1 FROM json_each(events.aliases) WHERE value IN (${placeholders}))
         ORDER BY time_ms LIMIT 1`,
      )
      .get(...ids, ...ids) as Row | undefined;
  }

  upsert(e: SeismicEvent): { action: UpsertAction; id: string; revision: number } {
    const tx = this.db.transaction(() => {
      const existing = this.findCanonical(e);
      const action = classifyIncoming(existing ? { updated: existing.updated_ms } : undefined, e);
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO events (id, aliases, time_ms, updated_ms, lat, lon, depth_km, mag, alert, status, revision, raw)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          )
          .run(e.id, JSON.stringify(e.aliases), e.time, e.updated, e.epicentre.lat, e.epicentre.lon, e.depthKm, e.mag, e.alert, e.status, canonicalJson(e));
        return { action, id: e.id, revision: 1 };
      }
      const canonicalId = existing.id;
      const knownAliases = new Set<string>([...(JSON.parse(existing.aliases) as string[]), ...e.aliases]);
      if (e.id !== canonicalId) knownAliases.add(e.id);
      knownAliases.delete(canonicalId);
      const aliases = [...knownAliases].sort();
      if (action !== 'revised') {
        // Still learn new aliases from a non-newer copy; never overwrite other data with it.
        const kept: SeismicEvent = { ...(JSON.parse(existing.raw) as SeismicEvent), aliases };
        this.db
          .prepare('UPDATE events SET aliases = ?, raw = ? WHERE id = ?')
          .run(JSON.stringify(aliases), canonicalJson(kept), canonicalId);
        return { action, id: canonicalId, revision: existing.revision };
      }
      const revised: SeismicEvent = { ...e, id: canonicalId, aliases };
      const revision = existing.revision + 1;
      this.db
        .prepare(
          `UPDATE events SET aliases = ?, time_ms = ?, updated_ms = ?, lat = ?, lon = ?, depth_km = ?, mag = ?, alert = ?,
             status = ?, revision = ?, raw = ? WHERE id = ?`,
        )
        .run(JSON.stringify(aliases), e.time, e.updated, e.epicentre.lat, e.epicentre.lon, e.depthKm, e.mag, e.alert, e.status, revision, canonicalJson(revised), canonicalId);
      return { action, id: canonicalId, revision };
    });
    return tx.immediate();
  }

  get(idOrAlias: string): (SeismicEvent & { revision: number }) | undefined {
    const row = this.findCanonical({ id: idOrAlias, aliases: [] });
    if (!row) return undefined;
    return { ...(JSON.parse(row.raw) as SeismicEvent), revision: row.revision };
  }

  list(): (SeismicEvent & { revision: number })[] {
    const rows = this.db.prepare('SELECT raw, revision FROM events ORDER BY time_ms DESC').all() as { raw: string; revision: number }[];
    return rows.map((r) => ({ ...(JSON.parse(r.raw) as SeismicEvent), revision: r.revision }));
  }
}
