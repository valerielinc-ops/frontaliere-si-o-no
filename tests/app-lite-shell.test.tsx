/**
 * Regression test for lite-shell vs full-shell rendering.
 *
 * Lite-shell mode (staticOverlay === true): the URL matches a build-time
 * static SEO page (per-station fuel, per-canton health premiums, per-city
 * employer hubs, etc.). The SEO HTML lives in a sibling
 * `<main class="seo-static-content">` OUTSIDE `#root`, so the React SPA must
 * render ONLY minimal chrome (header/top-nav). It must NOT render:
 *  - the React `<main id="main-content">` (would replace the static page)
 *  - the per-tab `SubTabNav` (adds visual clutter + empty space below header)
 *
 * Full-shell mode (staticOverlay === false): normal SPA pages (homepage,
 * calculator, etc.) render the full UI including SubTabNav below the top nav.
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

  it('lite-shell: SEO static page renders top nav only, with NO footer, NO SubTabNav and NO React <main>', () => {
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

    // Footer must stay suppressed in lite shell so static SEO content starts
    // immediately after the hydrated top chrome.
    expect(screen.queryByText('footer.improveTitle')).toBeNull();

    // React <main id="main-content"> is NOT rendered (static content owns the page body).
    const reactMain = document.querySelector('main#main-content');
    expect(reactMain, 'lite-shell must not render React <main id="main-content">').toBeNull();

    // The static SEO <main class="seo-static-content"> is preserved in DOM.
    const staticSeoMain = document.querySelector('main.seo-static-content');
    expect(staticSeoMain, 'static SEO <main> must be preserved in DOM').not.toBeNull();

    // In lite shell only the main top-nav tablist (aria-label="Navigazione principale")
    // should be present — NO SubTabNav tablists.
    const tablists = document.querySelectorAll('[role="tablist"]');
    const subTabNavs = Array.from(tablists).filter(
      (el) => el.getAttribute('aria-label') !== 'Navigazione principale'
    );
    expect(
      subTabNavs.length,
      'lite-shell must suppress every SubTabNav (only top-nav tablist allowed)'
    ).toBe(0);
  });
});
