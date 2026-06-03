/**
 * Regression test for lite-shell vs full-shell rendering.
 *
 * Lite-shell mode (staticOverlay === true): the URL matches a build-time
 * static SEO page with no SPA equivalent (per-station fuel, per-canton health
 * premiums, per-city employer hubs, etc.). The SEO HTML lives in a sibling
 * `<main class="seo-static-content">` OUTSIDE `#root`. The SPA hydrates the
 * full chrome (top nav + SubTabNav + footer) on top so the page stays
 * interactive, but the React `<main id="main-content">` is NOT rendered —
 * the static SEO body owns the page body.
 *
 * Full-shell mode (staticOverlay === false): normal SPA routes (homepage,
 * calculator) render the React `<main>`. If a `<main class="seo-static-content">`
 * fallback was emitted at build time (because the URL is also a SEO landing
 * whose slug matches a real SPA sub-tab, e.g. confronta-retribuzione-ral →
 * ral), App.tsx hides it so the hydrated SPA view is what the user sees.
 * Crawlers without JS continue to receive the original static HTML.
 * See CLAUDE.md rule #14.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '@/App';

// Mock seoHelpers to prevent enableRuntimeSeo() from setting module-level
// runtimeSeoEnabled = true, which persists across test files (isolate: false).
vi.mock('@/hooks/seoHelpers', () => ({
  enableRuntimeSeo: vi.fn(),
  isRuntimeSeoEnabled: vi.fn(() => false),
  updateMetaTags: vi.fn(),
  trackSectionView: vi.fn(),
  _resetRuntimeSeoForTests: vi.fn(),
}));

// Router mocks — `parsePath` is re-assigned per test to flip staticOverlay.
const mockParsePath = vi.fn();

vi.mock('@/services/router', () => ({
  parsePath: (path: string) => mockParsePath(path),
  parseHashToPath: vi.fn(() => null),
  pushRoute: vi.fn(),
  replaceRoute: vi.fn(),
  buildPath: vi.fn(() => '/'),
  buildAllLocalePaths: vi.fn(() => ({ it: '/', en: '/en/', de: '/de/', fr: '/fr/' })),
  getSeoSection: vi.fn(() => 'home'),
  updatePathForLocale: vi.fn(),
  scrollToAnchor: vi.fn(() => false),
  getHashSection: vi.fn((_keys: readonly string[], fallback: string) => fallback),
  preloadBlogData: vi.fn(() => Promise.resolve()),
  resolveBlogSlug: vi.fn(() => undefined),
  ALL_GLOSSARY_TERM_IDS: [],
  ALL_BORDER_CROSSING_IDS: [],
}));

vi.mock('@/services/recaptchaService', () => ({
  recaptchaService: { verify: vi.fn() },
}));

vi.mock('@/services/trafficService', () => ({
  trafficService: {
    hasApiKey: vi.fn(() => false),
    getEstimatedTravelTimes: vi.fn(() => Promise.resolve([])),
  },
}));

vi.mock('@/services/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/i18n')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      locale: 'it' as const,
    }),
    t: (key: string) => key,
    getLocale: () => 'it' as const,
    setLocale: vi.fn(),
    initLocale: vi.fn(),
    onLocaleChange: vi.fn(() => vi.fn()),
    useLocale: () => ['it' as const, vi.fn()],
    loadBlogTranslations: vi.fn(() => Promise.resolve()),
    loadBlogMeta: vi.fn(() => Promise.resolve()),
    loadArticleBody: vi.fn(() => Promise.resolve()),
    loadTabTranslations: vi.fn(() => Promise.resolve()),
    loadAllTranslations: vi.fn(() => Promise.resolve()),
    itReady: Promise.resolve(),
    isTranslationsReady: () => true,
    LOCALE_LABELS: {
      it: { flag: '🇮🇹', name: 'Italian', nativeName: 'Italiano' },
      en: { flag: '🇬🇧', name: 'English', nativeName: 'English' },
      de: { flag: '🇩🇪', name: 'German', nativeName: 'Deutsch' },
      fr: { flag: '🇫🇷', name: 'French', nativeName: 'Français' },
    },
  };
});

const mockTaxResult = {
  grossIncome: 80000,
  familyAllowance: 0,
  socialContributions: 8000,
  taxableIncome: 72000,
  taxes: 7200,
  healthInsurance: 4800,
  customExpensesTotal: 0,
  netIncomeAnnual: 60000,
  netIncomeMonthly: 5000,
  currency: 'CHF' as const,
  breakdown: [{ label: 'Quellensteuer', amount: 400, percentage: 5 }],
  details: { regime: 'Quellensteuer', effectiveRate: 10, source: 'Test', notes: [] },
};
vi.mock('@/services/calculationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/calculationService')>();
  return {
    ...actual,
    calculateSimulation: vi.fn(() => ({
      chResident: { ...mockTaxResult },
      itResident: { ...mockTaxResult, currency: 'EUR' as const },
      savingsCHF: 500,
      savingsEUR: 460,
      exchangeRate: 0.92,
      monthsBasis: 12,
    })),
  };
});

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  window.history.replaceState(null, '', '/');
  document.body.innerHTML = '';
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
});

describe('App lite-shell (staticOverlay) rendering', () => {
  it('full-shell: homepage renders SubTabNav AND <main> AND <footer>', () => {
    mockParsePath.mockImplementation(() => ({
      route: { activeTab: 'calculator' as const },
      locale: 'it' as const,
    }));

    render(<App />);

    // Full shell renders <main id="main-content">
    const mainEl = document.querySelector('main#main-content');
    expect(mainEl, 'full-shell must render React <main>').not.toBeNull();

    // Footer still present
    expect(screen.getAllByText('footer.improveTitle').length).toBeGreaterThan(0);

    // SubTabNav uses role="tablist" too (the main top-nav also uses it);
    // the SubTabNav has `aria-selected` buttons without `aria-label` on tablist.
    // In full shell we expect at least TWO tablists (top nav + one SubTabNav).
    const tablists = document.querySelectorAll('[role="tablist"]');
    expect(
      tablists.length,
      'full-shell must render top-nav tablist AND SubTabNav tablist (>=2)'
    ).toBeGreaterThanOrEqual(2);
  });

  it('lite-shell: SEO static page renders top nav + footer, but NO SubTabNav and NO React <main>', () => {
    // Inject the static SEO marker that lite-shell detection looks for.
    const staticMain = document.createElement('main');
    staticMain.className = 'seo-static-content';
    staticMain.innerHTML = '<h1>Static SEO Content</h1>';
    document.body.appendChild(staticMain);

    // Router reports a staticOverlay route (e.g. per-station fuel page).
    mockParsePath.mockImplementation(() => ({
      route: { activeTab: 'stats' as const, staticOverlay: true },
      locale: 'it' as const,
    }));

    render(<App />);

    // Top-level nav tabs still render (user can navigate back to SPA).
    expect(screen.getAllByText('nav.simulator').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('nav.stats').length).toBeGreaterThanOrEqual(1);

    // Footer MUST render in lite-shell mode — it contains global chrome
    // (newsletter, sitemap links, weekly employers teaser).
    expect(screen.getAllByText('footer.improveTitle').length).toBeGreaterThan(0);
    const footerEl = document.querySelector('footer');
    expect(footerEl, 'lite-shell must render <footer> for newsletter + sitemap chrome').not.toBeNull();

    // React <main id="main-content"> is NOT rendered (static content owns the page body).
    const reactMain = document.querySelector('main#main-content');
    expect(reactMain, 'lite-shell must not render React <main id="main-content">').toBeNull();

    // The static SEO <main class="seo-static-content"> is preserved AND visible.
    const staticSeoMain = document.querySelector<HTMLElement>('main.seo-static-content');
    expect(staticSeoMain, 'static SEO <main> must be preserved in DOM').not.toBeNull();
    expect(
      staticSeoMain?.style.display,
      'static SEO <main> must stay visible in lite-shell mode'
    ).not.toBe('none');

    // Chrome must be fully hydrated: top-nav tablist AND the relevant SubTabNav
    // tablist render so the static SEO page is interactive (user can navigate
    // sections without losing the SPA shell).
    const tablists = document.querySelectorAll('[role="tablist"]');
    const subTabNavs = Array.from(tablists).filter(
      (el) => el.getAttribute('aria-label') !== 'Navigazione principale'
    );
    expect(
      subTabNavs.length,
      'lite-shell must hydrate the SubTabNav so the SPA chrome stays interactive'
    ).toBeGreaterThanOrEqual(1);
  });

  it('static hub-subnav DOM-deduplication: SPA removes the build-time nav.seo-hub-subnav that sits outside #root', () => {
    // Build plugins (staticPagesPlugin via renderHubChromeSplit) ship a
    // server-rendered `<nav class="seo-hub-subnav">` as a sibling of
    // `<main class="seo-static-content">` so the sub-nav is on screen during
    // first paint. After hydration the SPA renders its OWN interactive
    // SubTabNav inside `#root` — without cleanup the user sees two sub-nav
    // bars (one static, one hydrated). Regression for "due nav bar" bug on
    // /calcola-stipendio/* pages reported 2026-05-18 after PR #250.
    const staticSubnav = document.createElement('nav');
    staticSubnav.className = 'seo-hub-subnav border-t border-edge bg-surface';
    staticSubnav.setAttribute('aria-label', 'Hub navigation');
    staticSubnav.setAttribute('data-hub', 'calculator');
    staticSubnav.innerHTML = '<a data-static-marker="true" href="/calcola-stipendio/">tab</a>';
    document.body.appendChild(staticSubnav);

    const staticMain = document.createElement('main');
    staticMain.className = 'seo-static-content';
    staticMain.innerHTML = '<h1>Static SEO Content</h1>';
    document.body.appendChild(staticMain);

    mockParsePath.mockImplementation(() => ({
      route: { activeTab: 'calculator' as const, staticOverlay: true },
      locale: 'it' as const,
    }));

    render(<App />);

    // The build-time nav (marked with data-static-marker) must be gone after
    // hydration — its anchor was a body-direct sibling of <main>.
    const staleMarker = document.querySelector('[data-static-marker]');
    expect(
      staleMarker,
      'static seo-hub-subnav outside #root must be removed on SPA hydration'
    ).toBeNull();

    // The SPA's own hydrated SubTabNav must remain — it lives nested inside
    // the App wrapper (not as a body-direct child), so the deduplication
    // sweep leaves it untouched.
    const liveSubnavs = Array.from(
      document.querySelectorAll<HTMLElement>('nav.seo-hub-subnav')
    );
    expect(
      liveSubnavs.length,
      'hydrated SubTabNav must survive the deduplication'
    ).toBeGreaterThanOrEqual(1);
    expect(
      liveSubnavs.every((nav) => nav.parentElement !== document.body),
      'every remaining nav.seo-hub-subnav must be nested inside the App tree, not a body-direct sibling'
    ).toBe(true);
  });

  it('full-shell with static fallback: SPA renders <main> AND hides seo-static-content', () => {
    // The build emits a static SEO body for some URLs that ALSO resolve to a
    // real SPA route (e.g. /calcola-stipendio/confronta-retribuzione-ral →
    // calcolatoreSubTab: 'ral'). The SPA must take over for end users while
    // the static HTML stays in the source for crawlers without JS.
    const staticMain = document.createElement('main');
    staticMain.className = 'seo-static-content';
    staticMain.innerHTML = '<h1>SEO landing — visible to crawlers only</h1>';
    document.body.appendChild(staticMain);

    mockParsePath.mockImplementation(() => ({
      route: { activeTab: 'calculator' as const },
      locale: 'it' as const,
    }));

    render(<App />);

    // React <main> takes over.
    const reactMain = document.querySelector('main#main-content');
    expect(reactMain, 'SPA <main> must render when staticOverlay is falsy').not.toBeNull();

    // Static fallback stays in the DOM (crawlers still see it) but is hidden
    // from the user via inline display: none applied by the takeover useEffect.
    const staticSeoMain = document.querySelector<HTMLElement>('main.seo-static-content');
    expect(staticSeoMain, 'static fallback must remain in the DOM').not.toBeNull();
    expect(
      staticSeoMain?.style.display,
      'static fallback must be hidden when SPA route takes over'
    ).toBe('none');
  });
});
