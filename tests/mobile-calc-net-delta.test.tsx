import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import MobileCalcLayout from '@/components/calculator/MobileCalcLayout';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'mobileCalc.salary': 'Stipendio',
        'input.frontierType': 'Tipo frontaliere',
        'input.newFrontier': 'Nuovo frontaliere',
        'input.postDate': 'Post 2024',
        'input.oldFrontier': 'Vecchio frontaliere',
        'input.preDate': 'Pre 2024',
        'input.within20km': 'Entro 20km',
        'input.over20km': 'Oltre 20km',
        'mobileCalc.betterIT': 'Meglio in Italia',
        'mobileCalc.betterCH': 'Meglio in Svizzera',
        'mobileCalc.savings': 'Risparmio',
        'mobileCalc.perMonth': '/mese',
        'mobileCalc.liveInCH': 'Vivo in CH',
        'mobileCalc.crossBorderIT': 'Frontaliere IT',
        'mobileCalc.viewFullAnalysis': 'Analisi completa',
        'mobileCalc.customize': 'Personalizza',
        'mobileCalc.adjustParams': 'Modifica parametri',
      };
      return map[key] || key;
    },
  }),
  getCantonI18nParams: () => ({} as Record<string, string>),
}));

vi.mock('@/services/analytics', () => ({
  Analytics: { trackEvent: vi.fn() },
}));

vi.mock('@/services/lazyRetry', () => ({
  lazyRetry: (loader: any) => {
    const React = require('react');
    return React.lazy(loader);
  },
}));

vi.mock('@/components/shared/ShareableResultCard', () => ({
  default: () => <div data-testid="share-card" />,
}));

vi.mock('@/components/shared/SubscriptionCTA', () => ({
  default: () => <div data-testid="subscription-cta" />,
}));

function buildResult(chMonthly: number, itMonthly: number) {
  return {
    chResident: {
      swissNetIncomeMonthlyCHF: chMonthly,
      netIncomeMonthly: chMonthly,
      netIncomeAnnual: chMonthly * 12,
    },
    itResident: {
      netIncomeMonthly: itMonthly,
      netIncomeAnnual: itMonthly * 12,
      taxes: 0,
    },
    savingsCHF: chMonthly - itMonthly,
    savingsEUR: (chMonthly - itMonthly) * 0.92 * 12,
    monthsBasis: 12,
    exchangeRate: 0.92,
  } as any;
}

const baseInputs = {
  annualIncomeCHF: 80000,
  frontierWorkerType: 'NEW',
  distanceZone: 'WITHIN_20KM',
  age: 30,
  maritalStatus: 'SINGLE',
  spouseWorks: false,
  children: 0,
};

describe('MobileCalcLayout net delta badge', () => {
  it('shows temporary-style delta badges on the mobile result card when net values change', () => {
    const setInputs = vi.fn();
    const { rerender } = render(
      <MobileCalcLayout
        inputs={baseInputs as any}
        setInputs={setInputs}
        onCalculate={vi.fn()}
        result={buildResult(5000, 4700)}
      />,
    );

    expect(screen.queryByText(/\+CHF/i)).toBeNull();

    rerender(
      <MobileCalcLayout
        inputs={{ ...baseInputs, annualIncomeCHF: 85000 } as any}
        setInputs={setInputs}
        onCalculate={vi.fn()}
        result={buildResult(5300, 4900)}
      />,
    );

    expect(screen.getByText('+CHF 300')).toBeInTheDocument();
    expect(screen.getByText('+CHF 200')).toBeInTheDocument();
  });
});
