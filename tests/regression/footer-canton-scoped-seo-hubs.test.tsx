/**
 * Regression (follow-up #959 / origin PR #954): canton-scoped footer SEO hubs.
 *
 * App.tsx renders a `data-testid="footer-seo-hubs"` <nav> whose links are
 * canton-aware. On a per-canton job-board route (e.g. /cerca-lavoro-basilea/)
 * the `isCantonScoped` branch must:
 *   (a) suppress the Ticino city chips (`/cerca-lavoro-ticino/<city>/`) and the
 *       Ticino company chips — otherwise every non-TI canton page leaks ~36
 *       Ticino internal links into its SEO link graph;
 *   (b) point the "Tutti i lavori →" / "Tutti i settori →" / "Tutte le aziende →"
 *       hubs at THAT canton's section (`/cerca-lavoro-basilea/...`).
 *
 * The previous bug (pre-PR #954) was the static footer always rendering the
 * Ticino scope. A silent regression of `isCantonScoped` (e.g. returning false
 * for some route) would re-inject the Ticino links with no test catching it.
 * This test locks the link-graph invariant by driving `parsePath` to a Basilea
 * job-board route and asserting the rendered footer.
 *
 * Pattern mirrors tests/regression/footer-on-seo-pages.test.tsx (renders <App />
 * with a mocked router so the heavy SPA tree boots in jsdom).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import App from '@/App';
import { hubSlugFor } from '@/build-plugins/seoHubsData';

vi.mock('@/hooks/seoHelpers', () => ({
  enableRuntimeSeo: vi.fn(),
  isRuntimeSeoEnabled: vi.fn(() => false),
  updateMetaTags: vi.fn(),
  trackSectionView: vi.fn(),
  _resetRuntimeSeoForTests: vi.fn(),
}));

// Router mock — parsePath returns a per-canton job-board route. The footer
// branch in App.tsx reads parsePath(window.location.pathname) directly, so the
// same mock implementation drives both the render route and the footer scope.
const mockParsePath = vi.fn();

vi.mock('@/services/router', () => ({
  parsePath: (path: string) => mockParsePath(path),
  parseHashToPath: vi.fn(() => null),
  pushRoute: vi.fn(),
  replaceRoute: vi.fn(),
  buildPath: vi.fn(() => '/'),
  buildAllLocalePaths: vi.fn(() => ({ it: '/', en: '/en/', de: '/de/', fr: '/fr/' })),
  getSeoSection: vi.fn(() => 'job-board'),
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

function mockBasilea() {
  mockParsePath.mockImplementation(() => ({
    route: { activeTab: 'job-board' as const, jobBoardCanton: 'BASILEA' },
    locale: 'it' as const,
  }));
}

function mockTicino() {
  mockParsePath.mockImplementation(() => ({
    route: { activeTab: 'job-board' as const, jobBoardCanton: 'TI' },
    locale: 'it' as const,
  }));
}

function getFooterHubsNav(): HTMLElement {
  const nav = document.querySelector<HTMLElement>('[data-testid="footer-seo-hubs"]');
  if (!nav) throw new Error('footer-seo-hubs nav not found in rendered <App />');
  return nav;
}

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  window.history.replaceState(null, '', '/cerca-lavoro-basilea/');
  document.body.innerHTML = '';
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
});

describe('Regression: canton-scoped footer SEO hubs (#959)', () => {
  it('a — emits NO Ticino city chips on a non-TI canton route', () => {
    mockBasilea();
    render(<App />);
    const hrefs = Array.from(getFooterHubsNav().querySelectorAll('a')).map(
      (a) => a.getAttribute('href') ?? '',
    );
    // No `/cerca-lavoro-ticino/<city>/` city/company chips may leak under Basilea.
    const tiCityChips = hrefs.filter((h) => /\/cerca-lavoro-ticino\/[a-z-]+\/?$/.test(h));
    expect(
      tiCityChips,
      `Ticino city/company chips leaked into the Basilea footer: ${tiCityChips.join(', ')}`,
    ).toHaveLength(0);
    // Stronger: no href in the canton-scoped footer may contain the Ticino section at all.
    expect(hrefs.some((h) => h.includes('cerca-lavoro-ticino'))).toBe(false);
  });

  it('b — points the "all hubs" links at the Basilea section', () => {
    mockBasilea();
    render(<App />);
    const hrefs = Array.from(getFooterHubsNav().querySelectorAll('a')).map(
      (a) => a.getAttribute('href') ?? '',
    );
    // The canton root hubs are produced by hubSlugFor(canton, locale, kind).
    expect(hrefs).toContain(hubSlugFor('BASILEA', 'it', 'tutti'));
    expect(hrefs).toContain(hubSlugFor('BASILEA', 'it', 'settori'));
    expect(hrefs).toContain(hubSlugFor('BASILEA', 'it', 'aziende'));
    // Sanity: the Basilea section slug is what we expect (no raw group key in URL).
    expect(hubSlugFor('BASILEA', 'it', 'tutti')).toBe('/cerca-lavoro-basilea/tutti/');
  });

  it('TI route keeps the legacy Ticino city chips (no over-suppression)', () => {
    mockTicino();
    render(<App />);
    const hrefs = Array.from(getFooterHubsNav().querySelectorAll('a')).map(
      (a) => a.getAttribute('href') ?? '',
    );
    // On the Ticino route the footer must still carry Ticino city chips.
    expect(hrefs.some((h) => /\/cerca-lavoro-ticino\/[a-z-]+\/$/.test(h))).toBe(true);
  });
});
