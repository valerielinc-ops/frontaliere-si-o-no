/**
 * Regression: <footer> renders on staticOverlay (SEO static-overlay) routes.
 *
 * Before the fix, App.tsx wrapped the <footer> in `{!staticOverlay && (...)}`,
 * which suppressed the footer on all SEO static-overlay pages
 * (e.g. /traffico-dogane/chiasso-brogeda/oggi/, /prezzi-diesel/lugano/oggi/,
 * /aziende-che-assumono/chiasso/settimana-corrente/, etc.).
 *
 * The footer is global chrome (newsletter signup, sitemap links, weekly
 * employers teaser, privacy/terms) and must always render regardless of
 * overlay mode. The static <main class="seo-static-content"> lives OUTSIDE
 * #root so there is no visual conflict.
 *
 * The fix: remove the `!staticOverlay` guard from the <footer> block in
 * App.tsx while keeping the guard on <main id="main-content"> (the React
 * content area that would visually replace the static SEO page).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '@/App';

// Mock seoHelpers to prevent runtimeSeoEnabled module-level state from bleeding
// across test files (isolate: false shares module registry per worker).
vi.mock('@/hooks/seoHelpers', () => ({
  enableRuntimeSeo: vi.fn(),
  isRuntimeSeoEnabled: vi.fn(() => false),
  updateMetaTags: vi.fn(),
  trackSectionView: vi.fn(),
  _resetRuntimeSeoForTests: vi.fn(),
}));

// Router mock — parsePath returns staticOverlay: true to simulate an SEO
// static-overlay route (e.g. border wait, fuel daily, weekly employers, etc.).
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
  window.history.replaceState(null, '', '/traffico-dogane/chiasso-brogeda/oggi/');
  document.body.innerHTML = '';
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
});

describe('Regression: footer renders on SEO static-overlay routes', () => {
  it('renders <footer> when parsePath returns staticOverlay: true', () => {
    // Simulate a border-wait SEO overlay page (guida/border sub-tab).
    mockParsePath.mockImplementation(() => ({
      route: { activeTab: 'guida' as const, guidaSubTab: 'border' as const, staticOverlay: true },
      locale: 'it' as const,
    }));

    render(<App />);

    // The <footer> HTML element must be present in the DOM.
    const footerEl = document.querySelector('footer');
    expect(
      footerEl,
      'document.querySelector("footer") must not be null on staticOverlay routes'
    ).not.toBeNull();
  });

  it('newsletter form is present in the footer on staticOverlay routes', () => {
    mockParsePath.mockImplementation(() => ({
      route: { activeTab: 'guida' as const, guidaSubTab: 'border' as const, staticOverlay: true },
      locale: 'it' as const,
    }));

    render(<App />);

    // The footer contains the NewsletterInline component (renders text key "newsletter.*"
    // or a visible "Newsletter" label). Check that the footer itself is present
    // and that 'footer.improveTitle' translation key is rendered (always present in footer).
    expect(screen.getAllByText('footer.improveTitle').length).toBeGreaterThan(0);
  });

  it('React <main id="main-content"> is still suppressed on staticOverlay routes', () => {
    mockParsePath.mockImplementation(() => ({
      route: { activeTab: 'guida' as const, guidaSubTab: 'border' as const, staticOverlay: true },
      locale: 'it' as const,
    }));

    render(<App />);

    // The React main content area must NOT render — the static SEO <main> owns the body.
    const reactMain = document.querySelector('main#main-content');
    expect(
      reactMain,
      'React <main id="main-content"> must remain suppressed in lite-shell mode'
    ).toBeNull();
  });
});
