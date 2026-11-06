/**
 * German preposition override regression suite (2026-05-10).
 *
 * Some Swiss cantons take a definite article in German and the URL
 * preposition must reflect that:
 *   - der Aargau   → /de/jobs-im-aargau/
 *   - der Thurgau  → /de/jobs-im-thurgau/
 *   - der Jura     → /de/jobs-im-jura/
 *   - das Wallis   → /de/jobs-im-wallis/
 *   - die Waadt    → /de/jobs-in-der-waadt/
 *
 * Cantons without an article keep the bare `jobs-in-` prefix
 * (jobs-in-zurich, jobs-in-bern, jobs-in-genf, ...).
 *
 * Ticino is special-cased via the legacy `jobs-im-tessin` slug
 * (frozen URL — see {@link JOB_BOARD_PREFIX_LEGACY_DE}).
 *
 * Coverage:
 *   1. getJobBoardSlugForCanton emits the right prefix per canton.
 *   2. parseJobBoardSlug recognises both the override and default forms.
 *   3. Italian / English / French slugs for the same cantons are unchanged.
 *   4. The aggregator slug (`jobs-in-schweiz`) is unaffected.
 */

import { describe, expect, it } from 'vitest';
import { getJobBoardSlugForCanton, parseJobBoardSlug, getAggregatorJobBoardSlug } from '@/services/router';

describe('getJobBoardSlugForCanton — DE dePrefix overrides', () => {
  it.each([
    ['AG', 'jobs-im-aargau'],
    ['TG', 'jobs-im-thurgau'],
    ['JU', 'jobs-im-jura'],
    ['VS', 'jobs-im-wallis'],
    ['VD', 'jobs-in-der-waadt'],
  ])('canton %s emits %s in DE', (code, expected) => {
    expect(getJobBoardSlugForCanton(code, 'de')).toBe(expected);
  });

  it.each([
    ['ZH', 'jobs-in-zurich'],
    ['BE', 'jobs-in-bern'],
    ['GE', 'jobs-in-genf'],
    ['LU', 'jobs-in-luzern'],
    ['SG', 'jobs-in-st-gallen'],
    ['NE', 'jobs-in-neuenburg'],
    ['APPENZELLO', 'jobs-in-appenzell'],
    ['BASILEA', 'jobs-in-basel'],
  ])('canton %s without dePrefix uses default jobs-in- in DE', (code, expected) => {
    expect(getJobBoardSlugForCanton(code, 'de')).toBe(expected);
  });

  it('Ticino keeps legacy jobs-im-tessin form in DE', () => {
    expect(getJobBoardSlugForCanton('TI', 'de')).toBe('jobs-im-tessin');
  });

  it.each([
    ['AG', 'it', 'cerca-lavoro-argovia'],
    ['TG', 'it', 'cerca-lavoro-turgovia'],
    ['JU', 'it', 'cerca-lavoro-giura'],
    ['VS', 'it', 'cerca-lavoro-vallese'],
    ['VD', 'it', 'cerca-lavoro-vaud'],
    ['AG', 'en', 'find-jobs-aargau'],
    ['VS', 'en', 'find-jobs-valais'],
    ['VD', 'fr', 'trouver-emploi-vaud'],
    ['VS', 'fr', 'trouver-emploi-valais'],
  ] as const)('canton %s in locale %s emits %s (no override)', (code, locale, expected) => {
    expect(getJobBoardSlugForCanton(code, locale)).toBe(expected);
  });
});

describe('parseJobBoardSlug — DE dePrefix recognition', () => {
  it.each([
    ['jobs-im-aargau', 'AG'],
    ['jobs-im-thurgau', 'TG'],
    ['jobs-im-jura', 'JU'],
    ['jobs-im-wallis', 'VS'],
    ['jobs-in-der-waadt', 'VD'],
  ])('parses %s → cantonCode %s', (slug, expected) => {
    const result = parseJobBoardSlug(slug, 'de');
    expect(result).toEqual({ cantonCode: expected, isAggregator: false });
  });

  it.each([
    ['jobs-in-zurich', 'ZH'],
    ['jobs-in-bern', 'BE'],
    ['jobs-in-genf', 'GE'],
    ['jobs-in-luzern', 'LU'],
    ['jobs-in-appenzell', 'APPENZELLO'],
    ['jobs-in-basel', 'BASILEA'],
  ])('parses default form %s → cantonCode %s', (slug, expected) => {
    const result = parseJobBoardSlug(slug, 'de');
    expect(result).toEqual({ cantonCode: expected, isAggregator: false });
  });

  it('parses legacy jobs-im-tessin → TI', () => {
    expect(parseJobBoardSlug('jobs-im-tessin', 'de')).toEqual({
      cantonCode: 'TI',
      isAggregator: false,
    });
  });

  it('does not confuse jobs-in-der-waadt with jobs-in-derXXX prefix walk', () => {
    expect(parseJobBoardSlug('jobs-in-der-waadt', 'de')).toEqual({
      cantonCode: 'VD',
      isAggregator: false,
    });
    // The slug walk should NOT silently produce a different cantonCode
    // because `der-waadt` doesn't match any canton.de in the default path.
    expect(parseJobBoardSlug('jobs-in-der-waadtxxx', 'de')).toBeNull();
  });

  it('aggregator slug jobs-in-schweiz still resolves to _AGGREGATE_', () => {
    expect(parseJobBoardSlug('jobs-in-schweiz', 'de')).toEqual({
      cantonCode: '_AGGREGATE_',
      isAggregator: true,
    });
  });

  it('aggregator slug helper round-trips', () => {
    expect(getAggregatorJobBoardSlug('de')).toBe('jobs-in-schweiz');
  });
});

describe('Italian/English/French slugs unaffected by dePrefix', () => {
  it.each([
    ['AG', 'it', 'cerca-lavoro-argovia'],
    ['TG', 'it', 'cerca-lavoro-turgovia'],
    ['JU', 'it', 'cerca-lavoro-giura'],
    ['VS', 'it', 'cerca-lavoro-vallese'],
    ['VD', 'it', 'cerca-lavoro-vaud'],
  ] as const)('IT slug for %s is %s', (code, _locale, expected) => {
    expect(getJobBoardSlugForCanton(code, 'it')).toBe(expected);
  });

  it.each([
    ['AG', 'en', 'find-jobs-aargau'],
    ['TG', 'en', 'find-jobs-thurgau'],
    ['JU', 'en', 'find-jobs-jura'],
    ['VS', 'en', 'find-jobs-valais'],
    ['VD', 'en', 'find-jobs-vaud'],
  ] as const)('EN slug for %s is %s', (code, _locale, expected) => {
    expect(getJobBoardSlugForCanton(code, 'en')).toBe(expected);
  });

  it.each([
    ['AG', 'fr', 'trouver-emploi-argovie'],
    ['TG', 'fr', 'trouver-emploi-thurgovie'],
    ['JU', 'fr', 'trouver-emploi-jura'],
    ['VS', 'fr', 'trouver-emploi-valais'],
    ['VD', 'fr', 'trouver-emploi-vaud'],
  ] as const)('FR slug for %s is %s', (code, _locale, expected) => {
    expect(getJobBoardSlugForCanton(code, 'fr')).toBe(expected);
  });
});
