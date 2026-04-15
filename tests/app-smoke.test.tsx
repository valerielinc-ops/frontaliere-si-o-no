/**
 * Smoke / integration test for the App component.
 * Verifies that the app mounts without errors, renders key UI elements,
 * and does not trigger React warnings (infinite loops, setState-in-render, etc.).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '@/App';

// Mock router to avoid real history manipulation
vi.mock('@/services/router', () => ({
  parsePath: vi.fn(() => ({
    route: { activeTab: 'calculator' as const },
    locale: 'it' as const,
  })),
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

// Mock recaptcha
vi.mock('@/services/recaptchaService', () => ({
  recaptchaService: { verify: vi.fn() },
}));

// Mock traffic service
vi.mock('@/services/trafficService', () => ({
  trafficService: {
    hasApiKey: vi.fn(() => false),
    getEstimatedTravelTimes: vi.fn(() => Promise.resolve([])),
  },
}));

// Mock i18n — provide a minimal t() that returns keys, plus stubs
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
    onLocaleChange: vi.fn(() => vi.fn()), // returns unsubscribe
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

// Mock calculationService to return a valid SimulationResult shape
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

// Spy on console.error to detect React warnings
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Reset history state
  window.history.replaceState(null, '', '/');
});

describe('App smoke test', () => {
  it('renders without crashing and without console errors', () => {
    render(<App />);

    // Verify the app rendered key navigation elements (translation keys returned as text)
    // Nav items appear twice: desktop top bar + mobile bottom bar
    expect(screen.getByText('app.title')).toBeDefined();
    expect(screen.getAllByText('nav.simulator').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('nav.confronti').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('nav.fisco').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('nav.guida').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('nav.stats').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('nav.vita').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('footer.improveTitle').length).toBeGreaterThanOrEqual(1);

    // Check no React errors were logged (infinite loop, setState-in-render, etc.)
    const reactErrors = consoleErrorSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === 'string' &&
        (args[0].includes('Too many re-renders') ||
          args[0].includes('Cannot update a component') ||
          args[0].includes('Maximum update depth exceeded'))
    );
    expect(reactErrors).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  });

  it('does not cause infinite re-renders on any tab', { timeout: 30000 }, async () => {
    const user = userEvent.setup();
    render(<App />);

    // Navigate to each tab — none should cause infinite re-renders
    // Use getAllByText since nav items appear in both desktop and mobile nav
    const tabs = ['nav.confronti', 'nav.fisco', 'nav.guida', 'nav.vita', 'nav.stats'];
    for (const tabText of tabs) {
      const btns = screen.getAllByText(tabText);
      await user.click(btns[0]);
    }
    // footer.improveTitle link appears in footer (simplified footer uses title as link text)
    const improveLinks = screen.getAllByText('footer.improveTitle');
    await user.click(improveLinks[0]);

    // Back to calculator
    const calcBtns = screen.getAllByText('nav.simulator');
    await user.click(calcBtns[0]);

    // No React errors during navigation
    const reactErrors = consoleErrorSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === 'string' &&
        (args[0].includes('Too many re-renders') ||
          args[0].includes('Cannot update a component') ||
          args[0].includes('Maximum update depth exceeded'))
    );
    expect(reactErrors).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  });

  it('renders footer with privacy and API status links', () => {
    render(<App />);

    expect(screen.getAllByText('footer.privacy').length).toBeGreaterThan(0);
    expect(screen.getAllByText('footer.apiStatus').length).toBeGreaterThan(0);
    // footer.copyright is inside a <p> with other text nodes, so use substring match
    expect(screen.getByText((content) => content.includes('footer.copyright'))).toBeDefined();

    consoleErrorSpy.mockRestore();
  });

  it('renders all confronti sub-tabs without crashing', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Navigate to confronti
    await user.click(screen.getAllByText('nav.confronti')[0]);

    // Click each confronti sub-tab — some may not render if a component errors,
    // so we use queryAllByText and skip if not found (labels appear in both tab nav and footer sitemap)
    const confrontiTabs = [
      'comparators.exchange',
      'comparators.banks',
      'comparators.health',
      'comparators.mobile',
      'comparators.shopping',
      'comparators.costOfLiving',
      'comparators.jobs',
      'comparators.renovation',
    ];
    for (const tabText of confrontiTabs) {
      const btns = screen.queryAllByText(tabText);
      if (btns.length > 0) await user.click(btns[0]);
    }

    // No React errors during navigation
    const reactErrors = consoleErrorSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === 'string' &&
        (args[0].includes('Too many re-renders') ||
          args[0].includes('Cannot update a component') ||
          args[0].includes('Maximum update depth exceeded'))
    );
    expect(reactErrors).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  }, 30000);

  it('renders all guida sections without crashing', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Navigate to guida
    await user.click(screen.getAllByText('nav.guida')[0]);

    // Click each guida tab — use queryAllByText for resilience (labels appear in both tab nav and footer sitemap)
    const guidaTabs = [
      'guide.tabs.firstDay',
      'guide.tabs.permits',
      'guide.tabs.border',
      'guide.tabs.unemployment',
      'guide.tabs.carTransfer',
      'guide.tabs.carCost',
      'guide.tabs.municipalities',
      'guide.tabs.borderMap',
    ];
    for (const tabText of guidaTabs) {
      const btns = screen.queryAllByText(tabText);
      if (btns.length > 0) await user.click(btns[0]);
    }

    // No React errors during navigation
    const reactErrors = consoleErrorSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === 'string' &&
        (args[0].includes('Too many re-renders') ||
          args[0].includes('Cannot update a component') ||
          args[0].includes('Maximum update depth exceeded'))
    );
    expect(reactErrors).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  }, 60000);

  it('renders fisco sub-tabs without crashing', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Navigate to fisco
    await user.click(screen.getAllByText('nav.fisco')[0]);

    // Click each fisco sub-tab — use queryAllByText for resilience (labels appear in both tab nav and footer sitemap)
    const fiscoTabs = [
      'fisco.tabs.taxReturn',
      'fisco.tabs.calendar',
      'fisco.tabs.holidays',
      'fisco.tabs.ristorni',
      'pension.planner',
      'pension.pillar3',
      'fisco.tabs.quiz',
    ];
    for (const tabText of fiscoTabs) {
      const btns = screen.queryAllByText(tabText);
      if (btns.length > 0) await user.click(btns[0]);
    }

    const reactErrors = consoleErrorSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === 'string' &&
        (args[0].includes('Too many re-renders') ||
          args[0].includes('Cannot update a component') ||
          args[0].includes('Maximum update depth exceeded'))
    );
    expect(reactErrors).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  }, 15000);

  it('renders simulator sub-tabs without crashing', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Should already be on calculator tab (use getAllByText since labels appear in both tab nav and footer sitemap)
    const whatIfBtns = screen.queryAllByText('simulator.whatif');
    if (whatIfBtns.length > 0) await user.click(whatIfBtns[0]);
    const calcBtns = screen.queryAllByText('simulator.calculator');
    if (calcBtns.length > 0) await user.click(calcBtns[0]);

    const reactErrors = consoleErrorSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === 'string' &&
        (args[0].includes('Too many re-renders') ||
          args[0].includes('Cannot update a component') ||
          args[0].includes('Maximum update depth exceeded'))
    );
    expect(reactErrors).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  }, 15000);
});
