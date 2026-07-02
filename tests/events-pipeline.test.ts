/**
 * Pipeline guard for the per-comune Ticino events feature (issue #2963):
 * crawler parser → comune resolution → dataset shaping → Event JSON-LD.
 *
 * This is the CI gate the crawl-events workflow runs BEFORE committing
 * data/events.json to main, so a malformed agenda parse can never poison the
 * dataset / turn main red (AGENTS.md: data-refresh = same gate as a PR).
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseDayHtml, warnIfLowConfidenceComuneShare, mirrorEventImages } from '../scripts/crawl-tio-agenda.mjs';
import {
  resolveComune,
  slugifyComune,
  isoFromCompactDate,
  eventStableId,
  upcomingEvents,
  groupByComune,
  loadCantonComuni,
} from '../scripts/lib/events-utils.mjs';
import { eventLd, zurichOffset } from '../build-plugins/eventsSeoPagesPlugin';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal tio.ch /agenda/day fixture: one date-picker card (must be ignored),
// one region-resolved event (Luganese → Lugano) and one exact-match event
// (venue contains "Bellinzona").
const DAY_HTML = `
<div class="agenda-event">
  <a href="/agenda/day/20260704" class="stretched-link"><div class="card dayCard"><span class="dayText">Saturday</span></div></a>
</div>
<div class="agenda-event">
  <a href="/agenda/day/20260704/62100" class="stretched-link">
    <div class="card mb-3">
      <img src="https://biglietteria.ch/flyer.jpg" class="card-img-top" width="450" height="200">
      <div class="card-body">
        <p class="card-text d-flex justify-content-between"><small class="text-muted">Sabato 04</small> <small class="text-muted">07.30</small></p>
        <p class="card-text d-flex justify-content-between"><small class="text-muted"><span class="category-color background_agenda_arte"></span>Arte</small> <small class="text-muted">Luganese</small></p>
        <h5 class="card-title">Quando delle opere d'arte rimangono solo le foto</h5>
        <p class="card-text description"> Canvetto luganese </p>
      </div>
    </div>
  </a>
</div>
<div class="agenda-event">
  <a href="/agenda/day/20260704/62101" class="stretched-link">
    <div class="card mb-3">
      <div class="card-body">
        <p class="card-text d-flex justify-content-between"><small class="text-muted">Sabato 04</small> <small class="text-muted">20.00</small></p>
        <p class="card-text d-flex justify-content-between"><small class="text-muted"><span class="category-color background_agenda_musica"></span>Musica</small> <small class="text-muted">Bellinzonese</small></p>
        <h5 class="card-title">Concerto sinfonico</h5>
        <p class="card-text description">Teatro Sociale Bellinzona</p>
      </div>
    </div>
  </a>
</div>`;

describe('parseDayHtml (tio.ch agenda card parser)', () => {
  const events = parseDayHtml(DAY_HTML, '20260704');

  it('ignores date-picker cards and keeps only real events', () => {
    expect(events).toHaveLength(2);
    expect(events.every((e: { url: string }) => /\/agenda\/day\/\d+\/\d+/.test(e.url))).toBe(true);
  });

  it('extracts title, date, time, category, venue and image', () => {
    const e = events[0];
    expect(e.title).toBe("Quando delle opere d'arte rimangono solo le foto");
    expect(e.startDate).toBe('2026-07-04');
    expect(e.startTime).toBe('07:30');
    expect(e.category).toBe('arte');
    expect(e.venue).toBe('Canvetto luganese');
    expect(e.imageUrl).toContain('biglietteria.ch');
    expect(e.url).toBe('https://www.tio.ch/agenda/day/20260704/62100');
    expect(e.id).toBe('tio-agenda:62100');
    expect(e.canton).toBe('TI');
  });

  it('resolves comune by region adjective (Luganese → Lugano)', () => {
    expect(events[0].comune).toBe('Lugano');
    expect(events[0].comuneMatch).toBe('region');
  });

  it('resolves comune by exact venue match (Teatro Sociale Bellinzona → Bellinzona)', () => {
    expect(events[1].comune).toBe('Bellinzona');
    expect(events[1].comuneMatch).toBe('exact');
  });
});

describe('mirrorEventImages (issue #3036 item 3 — tio-agenda no-hotlink policy)', () => {
  // No live network / CDN upload in tests: mirrorFn is injected exactly for
  // this, per the task's "do not trigger a live crawl or live CDN upload" rule.
  it('replaces each raw flyer URL with the mirrored site-relative path the mirror function returns', async () => {
    const events = [
      { id: 'tio-agenda:1', imageUrl: 'https://biglietteria.ch/flyer1.jpg' },
      { id: 'tio-agenda:2', imageUrl: 'https://biglietteria.ch/flyer2.jpg' },
    ];
    const fakeMirror = async (url, id) => `/images/events/${id.replace(':', '-')}.jpg`;
    const out = await mirrorEventImages(events, fakeMirror);
    expect(out[0].imageUrl).toBe('/images/events/tio-agenda-1.jpg');
    expect(out[1].imageUrl).toBe('/images/events/tio-agenda-2.jpg');
    // Non-mutating: source array untouched.
    expect(events[0].imageUrl).toBe('https://biglietteria.ch/flyer1.jpg');
  });

  it('drops imageUrl (never falls back to the raw URL) when the event had none to start with', async () => {
    const events = [{ id: 'tio-agenda:3', imageUrl: '' }, { id: 'tio-agenda:4' }];
    const fakeMirror = async (url) => (url ? '/images/events/mirrored.jpg' : null);
    const out = await mirrorEventImages(events, fakeMirror);
    expect(out[0].imageUrl).toBeUndefined();
    expect(out[1].imageUrl).toBeUndefined();
  });

  it('drops imageUrl (never leaves the raw external URL) when mirroring fails', async () => {
    const events = [{ id: 'tio-agenda:5', imageUrl: 'https://biglietteria.ch/flyer5.jpg' }];
    const failingMirror = async () => null;
    const out = await mirrorEventImages(events, failingMirror);
    // undefined, not the raw biglietteria.ch URL — never hotlinked as a fallback.
    expect(out[0].imageUrl).toBeUndefined();
  });
});

describe('events-utils helpers', () => {
  it('resolveComune: exact > region > none', () => {
    expect(resolveComune({ venue: 'Palazzo dei Congressi Lugano', title: '', region: '' }).comune).toBe('Lugano');
    expect(resolveComune({ venue: 'Palazzo dei Congressi Lugano', title: '', region: '' }).method).toBe('exact');
    expect(resolveComune({ venue: '', title: '', region: 'Mendrisiotto' })).toEqual({ comune: 'Mendrisio', method: 'region' });
    expect(resolveComune({ venue: 'Posto ignoto', title: 'Evento', region: 'Boh' })).toEqual({ comune: null, method: null });
  });

  it('resolveComune: longer comune name wins over a shorter substring', () => {
    // "Riva San Vitale" must win over "Riviera" for a Riva San Vitale venue.
    expect(resolveComune({ venue: 'Centro Riva San Vitale', title: '', region: '' }).comune).toBe('Riva San Vitale');
  });

  it('resolveComune: ambiguous multi-candidate match still resolves (longest wins) but warns (#3036 item 4)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Venue text names two comuni — the card parses fine but which one it
    // "belongs to" is genuinely uncertain; must not fail silently.
    const r = resolveComune({ venue: 'Tour itinerante Lugano e Bellinzona', title: '', region: '' });
    expect(r).toEqual({ comune: 'Bellinzona', method: 'exact' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/uncertain match/);
    expect(warnSpy.mock.calls[0][0]).toMatch(/Lugano/);
    warnSpy.mockRestore();
  });

  it('resolveComune: unambiguous match does not warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveComune({ venue: 'Palazzo dei Congressi Lugano', title: '', region: '' });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('warnIfLowConfidenceComuneShare: warns when region fallback dominates a large-enough sample (#3036 item 4)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnIfLowConfidenceComuneShare({ exact: 3, region: 12 }, 15)).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/low-confidence comune attribution/);
    warnSpy.mockRestore();
  });

  it('warnIfLowConfidenceComuneShare: stays silent below the sample floor or the ratio threshold', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // High ratio but too few resolved events to be meaningful.
    expect(warnIfLowConfidenceComuneShare({ exact: 0, region: 5 }, 5)).toBe(false);
    // Enough sample, but region share below the warn threshold.
    expect(warnIfLowConfidenceComuneShare({ exact: 8, region: 4 }, 12)).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('slugifyComune is ascii, lowercase, hyphenated', () => {
    expect(slugifyComune('Riva San Vitale')).toBe('riva-san-vitale');
    expect(slugifyComune("Sant'Antonino")).toBe('santantonino');
    expect(slugifyComune('Bosco/Gurin')).toBe('bosco-gurin');
  });

  it('isoFromCompactDate + eventStableId', () => {
    expect(isoFromCompactDate('20260704')).toBe('2026-07-04');
    expect(isoFromCompactDate('bad')).toBe('');
    expect(eventStableId('tio-agenda', '62100')).toBe('tio-agenda:62100');
  });

  it('upcomingEvents prunes past and sorts ascending', () => {
    const sample = [
      { startDate: '2026-07-10', title: 'B', comune: 'Lugano' },
      { startDate: '2020-01-01', title: 'Old', comune: 'Lugano' },
      { startDate: '2026-07-10', title: 'A', comune: 'Locarno' },
    ];
    const out = upcomingEvents(sample, '2026-07-01');
    expect(out.map((e: { title: string }) => e.title)).toEqual(['A', 'B']);
  });

  it('upcomingEvents breaks ties on id so slug-collision suffix is stable across crawl insertion order', () => {
    // Two events with identical title+date: slug base is the same, so the
    // collision suffix (-2) is assigned by iteration order. The id tiebreaker
    // pins which event comes first regardless of dataset insertion order.
    const evA = { id: 'tio-agenda:100', startDate: '2026-08-01', title: 'Sagra', comune: 'Lugano' };
    const evB = { id: 'tio-agenda:200', startDate: '2026-08-01', title: 'Sagra', comune: 'Lugano' };
    // Dataset order A,B → A comes first
    expect(upcomingEvents([evA, evB], '2026-07-01').map((e: { id: string }) => e.id)).toEqual(['tio-agenda:100', 'tio-agenda:200']);
    // Dataset order B,A (future crawl inserts B before A) → still A first (id sort wins)
    expect(upcomingEvents([evB, evA], '2026-07-01').map((e: { id: string }) => e.id)).toEqual(['tio-agenda:100', 'tio-agenda:200']);
  });

  it('groupByComune drops events without a comune', () => {
    const g = groupByComune([
      { comune: 'Lugano', title: 'x' },
      { comune: undefined, title: 'y' },
      { comune: 'Lugano', title: 'z' },
    ]);
    expect(g.get('Lugano')).toHaveLength(2);
    expect(g.has('undefined')).toBe(false);
  });

  it('loadCantonComuni returns the 100 Ticino comuni', () => {
    const comuni = loadCantonComuni('TI');
    expect(comuni).toContain('Lugano');
    expect(comuni).toContain('Stabio');
    expect(comuni.length).toBeGreaterThanOrEqual(90);
  });
});

describe('eventLd — schema.org/Event completeness gate', () => {
  const REQUIRED = (ld: Record<string, any>) => {
    expect(ld['@type']).toBe('Event');
    expect(ld.name).toBeTruthy();
    expect(ld.startDate).toBeTruthy();
    expect(ld.endDate).toBeTruthy();
    expect(ld.eventStatus).toBe('https://schema.org/EventScheduled');
    expect(ld.eventAttendanceMode).toBe('https://schema.org/OfflineEventAttendanceMode');
    expect(ld.location?.address?.addressLocality).toBeTruthy();
    expect(String(ld.description).length).toBeGreaterThanOrEqual(30);
    expect(ld.image).toBeTruthy();
    expect(ld.organizer?.name).toBeTruthy();
    expect(ld.organizer?.url).toBeTruthy();
    expect(ld.performer?.name).toBeTruthy();
    // offers is intentionally OMITTED (price unknown → no false "free" claim).
    expect(ld.offers).toBeUndefined();
    // endDate must never precede startDate (Google Rich Results validity).
    expect(String(ld.endDate) >= String(ld.startDate)).toBe(true);
  };

  it('emits every Google-required Event field for a full event', () => {
    REQUIRED(
      eventLd(
        {
          id: 'tio-agenda:1',
          title: 'Concerto sinfonico',
          startDate: '2026-07-04',
          startTime: '20:00',
          category: 'musica',
          venue: 'Teatro Sociale Bellinzona',
          comune: 'Bellinzona',
          canton: 'TI',
          url: 'https://www.tio.ch/agenda/day/20260704/62101',
          sourceKey: 'tio-agenda',
          sourceName: 'Tio.ch Agenda',
        },
        'it',
      ),
    );
  });

  it('single-day timed event: endDate equals startDate datetime, CEST offset in summer', () => {
    const ld = eventLd(
      {
        id: 'tio-agenda:3',
        title: 'Concerto estivo',
        startDate: '2026-07-04',
        startTime: '20:00',
        canton: 'TI',
        url: 'https://www.tio.ch/agenda/day/20260704/62103',
        sourceKey: 'tio-agenda',
        sourceName: 'Tio.ch Agenda',
      },
      'it',
    ) as Record<string, any>;
    // July → CEST (+02:00), not the winter +01:00.
    expect(ld.startDate).toBe('2026-07-04T20:00:00+02:00');
    expect(ld.endDate).toBe(ld.startDate);
  });

  it('multi-day event keeps a distinct later endDate', () => {
    const ld = eventLd(
      {
        id: 'tio-agenda:4',
        title: 'Mostra',
        startDate: '2026-07-04',
        endDate: '2026-07-10',
        startTime: '10:00',
        canton: 'TI',
        url: 'https://www.tio.ch/agenda/day/20260704/62104',
        sourceKey: 'tio-agenda',
        sourceName: 'Tio.ch Agenda',
      },
      'it',
    ) as Record<string, any>;
    expect(ld.endDate).toBe('2026-07-10');
    expect(String(ld.endDate) >= String(ld.startDate)).toBe(true);
  });

  it('zurichOffset stays correct when ICU lacks Europe/Zurich (small-icu build)', () => {
    // Simulate a `small-icu` Node build: constructing a DateTimeFormat for a
    // non-UTC zone throws RangeError. Without the defensive fallback the offset
    // would collapse to a fixed +01:00 and shift summer JSON-LD times by an hour.
    const RealDTF = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function () {
      throw new RangeError('Invalid time zone specified: Europe/Zurich');
    } as unknown as typeof Intl.DateTimeFormat;
    try {
      expect(zurichOffset('2026-07-04')).toBe('+02:00'); // CEST (summer)
      expect(zurichOffset('2026-01-15')).toBe('+01:00'); // CET (winter)
      // DST boundaries: last Sun March (29) → CEST, last Sun October (25) → CET.
      expect(zurichOffset('2026-03-29')).toBe('+02:00');
      expect(zurichOffset('2026-10-25')).toBe('+01:00');
      expect(zurichOffset('2026-03-28')).toBe('+01:00');
    } finally {
      Intl.DateTimeFormat = RealDTF;
    }
  });

  it('winter event uses CET offset (+01:00)', () => {
    const ld = eventLd(
      {
        id: 'tio-agenda:5',
        title: 'Concerto invernale',
        startDate: '2026-01-15',
        startTime: '20:00',
        canton: 'TI',
        url: 'https://www.tio.ch/agenda/day/20260115/62105',
        sourceKey: 'tio-agenda',
        sourceName: 'Tio.ch Agenda',
      },
      'it',
    ) as Record<string, any>;
    expect(ld.startDate).toBe('2026-01-15T20:00:00+01:00');
  });

  it('stays complete for a minimal event (no venue/time/comune)', () => {
    REQUIRED(
      eventLd(
        {
          id: 'tio-agenda:2',
          title: 'X',
          startDate: '2026-07-04',
          canton: 'TI',
          url: 'https://www.tio.ch/agenda/day/20260704/62102',
          sourceKey: 'tio-agenda',
          sourceName: 'Tio.ch Agenda',
        },
        'en',
      ),
    );
  });
});

describe('assembled dataset integrity (data/events.json)', () => {
  it('every committed event has the required base shape and ISO dates', () => {
    const file = path.join(REPO_ROOT, 'data', 'events.json');
    if (!existsSync(file)) return; // dataset is CI-generated; absent locally is fine
    const ds = JSON.parse(readFileSync(file, 'utf-8'));
    expect(Array.isArray(ds.events)).toBe(true);
    for (const e of ds.events) {
      expect(typeof e.id).toBe('string');
      expect(e.id.length).toBeGreaterThan(0);
      expect(typeof e.title).toBe('string');
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (e.endDate) expect(e.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.canton).toBe('TI');
    }
  });
});
