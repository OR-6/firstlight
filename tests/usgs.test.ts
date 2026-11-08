import { describe, expect, it } from 'vitest';
import { openDb } from '../src/ledger/db';
import { EventStore, classifyIncoming } from '../src/signals/event-store';
import {
  fetchUsgsEvent,
  fetchUsgsFeed,
  parseUsgsFeature,
  parseUsgsFeed,
  usgsEventUrl,
  usgsFeedUrl,
  type SeismicEvent,
} from '../src/signals/usgs';
import feed from '../fixtures/events/usgs-significant_month-2026-11-08.json' with { type: 'json' };
import panama from '../fixtures/events/us6000u18k.fdsn.json' with { type: 'json' };

// Fixtures are real USGS responses captured on 2026-11-08.

const parsed = (raw: unknown): SeismicEvent => {
  const r = parseUsgsFeature(raw);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('USGS URLs', () => {
  it('builds summary feed URLs', () => {
    expect(usgsFeedUrl('significant', 'month')).toBe(
      'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson',
    );
  });
  it('builds FDSN event URLs and rejects injection in ids', () => {
    expect(usgsEventUrl('us6000u18k')).toBe('https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=us6000u18k&format=geojson');
    expect(() => usgsEventUrl('us6000u18k&format=xml')).toThrow();
    expect(() => usgsEventUrl('../../etc')).toThrow();
  });
});

describe('USGS parsing (real data)', () => {
  it('parses the captured significant-month feed', () => {
    const r = parseUsgsFeed(feed);
    expect(r.rejected).toEqual([]);
    expect(r.events).toHaveLength(14);
    const panamaFromFeed = r.events.find((e) => e.id === 'us6000u18k');
    expect(panamaFromFeed).toMatchObject({ mag: 7.7, alert: 'orange', status: 'reviewed', aliases: ['pt26282000'] });
    expect(panamaFromFeed?.epicentre).toEqual({ lat: 7.6069, lon: -80.7566 });
  });

  it('parses an FDSN event-detail response and collects alias ids', () => {
    const e = parsed(panama);
    expect(e.id).toBe('us6000u18k');
    expect(e.aliases).toEqual(['pt26282000', 'usauto6000u18k']);
    expect(e.time).toBe(1791568565537);
  });

  type Row = { name: string; mutate: (f: any) => void; ok: boolean; check?: (e: SeismicEvent) => void };
  const rows: Row[] = [
    { name: 'null PAGER alert is kept as null', mutate: (f) => (f.properties.alert = null), ok: true, check: (e) => expect(e.alert).toBeNull() },
    { name: 'tsunami=1 means notification zone', mutate: (f) => (f.properties.tsunami = 1), ok: true, check: (e) => expect(e.tsunamiZone).toBe(true) },
    { name: 'missing depth is null', mutate: (f) => (f.geometry.coordinates = f.geometry.coordinates.slice(0, 2)), ok: true, check: (e) => expect(e.depthKm).toBeNull() },
    { name: 'null magnitude is rejected', mutate: (f) => (f.properties.mag = null), ok: false },
    { name: 'non-earthquake (quarry blast) is rejected', mutate: (f) => (f.properties.type = 'quarry blast'), ok: false },
    { name: 'unknown PAGER colour is rejected', mutate: (f) => (f.properties.alert = 'purple'), ok: false },
    { name: 'latitude out of range is rejected', mutate: (f) => (f.geometry.coordinates[1] = 91), ok: false },
    { name: 'string magnitude is rejected', mutate: (f) => (f.properties.mag = '7.7'), ok: false },
  ];
  it.each(rows)('$name', ({ mutate, ok, check }) => {
    const f = structuredClone(panama);
    mutate(f);
    const r = parseUsgsFeature(f);
    expect(r.ok).toBe(ok);
    if (r.ok && check) check(r.value);
  });

  it('a bad feature in a feed is reported, not fatal; duplicates keep the newest revision', () => {
    const f = structuredClone(feed) as any;
    const dup = structuredClone(f.features[0]);
    dup.properties.updated += 1000;
    dup.properties.mag = 6.5;
    f.features.push(dup, { type: 'Feature', id: 'junk', geometry: null, properties: {} });
    const r = parseUsgsFeed(f);
    expect(r.rejected.map((x) => x.id)).toEqual(['junk']);
    expect(r.events.find((e) => e.id === dup.id)?.mag).toBe(6.5);
  });

  it('fetches through an injected fetch (no network in tests)', async () => {
    const calls: string[] = [];
    const fake = async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => (url.includes('eventid') ? panama : feed) };
    };
    expect((await fetchUsgsFeed({ level: 'significant', window: 'month', fetchImpl: fake })).events).toHaveLength(14);
    expect((await fetchUsgsEvent('us6000u18k', { fetchImpl: fake })).mag).toBe(7.7);
    expect(calls).toHaveLength(2);
    const failing = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await expect(fetchUsgsEvent('us6000u18k', { fetchImpl: failing })).rejects.toThrow(/503/);
  });
});

describe('event store: dedupe and revisions', () => {
  it.each([
    [undefined, 5, 'inserted'],
    [{ updated: 5 }, 6, 'revised'],
    [{ updated: 5 }, 5, 'unchanged'],
    [{ updated: 5 }, 4, 'stale'],
  ] as const)('classifyIncoming(%o, updated=%d) → %s', (existing, updated, action) => {
    expect(classifyIncoming(existing, { updated })).toBe(action);
  });

  it('inserts, ignores identical copies, revises on newer `updated`, ignores stale', () => {
    const store = new EventStore(openDb());
    const e = parsed(panama);
    expect(store.upsert(e)).toEqual({ action: 'inserted', id: e.id, revision: 1 });
    expect(store.upsert(e)).toEqual({ action: 'unchanged', id: e.id, revision: 1 });
    expect(store.upsert({ ...e, updated: e.updated + 1, mag: 7.6 })).toEqual({ action: 'revised', id: e.id, revision: 2 });
    expect(store.upsert({ ...e, updated: e.updated - 1, mag: 9.9 })).toEqual({ action: 'stale', id: e.id, revision: 2 });
    expect(store.get(e.id)?.mag).toBe(7.6);
    expect(store.list()).toHaveLength(1);
  });

  it('the same quake under an alias id maps onto the stored event', () => {
    const store = new EventStore(openDb());
    const feedCopy = parseUsgsFeed(feed).events.find((x) => x.id === 'us6000u18k')!;
    store.upsert(feedCopy);
    // Same event reported by the PTWC contributor under its own id.
    const ptwc: SeismicEvent = { ...feedCopy, id: 'pt26282000', aliases: ['us6000u18k'], updated: feedCopy.updated + 5 };
    expect(store.upsert(ptwc)).toEqual({ action: 'revised', id: 'us6000u18k', revision: 2 });
    expect(store.list()).toHaveLength(1);
    expect(store.get('pt26282000')?.id).toBe('us6000u18k');
    // FDSN detail adds a third alias; it is learned even though the copy isn't newer.
    store.upsert({ ...parsed(panama), updated: 0 });
    expect(store.get('usauto6000u18k')?.aliases).toEqual(['pt26282000', 'usauto6000u18k']);
  });
});
