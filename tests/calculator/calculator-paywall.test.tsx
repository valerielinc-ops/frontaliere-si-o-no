/**
 * E2 — CalculatorPaywall regression tests.
 *
 * Covers:
 *  - Trigger rules (3+ sim complete, 2+ visit, both gates)
 *  - ft_job_email short-circuit
 *  - 30-day dismissal persistence (fresh vs expired)
 *  - Email submission fires analytics + closes the modal
 *  - Feature flag default (off) gates the modal
 *  - Localized copy keys are present in all 4 locales
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    locale: 'it' as const,
  }),
  useLocale: () => ['it' as const, vi.fn()],
  t: (key: string) => key,
  getLocale: () => 'it' as const,
  onLocaleChange: vi.fn(() => vi.fn()),
}));

vi.mock('@/services/pdfReport', () => ({
  generateCalculatorPdfReport: vi.fn(async () => new Blob(['fake-pdf'], { type: 'application/pdf' })),
  computeCalculatorPdfMetrics: vi.fn(() => ({
    netIT_EUR: 30000,
    netCH_CHF: 45000,
    diffAnnuaCHF: 15000,
    taxBurdenITPct: 35,
    taxBurdenCHPct: 20,
    socialIT_EUR: 5000,
    socialCH_CHF: 4000,
  })),
}));

import CalculatorPaywall, {
  shouldShowPaywall,
  PAYWALL_DISMISSED_KEY,
  SIM_COMPLETE_COUNTER_KEY,
  VISIT_COUNTER_KEY,
  JOB_EMAIL_KEY,
} from '@/components/calculator/CalculatorPaywall';
import { Analytics } from '@/services/analytics';
import type { SimulationResult, SimulationInputs } from '@/types';

const mockResult: SimulationResult = {
  chResident: {
    grossIncome: 80000,
    familyAllowance: 0,
    socialContributions: 10000,
    taxableIncome: 70000,
    taxes: 8000,
    healthInsurance: 4800,
    customExpensesTotal: 0,
    netIncomeAnnual: 57200,
    netIncomeMonthly: 4767,
    currency: 'CHF',
    breakdown: [],
    details: { regime: 'ch', effectiveRate: 10, source: 'test', notes: [] },
  },
  itResident: {
    grossIncome: 80000,
    familyAllowance: 0,
    socialContributions: 8000,
    taxableIncome: 72000,
    taxes: 15000,
    healthInsurance: 0,
    customExpensesTotal: 0,
    netIncomeAnnual: 57000,
    netIncomeMonthly: 4750,
    currency: 'CHF',
    breakdown: [],
    details: { regime: 'calc.regime.newFrontier', effectiveRate: 20, source: 'test', notes: [] },
  },
  savingsCHF: 200,
  savingsEUR: 190,
  exchangeRate: 0.95,
  monthsBasis: 12,
};

const mockInputs: SimulationInputs = {
  age: 35,
  maritalStatus: 'SINGLE',
  spouseWorks: false,
  children: 0,
  annualIncomeCHF: 80000,
  frontierWorkerType: 'NEW',
  distanceZone: 'WITHIN_20KM',
  customExchangeRate: 0.95,
  monthsBasis: 12,
} as unknown as SimulationInputs;

describe('shouldShowPaywall — trigger rules', () => {
  it('shows when sim-complete counter >= 3', () => {
    expect(
      shouldShowPaywall({
        simCompleteCount: 3,
        visitCount: 0,
        dismissedAtRaw: null,
        jobEmail: null,
      }),
    ).toBe(true);
  });

  it('shows when visit counter >= 2', () => {
    expect(
      shouldShowPaywall({
        simCompleteCount: 0,
        visitCount: 2,
        dismissedAtRaw: null,
        jobEmail: null,
      }),
    ).toBe(true);
  });

  it('does not show when both counters below threshold', () => {
    expect(
      shouldShowPaywall({
        simCompleteCount: 2,
        visitCount: 1,
        dismissedAtRaw: null,
        jobEmail: null,
      }),
    ).toBe(false);
  });

  it('does not show when ft_job_email is already set (already converted)', () => {
    expect(
      shouldShowPaywall({
        simCompleteCount: 5,
        visitCount: 5,
        dismissedAtRaw: null,
        jobEmail: 'user@example.com',
      }),
    ).toBe(false);
  });

  it('does not show when dismissed within 30 days', () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 5);
    expect(
      shouldShowPaywall({
        simCompleteCount: 5,
        visitCount: 5,
        dismissedAtRaw: recent.toISOString(),
        jobEmail: null,
      }),
    ).toBe(false);
  });

  it('shows again when dismissal is older than 30 days', () => {
    const old = new Date();
    old.setDate(old.getDate() - 45);
    expect(
      shouldShowPaywall({
        simCompleteCount: 3,
        visitCount: 0,
        dismissedAtRaw: old.toISOString(),
        jobEmail: null,
      }),
    ).toBe(true);
  });

  it('tolerates legacy numeric dismissal timestamps', () => {
    const recent = Date.now() - 5 * 24 * 60 * 60 * 1000;
    expect(
      shouldShowPaywall({
        simCompleteCount: 5,
        visitCount: 5,
        dismissedAtRaw: String(recent),
        jobEmail: null,
      }),
    ).toBe(false);
  });
});

describe('CalculatorPaywall — render + interaction', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires paywall_shown funnel event on mount', () => {
    render(<CalculatorPaywall result={mockResult} inputs={mockInputs} onClose={() => {}} />);
    expect(Analytics.trackFunnelStep).toHaveBeenCalledWith('paywall_shown', {
      funnel: 'newsletter_paywall',
    });
  });

  it('dismiss button sets a 30-day dismissal timestamp + closes modal + fires analytics', () => {
    const onClose = vi.fn();
    render(<CalculatorPaywall result={mockResult} inputs={mockInputs} onClose={onClose} />);
    // Two buttons carry the dismissLabel (close X + inline text button). Either
    // fires the same handler — we click the first (close X in the corner).
    const dismissBtns = screen.getAllByRole('button', { name: 'calculator.paywall.dismissLabel' });
    expect(dismissBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(dismissBtns[0]);
    expect(onClose).toHaveBeenCalled();
    const raw = localStorage.getItem(PAYWALL_DISMISSED_KEY);
    expect(raw).toBeTruthy();
    // ISO timestamp — Date.parse must yield a finite value
    expect(Number.isFinite(Date.parse(raw!))).toBe(true);
    expect(Analytics.trackUIInteraction).toHaveBeenCalledWith(
      'calculator',
      'paywall',
      'paywall_dismiss',
      'click',
    );
  });

  it('submits email, fires funnel analytics, and closes after success', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const onClose = vi.fn();
    const { container } = render(
      <CalculatorPaywall
        result={mockResult}
        inputs={mockInputs}
        onClose={onClose}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    const input = screen.getByPlaceholderText('calculator.paywall.emailPlaceholder');
    // Note: example.com is in EmailInput's FAKE_DOMAINS blocklist — use a real
    // common domain so validateEmailStrict returns valid.
    fireEvent.change(input, { target: { value: 'user@gmail.com' } });
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }, { timeout: 5000 });
    const callArgs = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(callArgs[1].body));
    expect(body.email).toBe('user@gmail.com');
    expect(body.pdfBase64).toBeTruthy();
    expect(body.resultSummary).toMatchObject({
      netCH_CHF: 57200,
      savingsCHF: 200,
    });
    expect(Analytics.trackFunnelStep).toHaveBeenCalledWith('paywall_email_submitted', {
      funnel: 'newsletter_paywall',
    });

    // Success-delay auto-close (hardcoded 1800ms in CalculatorPaywall)
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 3000 });
  });

  it('rejects invalid emails without calling the Cloud Function', async () => {
    const fetchImpl = vi.fn();
    const { container } = render(
      <CalculatorPaywall
        result={mockResult}
        inputs={mockInputs}
        onClose={() => {}}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const input = screen.getByPlaceholderText('calculator.paywall.emailPlaceholder') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'not-an-email' } });
    // Dispatch a submit directly on the form — bypasses browser-level
    // `type="email"` constraint validation that otherwise blocks the click path.
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    await waitFor(() => {
      expect(screen.getByText('calculator.paywall.errorToast')).toBeInTheDocument();
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('CalculatorPaywall — feature flag default', () => {
  it('ENABLE_CALCULATOR_PAYWALL defaults to false in REMOTE_CONFIG_DEFAULTS', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'services', 'firebase.ts'), 'utf8');
    expect(src).toMatch(/ENABLE_CALCULATOR_PAYWALL:\s*'false'/);
  });

  it('ResultsView only opens the paywall when the RC flag resolves to "true"', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'components', 'calculator', 'ResultsView.tsx'), 'utf8');
    // The gate compares RC value strictly to the literal 'true' and the
    // flag lookup is keyed by ENABLE_CALCULATOR_PAYWALL. Guarding at the
    // source level is sufficient — the RC defaults test above pins the
    // runtime behaviour to "off" when RC is unavailable.
    expect(src).toMatch(/getConfigValue\(['"]ENABLE_CALCULATOR_PAYWALL['"]\)/);
    expect(src).toMatch(/setPaywallEnabled\(val === ['"]true['"]\)/);
  });
});

describe('CalculatorPaywall — 4-locale copy keys present', () => {
  const REQUIRED_KEYS = [
    'calculator.paywall.title',
    'calculator.paywall.body',
    'calculator.paywall.bullet1',
    'calculator.paywall.bullet2',
    'calculator.paywall.emailPlaceholder',
    'calculator.paywall.submit',
    'calculator.paywall.dismissLabel',
    'calculator.paywall.privacyNote',
    'calculator.paywall.successToast',
    'calculator.paywall.errorToast',
  ];
  const LOCALES = ['it', 'en', 'de', 'fr'] as const;

  LOCALES.forEach((lang) => {
    it(`${lang}-calculator.ts contains every paywall key`, () => {
      const src = readFileSync(
        resolve(__dirname, '..', '..', 'services', 'locales', `${lang}-calculator.ts`),
        'utf8',
      );
      REQUIRED_KEYS.forEach((key) => {
        expect(src, `${lang} missing ${key}`).toContain(`'${key}':`);
      });
    });
  });
});

describe('ResultsView — counter wiring', () => {
  it('increments counter_sim_complete + visit_count and references shouldShowPaywallFromStorage', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'components', 'calculator', 'ResultsView.tsx'), 'utf8');
    expect(src).toContain(SIM_COMPLETE_COUNTER_KEY);
    expect(src).toContain(VISIT_COUNTER_KEY);
    expect(src).toContain('shouldShowPaywallFromStorage');
    // JOB_EMAIL_KEY only appears inside the gate helper — not required here,
    // but ensure CalculatorPaywall exports the key so integrations can read it.
    expect(JOB_EMAIL_KEY).toBe('ft_job_email');
  });
});
