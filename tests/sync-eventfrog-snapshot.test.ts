// @vitest-environment node
/**
 * Eventfrog Public API → private snapshot (owner decision D5, AGB v1.28 §17).
 *
 * Fixtures follow the Public API v1 spec (publicapi-v1 bundle.yaml): `title`
 * is a language map, `begin`/`end` ISO date-times, `lowestTicketPrice` a bare
 * number without currency, locations fetched by id. Dates are relative to the
 * test run (no absolute dates).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRequestPacer,
  eventfrogPrice,
  fetchEventsInCircle,
  mapEventfrogEvent,
  MAX_REQUESTS_PER_RUN,
  MIN_REQUEST_GAP_MS,
  zurichParts,
} from '../scripts/lib/eventfrog.mjs';
import { daysUntilKeyExpiry, isAllowedLocalOut, run } from '../scripts/sync-eventfrog-snapshot.mjs';

const ROOT = path.resolve(__dirname, '..');
const API_KEY = 'efk_test_0123456789abcdef_secret';

function isoInDays(days: number, time = '19:30:00'): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T${time}+02:00`;
}

// Lugano (TI), and Roveredo (GR, Misox): inside the 50 km circle around
// Bellinzona but not in Ticino, so the canton filter must reject it.
const LUGANO = { lat: 46.0037, lng: 8.9511 };
const ROVEREDO_GR = { lat: 46.2367, lng: 9.1236 };

function location(id: string, geo: { lat: number; lng: number }, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: { it: 'Palazzo dei Congressi', de: 'Kongresspalast' },
    url: `https://eventfrog.ch/de/l/${id}`,
    descriptionAsHTML: { de: '<p>Ein Ort</p>' },
    img: { url: 'https://img.eventfrog.net/location.jpg' },
    addressLine: 'Piazza Indipendenza 4',
    country: 'CH',
    zip: '6900',
    city: 'Lugano',
    lat: geo.lat,
    lng: geo.lng,
    modifyDate: isoInDays(-3),
    ...extra,
  };
}

function apiEvent(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    groupId: '0',
    rubricId: 5,
    title: { it: `Concerto d'autunno ${id}`, de: `Herbstkonzert ${id}` },
    url: `https://eventfrog.ch/de/p/event-${id}`,
    organizerId: '555',
    organizerName: 'Associazione Musica',
    presaleLink: `https://tickets.eventfrog.ch/event/${id}`,
    emblemToShow: { url: 'https://img.eventfrog.net/emblem.jpg', width: 800, height: 600 },
    emblemCredits: 'Foto: qualcuno',
    begin: isoInDays(5),
    end: isoInDays(5, '22:00:00'),
    cancelled: false,
    visible: true,
    published: true,
    agendaEntryOnly: false,
    littleTicketsLeft: false,
    soldOut: false,
    lowestTicketPrice: 25.5,
    locationIds: ['L1'],
    modifyDate: isoInDays(-1),
    shortDescription: { it: 'Un concerto meraviglioso con artisti straordinari' },
    descriptionAsHTML: { it: '<p>Un <strong>concerto</strong> meraviglioso</p>' },
    ...extra,
  };
}

const LOCATIONS = new Map([
  ['L1', location('L1', LUGANO)],
  ['L2', location('L2', ROVEREDO_GR, { city: 'Roveredo', zip: '6535' })],
]);

/** A fake Public API: `events` per call, locations by id, request log. */
function fakeApi(eventsPerCall: Array<Array<Record<string, unknown>>>, opts: { status?: number; total?: number; locations?: typeof LOCATIONS } = {}) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  let call = 0;
  const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    if (opts.status) return new Response('{"title":"nope"}', { status: opts.status });
    const u = new URL(url);
    if (u.pathname === '/public/v1/events') {
      const events = eventsPerCall[Math.min(call, eventsPerCall.length - 1)];
      call += 1;
      return Response.json({ totalNumberOfResources: opts.total ?? events.length, events });
    }
    if (u.pathname === '/public/v1/locations') {
      const ids = u.searchParams.getAll('id');
      const locations = ids.map((id) => (opts.locations ?? LOCATIONS).get(id)).filter(Boolean);
      return Response.json({ totalNumberOfResources: locations.length, locations });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function memoryStore() {
  const writes: any[] = [];
  return {
    writes,
    store: {
      read: async () => writes.at(-1) ?? null,
      write: async (doc: any) => {
        writes.push(JSON.parse(JSON.stringify(doc)));
      },
    },
  };
}

const ENABLED = { EVENTFROG_ENABLED: 'true', EVENTFROG_PUBLIC_API_KEY: API_KEY };
const noSleep = async () => {};

describe('mapEventfrogEvent', () => {
  it('keeps titles exactly as returned, per language, and stores no description or image', () => {
    const event = apiEvent('101');
    const mapped = mapEventfrogEvent(event, LOCATIONS);
    expect(mapped.skip).toBeUndefined();
    const record = mapped.record!;
    expect(record.id).toBe('eventfrog:101');
    expect(record.sourceKey).toBe('eventfrog');
    expect(record.ephemeral).toBe(true);
    expect(record.title).toBe("Concerto d'autunno 101");
    expect(record.titleByLocale).toEqual({ it: "Concerto d'autunno 101", de: 'Herbstkonzert 101' });
    expect(record.canton).toBe('TI');
    expect(record.comune).toBe('Lugano');
    // Only the format changes: the Europe/Zurich wall clock of `begin`.
    expect(record.startTime).toBe(zurichParts(event.begin)!.time);
    expect(record.startDate).toBe(zurichParts(event.begin)!.date);
    expect(record.geo).toEqual(LUGANO);
    expect(record.organizer).toEqual({ '@type': 'Organization', name: 'Associazione Musica' });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('concerto meraviglioso');
    expect(serialized).not.toContain('<strong>');
    expect(serialized).not.toContain('img.eventfrog.net');
    expect(record).not.toHaveProperty('description');
    expect(record).not.toHaveProperty('descriptionByLocale');
    expect(record).not.toHaveProperty('imageUrl');
  });

  it('never invents a language: a German-only event keeps its German title in every locale fallback', () => {
    const record = mapEventfrogEvent(apiEvent('102', { title: { de: 'Nur Deutsch' } }), LOCATIONS).record!;
    expect(record.title).toBe('Nur Deutsch');
    expect(record.titleByLocale).toEqual({ de: 'Nur Deutsch' });
  });

  it('drops cancelled, hidden, unpublished, location-less and out-of-canton events', () => {
    expect(mapEventfrogEvent(apiEvent('1', { cancelled: true }), LOCATIONS).skip).toBe('cancelled');
    expect(mapEventfrogEvent(apiEvent('2', { visible: false }), LOCATIONS).skip).toBe('hidden');
    expect(mapEventfrogEvent(apiEvent('3', { published: false }), LOCATIONS).skip).toBe('hidden');
    expect(mapEventfrogEvent(apiEvent('4', { locationIds: ['missing'] }), LOCATIONS).skip).toBe('no-location');
    expect(mapEventfrogEvent(apiEvent('5', { locationIds: ['L2'] }), LOCATIONS).skip).toBe('outside-canton');
  });
});

describe('eventfrogPrice (fonte nel dato, quattro condizioni)', () => {
  const ch = { country: 'CH' };
  it('is stamped with source and field when all four conditions hold', () => {
    expect(eventfrogPrice(apiEvent('1'), ch)).toEqual({
      amount: 25.5,
      currency: 'CHF',
      isFree: false,
      priceSource: 'eventfrog',
      priceField: 'lowestTicketPrice',
      currencySource: 'location.country',
    });
  });
  it('is absent when any condition fails', () => {
    expect(eventfrogPrice(apiEvent('1'), { country: 'IT' })).toBeUndefined();
    expect(eventfrogPrice(apiEvent('1', { agendaEntryOnly: true }), ch)).toBeUndefined();
    expect(eventfrogPrice(apiEvent('1', { cancelled: true }), ch)).toBeUndefined();
    expect(eventfrogPrice(apiEvent('1', { lowestTicketPrice: 0 }), ch)).toBeUndefined();
    expect(eventfrogPrice(apiEvent('1', { lowestTicketPrice: null }), ch)).toBeUndefined();
  });
});

describe('request pacing and budget (30/min, 2000/day per account)', () => {
  it('waits at least MIN_REQUEST_GAP_MS between requests and stops at the per-run cap', async () => {
    let clock = 0;
    const waits: number[] = [];
    const pacer = createRequestPacer({
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      maxRequests: 3,
    });
    await pacer.take();
    await pacer.take();
    await pacer.take();
    expect(waits).toEqual([MIN_REQUEST_GAP_MS, MIN_REQUEST_GAP_MS]);
    await expect(pacer.take()).rejects.toThrow(/budget exhausted/);
    expect(MIN_REQUEST_GAP_MS).toBeGreaterThanOrEqual(2000);
    expect(MAX_REQUESTS_PER_RUN).toBeLessThan(2000);
  });

  it('refuses a listing whose pages do not add up to the declared total', async () => {
    const { fetchImpl } = fakeApi([[apiEvent('1')], []], { total: 5 });
    const pacer = createRequestPacer({ sleep: noSleep });
    await expect(fetchEventsInCircle({ apiKey: API_KEY, fetchImpl, pacer })).rejects.toThrow(/incomplete listing/);
  });
});

describe('sync run()', () => {
  it('is a no-op with a notice when the Remote Config switch is off or the key is missing', async () => {
    const lines: string[] = [];
    const { fetchImpl, calls } = fakeApi([[apiEvent('1')]]);
    const off = await run({ env: { EVENTFROG_PUBLIC_API_KEY: API_KEY }, fetchImpl, log: (l) => lines.push(l), argv: [] });
    expect(off).toMatchObject({ status: 'disabled', exitCode: 0 });
    const noKey = await run({ env: { EVENTFROG_ENABLED: 'true' }, fetchImpl, log: (l) => lines.push(l), argv: [] });
    expect(noKey).toMatchObject({ status: 'no-key', exitCode: 0 });
    expect(lines.every((l) => l.startsWith('::notice::'))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('authenticates with a Bearer header, never with the deprecated query key', async () => {
    const { fetchImpl, calls } = fakeApi([[apiEvent('1')]]);
    const { store } = memoryStore();
    await run({ env: ENABLED, fetchImpl, store, sleep: noSleep, log: () => {}, argv: [] });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.auth).toBe(`Bearer ${API_KEY}`);
      expect(call.url).not.toContain('apiKey');
      expect(call.url).not.toContain(API_KEY);
    }
  });

  it('replaces the snapshot: an event the API stops returning is gone from the next one', async () => {
    const { store, writes } = memoryStore();
    const first = fakeApi([[apiEvent('1'), apiEvent('2')]]);
    await run({ env: ENABLED, fetchImpl: first.fetchImpl, store, sleep: noSleep, log: () => {}, argv: [] });
    const second = fakeApi([[apiEvent('2')]]);
    const outcome = await run({ env: ENABLED, fetchImpl: second.fetchImpl, store, sleep: noSleep, log: () => {}, argv: [] });
    expect(outcome).toMatchObject({ status: 'written', exitCode: 0 });
    expect(writes[0].events.map((e: { id: string }) => e.id)).toEqual(['eventfrog:1', 'eventfrog:2']);
    expect(writes[1].events.map((e: { id: string }) => e.id)).toEqual(['eventfrog:2']);
  });

  it('keeps the previous snapshot and exits 1 on an API error, without printing the key', async () => {
    const lines: string[] = [];
    const { store, writes } = memoryStore();
    const { fetchImpl } = fakeApi([[]], { status: 401 });
    const outcome = await run({ env: ENABLED, fetchImpl, store, sleep: noSleep, log: (l) => lines.push(l), argv: [] });
    expect(outcome).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(writes).toHaveLength(0);
    expect(lines.join('\n')).not.toContain(API_KEY);
    expect(lines.join('\n')).toContain('HTTP 401');
  });

  it('keeps the previous snapshot and exits 1 when a location batch is incomplete', async () => {
    const { store, writes } = memoryStore();
    const previous = { schemaVersion: 1, source: 'eventfrog', events: [{ id: 'eventfrog:previous' }] };
    await store.write(previous);
    const partialLocations = new Map([['a', location('a', LUGANO)]]);
    const { fetchImpl } = fakeApi(
      [[apiEvent('partial', { locationIds: ['a', 'b'] })]],
      { locations: partialLocations },
    );

    const outcome = await run({ env: ENABLED, fetchImpl, store, sleep: noSleep, log: () => {}, argv: [] });

    expect(outcome).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(writes).toEqual([previous]);
  });

  it('logs counts only: no title, venue or organizer reaches the (public) Actions log', async () => {
    const lines: string[] = [];
    const { fetchImpl } = fakeApi([[apiEvent('1'), apiEvent('2', { locationIds: ['L2'] })]]);
    const { store } = memoryStore();
    await run({ env: ENABLED, fetchImpl, store, sleep: noSleep, log: (l) => lines.push(l), argv: [] });
    const log = lines.join('\n');
    expect(log).toMatch(/\[eventfrog\] snapshot TI: 1 events/);
    expect(log).not.toContain('Concerto');
    expect(log).not.toContain('Palazzo');
    expect(log).not.toContain('Associazione');
    expect(log).not.toContain(API_KEY);
  });

  it('warns 14 days before the key expires', async () => {
    expect(daysUntilKeyExpiry('2000-01-01')).toBeLessThan(0);
    expect(daysUntilKeyExpiry('not-a-date')).toBeNull();
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const lines: string[] = [];
    const { fetchImpl } = fakeApi([[apiEvent('1')]]);
    const { store } = memoryStore();
    await run({
      env: { ...ENABLED, EVENTFROG_PUBLIC_API_KEY_EXPIRES_AT: soon },
      fetchImpl,
      store,
      sleep: noSleep,
      log: (l) => lines.push(l),
      argv: [],
    });
    expect(lines.some((l) => l.startsWith('::warning::') && l.includes('expires'))).toBe(true);
  });
});

describe('the snapshot never lands in a tracked path', () => {
  it('accepts --out only under .cache/private-events/ or the OS temp dir', () => {
    expect(isAllowedLocalOut(path.join(ROOT, '.cache', 'private-events', 'x.json'))).toBe(true);
    expect(isAllowedLocalOut(path.join(os.tmpdir(), 'x.json'))).toBe(true);
    expect(isAllowedLocalOut(path.join(ROOT, 'data', 'events', 'by-source', 'eventfrog.json'))).toBe(false);
    expect(isAllowedLocalOut(path.join(ROOT, 'data', 'events.json'))).toBe(false);
    expect(isAllowedLocalOut(path.join(ROOT, 'public', 'data', 'events.json'))).toBe(false);
  });

  it('refuses a tracked --out target before calling the API', async () => {
    const { fetchImpl, calls } = fakeApi([[apiEvent('1')]]);
    const target = path.join(ROOT, 'data', 'events', 'by-source', 'eventfrog.json');
    const outcome = await run({ env: ENABLED, fetchImpl, sleep: noSleep, log: () => {}, argv: ['--out', target] });
    expect(outcome).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('writes a local --out snapshot into the temp dir only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventfrog-out-'));
    const out = path.join(dir, 'snap.json');
    const { fetchImpl } = fakeApi([[apiEvent('1')]]);
    const outcome = await run({ env: ENABLED, fetchImpl, sleep: noSleep, log: () => {}, argv: ['--out', out] });
    expect(outcome.status).toBe('written');
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(doc.source).toBe('eventfrog');
    expect(doc.events.map((e: { id: string }) => e.id)).toEqual(['eventfrog:1']);
  });

  it('the Eventfrog modules neither write slices nor call a translator or an LLM', () => {
    for (const rel of ['scripts/lib/eventfrog.mjs', 'scripts/sync-eventfrog-snapshot.mjs', 'scripts/lib/private-event-snapshots.mjs']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src, rel).not.toMatch(/mergeEventsIntoSlice|EVENTS_SLICE_DIR|EVENTS_DATASET_PATH|writeSlice/);
      expect(src, rel).not.toMatch(/free-translate|freeTranslate|ai-models|translateWith|enrichEventsWithLocaleFallbackTranslations/);
      expect(src, rel).not.toMatch(/mirrorEventImage|descriptionAsHTML\s*[:=]|shortDescription\s*[:=]/);
    }
  });
});
