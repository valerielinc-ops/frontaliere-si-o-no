import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { buildPath, parsePath, pushRoute, replaceRoute, updatePathForLocale, registerJobSlugMap, getJobMetaForSlug, type AppRoute } from '@/services/router';
import type { Locale } from '@/services/i18n';

const SEO_LANDINGS = [
  'salary-60000',
  'salary-80000',
  'salary-100000',
  'salary-120000',
] as const;

const GLOSSARY_TERMS = [
  'impostaAllaFonte',
  'irpef',
  'franchigia',
  'ristorni',
] as const;

const BORDER_CROSSINGS = [
  'chiasso-centro',
  'ponte-tresa',
] as const;

/* ─────────── Sub-tab arrays (new structure) ─────────── */

const CALCOLATORE_SUBS = [
  'calculator', 'whatif', 'payslip', 'ral', 'bonus', 'parental-leave', 'residency', 'salary-quiz',
] as const;

const CONFRONTI_SUBS = [
  'exchange', 'banks', 'health', 'mobile', 'shopping', 'cost-of-living', 'jobs', 'renovation',
] as const;

const FISCO_SUBS = [
  'tax-return', 'calendar', 'holidays', 'ristorni', 'pension', 'pillar3', 'quiz',
] as const;

const GUIDA_SUBS = [
  'first-day', 'permits', 'border', 'unemployment', 'car-transfer', 'car-cost', 'permit-compare', 'border-map',
] as const;

const VITA_SUBS = [
  'living-ch', 'living-it', 'companies', 'schools', 'nursery', 'places', 'transport', 'municipalities',
] as const;

const STATS_SUBS = [
  'overview', 'livability', 'salary-compare', 'traffic-history',
] as const;

const ALL_LOCALES = ['it', 'en', 'de', 'fr'] as const;

/* ─────────── buildPath — valid paths ─────────── */

describe('Router — buildPath', () => {
  describe('Calcolatore subtabs produce valid paths', () => {
    for (const locale of ALL_LOCALES) {
      for (const sub of CALCOLATORE_SUBS) {
        it(`[${locale}] calculator/${sub} → valid path`, () => {
          const path = buildPath(
            { activeTab: 'calculator', calcolatoreSubTab: sub },
            locale,
          );
          expect(path).toBeDefined();
          expect(path).not.toContain('undefined');
          // Homepage (calculator main tab) uses locale root: / or /en/ etc.
          if (sub === 'calculator') {
            expect(path).toMatch(/^\/([a-z]{2}\/)?$/);
          } else {
            expect(path).toMatch(/^\/[a-z0-9/-]+$/);
          }
        });
      }
    }
  });

  describe('SEO landings (calculator) produce valid paths', () => {
    for (const locale of ALL_LOCALES) {
      for (const landing of SEO_LANDINGS) {
        it(`[${locale}] seo landing ${landing} → valid path`, () => {
          const path = buildPath(
            { activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: landing as any },
            locale,
          );
          expect(path).toBeDefined();
          expect(path).not.toContain('undefined');
          // Must NOT be locale root
          expect(path).toMatch(/^\/[a-z0-9/-]+$/);
        });
      }
    }
  });

  describe('Glossary term deep links produce valid paths', () => {
    for (const locale of ALL_LOCALES) {
      for (const term of GLOSSARY_TERMS) {
        it(`[${locale}] glossario/${term} → valid path`, () => {
          const path = buildPath(
            { activeTab: 'glossario', glossaryTerm: term as any },
            locale,
          );
          expect(path).toBeDefined();
          expect(path).not.toContain('undefined');
          expect(path).toMatch(/^\/[a-z0-9/-]+$/);
        });
      }
    }
  });

  describe('Border crossing deep links produce valid paths', () => {
    for (const locale of ALL_LOCALES) {
      for (const crossing of BORDER_CROSSINGS) {
        it(`[${locale}] guida/border/${crossing} → valid path`, () => {
          const path = buildPath(
            { activeTab: 'guida', guidaSubTab: 'border' as any, borderCrossing: crossing as any },
            locale,
          );
          expect(path).toBeDefined();
          expect(path).not.toContain('undefined');
          expect(path).toMatch(/^\/[a-z0-9/-]+$/);
        });
      }
    }
  });

  describe('Confronti subtabs produce valid paths', () => {
    for (const locale of ALL_LOCALES) {
      for (const sub of CONFRONTI_SUBS) {
        it(`[${locale}] confronti/${sub} → valid path`, () => {
          const path = buildPath(
            { activeTab: 'confronti', confrontiSubTab: sub },
            locale,
          );
          expect(path).toBeDefined();
          expect(path).not.toContain('undefined');
          expect(path).toMatch(/^\/[a-z0-9/-]+$/);
        });
      }
    }
  });

  describe('Fisco subtabs produce valid paths', () => {
    for (const locale of ALL_LOCALES) {
      for (const sub of FISCO_SUBS) {
        it(`[${locale}] fisco/${sub} → valid path`, () => {
          const path = buildPath(
            { activeTab: 'fisco', fiscoSubTab: sub },
            locale,
          );
          expect(path).toBeDefined();
          expect(path).not.toContain('undefined');
          expect(path).toMatch(/^\/[a-z0-9/-]+$/);
        });
      }
    }
  });

  describe('Guida subtabs produce valid paths', () => {
    for (const locale of ALL_LOCALES) {
      for (const sub of GUIDA_SUBS) {
        it(`[${locale}] guida/${sub} → valid path`, () => {
          const path = buildPath(
            { activeTab: 'guida', guidaSubTab: sub },
            locale,
          );
          expect(path).toBeDefined();
          expect(path).not.toContain('undefined');
          expect(path).toMatch(/^\/[a-z0-9/-]+$/);
        });
      }
    }
  });

  describe('Vita subtabs produce valid paths', () => {
    for (const locale of ALL_LOCALES) {
      for (const sub of VITA_SUBS) {
        it(`[${locale}] vita/${sub} → valid path`, () => {
          const path = buildPath(
            { activeTab: 'vita', vitaSubTab: sub },
            locale,
          );
          expect(path).toBeDefined();
          expect(path).not.toContain('undefined');
          expect(path).toMatch(/^\/[a-z0-9/-]+$/);
        });
      }
    }
  });

  describe('Stats subtabs produce valid paths', () => {
    for (const locale of ALL_LOCALES) {
      for (const sub of STATS_SUBS) {
        it(`[${locale}] stats/${sub} → valid path`, () => {
          const path = buildPath(
            { activeTab: 'stats', statsSubTab: sub },
            locale,
          );
          expect(path).toBeDefined();
          expect(path).not.toContain('undefined');
          expect(path).toMatch(/^\/[a-z0-9/-]+$/);
        });
      }
    }
  });
});

/* ─────────── parsePath roundtrip ─────────── */

describe('Router — parsePath roundtrip', () => {
  describe('Confronti paths survive roundtrip', () => {
    for (const locale of ALL_LOCALES) {
      for (const sub of CONFRONTI_SUBS) {
        it(`[${locale}] confronti/${sub} roundtrips`, () => {
          const path = buildPath(
            { activeTab: 'confronti', confrontiSubTab: sub },
            locale,
          );
          const { route } = parsePath(path);
          expect(route.activeTab).toBe('confronti');
          expect(route.confrontiSubTab).toBe(sub);
        });
      }
    }
  });

  describe('Calcolatore paths survive roundtrip', () => {
    for (const locale of ALL_LOCALES) {
      for (const sub of CALCOLATORE_SUBS) {
        it(`[${locale}] calculator/${sub} roundtrips`, () => {
          const path = buildPath(
            { activeTab: 'calculator', calcolatoreSubTab: sub },
            locale,
          );
          const { route } = parsePath(path);
          expect(route.activeTab).toBe('calculator');
          expect(route.calcolatoreSubTab).toBe(sub);
        });
      }
    }
  });

  describe('SEO landing paths survive roundtrip', () => {
    for (const locale of ALL_LOCALES) {
      for (const landing of SEO_LANDINGS) {
        it(`[${locale}] seo landing ${landing} roundtrips`, () => {
          const path = buildPath(
            { activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: landing as any },
            locale,
          );
          const { route } = parsePath(path);
          expect(route.activeTab).toBe('calculator');
          expect(route.calcolatoreSubTab).toBe('calculator');
          expect(route.seoLanding).toBe(landing);
        });
      }
    }
  });

  describe('Glossary term paths survive roundtrip', () => {
    for (const locale of ALL_LOCALES) {
      for (const term of GLOSSARY_TERMS) {
        it(`[${locale}] glossario/${term} roundtrips`, () => {
          const path = buildPath(
            { activeTab: 'glossario', glossaryTerm: term as any },
            locale,
          );
          const { route } = parsePath(path);
          expect(route.activeTab).toBe('glossario');
          expect(route.glossaryTerm).toBe(term);
        });
      }
    }
  });

  describe('Border crossing paths survive roundtrip', () => {
    for (const locale of ALL_LOCALES) {
      for (const crossing of BORDER_CROSSINGS) {
        it(`[${locale}] guida/border/${crossing} roundtrips`, () => {
          const path = buildPath(
            { activeTab: 'guida', guidaSubTab: 'border' as any, borderCrossing: crossing as any },
            locale,
          );
          const { route } = parsePath(path);
          expect(route.activeTab).toBe('guida');
          expect(route.guidaSubTab).toBe('border');
          expect(route.borderCrossing).toBe(crossing);
        });
      }
    }
  });

  describe('Fisco paths survive roundtrip', () => {
    for (const locale of ALL_LOCALES) {
      for (const sub of FISCO_SUBS) {
        it(`[${locale}] fisco/${sub} roundtrips`, () => {
          const path = buildPath(
            { activeTab: 'fisco', fiscoSubTab: sub },
            locale,
          );
          const { route } = parsePath(path);
          expect(route.activeTab).toBe('fisco');
          expect(route.fiscoSubTab).toBe(sub);
        });
      }
    }
  });

  describe('Guida paths survive roundtrip', () => {
    for (const locale of ALL_LOCALES) {
      for (const sub of GUIDA_SUBS) {
        it(`[${locale}] guida/${sub} roundtrips`, () => {
          const path = buildPath(
            { activeTab: 'guida', guidaSubTab: sub },
            locale,
          );
          const { route } = parsePath(path);
          expect(route.activeTab).toBe('guida');
          expect(route.guidaSubTab).toBe(sub);
        });
      }
    }
  });

  describe('Vita paths survive roundtrip', () => {
    for (const locale of ALL_LOCALES) {
      for (const sub of VITA_SUBS) {
        it(`[${locale}] vita/${sub} roundtrips`, () => {
          const path = buildPath(
            { activeTab: 'vita', vitaSubTab: sub },
            locale,
          );
          const { route } = parsePath(path);
          expect(route.activeTab).toBe('vita');
          expect(route.vitaSubTab).toBe(sub);
        });
      }
    }
  });
});

describe('Router — locale-aware job detail updates', () => {
  it('rewrites job detail slugs and history state when switching locale', () => {
    const italianSlug = 'manifestazione-di-interesse-international-school-of-ticino-international-school-of-ticino-lugano';
    const englishSlug = 'expression-of-interest-international-school-of-ticino-international-school-of-ticino-lugano';
    registerJobSlugMap([
      {
        slug: italianSlug,
        slugByLocale: {
          it: italianSlug,
          en: englishSlug,
        },
      },
    ]);

    window.history.replaceState(
      { route: { activeTab: 'job-board', jobSlug: italianSlug } },
      '',
      buildPath({ activeTab: 'job-board', jobSlug: italianSlug }, 'it'),
    );

    updatePathForLocale('en');

    expect(window.location.pathname).toBe(buildPath({ activeTab: 'job-board', jobSlug: englishSlug }, 'en'));
    // The route may carry additional fields (e.g. jobBoardCanton) added by
    // unrelated features — assert only what this test cares about.
    expect(window.history.state?.route).toMatchObject({ activeTab: 'job-board', jobSlug: englishSlug });
  });
});

/* ─────────── Employer insights (private per-company page) ─────────── */

describe('Router — employer insights companyKey segment', () => {
  const companyKey = 'eoc-ente-ospedaliero-cantonale';
  const token = 'e10bb7f63d0c2d9c972fb4a5658ff42000cb6333689cc11fca4b2e97f1cff621';

  it('parsePath captures the companyKey path segment', () => {
    const { route } = parsePath(`/azienda/${companyKey}/`);
    expect(route.activeTab).toBe('employer-insights');
    expect(route.companyKey).toBe(companyKey);
  });

  it('buildPath round-trips the companyKey segment', () => {
    expect(buildPath({ activeTab: 'employer-insights', companyKey })).toBe(`/azienda/${companyKey}/`);
  });

  it('locale-boot canonicalization preserves companyKey + ?t= token (no collapse to /azienda/)', () => {
    // Repro of the live bug: updatePathForLocale rebuilt the URL from the
    // route model, which dropped the companyKey → /azienda/?t=… → empty key →
    // "Link non valido o scaduto". With companyKey carried in the route, the
    // segment (and the private token in the query) survive the rewrite.
    window.history.replaceState(
      { route: parsePath(`/azienda/${companyKey}/`).route },
      '',
      `/azienda/${companyKey}/?t=${token}`,
    );

    updatePathForLocale('it');

    expect(window.location.pathname).toBe(`/azienda/${companyKey}/`);
    expect(window.location.search).toBe(`?t=${token}`);
  });
});

/* ─────────── Author profile pages (/autori/{slug}/) ─────────── */

describe('Router — author profile slug segment', () => {
  // Regression: parsePath never had a branch for /autori/{slug}/, so the SPA
  // fell through to the notFoundPath fallback on hydrate and replaced the
  // correct static HTML with "Pagina non trovata" for every author page
  // (reported live for /autori/samuele-valente/, but affected all authors).
  const cases: ReadonlyArray<{ path: string; locale: string }> = [
    { path: '/autori/samuele-valente/', locale: 'it' },
    { path: '/en/authors/samuele-valente/', locale: 'en' },
    { path: '/de/autoren/samuele-valente/', locale: 'de' },
    { path: '/fr/auteurs/samuele-valente/', locale: 'fr' },
  ];

  for (const { path, locale } of cases) {
    it(`parsePath resolves ${path} to activeTab='autore'`, () => {
      const { route, locale: parsedLocale } = parsePath(path);
      expect(route.activeTab).toBe('autore');
      expect(route.author).toBe('samuele-valente');
      expect(parsedLocale).toBe(locale);
    });
  }

  it('buildPath round-trips the author slug for each locale', () => {
    expect(buildPath({ activeTab: 'autore', author: 'samuele-valente' }, 'it')).toBe('/autori/samuele-valente/');
    expect(buildPath({ activeTab: 'autore', author: 'samuele-valente' }, 'en')).toBe('/en/authors/samuele-valente/');
    expect(buildPath({ activeTab: 'autore', author: 'samuele-valente' }, 'de')).toBe('/de/autoren/samuele-valente/');
    expect(buildPath({ activeTab: 'autore', author: 'samuele-valente' }, 'fr')).toBe('/fr/auteurs/samuele-valente/');
  });
});

/* ─────────── CHF/EUR exchange SSG vertical (/cambio-franco-euro/) ─────────── */

describe('Router — CHF/EUR exchange SSG vertical (epic #4452)', () => {
  // Regression: parsePath never had a branch for the hub/amount pages, so
  // hydration fell through to the notFoundPath fallback and replaced the
  // correct static HTML with "Pagina non trovata" — plus replaceRoute()
  // rewrote the address bar back to '/' since the resolved fallback route
  // wasn't staticOverlay (reported live for
  // /cambio-franco-euro/4500-franchi-in-euro/, linked from the calculator
  // results cross-link).
  const hubCases: ReadonlyArray<{ path: string; locale: string }> = [
    { path: '/cambio-franco-euro/', locale: 'it' },
    { path: '/en/chf-eur-exchange/', locale: 'en' },
    { path: '/de/franken-euro-kurs/', locale: 'de' },
    { path: '/fr/change-franc-euro/', locale: 'fr' },
  ];

  const amountCases: ReadonlyArray<{ path: string; locale: string }> = [
    { path: '/cambio-franco-euro/4500-franchi-in-euro/', locale: 'it' },
    { path: '/en/chf-eur-exchange/4500-chf-to-eur/', locale: 'en' },
    { path: '/de/franken-euro-kurs/4500-franken-in-euro/', locale: 'de' },
    { path: '/fr/change-franc-euro/4500-francs-en-euros/', locale: 'fr' },
  ];

  for (const { path, locale } of [...hubCases, ...amountCases]) {
    it(`parsePath resolves ${path} to a staticOverlay confronti/exchange route (no notFoundPath)`, () => {
      const { route, locale: parsedLocale, notFoundPath } = parsePath(path);
      expect(route.activeTab).toBe('confronti');
      expect(route.confrontiSubTab).toBe('exchange');
      expect(route.staticOverlay).toBe(true);
      expect(parsedLocale).toBe(locale);
      expect(notFoundPath).toBeUndefined();
    });
  }

  it('does not match the unrelated SPA comparator sub-route /compara-servizi/cambio-franco-euro/', () => {
    // Same wording, different (SPA, non-root) path — must NOT staticOverlay.
    const { route, notFoundPath } = parsePath('/compara-servizi/cambio-franco-euro/');
    expect(route.staticOverlay).toBeUndefined();
    expect(notFoundPath).toBeUndefined();
  });
});

/* ─────────── Health-facilities hub (/strutture-sanitarie/{slug}/) ─────────── */

describe('Router — health-facilities hub (epic #4455)', () => {
  // Regression: parsePath never had a branch for facility detail pages —
  // same failure mode as the exchange-vertical bug above.
  const cases: ReadonlyArray<{ path: string; locale: string }> = [
    { path: '/strutture-sanitarie/hirslanden/', locale: 'it' },
    { path: '/en/healthcare-facilities/hirslanden/', locale: 'en' },
    { path: '/de/gesundheitseinrichtungen/hirslanden/', locale: 'de' },
    { path: '/fr/etablissements-sante/hirslanden/', locale: 'fr' },
  ];

  for (const { path, locale } of cases) {
    it(`parsePath resolves ${path} to a staticOverlay job-board route (no notFoundPath)`, () => {
      const { route, locale: parsedLocale, notFoundPath } = parsePath(path);
      expect(route.activeTab).toBe('job-board');
      expect(route.staticOverlay).toBe(true);
      expect(parsedLocale).toBe(locale);
      expect(notFoundPath).toBeUndefined();
    });
  }

  it('unknown facility slug does not staticOverlay (genuinely unmatched)', () => {
    const { route, notFoundPath } = parsePath('/strutture-sanitarie/not-a-real-facility/');
    expect(route.staticOverlay).toBeUndefined();
    expect(notFoundPath).toBe('/strutture-sanitarie/not-a-real-facility/');
  });
});

/* ─────────── Per-canton job-market snapshot (/cerca-lavoro-{canton}/snapshot/) ─────────── */

describe('Router — per-canton job-market snapshot (T2.5)', () => {
  // Regression: parsePath never had a branch for this family — same failure
  // mode as the exchange-vertical bug above. Uses canton AG (Aargau), a real
  // non-TI canton emitted by jobMarketSnapshotChCantonPathsData.ts.
  const cases: ReadonlyArray<{ path: string; locale: string }> = [
    { path: '/cerca-lavoro-argovia/snapshot/', locale: 'it' },
    { path: '/en/find-jobs-aargau/snapshot/', locale: 'en' },
    { path: '/de/jobs-im-aargau/snapshot/', locale: 'de' },
    { path: '/fr/trouver-emploi-argovie/snapshot/', locale: 'fr' },
  ];

  for (const { path, locale } of cases) {
    it(`parsePath resolves ${path} to a staticOverlay stats/jobs-observatory route (no notFoundPath)`, () => {
      const { route, locale: parsedLocale, notFoundPath } = parsePath(path);
      expect(route.activeTab).toBe('stats');
      expect(route.statsSubTab).toBe('jobs-observatory');
      expect(route.staticOverlay).toBe(true);
      expect(parsedLocale).toBe(locale);
      expect(notFoundPath).toBeUndefined();
    });
  }

  it('unknown canton slug does not staticOverlay (genuinely unmatched)', () => {
    const { route, notFoundPath } = parsePath('/cerca-lavoro-narnia/snapshot/');
    expect(route.staticOverlay).toBeUndefined();
    expect(notFoundPath).toBe('/cerca-lavoro-narnia/snapshot/');
  });
});

/* ─────────── Per-canton "aziende che assumono" (/cerca-lavoro-{canton}/aziende-che-assumono/) ─────────── */

describe('Router — per-canton weekly employers hub (finding #4)', () => {
  // Regression: parsePath never had a branch for this family — same failure
  // mode as the exchange-vertical bug above. Uses canton AG (Aargau), a real
  // non-TI canton emitted by weeklyEmployersChCantonPathsData.ts.
  const cases: ReadonlyArray<{ path: string; locale: string }> = [
    { path: '/cerca-lavoro-argovia/aziende-che-assumono/', locale: 'it' },
    { path: '/en/find-jobs-aargau/companies-hiring/', locale: 'en' },
    { path: '/de/jobs-im-aargau/unternehmen-einstellen/', locale: 'de' },
    { path: '/fr/trouver-emploi-argovie/entreprises-recrutent/', locale: 'fr' },
  ];

  for (const { path, locale } of cases) {
    it(`parsePath resolves ${path} to a staticOverlay job-board route (no notFoundPath)`, () => {
      const { route, locale: parsedLocale, notFoundPath } = parsePath(path);
      expect(route.activeTab).toBe('job-board');
      expect(route.staticOverlay).toBe(true);
      expect(parsedLocale).toBe(locale);
      expect(notFoundPath).toBeUndefined();
    });
  }

  it('unknown canton slug does not staticOverlay (genuinely unmatched)', () => {
    const { route, notFoundPath } = parsePath('/cerca-lavoro-narnia/aziende-che-assumono/');
    expect(route.staticOverlay).toBeUndefined();
    expect(notFoundPath).toBe('/cerca-lavoro-narnia/aziende-che-assumono/');
  });
});

/* ─────────── Google-News topic section pages (/fisco/, /salari/, ...) ─────────── */

describe('Router — topic section pages (finding #5)', () => {
  // Regression: parsePath never had a branch for this family. 24 of the 28
  // URLs fell through to notFoundPath; the other 4 (/fisco/, /de/steuern/,
  // /fr/fiscalite/ plus the bare-word alias) silently resolved to the LIVE
  // interactive fisco tab instead of the static article-list HTML — same
  // SSG-hydration-gap bug class either way.
  const cases: ReadonlyArray<{ path: string; locale: string }> = [
    { path: '/fisco/', locale: 'it' },
    { path: '/en/tax/', locale: 'en' },
    { path: '/de/steuern/', locale: 'de' },
    { path: '/fr/fiscalite/', locale: 'fr' },
    { path: '/lavoro-frontaliere/', locale: 'it' },
    { path: '/en/cross-border-work/', locale: 'en' },
    { path: '/de/grenzgaenger-arbeit/', locale: 'de' },
    { path: '/fr/travail-frontalier/', locale: 'fr' },
    { path: '/salari/', locale: 'it' },
    { path: '/en/salaries/', locale: 'en' },
    { path: '/de/loehne/', locale: 'de' },
    { path: '/fr/salaires/', locale: 'fr' },
    { path: '/cambio-valuta/', locale: 'it' },
    { path: '/en/currency-exchange/', locale: 'en' },
    { path: '/de/waehrung/', locale: 'de' },
    { path: '/fr/change/', locale: 'fr' },
    { path: '/trasporti/', locale: 'it' },
    { path: '/en/transport/', locale: 'en' },
    { path: '/de/verkehr/', locale: 'de' },
    { path: '/fr/transports/', locale: 'fr' },
    { path: '/pensioni/', locale: 'it' },
    { path: '/en/pensions/', locale: 'en' },
    { path: '/de/renten/', locale: 'de' },
    { path: '/fr/retraites/', locale: 'fr' },
    { path: '/dogana/', locale: 'it' },
    { path: '/en/customs/', locale: 'en' },
    { path: '/de/zoll/', locale: 'de' },
    { path: '/fr/douane/', locale: 'fr' },
  ];

  for (const { path, locale } of cases) {
    it(`parsePath resolves ${path} to a staticOverlay blog route (no notFoundPath, no live-tab swap)`, () => {
      const { route, locale: parsedLocale, notFoundPath } = parsePath(path);
      expect(route.activeTab).toBe('blog');
      expect(route.staticOverlay).toBe(true);
      expect(parsedLocale).toBe(locale);
      expect(notFoundPath).toBeUndefined();
    });
  }

  it('unrelated bare-word path does not staticOverlay (genuinely unmatched)', () => {
    const { route, notFoundPath } = parsePath('/narnia-topic/');
    expect(route.staticOverlay).toBeUndefined();
    expect(notFoundPath).toBe('/narnia-topic/');
  });
});

/* ─────────── Per-municipality FISCAL guide pages (epic #4482/#4484, finding #1) ─────────── */

describe('Router — per-municipality fiscal guide pages (finding #1)', () => {
  // Regression: parsePath never had a branch for this family. Every hub +
  // per-comune detail/bridge URL fell through to notFoundPath — same
  // SSG-hydration-gap bug class as the other findings in this suite. `como`
  // is a real above-floor comune (indexable page), `gallarate` a real
  // below-floor comune (noindex,follow bridge, same URL shape either way).
  const hubCases: ReadonlyArray<{ path: string; locale: string }> = [
    { path: '/tasse-frontalieri-comune/', locale: 'it' },
    { path: '/en/cross-border-tax-municipality/', locale: 'en' },
    { path: '/de/grenzgaenger-steuern-gemeinde/', locale: 'de' },
    { path: '/fr/impots-frontaliers-commune/', locale: 'fr' },
  ];

  for (const { path, locale } of hubCases) {
    it(`parsePath resolves hub ${path} to a staticOverlay fisco route (no notFoundPath)`, () => {
      const { route, locale: parsedLocale, notFoundPath } = parsePath(path);
      expect(route.activeTab).toBe('fisco');
      expect(route.staticOverlay).toBe(true);
      expect(parsedLocale).toBe(locale);
      expect(notFoundPath).toBeUndefined();
    });
  }

  const detailCases: ReadonlyArray<{ path: string; locale: string }> = [
    { path: '/tasse-frontalieri-comune/como/', locale: 'it' },
    { path: '/en/cross-border-tax-municipality/como/', locale: 'en' },
    { path: '/de/grenzgaenger-steuern-gemeinde/como/', locale: 'de' },
    { path: '/fr/impots-frontaliers-commune/como/', locale: 'fr' },
    { path: '/tasse-frontalieri-comune/gallarate/', locale: 'it' },
    { path: '/en/cross-border-tax-municipality/gallarate/', locale: 'en' },
    { path: '/de/grenzgaenger-steuern-gemeinde/gallarate/', locale: 'de' },
    { path: '/fr/impots-frontaliers-commune/gallarate/', locale: 'fr' },
  ];

  for (const { path, locale } of detailCases) {
    it(`parsePath resolves comune page ${path} to a staticOverlay fisco route (no notFoundPath)`, () => {
      const { route, locale: parsedLocale, notFoundPath } = parsePath(path);
      expect(route.activeTab).toBe('fisco');
      expect(route.staticOverlay).toBe(true);
      expect(parsedLocale).toBe(locale);
      expect(notFoundPath).toBeUndefined();
    });
  }

  it('unknown comune slug does not staticOverlay (genuinely unmatched)', () => {
    const { route, notFoundPath } = parsePath('/tasse-frontalieri-comune/narnia/');
    expect(route.staticOverlay).toBeUndefined();
    expect(notFoundPath).toBe('/tasse-frontalieri-comune/narnia/');
  });
});

describe('Router — communications list (/comunicazioni/ and its locale twins)', () => {
  /**
   * The page is named INSIDE every consent formula
   * (services/consentTexts.ts → CONSENT_PAGE_LABEL), so a visitor arrives here
   * by clicking a notice they were shown at signup. Without `staticOverlay`
   * the path is unmatched anywhere else in parsePath, falls through to the
   * notFoundPath fallback, and the SPA hides `main.seo-static-content` and
   * renders NotFoundSuggestions over a page the build did emit — i.e. the
   * consent formula would point at a 404 for anyone with JS.
   */
  const CASES: Array<[string, string]> = [
    ['/comunicazioni/', 'it'],
    ['/en/communications/', 'en'],
    ['/de/mitteilungen/', 'de'],
    ['/fr/communications/', 'fr'],
  ];

  it.each(CASES)('parsePath resolves %s to a staticOverlay route in %s', (p, expectedLocale) => {
    const { route, locale, notFoundPath } = parsePath(p);
    expect(route.staticOverlay).toBe(true);
    expect(route.activeTab).toBe('privacy');
    expect(locale).toBe(expectedLocale);
    expect(notFoundPath).toBeUndefined();
  });

  it.each(CASES)('resolves %s without the trailing slash the same way', (p) => {
    const { route, notFoundPath } = parsePath(p.replace(/\/$/, ''));
    expect(route.staticOverlay).toBe(true);
    expect(notFoundPath).toBeUndefined();
  });

  it('does not swallow a neighbouring path that the build does not emit', () => {
    const { route, notFoundPath } = parsePath('/comunicazioni/qualcosa/');
    expect(route.staticOverlay).toBeUndefined();
    expect(notFoundPath).toBe('/comunicazioni/qualcosa/');
  });
});

describe('Router — self-certification forms guide (/moduli/autocertificazione-candidatura/)', () => {
  it('parsePath resolves the guide URL to a staticOverlay guida route (no notFoundPath)', () => {
    const { route, locale, notFoundPath } = parsePath('/moduli/autocertificazione-candidatura/');
    expect(route.activeTab).toBe('guida');
    expect(route.staticOverlay).toBe(true);
    expect(locale).toBe('it');
    expect(notFoundPath).toBeUndefined();
  });

  it('parsePath resolves the guide URL without a trailing slash the same way', () => {
    const { route, notFoundPath } = parsePath('/moduli/autocertificazione-candidatura');
    expect(route.activeTab).toBe('guida');
    expect(route.staticOverlay).toBe(true);
    expect(notFoundPath).toBeUndefined();
  });
});

/* ─────────── parsePath/buildPath round-trip symmetry (issue #2698) ─────────── */

/**
 * Guards against the bug class fixed by PR #2696 (employer-insights companyKey):
 * `parsePath` captures a path segment into a route field (parts[1], parts[2], …)
 * but the matching `buildPath` branch DROPS it on round-trip, so locale-boot
 * canonicalization (`updatePathForLocale` → `buildPath` → `history.replaceState`)
 * collapses the URL and breaks navigation / page rendering for that route.
 *
 * The invariant: for every URL whose `parsePath` result is NOT a `staticOverlay`
 * route (static-overlay routes are intentionally exempt — `updatePathForLocale`
 * early-returns for them and never rebuilds the URL), feeding the parsed route
 * back through `buildPath` and re-parsing MUST preserve every captured segment.
 *
 * This is the exhaustive audit the follow-up asked for, expressed as an
 * executable contract so any future asymmetric `parsePath`/`buildPath` pair is
 * caught at CI time rather than silently in production.
 */
describe('Router — parsePath/buildPath round-trip symmetry (no dropped segments)', () => {
  // One representative URL per non-staticOverlay activeTab case that captures a
  // segment beyond parts[0]. Each entry: the captured route fields that MUST
  // survive a parse → build → re-parse cycle in every locale.
  type LocaleId = (typeof ALL_LOCALES)[number];
  const SEGMENT_CASES: Array<{
    name: string;
    paths: Partial<Record<LocaleId, string>>;
    captured: (keyof AppRoute)[];
  }> = [
    {
      name: 'employer-insights companyKey',
      paths: { it: '/azienda/eoc-ente-ospedaliero-cantonale/' },
      captured: ['companyKey'],
    },
    {
      name: 'guida/border borderCrossing deep link',
      paths: { it: '/guida-frontaliere/tempi-attesa-valichi/chiasso-centro/' },
      captured: ['borderCrossing'],
    },
    {
      name: 'fisco tax-return country variant (italia)',
      paths: { it: '/tasse-e-pensione/dichiarazione-redditi-italia/' },
      captured: ['taxReturnCountry'],
    },
    {
      name: 'fisco tax-return country variant (svizzera)',
      paths: { it: '/tasse-e-pensione/dichiarazione-redditi-svizzera/' },
      captured: ['taxReturnCountry'],
    },
    {
      name: 'per-canton job-board jobSlug deep link (jobBoardCanton + jobSlug)',
      paths: { it: '/cerca-lavoro-zurigo/some-engineer-role-zurich-12345/' },
      captured: ['jobBoardCanton', 'jobSlug'],
    },
    {
      // TI legacy city hub is NOT staticOverlay (unlike non-TI city hubs), so it
      // IS canonicalized on locale-boot — its captured jobBoardCity MUST survive
      // (buildPath emits the clean `/cerca-lavoro-ticino/lugano/` URL).
      name: 'TI city hub (jobBoardCanton + jobBoardCity, non-staticOverlay)',
      paths: { it: '/cerca-lavoro-ticino/lugano/' },
      captured: ['jobBoardCanton', 'jobBoardCity'],
    },
  ];
  // NOTE: non-TI city hubs (`/cerca-lavoro-zurigo/zurich/`), sector hubs, SEO
  // landings and salary-hub routes capture segments too, but parsePath marks
  // them `staticOverlay: true` — `updatePathForLocale` early-returns for those
  // and never rebuilds the URL, so the round-trip contract does not apply (the
  // test below asserts they are correctly excluded via the staticOverlay guard).

  for (const testCase of SEGMENT_CASES) {
    for (const [locale, path] of Object.entries(testCase.paths) as [LocaleId, string][]) {
      it(`[${locale}] ${testCase.name} survives parse → build → re-parse`, () => {
        const first = parsePath(path);
        // Static-overlay routes are deliberately exempt from buildPath
        // canonicalization (see updatePathForLocale), so this contract only
        // applies to interactive SPA routes.
        expect(first.route.staticOverlay).toBeFalsy();

        const rebuilt = buildPath(first.route, locale);
        const second = parsePath(rebuilt);

        for (const field of testCase.captured) {
          expect(
            second.route[field],
            `field "${String(field)}" dropped on round-trip for ${path} (rebuilt: ${rebuilt})`,
          ).toEqual(first.route[field]);
        }
        // A captured-segment route must never round-trip into a 404.
        expect(second.notFoundPath).toBeUndefined();
      });
    }
  }

  it('every captured non-staticOverlay segment in SEGMENT_CASES re-emits via buildPath', () => {
    // Aggregate guard: if any case loses a segment, fail loudly with the list.
    const dropped: string[] = [];
    for (const testCase of SEGMENT_CASES) {
      for (const [locale, path] of Object.entries(testCase.paths) as [LocaleId, string][]) {
        const first = parsePath(path);
        if (first.route.staticOverlay) continue;
        const second = parsePath(buildPath(first.route, locale));
        for (const field of testCase.captured) {
          if (second.route[field] !== first.route[field]) {
            dropped.push(`${testCase.name} [${locale}] → ${String(field)}`);
          }
        }
      }
    }
    expect(dropped).toEqual([]);
  });

  // Documents the audit's scope boundary: segment-capturing routes that ARE
  // staticOverlay are intentionally outside the buildPath round-trip contract,
  // because updatePathForLocale never canonicalizes them.
  it('staticOverlay segment-capturing routes are correctly exempt (no canonicalization)', () => {
    const overlayPaths = [
      '/cerca-lavoro-zurigo/zurich/', // non-TI city hub
      '/cerca-lavoro-ticino/infermieri/', // sector hub
      '/calcola-stipendio/stipendio-netto-80000-chf/', // SEO landing
    ];
    for (const p of overlayPaths) {
      expect(parsePath(p).route.staticOverlay, `${p} should be staticOverlay`).toBe(true);
    }
  });
});

/* ─────────── Backward compatibility ─────────── */

describe('Router — backward compatibility', () => {
  it('old /comparatori/costi-pendolarismo → confronti/cost-of-living', () => {
    const { route } = parsePath('/comparatori/costi-pendolarismo');
    expect(route.activeTab).toBe('confronti');
    expect(route.confrontiSubTab).toBe('cost-of-living');
  });

  it('old /en/comparators/commuting-costs → confronti/cost-of-living', () => {
    const { route } = parsePath('/en/comparators/commuting-costs');
    expect(route.activeTab).toBe('confronti');
    expect(route.confrontiSubTab).toBe('cost-of-living');
  });

  it('old /comparatori/cambio-valuta → confronti/exchange', () => {
    const { route } = parsePath('/comparatori/cambio-valuta');
    expect(route.activeTab).toBe('confronti');
    expect(route.confrontiSubTab).toBe('exchange');
  });

  it('old /guida-frontalieri/primo-giorno → guida/first-day', () => {
    const { route } = parsePath('/guida-frontalieri/primo-giorno');
    expect(route.activeTab).toBe('guida');
    expect(route.guidaSubTab).toBe('first-day');
  });

  it('old /pianificatore-pensione → fisco/pension', () => {
    const { route } = parsePath('/pianificatore-pensione');
    expect(route.activeTab).toBe('fisco');
    expect(route.fiscoSubTab).toBe('pension');
  });

  it('old /strumenti/busta-paga → calculator/payslip', () => {
    const { route } = parsePath('/strumenti/busta-paga');
    expect(route.activeTab).toBe('calculator');
    expect(route.calcolatoreSubTab).toBe('payslip');
  });

  it('old /strumenti/vivibilita-comuni → stats/livability', () => {
    const { route } = parsePath('/strumenti/vivibilita-comuni');
    expect(route.activeTab).toBe('stats');
    expect(route.statsSubTab).toBe('livability');
  });

  it('old /strumenti/confronto-stipendi → stats/salary-compare', () => {
    const { route } = parsePath('/strumenti/confronto-stipendi');
    expect(route.activeTab).toBe('stats');
    expect(route.statsSubTab).toBe('salary-compare');
  });
});

/* ─────────── Gamification tab ─────────── */

describe('Router — gamification tab', () => {
  for (const locale of ALL_LOCALES) {
    it(`[${locale}] gamification → valid path`, () => {
      const path = buildPath({ activeTab: 'gamification' }, locale);
      expect(path).toBeDefined();
      expect(path).not.toContain('undefined');
      expect(path).toMatch(/^\/[a-z0-9/-]+$/);
    });

    it(`[${locale}] gamification roundtrips`, () => {
      const path = buildPath({ activeTab: 'gamification' }, locale);
      const { route } = parsePath(path);
      expect(route.activeTab).toBe('gamification');
    });
  }

  it('[it] uses /gamificazione slug', () => {
    const path = buildPath({ activeTab: 'gamification' }, 'it');
    expect(path).toContain('gamificazione');
  });

  it('[en] uses /gamification slug', () => {
    const path = buildPath({ activeTab: 'gamification' }, 'en');
    expect(path).toContain('gamification');
  });
});

/* ─────────── Dashboard → profile redirect ─────────── */

describe('Router — dashboard tab (redirects to profile)', () => {
  for (const locale of ALL_LOCALES) {
    it(`[${locale}] old dashboard URL → resolves to profile`, () => {
      const { route } = parsePath(`/${locale === 'it' ? '' : locale + '/'}dashboard`);
      expect(route.activeTab).toBe('profile');
    });
  }
});

/* ─────────── Profile tab ─────────── */

describe('Router — profile tab', () => {
  for (const locale of ALL_LOCALES) {
    it(`[${locale}] profile → valid path`, () => {
      const path = buildPath({ activeTab: 'profile' }, locale);
      expect(path).toBeDefined();
      expect(path).not.toContain('undefined');
      expect(path).toMatch(/^\/[a-z0-9/-]+$/);
    });

    it(`[${locale}] profile roundtrips`, () => {
      const path = buildPath({ activeTab: 'profile' }, locale);
      const { route } = parsePath(path);
      expect(route.activeTab).toBe('profile');
    });
  }

  it('[it] uses /profilo slug', () => {
    const path = buildPath({ activeTab: 'profile' }, 'it');
    expect(path).toContain('profilo');
  });

  it('[en] uses /profile slug', () => {
    const path = buildPath({ activeTab: 'profile' }, 'en');
    expect(path).toContain('profile');
  });
});

/* ─────────── Root path preservation (SEO fix) ─────────── */

describe('Router — root path preservation (no redirect from / to /calcola-stipendio)', () => {
  let pushStateSpy: ReturnType<typeof vi.fn>;
  let replaceStateSpy: ReturnType<typeof vi.fn>;
  // Capture the real location object BEFORE any setPathname override so we
  // can restore it in afterAll without leaving window.location undefined.
  const nativeLocation = window.location;

  beforeEach(() => {
    pushStateSpy = vi.spyOn(history, 'pushState').mockImplementation(() => {});
    replaceStateSpy = vi.spyOn(history, 'replaceState').mockImplementation(() => {});
  });

  afterEach(() => {
    pushStateSpy.mockRestore();
    replaceStateSpy.mockRestore();
  });

  afterAll(() => {
    // Restore the native window.location so subsequent test files that read
    // window.location.pathname don't get undefined.
    Object.defineProperty(window, 'location', {
      value: nativeLocation,
      writable: true,
      configurable: true,
    });
  });

  function setPathname(path: string) {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, pathname: path },
      writable: true,
      configurable: true,
    });
  }

  it('pushRoute does NOT change URL when at / with default calculator route', () => {
    setPathname('/');
    pushRoute({ activeTab: 'calculator', calcolatoreSubTab: 'calculator' });
    expect(pushStateSpy).not.toHaveBeenCalled();
  });

  it('replaceRoute does NOT change URL when at / with default calculator route', () => {
    setPathname('/');
    replaceRoute({ activeTab: 'calculator', calcolatoreSubTab: 'calculator' });
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it('pushRoute does NOT change URL when at /en/ with default calculator route', () => {
    setPathname('/en/');
    pushRoute({ activeTab: 'calculator', calcolatoreSubTab: 'calculator' });
    expect(pushStateSpy).not.toHaveBeenCalled();
  });

  it('pushRoute DOES change URL when at / with non-default calculator sub-tab', () => {
    setPathname('/');
    pushRoute({ activeTab: 'calculator', calcolatoreSubTab: 'whatif' });
    expect(pushStateSpy).toHaveBeenCalled();
  });

  it('pushRoute DOES change URL when at / with non-calculator tab', () => {
    setPathname('/');
    pushRoute({ activeTab: 'confronti', confrontiSubTab: 'exchange' });
    expect(pushStateSpy).toHaveBeenCalled();
  });

  it('pushRoute works normally for non-root paths', () => {
    setPathname('/calcola-stipendio');
    pushRoute({ activeTab: 'confronti', confrontiSubTab: 'exchange' });
    expect(pushStateSpy).toHaveBeenCalled();
  });

  it('parsePath("/") returns the default calculator route', () => {
    const { route } = parsePath('/');
    expect(route.activeTab).toBe('calculator');
    expect(route.calcolatoreSubTab).toBe('calculator');
  });

  it('parsePath("/calcola-stipendio") also returns the default calculator route', () => {
    const { route } = parsePath('/calcola-stipendio');
    expect(route.activeTab).toBe('calculator');
    expect(route.calcolatoreSubTab).toBe('calculator');
  });
});

/* ─────────── Query-string preservation (autologin regression) ─────────── */

describe('Router — query string preservation', () => {
  // Regression: newsletter autologin URLs (?ne=…&ac=…) must survive
  // canonical URL rewrites triggered on initial mount. If pushRoute /
  // replaceRoute / updatePathForLocale drop location.search when calling
  // history.{push,replace}State, App.tsx's autologin useEffect reads an
  // empty search string and bails with "skip: no token".
  let pushStateSpy: ReturnType<typeof vi.fn>;
  let replaceStateSpy: ReturnType<typeof vi.fn>;
  // Capture the real location object BEFORE any setLocation override so we
  // can restore it in afterAll without leaving window.location undefined.
  const nativeLocation = window.location;

  beforeEach(() => {
    pushStateSpy = vi.spyOn(history, 'pushState').mockImplementation(() => {});
    replaceStateSpy = vi.spyOn(history, 'replaceState').mockImplementation(() => {});
  });

  afterEach(() => {
    pushStateSpy.mockRestore();
    replaceStateSpy.mockRestore();
  });

  afterAll(() => {
    // Restore the native window.location so subsequent test files that read
    // window.location.pathname don't get undefined.
    Object.defineProperty(window, 'location', {
      value: nativeLocation,
      writable: true,
      configurable: true,
    });
  });

  function setLocation(pathname: string, search = '', hash = '') {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, pathname, search, hash },
      writable: true,
      configurable: true,
    });
  }

  const AUTOLOGIN_SEARCH = '?ne=casarijenny5%40gmail.com&ac=5b4a42b1c867643c386f6802f2e2de4546114ff2fc0c025265be3c02af8026c8&utm_medium=newsletter';

  it('pushRoute preserves ?ne=…&ac=… when canonicalizing the current path', () => {
    setLocation('/compara-servizi/cambio-franco-euro', AUTOLOGIN_SEARCH);
    pushRoute({ activeTab: 'confronti', confrontiSubTab: 'exchange' });
    expect(pushStateSpy).toHaveBeenCalled();
    const newUrl = pushStateSpy.mock.calls[0]?.[2] as string;
    expect(newUrl).toContain('ne=casarijenny5');
    expect(newUrl).toContain('ac=5b4a42b1c867');
    expect(newUrl).toContain('utm_medium=newsletter');
  });

  it('replaceRoute preserves ?ne=…&ac=… when canonicalizing the current path', () => {
    setLocation('/compara-servizi/cambio-franco-euro', AUTOLOGIN_SEARCH);
    replaceRoute({ activeTab: 'confronti', confrontiSubTab: 'exchange' });
    expect(replaceStateSpy).toHaveBeenCalled();
    const newUrl = replaceStateSpy.mock.calls[0]?.[2] as string;
    expect(newUrl).toContain('ne=casarijenny5');
    expect(newUrl).toContain('ac=5b4a42b1c867');
  });

  it('pushRoute keeps both search and hash when both are present', () => {
    setLocation('/compara-servizi/cambio-franco-euro', '?ne=user%40example.com&ac=deadbeef');
    pushRoute({ activeTab: 'confronti', confrontiSubTab: 'exchange', hash: 'tool' });
    expect(pushStateSpy).toHaveBeenCalled();
    const newUrl = pushStateSpy.mock.calls[0]?.[2] as string;
    expect(newUrl).toContain('?ne=user');
    expect(newUrl).toContain('ac=deadbeef');
    expect(newUrl).toContain('#tool');
    // search must come before the hash fragment
    expect(newUrl.indexOf('?')).toBeLessThan(newUrl.indexOf('#'));
  });

  it('updatePathForLocale preserves query string when switching locale from locale-root', () => {
    setLocation('/', '?ne=user%40example.com&ac=deadbeef');
    updatePathForLocale('en');
    expect(replaceStateSpy).toHaveBeenCalled();
    const newUrl = replaceStateSpy.mock.calls[0]?.[2] as string;
    expect(newUrl).toContain('/en/');
    expect(newUrl).toContain('ne=user');
    expect(newUrl).toContain('ac=deadbeef');
  });

  it('updatePathForLocale preserves query string when switching locale on a deep page', () => {
    setLocation('/compara-servizi/cambio-franco-euro', '?ne=user%40example.com&ac=deadbeef');
    updatePathForLocale('en');
    expect(replaceStateSpy).toHaveBeenCalled();
    const newUrl = replaceStateSpy.mock.calls[0]?.[2] as string;
    expect(newUrl).toContain('ne=user');
    expect(newUrl).toContain('ac=deadbeef');
  });

  it('updatePathForLocale navigates to translated border municipality static pages', () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: {
        ...window.location,
        pathname: '/vivere-in-ticino/comuni-di-frontiera/cantello/',
        search: '?ne=user%40example.com&ac=deadbeef',
        hash: '#dogana',
        assign: assignSpy,
      },
      writable: true,
      configurable: true,
    });

    updatePathForLocale('en');

    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(assignSpy).toHaveBeenCalledWith(
      '/en/living-in-ticino/border-municipalities/cantello/?ne=user%40example.com&ac=deadbeef#dogana',
    );
  });

  it('updatePathForLocale translates VB border municipality slugs (villadossola)', () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: {
        ...window.location,
        pathname: '/vivere-in-ticino/comuni-di-frontiera/villadossola/',
        search: '',
        hash: '',
        assign: assignSpy,
      },
      writable: true,
      configurable: true,
    });

    updatePathForLocale('de');

    expect(assignSpy).toHaveBeenCalledWith(
      '/de/leben-im-tessin/grenzgemeinden/villadossola/',
    );
  });

  it('pushRoute still works (and writes empty search) when no query string is present', () => {
    setLocation('/compara-servizi/cambio-franco-euro', '');
    pushRoute({ activeTab: 'confronti', confrontiSubTab: 'exchange' });
    expect(pushStateSpy).toHaveBeenCalled();
    const newUrl = pushStateSpy.mock.calls[0]?.[2] as string;
    expect(newUrl).not.toContain('?');
  });

  it('pushRoute drops JobBoard ?q=… when navigating to a different path', () => {
    // Regression: ?q=Infermieri must not survive when leaving /cerca-lavoro-ticino/
    setLocation('/cerca-lavoro-ticino', '?q=Infermieri');
    pushRoute({ activeTab: 'calculator', calcolatoreSubTab: 'whatif' });
    expect(pushStateSpy).toHaveBeenCalled();
    const newUrl = pushStateSpy.mock.calls[0]?.[2] as string;
    expect(newUrl).not.toContain('q=Infermieri');
  });

  it('pushRoute keeps ?q=… when staying on the same path (intra-page filter)', () => {
    setLocation('/cerca-lavoro-ticino', '?q=Infermieri');
    pushRoute({ activeTab: 'job-board' });
    // pushState may or may not fire depending on path canonicalization; if it
    // does, the q must be preserved (same path = filter belongs to this page).
    if (pushStateSpy.mock.calls.length > 0) {
      const newUrl = pushStateSpy.mock.calls[0]?.[2] as string;
      expect(newUrl).toContain('q=Infermieri');
    }
  });

  it('pushRoute drops job-board ?q=… but keeps ?ne=… autologin on cross-path navigation', () => {
    setLocation('/cerca-lavoro-ticino', '?q=Infermieri&ne=user%40example.com&ac=token123');
    pushRoute({ activeTab: 'calculator', calcolatoreSubTab: 'whatif' });
    expect(pushStateSpy).toHaveBeenCalled();
    const newUrl = pushStateSpy.mock.calls[0]?.[2] as string;
    expect(newUrl).not.toContain('q=Infermieri');
    expect(newUrl).toContain('ne=user');
    expect(newUrl).toContain('ac=token123');
  });
});

describe('Router — legacy bare English slugs', () => {
  it('parsePath("/calculator") resolves to calculator tab', () => {
    const { route } = parsePath('/calculator');
    expect(route.activeTab).toBe('calculator');
  });

  it('parsePath("/stats") resolves to stats tab', () => {
    const { route } = parsePath('/stats');
    expect(route.activeTab).toBe('stats');
  });

  it('parsePath("/guide") resolves to guida tab', () => {
    const { route } = parsePath('/guide');
    expect(route.activeTab).toBe('guida');
  });

  it('parsePath("/lavoro") resolves to job-board tab (IT intuitive alias)', () => {
    const { route, locale } = parsePath('/lavoro');
    expect(route.activeTab).toBe('job-board');
    expect(locale).toBe('it');
    // Bare alias is the live SPA job board — must NOT be staticOverlay, else
    // the publisher-ad detail branch would shadow it and wipe the SPA listing.
    expect(route.staticOverlay).toBeFalsy();
  });

  it('parsePath("/lavoro/<slug>/") keeps staticOverlay (publisher ad detail)', () => {
    // build-plugins/publisherAdPagesPlugin emits a static page per publisher ad
    // at /lavoro/<slug>/ (+ locale variants). Without staticOverlay the SPA
    // routes the slug to a missing job-board lookup → "Annuncio non trovato".
    for (const url of [
      '/lavoro/fisioterapista-diplomato-lugano/',
      '/en/lavoro/fisioterapista-diplomato-lugano/',
      '/de/lavoro/fisioterapista-diplomato-lugano/',
      '/fr/lavoro/fisioterapista-diplomato-lugano/',
    ]) {
      const { route } = parsePath(url);
      expect(route.activeTab, url).toBe('job-board');
      expect(route.staticOverlay, url).toBe(true);
    }
    expect(parsePath('/en/lavoro/test-slug/').locale).toBe('en');
  });

  it('parsePath("/en/jobs") resolves to job-board tab (EN intuitive alias)', () => {
    const { route, locale } = parsePath('/en/jobs');
    expect(route.activeTab).toBe('job-board');
    expect(locale).toBe('en');
  });

  it('parsePath("/de/jobs") resolves to job-board tab (DE intuitive alias)', () => {
    const { route, locale } = parsePath('/de/jobs');
    expect(route.activeTab).toBe('job-board');
    expect(locale).toBe('de');
  });

  it('parsePath("/fr/emploi") resolves to job-board tab (FR intuitive alias)', () => {
    const { route, locale } = parsePath('/fr/emploi');
    expect(route.activeTab).toBe('job-board');
    expect(locale).toBe('fr');
  });
});

describe('Router — Swiss-wide events index hub (issue #3645, F3)', () => {
  it('parsePath("/eventi/") resolves to the vita/places static overlay in IT', () => {
    const { route, locale } = parsePath('/eventi/');
    expect(route.activeTab).toBe('vita');
    expect(route.vitaSubTab).toBe('places');
    expect(route.staticOverlay).toBe(true);
    expect(locale).toBe('it');
  });

  it('parsePath("/eventi") (no trailing slash) still resolves — canonical link always emits the slash', () => {
    const { route } = parsePath('/eventi');
    expect(route.activeTab).toBe('vita');
    expect(route.staticOverlay).toBe(true);
  });

  it('resolves the bare index root for every locale variant', () => {
    const cases: Array<[string, Locale]> = [
      ['/eventi/', 'it'],
      ['/en/events/', 'en'],
      ['/de/veranstaltungen/', 'de'],
      ['/fr/evenements/', 'fr'],
    ];
    for (const [path, expectedLocale] of cases) {
      const { route, locale } = parsePath(path);
      expect(route.activeTab, path).toBe('vita');
      expect(route.staticOverlay, path).toBe(true);
      expect(locale, path).toBe(expectedLocale);
    }
  });

  it('does not swallow a per-canton hub (EVENTS_INDEX_PATTERN and EVENTS_PATH_PATTERN stay mutually exclusive)', () => {
    // Regression guard: EVENTS_INDEX_PATTERN's `^\/eventi\/?$` requires zero
    // chars after the segment, EVENTS_PATH_PATTERN's canton group requires
    // one-or-more — both existing side by side must never let the bare
    // index pattern intercept a real canton hub path.
    for (const path of ['/eventi/ticino/', '/en/events/zurich/', '/de/veranstaltungen/graubunden/', '/fr/evenements/vaud/']) {
      const { route } = parsePath(path);
      expect(route.activeTab, path).toBe('vita');
      expect(route.vitaSubTab, path).toBe('places');
      expect(route.staticOverlay, path).toBe(true);
    }
  });
});

/* ─────────── SPA over static (CLAUDE.md rule #14) ─────────── */

describe('Router — SPA equivalent wins over static landing', () => {
  // /calcola-stipendio/<slug>/ has TWO emitters: build-plugins/staticPagesPlugin
  // ships a SEO landing body (so crawlers see rich content) AND the slug is
  // declared in CALCOLATORE_SLUGS so the router resolves it to a real SPA
  // sub-tab. The router MUST return the sub-tab — App.tsx then hides the
  // static fallback so end users get the interactive calculator.
  it('confronta-retribuzione-ral routes to ral sub-tab without staticOverlay', () => {
    const { route, locale } = parsePath('/calcola-stipendio/confronta-retribuzione-ral');
    expect(route.activeTab).toBe('calculator');
    expect(route.calcolatoreSubTab).toBe('ral');
    expect(route.staticOverlay).toBeFalsy();
    expect(locale).toBe('it');
  });

  it('verifica-congedo-parentale routes to parental-leave sub-tab without staticOverlay', () => {
    const { route, locale } = parsePath('/calcola-stipendio/verifica-congedo-parentale');
    expect(route.activeTab).toBe('calculator');
    expect(route.calcolatoreSubTab).toBe('parental-leave');
    expect(route.staticOverlay).toBeFalsy();
    expect(locale).toBe('it');
  });

  // Negative: known SEO landings (e.g. salary-80000 → stipendio-netto-80000-chf)
  // have no SPA equivalent — must keep staticOverlay so the static body owns
  // the page.
  it('stipendio-netto-80000-chf keeps staticOverlay (SEO landing, no SPA equivalent)', () => {
    const { route } = parsePath('/calcola-stipendio/stipendio-netto-80000-chf');
    expect(route.activeTab).toBe('calculator');
    expect(route.staticOverlay).toBe(true);
    expect(route.seoLanding).toBe('salary-80000');
  });

  // Programmatic salary-hub long-tail (no SEO_LANDING entry, numeric pattern
  // match) — also stays staticOverlay.
  it('stipendio-netto-77000-chf keeps staticOverlay via salaryHubSlug branch', () => {
    const { route } = parsePath('/calcola-stipendio/stipendio-netto-77000-chf');
    expect(route.activeTab).toBe('calculator');
    expect(route.staticOverlay).toBe(true);
    expect(route.salaryHubSlug).toBe('stipendio-netto-77000-chf');
  });

  // Related-search-clusters landings (build-plugins/relatedSearchClustersPlugin.ts):
  // emit /cerca-lavoro-ticino/ricerca-{slug}/ with rich curated job lists.
  // The slug passes through as `jobSlug`; JobBoard's parseSearchSlugFilter
  // (services/relatedSearchClusters.ts) detects the prefix and populates the
  // search bar + result grid. NOT staticOverlay — the static body is sr-only
  // (crawler-only) and the SPA must hydrate the interactive search view.
  it('ricerca-data-center-technician routes to JobBoard with jobSlug', () => {
    const { route } = parsePath('/cerca-lavoro-ticino/ricerca-data-center-technician');
    expect(route.activeTab).toBe('job-board');
    expect(route.jobSlug).toBe('ricerca-data-center-technician');
    expect(route.staticOverlay).toBeFalsy();
  });

  it('EN search-data-center-technician routes to JobBoard with jobSlug', () => {
    const { route } = parsePath('/en/find-jobs-ticino/search-data-center-technician');
    expect(route.activeTab).toBe('job-board');
    expect(route.jobSlug).toBe('search-data-center-technician');
    expect(route.staticOverlay).toBeFalsy();
  });

  it('DE suche-pflegefachperson routes to JobBoard with jobSlug', () => {
    const { route } = parsePath('/de/jobs-im-tessin/suche-pflegefachperson');
    expect(route.activeTab).toBe('job-board');
    expect(route.jobSlug).toBe('suche-pflegefachperson');
    expect(route.staticOverlay).toBeFalsy();
  });

  it('FR recherche-soignant routes to JobBoard with jobSlug', () => {
    const { route } = parsePath('/fr/trouver-emploi-tessin/recherche-soignant');
    expect(route.activeTab).toBe('job-board');
    expect(route.jobSlug).toBe('recherche-soignant');
    expect(route.staticOverlay).toBeFalsy();
  });

  // BARE search-index hub (no hyphen slug): relatedSearchClustersPlugin emits a
  // curated ~465-link static index at /cerca-lavoro-ticino/ricerca/ (+ en/search,
  // de/suche, fr/recherche). Unlike the hyphenated ricerca-{slug} landings above,
  // the bare hub has no interactive SPA equivalent — it MUST be staticOverlay so
  // the SPA keeps the curated list (no progressive re-render → no footer-bounce
  // CLS, no SEO loss). Exact-equality match in router.ts excludes the slugs above.
  it.each([
    ['/cerca-lavoro-ticino/ricerca/', 'it'],
    ['/en/find-jobs-ticino/search/', 'en'],
    ['/de/jobs-im-tessin/suche/', 'de'],
    ['/fr/trouver-emploi-tessin/recherche/', 'fr'],
  ])('bare search hub %s is staticOverlay (curated static index, not interactive SPA)', (url, loc) => {
    const { route, locale } = parsePath(url);
    expect(route.activeTab, url).toBe('job-board');
    expect(locale, url).toBe(loc);
    expect(route.staticOverlay, url).toBe(true);
    expect(route.jobSlug, url).toBeUndefined();
  });

  // Post-2026-05-28 cluster canonical migration: cluster pages now live at
  // /cerca-lavoro-svizzera/ricerca-{slug}/ (and per-locale aggregator
  // equivalents). The router must recognise these as `job-board` with the
  // `_AGGREGATE_` canton sentinel so the SPA renders the search-query view
  // without applying a canton filter — strictly more results than the
  // previous per-canton pinning.
  it('IT /cerca-lavoro-svizzera/ricerca-* routes to JobBoard with _AGGREGATE_ canton', () => {
    const { route } = parsePath('/cerca-lavoro-svizzera/ricerca-data-center-technician');
    expect(route.activeTab).toBe('job-board');
    expect(route.jobBoardCanton).toBe('_AGGREGATE_');
    expect(route.jobSlug).toBe('ricerca-data-center-technician');
    expect(route.staticOverlay).toBeFalsy();
  });

  it('EN /en/find-jobs-switzerland/search-* routes to JobBoard with _AGGREGATE_ canton', () => {
    const { route } = parsePath('/en/find-jobs-switzerland/search-data-center-technician');
    expect(route.activeTab).toBe('job-board');
    expect(route.jobBoardCanton).toBe('_AGGREGATE_');
    expect(route.jobSlug).toBe('search-data-center-technician');
    expect(route.staticOverlay).toBeFalsy();
  });

  // Salary-hub scenario index (build-plugins/salaryHubIndex.ts): emits the
  // curated index of all salary scenarios. Must keep staticOverlay so the
  // SPA does not replace it with the default calculator view.
  it('/calcola-stipendio/scenari/ keeps staticOverlay (scenario index)', () => {
    const { route } = parsePath('/calcola-stipendio/scenari');
    expect(route.activeTab).toBe('calculator');
    expect(route.staticOverlay).toBe(true);
  });

  it('/en/calculate-salary/scenarios/ keeps staticOverlay', () => {
    const { route } = parsePath('/en/calculate-salary/scenarios');
    expect(route.activeTab).toBe('calculator');
    expect(route.staticOverlay).toBe(true);
  });

  it('/de/gehalt-berechnen/szenarien/ keeps staticOverlay', () => {
    const { route } = parsePath('/de/gehalt-berechnen/szenarien');
    expect(route.activeTab).toBe('calculator');
    expect(route.staticOverlay).toBe(true);
  });

  it('/fr/calculer-salaire/scenarios/ keeps staticOverlay', () => {
    const { route } = parsePath('/fr/calculer-salaire/scenarios');
    expect(route.activeTab).toBe('calculator');
    expect(route.staticOverlay).toBe(true);
  });
});

describe('Router — registerJobSlugMap protects against slim-payload wipe', () => {
  it('does not overwrite a populated slug map when called with slim jobs that lack slugByLocale', () => {
    const slug = 'responsabile-pulizie-manutenzione-60-100-spital-schwyz-schwyz';
    registerJobSlugMap([
      {
        id: 'spital-schwyz-a273343ebd6e',
        canton: 'SZ',
        slug,
        slugByLocale: {
          it: slug,
          de: 'stv-leitung-reinigung-unterhalt-60-100-spital-schwyz-schwyz',
        },
      },
    ]);
    expect(getJobMetaForSlug(slug)).toMatchObject({ canton: 'SZ', id: 'spital-schwyz-a273343ebd6e' });

    // Second call mimics JobBoard.finalize() invoking registerJobSlugMap
    // with the size-trimmed /data/jobs-${locale}-index.json payload, which
    // carries `slug` + `previousSlugs` but no `slugByLocale`.
    registerJobSlugMap([
      { id: 'spital-schwyz-a273343ebd6e', canton: 'SZ', slug },
    ]);

    // Bridge resolution would break here if the empty payload wiped the
    // full map loaded from /data/jobs-slug-map.json.
    expect(getJobMetaForSlug(slug)).toMatchObject({ canton: 'SZ', id: 'spital-schwyz-a273343ebd6e' });
  });
});

/**
 * Article topic hubs (#5001) and the bare topic index above them (#5436).
 *
 * Both are static HTML emitted outside `#root` by
 * `build-plugins/topicClusterHubsPlugin.ts`, so both need `staticOverlay` or
 * React hydration replaces the served page. The index needs it for a sharper
 * reason than the hubs: `/articoli-frontaliere/argomenti/` is one segment past
 * the section hub, which is exactly the shape the `blog` tab's article-slug
 * parser reads as `blogSlug: 'argomenti'` — an id that does not exist. Without
 * the branch the page would render, then hydrate into a deferred-article view.
 */
describe('article topic hubs + topic index — staticOverlay', () => {
  const CASES: ReadonlyArray<{ path: string; locale: Locale; svizzera: boolean }> = [
    // The index — the level this test exists for.
    { path: '/articoli-frontaliere/argomenti/', locale: 'it', svizzera: false },
    { path: '/articoli-svizzera/argomenti/', locale: 'it', svizzera: true },
    { path: '/en/cross-border-articles/topics/', locale: 'en', svizzera: false },
    { path: '/de/schweiz-artikel/themen/', locale: 'de', svizzera: true },
    { path: '/fr/articles-frontalier/sujets/', locale: 'fr', svizzera: false },
    // A hub and a paginated hub under it, so the index cannot pass by
    // accidentally swallowing the family it belongs to.
    { path: '/articoli-frontaliere/argomenti/tasse-e-imposte/', locale: 'it', svizzera: false },
    { path: '/de/schweiz-artikel/themen/steuern/page-3/', locale: 'de', svizzera: true },
  ];

  for (const { path, locale, svizzera } of CASES) {
    it(`parsePath resolves ${path} to a staticOverlay blog route (no notFoundPath)`, () => {
      const { route, locale: parsedLocale, notFoundPath } = parsePath(path);
      expect(route.activeTab).toBe('blog');
      expect(route.staticOverlay).toBe(true);
      // The section decides which archive the SPA falls back to; getting it
      // wrong sends a svizzera reader to the frontaliere list.
      expect(route.blogSection).toBe(svizzera ? 'svizzera' : undefined);
      // The trap: never an article slug.
      expect(route.blogSlug).toBeUndefined();
      expect(parsedLocale).toBe(locale);
      expect(notFoundPath).toBeUndefined();
    });
  }

  it('does not staticOverlay a segment that is not the localized topic word', () => {
    // `/en/…/argomenti/` mixes the Italian segment into the English route:
    // it is not an emitted page, so claiming an overlay would hide a real 404.
    const { route } = parsePath('/en/cross-border-articles/argomenti/');
    expect(route.staticOverlay).toBeUndefined();
  });
});
