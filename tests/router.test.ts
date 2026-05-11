import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { buildPath, parsePath, pushRoute, replaceRoute, updatePathForLocale, registerJobSlugMap } from '@/services/router';

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
