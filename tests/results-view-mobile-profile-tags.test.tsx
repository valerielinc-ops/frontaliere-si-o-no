import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ResultsView } from '@/components/calculator/ResultsView';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      switch (key) {
        case 'common.years':
          return 'anni';
        case 'input.single':
          return 'Celibe/Nubile';
        case 'input.married':
          return 'Sposato/a';
        case 'input.divorced':
          return 'Divorziato/a';
        case 'input.widowed':
          return 'Vedovo/a';
        case 'input.spouseWorks':
          return 'Coniuge lavora';
        case 'input.noChildren':
          return 'no figli';
        case 'input.childrenCount':
          return `${params?.count ?? 0} figli`;
        case 'input.newFrontShort':
          return 'Nuovo';
        case 'input.oldFrontShort':
          return 'Vecchio';
        case 'results.comparativeAnalysis':
          return 'Analisi comparativa';
        case 'results.showCHF':
          return 'Mostra CHF';
        case 'results.showEUR':
          return 'Mostra EUR';
        case 'results.downloadPDF':
          return 'Scarica PDF';
        case 'results.share.button':
          return 'Condividi';
        case 'results.share.title':
          return 'Condividi';
        case 'results.share.text':
          return 'Testo';
        case 'mobileCalc.editParam':
          return 'Modifica parametro';
        default:
          return key;
      }
    },
  }),
  getCantonI18nParams: () => ({} as Record<string, string>),
}));

vi.mock('@/services/NavigationContext', () => ({
  useNavigationOptional: () => null,
}));

vi.mock('@/services/urlStateService', () => ({
  buildShareURL: () => 'https://example.com',
}));

describe('ResultsView mobile profile tags', () => {
  it('calls the correct handler when editable profile tags are tapped', () => {
    const onProfileTagClick = vi.fn();

    render(
      <ResultsView
        result={{
          chResident: {
            grossIncome: 80000,
            familyAllowance: 0,
            socialContributions: 10000,
            taxableIncome: 70000,
            taxes: 5000,
            healthInsurance: 4000,
            customExpensesTotal: 0,
            netIncomeAnnual: 61000,
            netIncomeMonthly: 5083,
            currency: 'CHF',
            breakdown: [],
            details: { regime: 'A', effectiveRate: 10, source: 'test', notes: [] },
          },
          itResident: {
            grossIncome: 80000,
            familyAllowance: 0,
            socialContributions: 8000,
            taxableIncome: 72000,
            taxes: 7000,
            healthInsurance: 0,
            customExpensesTotal: 0,
            netIncomeAnnual: 65000,
            netIncomeMonthly: 5416,
            currency: 'EUR',
            breakdown: [],
            details: { regime: 'B', effectiveRate: 12, source: 'test', notes: [] },
          },
          savingsCHF: 1000,
          savingsEUR: 920,
          exchangeRate: 0.92,
          monthsBasis: 12,
        } as any}
        inputs={{
          age: 30,
          maritalStatus: 'SINGLE',
          spouseWorks: false,
          children: 0,
          frontierWorkerType: 'NEW',
          distanceZone: 'WITHIN_20KM',
          annualIncomeCHF: 80000,
        } as any}
        onProfileTagClick={onProfileTagClick}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /30 anni/i }));
    expect(onProfileTagClick).toHaveBeenNthCalledWith(1, 'age');

    fireEvent.click(screen.getByRole('button', { name: /celibe\/nubile/i }));
    expect(onProfileTagClick).toHaveBeenNthCalledWith(2, 'maritalStatus');

    fireEvent.click(screen.getByRole('button', { name: /no figli/i }));
    expect(onProfileTagClick).toHaveBeenNthCalledWith(3, 'children');
  });
});
