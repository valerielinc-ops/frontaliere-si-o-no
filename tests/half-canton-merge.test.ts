/**
 * Half-canton URL merge regression suite (2026-05-10).
 *
 * The four Swiss half-cantons collapse onto two virtual URL groups:
 *   - AI + AR → APPENZELLO  (it: appenzello, en/de/fr: appenzell/appenzell/appenzell)
 *   - BL + BS → BASILEA     (it: basilea,    en/de:   basel,   fr: bale)
 *
 * Internal BFS / canton-quorum logic is unchanged: jobs are still tagged
 * with the real BFS code (AI/AR/BL/BS); the URL/shard/landing emission
 * boundary applies `resolveCantonGroup` so per-canton URLs and per-canton
 * shards collapse onto APPENZELLO/BASILEA.
 *
 * Coverage:
 *   1. resolveCantonGroup (.mjs runtime + router.ts twin) returns the
 *      group key for member BFS codes and round-trips other codes.
 *   2. parsePath('/cerca-lavoro-appenzello/') etc. resolves jobBoardCanton
 *      to the URL group key in every locale.
 *   3. buildPath round-trips both real BFS codes (AI/AR/BL/BS) and the
 *      group key onto the merged slug.
 */

import { describe, expect, it } from 'vitest';
import { parsePath, buildPath, getJobBoardSlugForCanton, resolveCantonGroup as resolveCantonGroupTs } from '@/services/router';
import { resolveCantonGroup as resolveCantonGroupMjs, getCantonGroupMembers, getCantonUrlSlug, parseCantonUrlSlug } from '../scripts/lib/canton-url-slugs.mjs';
import { hubSlugFor } from '@/build-plugins/seoHubsData';

type Locale = 'it' | 'en' | 'de' | 'fr';
const ALL_LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'] as const;

describe('resolveCantonGroup (.mjs runtime + router.ts twin)', () => {
  for (const helper of [
    { name: 'mjs', fn: resolveCantonGroupMjs },
    { name: 'router.ts', fn: resolveCantonGroupTs },
  ]) {
    describe(helper.name, () => {
      it('AI → APPENZELLO', () => {
        expect(helper.fn('AI')).toBe('APPENZELLO');
      });
      it('AR → APPENZELLO', () => {
        expect(helper.fn('AR')).toBe('APPENZELLO');
      });
      it('BL → BASILEA', () => {
        expect(helper.fn('BL')).toBe('BASILEA');
      });
      it('BS → BASILEA', () => {
        expect(helper.fn('BS')).toBe('BASILEA');
      });
      it('TI round-trips unchanged', () => {
        expect(helper.fn('TI')).toBe('TI');
      });
      it('ZH round-trips unchanged', () => {
        expect(helper.fn('ZH')).toBe('ZH');
      });
      it('_AGGREGATE_ round-trips unchanged', () => {
        expect(helper.fn('_AGGREGATE_')).toBe('_AGGREGATE_');
      });
      it('lowercase BFS codes are normalised', () => {
        expect(helper.fn('ai')).toBe('APPENZELLO');
        expect(helper.fn('bs')).toBe('BASILEA');
      });
      it('group key is idempotent', () => {
        expect(helper.fn('APPENZELLO')).toBe('APPENZELLO');
        expect(helper.fn('BASILEA')).toBe('BASILEA');
      });
    });
  }
});

describe('getCantonGroupMembers', () => {
  it('APPENZELLO has AI and AR members', () => {
    expect(getCantonGroupMembers('APPENZELLO')).toEqual(['AI', 'AR']);
  });
  it('BASILEA has BL and BS members', () => {
    expect(getCantonGroupMembers('BASILEA')).toEqual(['BL', 'BS']);
  });
  it('non-group code returns []', () => {
    expect(getCantonGroupMembers('TI')).toEqual([]);
    expect(getCantonGroupMembers('_AGGREGATE_')).toEqual([]);
  });
});

describe('getCantonUrlSlug — half-canton group lookup', () => {
  it('APPENZELLO resolves to "appenzello" in IT', () => {
    expect(getCantonUrlSlug('APPENZELLO', 'it')).toBe('appenzello');
  });
  it('APPENZELLO resolves to "appenzell" in EN/DE/FR', () => {
    expect(getCantonUrlSlug('APPENZELLO', 'en')).toBe('appenzell');
    expect(getCantonUrlSlug('APPENZELLO', 'de')).toBe('appenzell');
    expect(getCantonUrlSlug('APPENZELLO', 'fr')).toBe('appenzell');
  });
  it('BASILEA resolves to "basilea" in IT', () => {
    expect(getCantonUrlSlug('BASILEA', 'it')).toBe('basilea');
  });
  it('BASILEA resolves to "basel" in EN/DE and "bale" in FR', () => {
    expect(getCantonUrlSlug('BASILEA', 'en')).toBe('basel');
    expect(getCantonUrlSlug('BASILEA', 'de')).toBe('basel');
    expect(getCantonUrlSlug('BASILEA', 'fr')).toBe('bale');
  });
  it('AI/AR/BL/BS BFS codes are NOT directly looked up (only via group)', () => {
    // Half-canton merge removed the per-member entries from the cantons
    // table; lookups against the BFS code now miss. Callers must use
    // resolveCantonGroup() first when they hold a real BFS code.
    expect(getCantonUrlSlug('AI', 'it')).toBeNull();
    expect(getCantonUrlSlug('BS', 'it')).toBeNull();
  });
});

describe('parseCantonUrlSlug — locale slug → URL group key', () => {
  it('appenzello (it) → APPENZELLO', () => {
    expect(parseCantonUrlSlug('appenzello', 'it')).toBe('APPENZELLO');
  });
  it('appenzell (en/de/fr) → APPENZELLO', () => {
    expect(parseCantonUrlSlug('appenzell', 'en')).toBe('APPENZELLO');
    expect(parseCantonUrlSlug('appenzell', 'de')).toBe('APPENZELLO');
    expect(parseCantonUrlSlug('appenzell', 'fr')).toBe('APPENZELLO');
  });
  it('basilea (it) → BASILEA', () => {
    expect(parseCantonUrlSlug('basilea', 'it')).toBe('BASILEA');
  });
  it('basel (en/de) → BASILEA, bale (fr) → BASILEA', () => {
    expect(parseCantonUrlSlug('basel', 'en')).toBe('BASILEA');
    expect(parseCantonUrlSlug('basel', 'de')).toBe('BASILEA');
    expect(parseCantonUrlSlug('bale', 'fr')).toBe('BASILEA');
  });
});

describe('Router parsePath — /cerca-lavoro-appenzello/ + locale variants', () => {
  const expectations: Array<{ path: string; locale: Locale; expectedCanton: string }> = [
    { path: '/cerca-lavoro-appenzello/',   locale: 'it', expectedCanton: 'APPENZELLO' },
    { path: '/en/find-jobs-appenzell/',    locale: 'en', expectedCanton: 'APPENZELLO' },
    { path: '/de/jobs-in-appenzell/',      locale: 'de', expectedCanton: 'APPENZELLO' },
    { path: '/fr/trouver-emploi-appenzell/', locale: 'fr', expectedCanton: 'APPENZELLO' },
    { path: '/cerca-lavoro-basilea/',      locale: 'it', expectedCanton: 'BASILEA' },
    { path: '/en/find-jobs-basel/',        locale: 'en', expectedCanton: 'BASILEA' },
    { path: '/de/jobs-in-basel/',          locale: 'de', expectedCanton: 'BASILEA' },
    { path: '/fr/trouver-emploi-bale/',    locale: 'fr', expectedCanton: 'BASILEA' },
  ];
  for (const { path, locale, expectedCanton } of expectations) {
    it(`${path} → jobBoardCanton: ${expectedCanton} (locale ${locale})`, () => {
      const parsed = parsePath(path);
      expect(parsed.locale).toBe(locale);
      expect(parsed.route.activeTab).toBe('job-board');
      expect(parsed.route.jobBoardCanton).toBe(expectedCanton);
    });
  }

  it('TI round-trips unchanged on the legacy URL', () => {
    const parsed = parsePath('/cerca-lavoro-ticino/');
    expect(parsed.route.jobBoardCanton).toBe('TI');
  });

  it('ZH round-trips unchanged (other 22 cantons untouched)', () => {
    const parsed = parsePath('/cerca-lavoro-zurigo/');
    expect(parsed.route.jobBoardCanton).toBe('ZH');
  });
});

describe('Router buildPath / getJobBoardSlugForCanton — collapse BFS codes onto group slug', () => {
  for (const locale of ALL_LOCALES) {
    it(`AI + ${locale} produces the APPENZELLO slug`, () => {
      const slug = getJobBoardSlugForCanton('AI', locale);
      const groupSlug = getJobBoardSlugForCanton('APPENZELLO', locale);
      expect(slug).toBe(groupSlug);
    });
    it(`AR + ${locale} produces the APPENZELLO slug`, () => {
      expect(getJobBoardSlugForCanton('AR', locale)).toBe(
        getJobBoardSlugForCanton('APPENZELLO', locale),
      );
    });
    it(`BL + ${locale} produces the BASILEA slug`, () => {
      expect(getJobBoardSlugForCanton('BL', locale)).toBe(
        getJobBoardSlugForCanton('BASILEA', locale),
      );
    });
    it(`BS + ${locale} produces the BASILEA slug`, () => {
      expect(getJobBoardSlugForCanton('BS', locale)).toBe(
        getJobBoardSlugForCanton('BASILEA', locale),
      );
    });
  }

  it('IT slug is the canonical italian group form', () => {
    expect(getJobBoardSlugForCanton('APPENZELLO', 'it')).toBe('cerca-lavoro-appenzello');
    expect(getJobBoardSlugForCanton('BASILEA', 'it')).toBe('cerca-lavoro-basilea');
  });

  it('FR BASILEA slug uses "bale" (no circumflex)', () => {
    expect(getJobBoardSlugForCanton('BASILEA', 'fr')).toBe('trouver-emploi-bale');
  });

  it('buildPath emits the merged slug for AI', () => {
    const path = buildPath({ activeTab: 'job-board', jobBoardCanton: 'AI' }, 'it');
    expect(path).toContain('cerca-lavoro-appenzello');
    expect(path).not.toContain('appenzello-interno');
  });

  it('buildPath emits the merged slug for BS', () => {
    const path = buildPath({ activeTab: 'job-board', jobBoardCanton: 'BS' }, 'de');
    expect(path).toContain('jobs-in-basel');
    expect(path).not.toContain('basel-stadt');
  });

  it('TI legacy DE form (jobs-im-tessin) preserved', () => {
    expect(getJobBoardSlugForCanton('TI', 'de')).toBe('jobs-im-tessin');
  });
});

// ── Follow-up #959 (item 3): sub-hub (tutti / settori / aziende) emission for
// the new half-canton URL groups. The footer "Tutte le aziende →" link
// (App.tsx, via seoHubSlugFor) and the per-canton hub page emission
// (seoHubsPlugin.emitThinCantonHubs, both via the SAME hubSlugFor helper) must
// agree by construction. The risk the reviewer flagged: if hubSlugFor returned
// a raw group key (`/cerca-lavoro-BASILEA/aziende/`) the footer link would
// 404 against the emitted slug (`/cerca-lavoro-basilea/aziende/`). Lock the
// slug shape for BASILEA + APPENZELLO across every locale + facet so the
// footer/emitter contract can't silently drift.
describe('hubSlugFor — sub-hub facets resolve for new half-canton groups (#959)', () => {
  // Expected canonical section slug per group/locale (no raw group key leak,
  // lowercase, locale-correct — matches getJobBoardSlugForCanton above).
  const SECTION: Record<'BASILEA' | 'APPENZELLO', Record<Locale, string>> = {
    BASILEA: {
      it: 'cerca-lavoro-basilea',
      en: 'find-jobs-basel',
      de: 'jobs-in-basel',
      fr: 'trouver-emploi-bale',
    },
    APPENZELLO: {
      it: 'cerca-lavoro-appenzello',
      en: 'find-jobs-appenzell',
      de: 'jobs-in-appenzell',
      fr: 'trouver-emploi-appenzell',
    },
  };
  // Trailing path component per facet/locale (mirrors HUB_SLUG_BY_LOCALE in
  // seoHubsData.ts — the table the emitter and footer both consume).
  const FACET: Record<'tutti' | 'settori' | 'aziende', Record<Locale, string>> = {
    tutti: { it: 'tutti', en: 'all', de: 'alle', fr: 'tous' },
    settori: { it: 'settori', en: 'sectors', de: 'branchen', fr: 'secteurs' },
    aziende: { it: 'aziende', en: 'companies', de: 'unternehmen', fr: 'entreprises' },
  };

  for (const group of ['BASILEA', 'APPENZELLO'] as const) {
    for (const locale of ALL_LOCALES) {
      for (const facet of ['tutti', 'settori', 'aziende'] as const) {
        it(`${group} + ${locale} + ${facet} → valid lowercase section slug (no 404)`, () => {
          const prefix = locale === 'it' ? '' : `/${locale}`;
          const expected = `${prefix}/${SECTION[group][locale]}/${FACET[facet][locale]}/`;
          expect(hubSlugFor(group, locale, facet)).toBe(expected);
        });
      }
    }
  }

  it('never leaks a raw group key into the emitted URL', () => {
    for (const group of ['BASILEA', 'APPENZELLO'] as const) {
      for (const locale of ALL_LOCALES) {
        for (const facet of ['tutti', 'settori', 'aziende'] as const) {
          const slug = hubSlugFor(group, locale, facet);
          expect(slug).not.toContain('BASILEA');
          expect(slug).not.toContain('APPENZELLO');
        }
      }
    }
  });

  it('member BFS codes collapse onto the same hub slug as the group key', () => {
    // hubSlugFor resolves the group internally, so AI/AR and BL/BS must produce
    // the SAME sub-hub URL as APPENZELLO / BASILEA (one emitted page per group).
    for (const locale of ALL_LOCALES) {
      expect(hubSlugFor('AI', locale, 'aziende')).toBe(hubSlugFor('APPENZELLO', locale, 'aziende'));
      expect(hubSlugFor('AR', locale, 'settori')).toBe(hubSlugFor('APPENZELLO', locale, 'settori'));
      expect(hubSlugFor('BL', locale, 'tutti')).toBe(hubSlugFor('BASILEA', locale, 'tutti'));
      expect(hubSlugFor('BS', locale, 'aziende')).toBe(hubSlugFor('BASILEA', locale, 'aziende'));
    }
  });
});
