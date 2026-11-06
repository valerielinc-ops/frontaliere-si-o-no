/**
 * Unit tests for the shared hreflang helper.
 *
 * Covers the 5 invariants enforced by `build-plugins/shared/hreflang.ts`:
 *   1. Every emitted block has exactly 5 entries (4 locales + x-default).
 *   2. Every href is absolute, on the canonical `https://frontaliereticino.ch`
 *      host (no `www`, no `http://`).
 *   3. The emitting page's own locale is self-referenced.
 *   4. `x-default` always matches the IT href byte-for-byte.
 *   5. Invalid inputs throw rather than emitting a broken tag.
 *
 * The fixtures exercise one representative route per plugin category so a
 * regression in any plugin's slug table surfaces here.
 */

import { describe, expect, it } from 'vitest';

import {
  BASE_URL,
} from '@/build-plugins/constants';
import {
  HREFLANG_LOCALES,
  buildHreflangEntries,
  renderHreflangTags,
  renderSitemapHreflangTags,
  toLegacyHreflangEntries,
  type HreflangPaths,
} from '@/build-plugins/shared/hreflang';

// ── Representative fixtures — one per plugin category ────────────────────
//
// Paths mirror the actual router/plugin slug tables so any future drift
// (e.g. an EN slug renamed in router.ts but not in the plugin) shows up as a
// failure of the matching test.

const FIXTURES: Record<string, HreflangPaths> = {
  // jobsSeoPages — job detail
  jobDetail: {
    it: '/cerca-lavoro-ticino/lugano/sviluppatore-frontend-senior-abc123/',
    en: '/en/find-jobs-ticino/lugano/senior-frontend-developer-abc123/',
    de: '/de/jobs-im-tessin/lugano/senior-frontend-entwickler-abc123/',
    fr: '/fr/trouver-emploi-tessin/lugano/developpeur-frontend-senior-abc123/',
  },
  // jobsSeoPages — city hub
  cityHub: {
    it: '/cerca-lavoro-ticino/lavoro-lugano/',
    en: '/en/find-jobs-ticino/jobs-lugano/',
    de: '/de/jobs-im-tessin/stellen-lugano/',
    fr: '/fr/trouver-emploi-tessin/emplois-lugano/',
  },
  // weeklyEmployers — per-company × city
  companyCity: {
    it: '/cerca-lavoro-ticino/lavoro-lugano/ubs/',
    en: '/en/find-jobs-ticino/jobs-lugano/ubs/',
    de: '/de/jobs-im-tessin/stellen-lugano/ubs/',
    fr: '/fr/trouver-emploi-tessin/emplois-lugano/ubs/',
  },
  // fuelDailyPages — per-station
  fuelStation: {
    it: '/benzina/stazione/agip-lugano-via-trevano/',
    en: '/en/petrol/station/agip-lugano-via-trevano/',
    de: '/de/benzin/tankstelle/agip-lugano-via-trevano/',
    fr: '/fr/essence/station/agip-lugano-via-trevano/',
  },
  // healthPremiumsLanding
  healthPremiums: {
    it: '/premi-cassa-malati/ticino/',
    en: '/en/health-insurance-premiums/ticino/',
    de: '/de/krankenkassenpraemien/tessin/',
    fr: '/fr/primes-assurance-maladie/tessin/',
  },
  // orphanQueryLanding
  orphanQuery: {
    it: '/ricerca/lavoro-magazzino-mendrisio/',
    en: '/en/search/warehouse-jobs-mendrisio/',
    de: '/de/suche/lagerjobs-mendrisio/',
    fr: '/fr/recherche/emplois-entrepot-mendrisio/',
  },
  // borderWaitPages
  borderWait: {
    it: '/tempi-attesa-confine/chiasso-brogeda/',
    en: '/en/border-wait-times/chiasso-brogeda/',
    de: '/de/wartezeiten-grenze/chiasso-brogeda/',
    fr: '/fr/temps-attente-frontiere/chiasso-brogeda/',
  },
  // weeklyEmployers — per-city
  weeklyEmployersCity: {
    it: '/aziende-che-assumono-ticino/lugano/',
    en: '/en/companies-hiring-ticino/lugano/',
    de: '/de/unternehmen-die-einstellen-tessin/lugano/',
    fr: '/fr/entreprises-qui-recrutent-tessin/lugano/',
  },
  // blog article
  article: {
    it: '/blog/tassa-salute-frontalieri/',
    en: '/en/blog/health-tax-cross-border/',
    de: '/de/blog/gesundheitssteuer-grenzgaenger/',
    fr: '/fr/blog/taxe-sante-frontaliers/',
  },
  // comparator hub
  comparator: {
    it: '/confronti/',
    en: '/en/comparators/',
    de: '/de/vergleicher/',
    fr: '/fr/comparateurs/',
  },
};

describe('hreflang helper — structural invariants', () => {
  it.each(Object.entries(FIXTURES))(
    'emits 5 entries (4 locales + x-default) for %s',
    (_name, paths) => {
      const entries = buildHreflangEntries(paths);
      expect(entries).toHaveLength(5);
      const langs = entries.map((e) => e.hreflang);
      expect(langs).toEqual(['it', 'en', 'de', 'fr', 'x-default']);
    },
  );

  it.each(Object.entries(FIXTURES))(
    'uses the canonical absolute host (no www, no http) for %s',
    (_name, paths) => {
      const entries = buildHreflangEntries(paths);
      for (const e of entries) {
        expect(e.href.startsWith(BASE_URL)).toBe(true);
        expect(e.href.startsWith('https://frontaliereticino.ch')).toBe(true);
        expect(e.href).not.toMatch(/^https?:\/\/www\./);
        expect(e.href).not.toMatch(/^http:\/\//);
      }
    },
  );

  it.each(Object.entries(FIXTURES))(
    'self-references the emitting locale for %s',
    (_name, paths) => {
      const entries = buildHreflangEntries(paths);
      for (const locale of HREFLANG_LOCALES) {
        const match = entries.find((e) => e.hreflang === locale);
        expect(match).toBeDefined();
        expect(match!.href).toBe(`${BASE_URL}${paths[locale]}`);
      }
    },
  );

  it.each(Object.entries(FIXTURES))(
    'x-default matches the IT href byte-for-byte for %s',
    (_name, paths) => {
      const entries = buildHreflangEntries(paths);
      const it = entries.find((e) => e.hreflang === 'it')!;
      const xDefault = entries.find((e) => e.hreflang === 'x-default')!;
      expect(xDefault.href).toBe(it.href);
    },
  );
});

describe('hreflang helper — HTML rendering', () => {
  it('renders one <link rel="alternate"> tag per entry with correct attributes', () => {
    const html = renderHreflangTags(FIXTURES.comparator);
    const lines = html.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(
      '    <link rel="alternate" hreflang="it" href="https://frontaliereticino.ch/confronti/">',
    );
    expect(lines[4]).toBe(
      '    <link rel="alternate" hreflang="x-default" href="https://frontaliereticino.ch/confronti/">',
    );
  });

  it('accepts a custom indent', () => {
    const html = renderHreflangTags(FIXTURES.comparator, { indent: '  ' });
    for (const line of html.split('\n')) {
      expect(line.startsWith('  <link')).toBe(true);
    }
  });

  it('renders the sitemap XML variant with <xhtml:link> self-closing tags', () => {
    const xml = renderSitemapHreflangTags(FIXTURES.comparator);
    const lines = xml.split('\n');
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(line).toMatch(/^    <xhtml:link rel="alternate" hreflang="[a-z-]+" href="https:\/\/frontaliereticino\.ch\/[^"]*" \/>$/);
    }
  });

  it('toLegacyHreflangEntries returns 5 plain {hreflang, href} entries', () => {
    const legacy = toLegacyHreflangEntries(FIXTURES.comparator);
    expect(legacy).toHaveLength(5);
    expect(legacy[0]).toEqual({
      hreflang: 'it',
      href: 'https://frontaliereticino.ch/confronti/',
    });
  });
});

describe('hreflang helper — invalid input rejection', () => {
  it('throws when a locale is missing', () => {
    const incomplete = {
      it: '/confronti/',
      en: '/en/comparators/',
      de: '/de/vergleicher/',
      // fr intentionally omitted
    } as unknown as HreflangPaths;
    expect(() => buildHreflangEntries(incomplete)).toThrow(/fr/);
  });

  it('throws when a path is the empty string', () => {
    const empty: HreflangPaths = {
      it: '/confronti/',
      en: '',
      de: '/de/vergleicher/',
      fr: '/fr/comparateurs/',
    };
    expect(() => buildHreflangEntries(empty)).toThrow(/en/);
  });

  it('throws when a path uses a non-canonical host', () => {
    const bad: HreflangPaths = {
      it: '/confronti/',
      en: 'https://www.frontaliereticino.ch/en/comparators/',
      de: '/de/vergleicher/',
      fr: '/fr/comparateurs/',
    };
    expect(() => buildHreflangEntries(bad)).toThrow(/non-canonical host/);
  });

  it('throws on protocol-relative hrefs', () => {
    const bad: HreflangPaths = {
      it: '/confronti/',
      en: '//frontaliereticino.ch/en/comparators/',
      de: '/de/vergleicher/',
      fr: '/fr/comparateurs/',
    };
    expect(() => buildHreflangEntries(bad)).toThrow(/protocol-relative/);
  });

  it('accepts a pre-built full URL only when it is on the canonical host', () => {
    const canonicalFull: HreflangPaths = {
      it: `${BASE_URL}/confronti/`,
      en: `${BASE_URL}/en/comparators/`,
      de: `${BASE_URL}/de/vergleicher/`,
      fr: `${BASE_URL}/fr/comparateurs/`,
    };
    const entries = buildHreflangEntries(canonicalFull);
    expect(entries.map((e) => e.href)).toEqual([
      `${BASE_URL}/confronti/`,
      `${BASE_URL}/en/comparators/`,
      `${BASE_URL}/de/vergleicher/`,
      `${BASE_URL}/fr/comparateurs/`,
      `${BASE_URL}/confronti/`,
    ]);
  });
});
