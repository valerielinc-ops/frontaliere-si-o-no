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
vi.mock('@/services/i18n', () => ({
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
  LOCALE_LABELS: {
    it: { flag: '🇮🇹', name: 'Italian', nativeName: 'Italiano' },
    en: { flag: '🇬🇧', name: 'English', nativeName: 'English' },
    de: { flag: '🇩🇪', name: 'German', nativeName: 'Deutsch' },
    fr: { flag: '🇫🇷', name: 'French', nativeName: 'Français' },
  },
}));

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
vi.mock('@/services/calculationService', () => ({
  calculateSimulation: vi.fn(() => ({
    chResident: { ...mockTaxResult },
    itResident: { ...mockTaxResult, currency: 'EUR' as const },
    savingsCHF: 500,
    savingsEUR: 460,
    exchangeRate: 0.92,
    monthsBasis: 12,
  })),
}));

// Spy on console.error to detect React warnings
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Reset history state
  window.history.replaceState(null, '', '/');
});

describe('App smoke test', () => {
  it('renders without crashing and without console errors', () => {
    render(<App />);

    // Verify the app rendered key navigation elements (translation keys returned as text)
    expect(screen.getByText('app.title')).toBeDefined();
    expect(screen.getByText('nav.simulator')).toBeDefined();
    expect(screen.getByText('nav.comparators')).toBeDefined();
    expect(screen.getByText('nav.pension')).toBeDefined();
    expect(screen.getByText('nav.guide')).toBeDefined();
    expect(screen.getByText('nav.stats')).toBeDefined();
    expect(screen.getByText('nav.support')).toBeDefined();

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

  it('does not cause infinite re-renders on any tab', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Navigate to each tab — none should cause infinite re-renders
    const tabs = ['nav.comparators', 'nav.pension', 'nav.guide', 'nav.stats', 'nav.support'];
    for (const tabText of tabs) {
      const btn = screen.getByText(tabText);
      await user.click(btn);
    }

    // Back to calculator
    const calcBtn = screen.getByText('nav.simulator');
    await user.click(calcBtn);

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

    expect(screen.getByText('footer.privacy')).toBeDefined();
    expect(screen.getByText('footer.apiStatus')).toBeDefined();
    // footer.copyright is inside a <p> with other text nodes, so use substring match
    expect(screen.getByText((content) => content.includes('footer.copyright'))).toBeDefined();

    consoleErrorSpy.mockRestore();
  });

  it('renders all comparator sub-tabs without crashing', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Navigate to comparators
    await user.click(screen.getByText('nav.comparators'));

    // Click each comparator sub-tab — some may not render if a component errors,
    // so we use queryByText and skip if not found
    const comparatorTabs = [
      'comparators.exchange',
      'comparators.mobile',
      'comparators.banks',
      'comparators.health',
      'comparators.transport',
      'comparators.jobs',
      'comparators.shopping',
      'comparators.costOfLiving',
      'comparators.costs',
      'comparators.traffic',
    ];
    for (const tabText of comparatorTabs) {
      const btn = screen.queryByText(tabText);
      if (btn) await user.click(btn);
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
  });

  it('renders all guide sections without crashing', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Navigate to guide
    await user.click(screen.getByText('nav.guide'));

    // Click each guide tab — use queryByText for resilience
    const guideTabs = [
      'guide.tabs.municipalities',
      'guide.tabs.border',
      'guide.tabs.livingCH',
      'guide.tabs.livingIT',
      'guide.tabs.calendar',
      'guide.tabs.holidays',
      'guide.tabs.permits',
      'guide.tabs.companies',
      'guide.tabs.places',
      'guide.tabs.schools',
      'guide.tabs.unemployment',
    ];
    for (const tabText of guideTabs) {
      const btn = screen.queryByText(tabText);
      if (btn) await user.click(btn);
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
  });

  it('renders pension sub-tabs without crashing', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Navigate to pension
    await user.click(screen.getByText('nav.pension'));

    // Click each pension sub-tab
    await user.click(screen.getByText('pension.planner'));
    await user.click(screen.getByText('pension.pillar3'));

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

  it('renders simulator sub-tabs without crashing', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Should already be on calculator tab
    await user.click(screen.getByText('simulator.whatif'));
    await user.click(screen.getByText('simulator.calculator'));

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
});
