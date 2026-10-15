import { describe, expect, it } from 'vitest';
import {
  resolveNearbyEventMatch,
  toNearbyEventLink,
  renderNearbyEventsBlock,
  nearbyEventsBlockForJobPage,
  type NearbyEventSourceEvent,
} from '../build-plugins/shared/jobEventsCrosslink';

// Issue #3646 (epic #3125) — reverse lavoro -> evento crosslink, the one
// item PR #3696 declared open. Fixture events use no absolute dates (the
// matcher itself is date-agnostic; date filtering happens upstream via
// `upcomingEvents`, already covered by events-utils tests) — AGENTS.md
// "test fixture: mai date assolute" applies to stale-prune windows, not to
// this matcher, but we still avoid literal dates here on principle.
const FIXTURE_EVENTS: NearbyEventSourceEvent[] = [
  { comune: 'Lugano', canton: 'TI' },
  { comune: 'Bellinzona', canton: 'TI' },
  { comune: 'Zurich', canton: 'ZH' },
];

describe('resolveNearbyEventMatch', () => {
  it('matches at comune level when the comune itself has an event', () => {
    const match = resolveNearbyEventMatch(FIXTURE_EVENTS, 'TI', 'Lugano');
    expect(match).toEqual({ kind: 'comune', comune: 'Lugano', canton: 'TI' });
  });

  it('matches diacritics/case-insensitively (normalizeText)', () => {
    const match = resolveNearbyEventMatch(FIXTURE_EVENTS, 'ti', 'lugano');
    expect(match).toEqual({ kind: 'comune', comune: 'Lugano', canton: 'TI' });
  });

  it('falls back to canton level when the comune has no event but the canton does (Chiasso real-data case: 0 events, TI has 137)', () => {
    const match = resolveNearbyEventMatch(FIXTURE_EVENTS, 'TI', 'Chiasso');
    expect(match).toEqual({ kind: 'canton', canton: 'TI' });
  });

  it('returns null when the canton itself has no upcoming event at all', () => {
    const match = resolveNearbyEventMatch(FIXTURE_EVENTS, 'GE', 'Geneve');
    expect(match).toBeNull();
  });

  it('returns null for an empty/blank canton', () => {
    expect(resolveNearbyEventMatch(FIXTURE_EVENTS, '', 'Lugano')).toBeNull();
  });
});

describe('toNearbyEventLink', () => {
  it('returns null when there is no match (never renders a dead link)', () => {
    expect(toNearbyEventLink(null, 'it', 'Ticino')).toBeNull();
  });

  it('builds a comune-scoped href + localized label per locale', () => {
    const match = resolveNearbyEventMatch(FIXTURE_EVENTS, 'TI', 'Lugano');
    const it = toNearbyEventLink(match, 'it', 'Ticino');
    const en = toNearbyEventLink(match, 'en', 'Ticino');
    const de = toNearbyEventLink(match, 'de', 'Ticino');
    const fr = toNearbyEventLink(match, 'fr', 'Ticino');

    expect(it).toEqual({ href: '/eventi/ticino/lugano/', label: 'Scopri gli eventi a Lugano' });
    expect(en).toEqual({ href: '/en/events/ticino/lugano/', label: 'See events in Lugano' });
    expect(de).toEqual({
      href: '/de/veranstaltungen/tessin/lugano/',
      label: 'Veranstaltungen in Lugano entdecken',
    });
    expect(fr).toEqual({
      href: '/fr/evenements/tessin/lugano/',
      label: 'Découvrir les événements à Lugano',
    });
  });

  it('builds a canton-hub href + localized label when falling back', () => {
    const match = resolveNearbyEventMatch(FIXTURE_EVENTS, 'TI', 'Chiasso');
    const link = toNearbyEventLink(match, 'it', 'Ticino');
    expect(link).toEqual({ href: '/eventi/ticino/', label: 'Scopri gli eventi in Ticino' });
  });
});

describe('renderNearbyEventsBlock', () => {
  it('renders nothing (empty string) when there is no matching event — no empty/dead section', () => {
    const html = renderNearbyEventsBlock(FIXTURE_EVENTS, 'it', 'GE', 'Geneve', 'Ginevra');
    expect(html).toBe('');
  });

  it('renders a section with heading + link when a comune match exists', () => {
    const html = renderNearbyEventsBlock(FIXTURE_EVENTS, 'it', 'TI', 'Lugano', 'Ticino');
    expect(html).toContain('Eventi vicino a te');
    expect(html).toContain('/eventi/ticino/lugano/');
    expect(html).toContain('Scopri gli eventi a Lugano');
    expect(html.startsWith('<section')).toBe(true);
  });

  it('escapes comune names that contain HTML-sensitive characters', () => {
    const evilEvents: NearbyEventSourceEvent[] = [{ comune: '<b>Evil</b>', canton: 'XX' }];
    const html = renderNearbyEventsBlock(evilEvents, 'it', 'XX', '<b>Evil</b>', '<b>Evil</b>');
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
  });
});

describe('nearbyEventsBlockForJobPage (production cached wrapper, real dataset smoke test)', () => {
  it('returns a string without throwing for a canton/comune with no real events (e.g. a made-up one)', () => {
    const html = nearbyEventsBlockForJobPage('it', 'ZZ', 'Nowhere', 'Nowhere');
    expect(typeof html).toBe('string');
    expect(html).toBe('');
  });

  it('does not throw for a real canton code + comune combination (dataset is live/mutable, so no content assertion — only wiring is under test here, matching logic is covered by the pure-function tests above)', () => {
    const html = nearbyEventsBlockForJobPage('it', 'TI', 'ThisComuneDoesNotExist', 'Ticino');
    expect(typeof html).toBe('string');
  });
});
