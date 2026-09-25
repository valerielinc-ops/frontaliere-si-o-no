/**
 * Regression: <footer> must NOT be inside #root on staticOverlay (SEO) pages.
 *
 * Bug A (commit 8d2c73d99): App.tsx removed the `!staticOverlay` guard on the
 * footer, causing it to render inside #root at y≈81px while the SEO content
 * (<main class="seo-static-content">) lives OUTSIDE #root further down the DOM.
 * Visually: user sees header → footer immediately → had to scroll down to reach
 * the SEO content.
 *
 * Fix (Approach A — portal):
 *   - htmlTemplate.ts emits <div id="footer-root"></div> AFTER
 *     <main class="seo-static-content"> in seoContentOutsideRoot mode.
 *   - App.tsx uses createPortal to render <footer> into #footer-root when
 *     staticOverlay is true, so the DOM order becomes:
 *       #root (header only) → <main seo-static-content> → #footer-root (footer)
 *
 * This test verifies the portal behaviour in a jsdom environment by manually
 * injecting the #footer-root div (mimicking what htmlTemplate.ts emits) and
 * asserting that the <footer> element is rendered into it, NOT inside #root.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import App from '@/App';

vi.mock('@/hooks/seoHelpers', () => ({
  enableRuntimeSeo: vi.fn(),
  isRuntimeSeoEnabled: vi.fn(() => false),
  updateMetaTags: vi.fn(),
  trackSectionView: vi.fn(),
  _resetRuntimeSeoForTests: vi.fn(),
}));

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

let rootDiv: HTMLDivElement;
let footerRootDiv: HTMLDivElement;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  window.history.replaceState(null, '', '/traffico-dogane/chiasso-brogeda/oggi/');
  document.body.innerHTML = '';

  // Create #root — the container React hydrates into, mirroring the real HTML page.
  rootDiv = document.createElement('div');
  rootDiv.id = 'root';
  document.body.appendChild(rootDiv);

  // Inject #footer-root div into document.body, mimicking what htmlTemplate.ts
  // emits for seoContentOutsideRoot pages (it appears AFTER the SEO main content).
  footerRootDiv = document.createElement('div');
  footerRootDiv.id = 'footer-root';
  document.body.appendChild(footerRootDiv);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
});

describe('Regression: footer position on staticOverlay SEO pages (Bug A portal fix)', () => {
  it('footer is portalled into #footer-root (NOT inside #root) when staticOverlay: true', () => {
    mockParsePath.mockImplementation(() => ({
      route: {
        activeTab: 'guida' as const,
        guidaSubTab: 'border' as const,
        staticOverlay: true,
      },
      locale: 'it' as const,
    }));

    // Render into the pre-existing #root div so the React tree lives inside it.
    render(<App />, { container: rootDiv });

    const footerEl = document.querySelector('footer');
    expect(footerEl, '<footer> must be present in the DOM').not.toBeNull();

    // The footer must NOT be a descendant of #root.
    expect(
      rootDiv.contains(footerEl),
      '<footer> must NOT be inside #root on staticOverlay pages'
    ).toBe(false);

    // The footer MUST be inside #footer-root.
    expect(
      footerRootDiv.contains(footerEl),
      '<footer> must be portalled into #footer-root on staticOverlay pages'
    ).toBe(true);
  });

  it('footer renders normally inside #root on regular (non-staticOverlay) pages', () => {
    mockParsePath.mockImplementation(() => ({
      route: {
        activeTab: 'calculator' as const,
      },
      locale: 'it' as const,
    }));

    // Render into the pre-existing #root div.
    render(<App />, { container: rootDiv });

    const footerEl = document.querySelector('footer');
    expect(footerEl, '<footer> must be present on regular pages').not.toBeNull();

    // On normal pages, footer stays inside #root as usual.
    expect(
      rootDiv.contains(footerEl),
      '<footer> must remain inside #root on non-staticOverlay pages'
    ).toBe(true);

    // #footer-root must remain empty on normal pages.
    expect(
      footerRootDiv.contains(footerEl),
      '<footer> must NOT be in #footer-root on non-staticOverlay pages'
    ).toBe(false);
  });
});
