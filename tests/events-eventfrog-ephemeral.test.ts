// @vitest-environment node
/**
 * Lifecycle of the Eventfrog pages (AGB §17(5)): live while the source returns
 * the event and the snapshot is fresh; afterwards no page, no archive, no slug
 * bridge, no sitemap entry. Public event URLs never move because of them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assignLiveEventSlugs,
  digestEligibleEvents,
  DIGESTS,
  partitionEventsForBuild,
} from '../build-plugins/eventsSeoPagesPlugin';
import {
  buildSnapshot,
  isEventfrogEnabled,
  loadEphemeralEvents,
  selectEphemeralEvents,
  SNAPSHOT_MAX_AGE_HOURS,
} from '../scripts/lib/private-event-snapshots.mjs';
import { slugifyEvent } from '../scripts/lib/events-utils.mjs';

function dayOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
const TODAY = dayOffset(0);

function publicEvent(id: string, title: string, startDate: string, comune = 'Lugano', extra: Record<string, unknown> = {}) {
  return { id: `tio-agenda:${id}`, title, startDate, comune, canton: 'TI', url: 'https://www.tio.ch/agenda', sourceKey: 'tio-agenda', sourceName: 'Tio.ch Agenda', ...extra };
}

function frogEvent(id: string, title: string, startDate: string, comune = 'Lugano', extra: Record<string, unknown> = {}) {
  return {
    id: `eventfrog:${id}`,
    title,
    startDate,
    comune,
    canton: 'TI',
    url: `https://eventfrog.ch/de/p/event-${id}`,
    sourceKey: 'eventfrog',
    sourceName: 'Eventfrog',
    ephemeral: true,
    ...extra,
  };
}

function writeSnapshot(events: unknown[], fetchedAtMs: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventfrog-snap-'));
  const file = path.join(dir, 'eventfrog-ti.json');
  fs.writeFileSync(file, JSON.stringify(buildSnapshot({ events, fetchedAt: new Date(fetchedAtMs).toISOString(), counts: {} })));
  return file;
}

const ON = { EVENTFROG_ENABLED: 'true' };
const LONG_TITLE = 'Rassegna internazionale di musica da camera, corale e sinfonica della Svizzera italiana con ospiti da tutta Europa';

describe('the Remote Config switch', () => {
  it('is on only for the exact value true (default off)', () => {
    expect(isEventfrogEnabled({})).toBe(false);
    expect(isEventfrogEnabled({ EVENTFROG_ENABLED: 'false' })).toBe(false);
    expect(isEventfrogEnabled({ EVENTFROG_ENABLED: '1' })).toBe(false);
    expect(isEventfrogEnabled({ EVENTFROG_ENABLED: 'true' })).toBe(true);
  });

  it('off → no ephemeral page even with a fresh snapshot on disk', () => {
    const file = writeSnapshot([frogEvent('1', 'Jazz al lago', dayOffset(3))], Date.now());
    expect(loadEphemeralEvents({ publicEvents: [], dateStamp: TODAY, env: {}, file })).toEqual([]);
    expect(loadEphemeralEvents({ publicEvents: [], dateStamp: TODAY, env: ON, file })).toHaveLength(1);
  });
});

describe('freshness (aggiornamento giornaliero)', () => {
  it(`a snapshot older than ${SNAPSHOT_MAX_AGE_HOURS} h publishes nothing`, () => {
    const stale = writeSnapshot([frogEvent('1', 'Jazz al lago', dayOffset(3))], Date.now() - (SNAPSHOT_MAX_AGE_HOURS + 1) * 3_600_000);
    expect(loadEphemeralEvents({ publicEvents: [], dateStamp: TODAY, env: ON, file: stale })).toEqual([]);
    expect(SNAPSHOT_MAX_AGE_HOURS).toBeLessThanOrEqual(36);
  });

  it('a missing or malformed snapshot publishes nothing', () => {
    expect(loadEphemeralEvents({ publicEvents: [], dateStamp: TODAY, env: ON, file: path.join(os.tmpdir(), 'nope-eventfrog.json') })).toEqual([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventfrog-bad-'));
    const bad = path.join(dir, 'x.json');
    fs.writeFileSync(bad, '{"schemaVersion":1,"source":"other","events":[]}');
    expect(loadEphemeralEvents({ publicEvents: [], dateStamp: TODAY, env: ON, file: bad })).toEqual([]);
  });
});

describe('selectEphemeralEvents', () => {
  it('drops ended events, public duplicates (title+date+comune) and public slug collisions, past included', () => {
    const publicEvents = [
      publicEvent('1', 'Festa di San Martino', dayOffset(4)),
      publicEvent('2', `${LONG_TITLE} — prima parte`, dayOffset(-30)), // past, archived
    ];
    const { events, counts } = selectEphemeralEvents({
      publicEvents,
      dateStamp: TODAY,
      snapshotEvents: [
        frogEvent('a', 'Festa di San Martino', dayOffset(4)), // same event as tio → tio keeps the page
        frogEvent('b', 'Concerto', dayOffset(-2)), // already ended
        // Not the same event (the titles differ past the slug's length budget),
        // but its detail slug would be the archived public page's URL.
        frogEvent('c', `${LONG_TITLE} — seconda parte`, dayOffset(-30), 'Lugano', { endDate: dayOffset(2) }),
        frogEvent('d', 'Jazz al lago', dayOffset(6)),
        publicEvent('9', 'Not private', dayOffset(6)), // not a private record: ignored
      ],
    });
    expect(events.map((e) => e.id)).toEqual(['eventfrog:d']);
    expect(counts).toMatchObject({ duplicates: 1, slugCollisions: 1 });
  });

  it('drops an ephemeral event whose slug is claimed by a public historical route', () => {
    const candidate = frogEvent('history-collision', 'Jazz al lago', dayOffset(6));
    const publicEvents = [
      publicEvent('history', 'Old public title', dayOffset(8), 'Lugano', {
        previousRoutes: [{ canton: 'TI', comune: 'Lugano', slug: slugifyEvent(candidate) }],
      }),
    ];

    const result = selectEphemeralEvents({
      publicEvents,
      dateStamp: TODAY,
      snapshotEvents: [candidate],
    });

    expect(result.events).toEqual([]);
    expect(result.counts).toMatchObject({ slugCollisions: 1 });
  });

  it('keeps one deterministic event when two private records share a detail slug', () => {
    const first = frogEvent('slug-b', LONG_TITLE, dayOffset(7));
    const second = frogEvent('slug-a', LONG_TITLE, dayOffset(7));
    const forward = selectEphemeralEvents({
      publicEvents: [],
      dateStamp: TODAY,
      snapshotEvents: [first, second],
    });
    const reverse = selectEphemeralEvents({
      publicEvents: [],
      dateStamp: TODAY,
      snapshotEvents: [second, first],
    });

    expect(forward.counts).toMatchObject({ slugCollisions: 1 });
    expect(forward.events).toHaveLength(1);
    expect(forward.events[0].id).toBe('eventfrog:slug-a');
    expect(reverse.events.map((event) => event.id)).toEqual(forward.events.map((event) => event.id));
  });
});

describe('partitionEventsForBuild', () => {
  const publicEvents = [publicEvent('1', 'Festa', dayOffset(4)), publicEvent('2', 'Sagra', dayOffset(-10))];

  it('lists a live ephemeral event, never archives it, never puts it in a digest', () => {
    const live = frogEvent('d', 'Jazz al lago', dayOffset(1));
    const { all, pastEvents } = partitionEventsForBuild(publicEvents as any, [live] as any, TODAY);
    expect(all.map((e) => e.id)).toContain('eventfrog:d');
    expect(pastEvents.map((e) => e.id)).not.toContain('eventfrog:d');
    expect(digestEligibleEvents(all).map((e) => e.id)).not.toContain('eventfrog:d');
    for (const def of DIGESTS) {
      expect(def.filter(digestEligibleEvents(all), { todayIso: TODAY }).map((e) => e.id)).not.toContain('eventfrog:d');
    }
  });

  // closeBundle() derives every detail page, slug bridge and sitemap entry from
  // `all` (live) and `pastEvents` (archive) only: absent from both = no URL.
  it('once ended: no live page, no archive page (hence no bridge and no sitemap entry)', () => {
    const ended = frogEvent('e', 'Jazz al lago', dayOffset(-2));
    const { all, pastEvents } = partitionEventsForBuild(publicEvents as any, [ended] as any, TODAY);
    expect(all.map((e) => e.id)).not.toContain('eventfrog:e');
    expect(pastEvents.map((e) => e.id)).not.toContain('eventfrog:e');
    expect(pastEvents.map((e) => e.id)).toContain('tio-agenda:2');
  });

  it('a private record that sneaked into the public dataset is neither listed nor archived', () => {
    const leaked = frogEvent('x', 'Leak', dayOffset(-5));
    const { all, pastEvents } = partitionEventsForBuild([...publicEvents, leaked] as any, [], TODAY);
    expect([...all, ...pastEvents].map((e) => e.id)).not.toContain('eventfrog:x');
  });
});

describe('assignLiveEventSlugs', () => {
  it('public slugs are byte-identical with or without ephemeral events in the same comune', () => {
    const pub = [publicEvent('1', 'Concerto', dayOffset(3)), publicEvent('2', 'Concerto', dayOffset(3))];
    const eph = [frogEvent('a', 'Concerto', dayOffset(3)), frogEvent('b', 'Altro', dayOffset(3))];
    const alone = assignLiveEventSlugs(pub as any);
    const mixed = assignLiveEventSlugs([eph[0], ...pub, eph[1]] as any);
    for (const ev of pub) expect(mixed.get(ev.id)).toBe(alone.get(ev.id));
    const publicSlugs = new Set(pub.map((ev) => alone.get(ev.id)));
    expect(publicSlugs.has(mixed.get('eventfrog:a')!)).toBe(false);
    expect(new Set(mixed.values()).size).toBe(mixed.size);
  });
});
