/**
 * Pipeline guard for the per-comune Ticino events feature (issue #2963):
 * crawler parser → comune resolution → dataset shaping → Event JSON-LD.
 *
 * This is the CI gate the crawl-events workflow runs BEFORE committing
 * data/events.json to main, so a malformed agenda parse can never poison the
 * dataset / turn main red (AGENTS.md: data-refresh = same gate as a PR).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseDayHtml,
  warnIfLowConfidenceComuneShare,
  mirrorEventImages,
  extractTioPrice,
  enrichEventsWithPrice,
  enrichEventsWithTranslations,
} from '../scripts/crawl-tio-agenda.mjs';
import {
  resolveComune,
  slugifyComune,
  isoFromCompactDate,
  eventStableId,
  upcomingEvents,
  recentlyEndedEvents,
  groupByComune,
  loadCantonComuni,
} from '../scripts/lib/events-utils.mjs';
import { pruneFailedImageRefs } from '../scripts/push-mirrored-event-images-cdn.mjs';
import { eventLd, zurichOffset } from '../build-plugins/eventsSeoPagesPlugin';
import { CANTON_CODES } from '../services/cantonList';

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

  it('recentlyEndedEvents keeps only events ended within the grace window, excludes still-ongoing/future/too-old', () => {
    // F4 (#3646): short noindex,follow bridge window for events that already
    // ended — must never overlap `upcomingEvents`'s set (mutually exclusive
    // by construction: `end < today` vs `end >= today`).
    const events = [
      { id: 'a', startDate: '2026-06-30', endDate: '2026-06-30', title: 'Ended yesterday', comune: 'Lugano' },
      { id: 'b', startDate: '2026-06-20', endDate: '2026-06-20', title: 'Ended 11 days ago', comune: 'Lugano' },
      { id: 'c', startDate: '2026-06-01', endDate: '2026-06-01', title: 'Ended way outside grace window', comune: 'Lugano' },
      { id: 'd', startDate: '2026-07-01', title: 'Still today/ongoing (no endDate)', comune: 'Lugano' },
      { id: 'e', startDate: '2026-06-29', endDate: '2026-07-02', title: 'Multi-day, still ongoing', comune: 'Lugano' },
      { id: 'f', startDate: '2026-07-10', title: 'Future', comune: 'Lugano' },
    ];
    const today = '2026-07-01';
    const past = recentlyEndedEvents(events, today, 14);
    expect(past.map((e: { id: string }) => e.id)).toEqual(['a', 'b']);
    // Complementary partition: no id appears in both sets.
    const upcoming = upcomingEvents(events, today).map((e: { id: string }) => e.id);
    for (const id of past.map((e: { id: string }) => e.id)) {
      expect(upcoming).not.toContain(id);
    }
  });

  it('recentlyEndedEvents sorts most-recently-ended first', () => {
    const events = [
      { id: 'older', startDate: '2026-06-20', endDate: '2026-06-20', title: 'Older', comune: 'Lugano' },
      { id: 'newer', startDate: '2026-06-30', endDate: '2026-06-30', title: 'Newer', comune: 'Lugano' },
    ];
    expect(recentlyEndedEvents(events, '2026-07-01').map((e: { id: string }) => e.id)).toEqual(['newer', 'older']);
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

  const baseEvent = {
    id: 'tio-agenda:6',
    title: 'Yoga e Pilates',
    startDate: '2026-07-04',
    canton: 'TI',
    url: 'https://www.tio.ch/agenda/day/20260704/63071',
    sourceKey: 'tio-agenda',
    sourceName: 'Tio.ch Agenda',
  };

  it('emits offers with a real price when event.price has a confident amount', () => {
    const ld = eventLd(
      { ...baseEvent, price: { amount: 19, currency: 'CHF', isFree: false } },
      'it',
      'https://frontaliereticino.ch/eventi/ticino/melide/',
    ) as Record<string, any>;
    expect(ld.offers).toEqual({
      '@type': 'Offer',
      price: '19',
      priceCurrency: 'CHF',
      availability: 'https://schema.org/InStock',
      validFrom: '2026-07-04',
      url: 'https://frontaliereticino.ch/eventi/ticino/melide/',
    });
  });

  it('emits offers with price "0" when event.price is confidently free', () => {
    const ld = eventLd({ ...baseEvent, price: { amount: 0, currency: 'CHF', isFree: true } }, 'it') as Record<string, any>;
    expect(ld.offers?.price).toBe('0');
  });

  it('omits offers (never fabricates "0") when price is present but not machine-parseable', () => {
    // e.g. tio.ch "Prezzo:" label says "su richiesta" / "CHF" with no digits —
    // parsePriceText returns amount: null, isFree: false for this bucket.
    const ld = eventLd({ ...baseEvent, price: { amount: null, currency: 'CHF', isFree: false } }, 'it') as Record<string, any>;
    expect(ld.offers).toBeUndefined();
  });
});

describe('extractTioPrice + enrichEventsWithPrice (offers/JSON-LD gap, tio.ch "Prezzo:" label)', () => {
  it('parses a real "N CHF" price off a detail page', () => {
    const html = '<div><span><strong>Prezzo:</strong> 19 CHF </span></div>';
    expect(extractTioPrice(html)).toEqual({ amount: 19, currency: 'CHF', isFree: false });
  });

  it('returns undefined when the label is present but empty (tio.ch has no price on file)', () => {
    const html = '<span class="d-none"> <strong>Prezzo:</strong></span>';
    expect(extractTioPrice(html)).toBeUndefined();
  });

  it('returns undefined when the label is missing entirely (unexpected page shape)', () => {
    expect(extractTioPrice('<div>no price label here</div>')).toBeUndefined();
    expect(extractTioPrice('')).toBeUndefined();
  });

  it('enrichEventsWithPrice attaches price from the injected fetch, never mutates the source array', async () => {
    const events = [
      { id: 'tio-agenda:63071', url: 'https://www.tio.ch/agenda/day/20260704/63071' },
      { id: 'tio-agenda:63038', url: 'https://www.tio.ch/agenda/day/20260703/63038' },
    ];
    const fakeFetch = async (url: string) =>
      url.endsWith('63071') ? '<strong>Prezzo:</strong> 19 CHF' : '<span class="d-none"><strong>Prezzo:</strong></span>';
    const out = await enrichEventsWithPrice(events, fakeFetch);
    expect(out[0].price).toEqual({ amount: 19, currency: 'CHF', isFree: false });
    expect(out[1].price).toBeUndefined();
    expect(events[0].price).toBeUndefined(); // non-mutating
  });

  it('enrichEventsWithPrice leaves price unset on fetch failure (soft-fail, never fabricates)', async () => {
    const events = [{ id: 'tio-agenda:1', url: 'https://www.tio.ch/agenda/day/20260704/1' }];
    const failingFetch = async () => null;
    const out = await enrichEventsWithPrice(events, failingFetch);
    expect(out[0].price).toBeUndefined();
  });
});

describe('enrichEventsWithTranslations — partial cache re-validation (#3427)', () => {
  const events = [{ title: 'Concerto sinfonico', id: 'tio-agenda:1' }];
  const fakeTranslate = async ({ targetLang }: { targetLang: string }) => `Translated-${targetLang}`;

  it('re-translates a partial cache entry that is missing locales (the #3427 bug)', async () => {
    // Pre-existing entry has only 'en' — 'de' and 'fr' are absent (partial).
    const cache: Record<string, Record<string, string>> = { 'concerto sinfonico': { en: 'Old-en' } };
    const out = await enrichEventsWithTranslations(events, cache, fakeTranslate);
    // Must contain all three locales after re-translation.
    expect(out[0].titleByLocale).toMatchObject({ it: 'Concerto sinfonico', en: 'Translated-en', de: 'Translated-de', fr: 'Translated-fr' });
    // Cache entry must be updated with the full set.
    expect(Object.keys(cache['concerto sinfonico'])).toHaveLength(3);
  });

  it('skips re-translation when cache entry is already complete', async () => {
    const cache: Record<string, Record<string, string>> = { 'concerto sinfonico': { en: 'Good-en', de: 'Good-de', fr: 'Good-fr' } };
    const noopTranslate = vi.fn();
    const out = await enrichEventsWithTranslations(events, cache, noopTranslate);
    expect(noopTranslate).not.toHaveBeenCalled();
    expect(out[0].titleByLocale?.en).toBe('Good-en');
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
      // Nationwide sources (guidle, myswitzerland — #3125) resolve events to
      // any of the 26 cantons, not just TI; assert membership in the same
      // canton list the job board uses instead of the pre-#3125 TI-only check.
      // '' is also valid: myswitzerland.com leaves canton blank when
      // resolveComuneNationwide finds no confident comune match (event shown
      // on the canton hub only — crawl-myswitzerland-events.mjs:370/413/505).
      expect(e.canton === '' || CANTON_CODES.includes(e.canton)).toBe(true);
    }
  });
});

// ── #6163: un upload CDN fallito deve ripulire ANCHE il dataset ─────────────
//
// Ordine di crawl-events.yml: assemble → gate → push CDN → commit. Quando il
// push arriva, l'evento la cui immagine fallisce e' gia' dentro le slice e
// dentro events.json con `imageUrl: "/images/events/<id>.<ext>"`. Potare solo
// il manifest committerebbe quel riferimento verso una chiave CDN che fa 404 —
// e niente lo riparerebbe: le immagini non sono piu' in git, quindi il
// ri-push idempotente del deploy da `public/images/<dir>` non esiste piu', e
// il crawl di domani ri-mirrora l'immagine ma non riscrive un evento gia'
// emesso.
describe('pruneFailedImageRefs (#6163 — dataset e manifest si potano insieme)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'events-prune-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, doc: unknown) => {
    const file = path.join(dir, name);
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    return file;
  };

  it('toglie imageUrl solo agli eventi falliti, in ogni file, e lascia il resto intatto', () => {
    const slice = write('tio-agenda.json', {
      sourceKey: 'tio-agenda',
      events: [
        { id: 'tio-agenda:1', title: 'ko', imageUrl: '/images/events/tio-agenda-1.webp' },
        { id: 'tio-agenda:2', title: 'ok', imageUrl: '/images/events/tio-agenda-2.webp' },
        { id: 'tio-agenda:3', title: 'senza immagine' },
      ],
    });
    const dataset = write('events.json', {
      schemaVersion: 1,
      events: [
        { id: 'tio-agenda:1', title: 'ko', imageUrl: '/images/events/tio-agenda-1.webp' },
        { id: 'tio-agenda:2', title: 'ok', imageUrl: '/images/events/tio-agenda-2.webp' },
      ],
    });

    const cleaned = pruneFailedImageRefs(['tio-agenda-1.webp'], [slice, dataset]);

    expect(cleaned.map((c) => c.count)).toEqual([1, 1]);
    for (const file of [slice, dataset]) {
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      expect(doc.events[0]).not.toHaveProperty('imageUrl');
      // L'evento resta pubblicato: perde la foto, non la riga.
      expect(doc.events[0].title).toBe('ko');
      expect(doc.events[1].imageUrl).toBe('/images/events/tio-agenda-2.webp');
    }
    // I campi di testa (sourceKey, schemaVersion) sopravvivono alla riscrittura.
    expect(JSON.parse(readFileSync(slice, 'utf8')).sourceKey).toBe('tio-agenda');
  });

  it('l’estensione fa parte del confronto: stesso id, estensione diversa, non si tocca', () => {
    // `mirrorEventImage` costruisce nome file e `imageUrl` dallo stesso safeId
    // + estensione, quindi il confronto e' sull'URL finito e non su un id
    // ri-derivato: e' cio' che impedisce di potare l'immagine sbagliata quando
    // un evento e' stato ri-mirrorato in un formato diverso.
    const f = write('events.json', {
      events: [{ id: 'x', imageUrl: '/images/events/foo.jpg' }],
    });
    expect(pruneFailedImageRefs(['foo.webp'], [f])).toEqual([]);
    expect(JSON.parse(readFileSync(f, 'utf8')).events[0].imageUrl).toBe('/images/events/foo.jpg');
  });

  it('un file assente o malformato viene saltato, e gli altri si potano lo stesso', () => {
    // La copia sotto public/ puo' legittimamente non esistere ancora; rifiutare
    // di potare le altre lascerebbe PIU' riferimenti rotti, non meno.
    const broken = path.join(dir, 'malformed.json');
    writeFileSync(broken, 'not json at all');
    const absent = path.join(dir, 'nope.json');
    const good = write('events.json', {
      events: [{ id: 'x', imageUrl: '/images/events/foo.webp' }],
    });

    const cleaned = pruneFailedImageRefs(['foo.webp'], [absent, broken, good]);

    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].file).toBe(good);
    expect(JSON.parse(readFileSync(good, 'utf8')).events[0]).not.toHaveProperty('imageUrl');
    expect(readFileSync(broken, 'utf8')).toBe('not json at all');
  });

  it('non riscrive niente quando non c’e’ niente da potare', () => {
    const f = write('events.json', { events: [{ id: 'x', imageUrl: '/images/events/ok.webp' }] });
    const before = readFileSync(f, 'utf8');
    expect(pruneFailedImageRefs(['altro.webp'], [f])).toEqual([]);
    expect(readFileSync(f, 'utf8')).toBe(before);
  });

  it('serializza come i writer del dataset: due spazi e newline finale', () => {
    // I file sono committati ogni notte: una serializzazione diversa da quella
    // di crawl-*.mjs / assemble-events-dataset.mjs farebbe un diff di 9 MB per
    // una potatura di un evento.
    const f = write('events.json', {
      events: [
        { id: 'a', imageUrl: '/images/events/ko.webp' },
        { id: 'b', imageUrl: '/images/events/ok.webp' },
      ],
    });
    pruneFailedImageRefs(['ko.webp'], [f]);
    const raw = readFileSync(f, 'utf8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).toBe(
      `${JSON.stringify({ events: [{ id: 'a' }, { id: 'b', imageUrl: '/images/events/ok.webp' }] }, null, 2)}\n`,
    );
  });
});
