import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BonusCalculator, { clampBonusNumericInput } from '@/components/calculator/BonusCalculator';

const exchangeRateMock = vi.hoisted(() => ({
 rate: 1.096,
 loading: false,
 refresh: vi.fn(),
}));

vi.mock('@/services/i18n', () => ({
 useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/services/exchangeRateService', () => ({
 useExchangeRate: () => exchangeRateMock,
}));

vi.mock('@/services/lazyRetry', () => ({
 lazyRetry: () => () => null,
}));

vi.mock('@/services/calculationService', () => ({
 calculateProgressiveWorkDeduction: () => 0,
 calculateProportionalTaxCredit: () => 0,
 calculateIrpefGross: () => 0,
 irpefMarginalRate: () => 0.23,
}));

afterEach(() => cleanup());

describe('BonusCalculator numeric inputs', () => {
 it('returns finite values inside the requested bounds', () => {
 expect(clampBonusNumericInput(-1, 0, 1_000_000, 5000)).toBe(0);
 expect(clampBonusNumericInput(2_000_000, 0, 1_000_000, 5000)).toBe(1_000_000);
 expect(clampBonusNumericInput(Number.NaN, 0, 1_000_000, 5000)).toBe(5000);
 expect(clampBonusNumericInput(Number.POSITIVE_INFINITY, 0, 1_000_000, 5000)).toBe(5000);
 });

 it('clamps each form field instead of propagating invalid numbers into the result', () => {
 render(<BonusCalculator />);

 const salary = document.getElementById('bonus-salary') as HTMLInputElement;
 const bonus = document.getElementById('bonus-amount') as HTMLInputElement;
 const children = document.getElementById('bonus-children') as HTMLInputElement;
 const exchange = document.getElementById('bonus-exchange') as HTMLInputElement;

 fireEvent.change(salary, { target: { value: '-100' } });
 expect(salary).toHaveValue(0);
 fireEvent.change(salary, { target: { value: '999999999' } });
 expect(salary).toHaveValue(1_000_000);
 fireEvent.change(salary, { target: { value: '' } });
 expect(salary).toHaveValue(7692);

 fireEvent.change(bonus, { target: { value: '-50' } });
 expect(bonus).toHaveValue(0);
 fireEvent.change(bonus, { target: { value: '999999999' } });
 expect(bonus).toHaveValue(1_000_000);
 fireEvent.change(bonus, { target: { value: '' } });
 expect(bonus).toHaveValue(5000);

 fireEvent.change(children, { target: { value: '-1' } });
 expect(children).toHaveValue(0);
 fireEvent.change(children, { target: { value: '99' } });
 expect(children).toHaveValue(10);
 fireEvent.change(children, { target: { value: '' } });
 expect(children).toHaveValue(1);

 fireEvent.change(exchange, { target: { value: '-1' } });
 expect(exchange).toHaveValue(0.5);
 fireEvent.change(exchange, { target: { value: '9' } });
 expect(exchange).toHaveValue(1.5);
 fireEvent.change(exchange, { target: { value: '' } });
 expect(exchange).toHaveValue(1.5);
 });
});
