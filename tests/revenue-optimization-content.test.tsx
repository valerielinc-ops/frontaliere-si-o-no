/**
 * Regression tests for revenue-optimization content shipped on 2026-04-20:
 *  - 4 previously-orphaned AdSense units are wired into the single-source-of-truth
 *    registry (AUTHGATE_RAIL_LEFT / AUTHGATE_RAIL_RIGHT / JOBDETAIL_SIDEBAR_2 /
 *    ARTICLE_INLINE_MOBILE_2).
 *  - NewFrontierOver20KmHub renders the editorial paragraph targeting the GSC
 *    striking-distance query "calcolo tasse frontalieri oltre 20 km".
 *  - TicineseDialect renders the two new editorial blocks targeting
 *    "parole in dialetto ticinese".
 *
 * These tests guard against accidental removal of the slot constants or the
 * editorial HTML, both of which are load-bearing for the SEO / ad-inventory
 * strategy and easy to regress during refactors.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AD_SLOTS } from '@/services/adsenseSlots';

vi.mock('@/services/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/i18n')>();
  return {
    ...actual,
    useLocale: () => ['it' as const, vi.fn()],
    useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key, locale: 'it' as const }),
    t: (key: string, fallback?: string) => fallback ?? key,
    getLocale: () => 'it' as const,
    onLocaleChange: vi.fn(() => vi.fn()),
  };
});

vi.mock('@/services/router', () => ({
  buildPath: vi.fn(() => '/'),
  parsePath: vi.fn(() => ({ route: { activeTab: 'calculator' as const }, locale: 'it' as const })),
  pushRoute: vi.fn(),
  replaceRoute: vi.fn(),
}));

vi.mock('@/services/trafficService', () => ({
  trafficService: { getTrafficData: vi.fn(async () => []) },
  hasLiveTrafficData: vi.fn(() => false),
}));

// Analytics is mocked globally in tests/setup.tsx — no override needed here.
// ISOLATION NOTE: A Proxy-based override here persists in the shared module registry
// (isolate: false) and breaks assertion-based analytics tests in later files.

vi.mock('@/services/errorReporter', () => ({
  reportCaughtError: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('@/services/calculationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/calculationService')>();
  const mockTaxResult = {
    grossIncome: 60000,
    familyAllowance: 0,
    socialContributions: 8400,
    taxableIncome: 51600,
    taxes: 5400,
    healthInsurance: 4800,
    customExpensesTotal: 0,
    netIncomeAnnual: 46200,
    netIncomeMonthly: 3850,
    currency: 'CHF' as const,
    breakdown: [],
    details: { regime: 'OVER_20KM', effectiveRate: 10.5, source: 'Test', notes: [] },
  };
  return {
    ...actual,
    calculateSimulation: vi.fn(() => ({
      chResident: { ...mockTaxResult },
      itResident: { ...mockTaxResult, currency: 'EUR' as const },
      savingsCHF: 0,
      savingsEUR: 0,
      exchangeRate: 0.92,
      monthsBasis: 12,
    })),
  };
});

describe('AD_SLOTS — registry shape (post 2026-04-26 prune)', () => {
  it('keeps the high-RPM long-form companion slot', () => {
    expect(AD_SLOTS.ARTICLE_INLINE_MOBILE_2.slot).toMatch(/^\d+$/);
    expect(AD_SLOTS.ARTICLE_INLINE_MOBILE_2.format).toBe('fluid');
    expect((AD_SLOTS.ARTICLE_INLINE_MOBILE_2 as { layout?: string }).layout).toBe('in-article');
  });

  it('does not expose the pruned desktop-rail / sidebar-2 slots', () => {
    expect((AD_SLOTS as Record<string, unknown>).AUTHGATE_RAIL_LEFT).toBeUndefined();
    expect((AD_SLOTS as Record<string, unknown>).AUTHGATE_RAIL_RIGHT).toBeUndefined();
    expect((AD_SLOTS as Record<string, unknown>).JOBDETAIL_SIDEBAR_2).toBeUndefined();
    expect((AD_SLOTS as Record<string, unknown>).ARTICLE_RAIL_LEFT).toBeUndefined();
    expect((AD_SLOTS as Record<string, unknown>).ARTICLE_RAIL_RIGHT).toBeUndefined();
  });
});

describe('NewFrontierOver20KmHub — striking-distance content', () => {
  it('renders the editorial section with the target query phrase', async () => {
    const { default: NewFrontierOver20KmHub } = await import(
      '@/components/calculator/NewFrontierOver20KmHub'
    );
    const { container } = render(<NewFrontierOver20KmHub />);
    expect(
      screen.getByText(/Come si calcolano le tasse del frontaliere oltre 20 km/i),
    ).toBeDefined();
    expect(container.textContent).toContain('tassazione esclusiva svizzera');
  });

  it('includes the worked CHF 60\'000 example with concrete net figures', async () => {
    const { default: NewFrontierOver20KmHub } = await import(
      '@/components/calculator/NewFrontierOver20KmHub'
    );
    const { container } = render(<NewFrontierOver20KmHub />);
    const text = container.textContent ?? '';
    expect(text).toContain("60'000");
    expect(text).toContain("3'820");
    expect(text).toContain("3'880");
  });
});

describe('TrafficAlerts — Chiasso Brogeda striking-distance editorial', () => {
  it('renders the Chiasso/Brogeda editorial block when deep-linked to a chiasso crossing', async () => {
    const { default: TrafficAlerts } = await import('@/components/guide/TrafficAlerts');
    const { container } = render(<TrafficAlerts initialCrossingId="chiasso-centro" />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/Traffico dogana Chiasso e Brogeda/i);
    // Key phrases that target the "traffico dogana chiasso brogeda" query + supporting tips.
    expect(text).toContain('Chiasso Brogeda');
    expect(text).toContain('orari di punta');
    expect(text).toMatch(/Bizzarone|Novazzano|Ponte Chiasso/);
  });

  it('does NOT render the Chiasso editorial block on non-chiasso crossings', async () => {
    const { default: TrafficAlerts } = await import('@/components/guide/TrafficAlerts');
    const { container } = render(<TrafficAlerts initialCrossingId="gaggiolo" />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Traffico dogana Chiasso e Brogeda/i);
  });
});

describe('TicineseDialect — expanded editorial content', () => {
  it('renders the "10 work expressions" section and the "differences" section', async () => {
    const { default: TicineseDialect } = await import('@/components/vita/TicineseDialect');
    const { container } = render(<TicineseDialect />);

    expect(
      screen.getByText(/Le 10 espressioni in dialetto più usate al lavoro in Ticino/i),
    ).toBeDefined();
    expect(
      screen.getByText(/Differenze tra dialetto ticinese e italiano standard/i),
    ).toBeDefined();

    // Sanity: the work-expressions paragraph mentions at least one of the
    // canonical dialect phrases, proving the body (not just the heading) rendered.
    const text = container.textContent ?? '';
    expect(text).toMatch(/Vèm a bev un cicchètt|Fa minga el sciatì/);
  });
});
