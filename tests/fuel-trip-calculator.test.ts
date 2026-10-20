// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  calculateFuelTrip,
  convertFuelPrice,
  datedFuelExchangeRate,
  fuelTripCalculatorInlineScript,
  renderFuelTripCalculatorMarkup,
  type FuelTripCalculatorCopy,
  type FuelTripCalculatorInput,
} from '../build-plugins/shared/fuelTripCalculator';

const copy: FuelTripCalculatorCopy = {
  title: 'Trip cost calculator',
  description: 'Compare prices in the same currency and add your route costs.',
  assumptionNote: 'Starting values are assumptions and can be changed.',
  referencePrice: 'Reference price',
  alternativePrice: 'Alternative price',
  liters: 'Litres',
  additionalRoundTripKm: 'Additional round-trip km',
  roundTripHint: 'Enter the complete distance in both directions; it will not be doubled.',
  vehicleCostPerKm: 'Vehicle cost per km',
  otherTripCosts: 'Other trip costs',
  monthlyTrips: 'Trips per month',
  optional: 'optional',
  resultTitle: 'Result',
  gross: 'Gross difference',
  tripCosts: 'Trip costs',
  net: 'Net difference',
  monthlyNet: 'Monthly net difference',
  breakEvenKm: 'Break-even round-trip km',
  breakEvenLiters: 'Break-even litres',
  breakEvenUnavailable: 'Not applicable',
  incomplete: 'Complete the required fields.',
  invalid: 'Check the entered values.',
  positiveMeaning: 'A positive value favors the alternative after entered costs.',
  currency: 'Currency',
  sourceLabel: 'Initial value from',
  dateLabel: 'Initial price date',
  dateUnavailable: 'date unavailable',
  fxLabel: 'Dated ECB rate',
  noDatedFx: 'Different currencies are not compared without a dated ECB rate.',
};

const readyInput: FuelTripCalculatorInput = {
  referencePrice: 1.8,
  alternativePrice: 1.7,
  liters: 50,
  additionalRoundTripKm: 20,
  vehicleCostPerKm: 0.2,
  otherTripCosts: 3,
  monthlyTrips: 4,
};

const validRate = {
  provider: 'ECB',
  sourceUrl: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
  rateDate: '2026-10-16',
  chfPerEur: 0.95,
  eurPerChf: 1 / 0.95,
};

describe('fuel trip calculator', () => {
  it('calculates gross and net differences, total A/R cost, monthly totals and break-even', () => {
    const result = calculateFuelTrip(readyInput);

    expect(result.status).toBe('ready');
    expect(result.grossDifference).toBeCloseTo(5);
    expect(result.tripCosts).toBeCloseTo(7); // 20 km A/R × 0.20 + 3; no second ×2
    expect(result.netDifference).toBeCloseTo(-2);
    expect(result.monthlyGrossDifference).toBeCloseTo(20);
    expect(result.monthlyTripCosts).toBeCloseTo(28);
    expect(result.monthlyNetDifference).toBeCloseTo(-8);
    expect(result.breakEvenAdditionalRoundTripKm).toBeCloseTo(10);
    expect(result.breakEvenLiters).toBeCloseTo(70);
  });

  it('accepts explicit zero route costs and zero monthly trips', () => {
    const result = calculateFuelTrip({ ...readyInput, additionalRoundTripKm: 0, vehicleCostPerKm: 0, otherTripCosts: 0, monthlyTrips: 0 });
    expect(result.status).toBe('ready');
    expect(result.tripCosts).toBe(0);
    expect(result.monthlyNetDifference).toBe(0);
    expect(result.breakEvenAdditionalRoundTripKm).toBeNull();
    expect(result.breakEvenLiters).toBe(0);
  });

  it('returns incomplete rather than an apparent saving when either price or route input is missing', () => {
    expect(calculateFuelTrip({ ...readyInput, alternativePrice: null }).status).toBe('incomplete');
    expect(calculateFuelTrip({ ...readyInput, additionalRoundTripKm: null }).status).toBe('incomplete');
    expect(calculateFuelTrip({ ...readyInput, monthlyTrips: null }).monthlyNetDifference).toBeNull();
  });

  it.each([
    ['zero reference price', { ...readyInput, referencePrice: 0 }],
    ['negative alternative price', { ...readyInput, alternativePrice: -1 }],
    ['zero litres', { ...readyInput, liters: 0 }],
    ['negative litres', { ...readyInput, liters: -1 }],
    ['negative distance', { ...readyInput, additionalRoundTripKm: -1 }],
    ['negative car cost', { ...readyInput, vehicleCostPerKm: -0.1 }],
    ['negative extra cost', { ...readyInput, otherTripCosts: -1 }],
    ['negative frequency', { ...readyInput, monthlyTrips: -1 }],
    ['NaN price', { ...readyInput, referencePrice: Number.NaN }],
    ['infinite distance', { ...readyInput, additionalRoundTripKm: Number.POSITIVE_INFINITY }],
    ['gross overflow', { ...readyInput, referencePrice: 1e308, liters: 1e308 }],
    ['trip-cost overflow', { ...readyInput, additionalRoundTripKm: 1e308, vehicleCostPerKm: 1e308 }],
    ['monthly overflow', { ...readyInput, monthlyTrips: 1e308 }],
  ])('rejects invalid values (%s)', (_name, input) => {
    expect(calculateFuelTrip(input).status).toBe('invalid');
  });

  it('uses a conversion only when an ECB source and a consistent dated rate are present', () => {
    const rate = datedFuelExchangeRate(validRate);
    expect(rate?.rateDate).toBe('2026-10-16');
    expect(convertFuelPrice(1.9, 'CHF', 'EUR', rate)).toBeCloseTo(1.9 / 0.95);
    expect(convertFuelPrice(1.9, 'CHF', 'EUR', null)).toBeNull();
    expect(datedFuelExchangeRate({ ...validRate, rateDate: undefined })).toBeNull();
    expect(datedFuelExchangeRate({ ...validRate, provider: 'cache' })).toBeNull();
    expect(datedFuelExchangeRate({ ...validRate, sourceUrl: 'https://example.com/rates' })).toBeNull();
    expect(datedFuelExchangeRate({ ...validRate, eurPerChf: 99 })).toBeNull();
    expect(datedFuelExchangeRate({ ...validRate, rateDate: '2026-02-30' })).toBeNull();
  });

  it('renders price prefill and provenance while keeping unknown alternative prices blank', () => {
    const markup = renderFuelTripCalculatorMarkup({
      locale: 'it',
      fuel: 'benzina',
      currency: 'EUR',
      id: 'city-trip',
      referencePrice: 1.206,
      alternativePrice: null,
      referenceSource: 'MIMIT · Livigno sample',
      referenceDate: '20/10/2026',
      copy,
    });

    expect(markup).toContain('data-fuel-trip-calculator');
    expect(markup).toContain('value="1.206"');
    expect(markup).toMatch(/data-fuel-trip-field="alternativePrice"[^>]*value=""/);
    expect(markup).toContain('Initial value from: MIMIT · Livigno sample');
    expect(markup).toContain('Initial price date: 20/10/2026');
    expect(markup).toContain('50');
    expect(markup).toContain('0.18');
    expect(markup).toContain('will not be doubled');

    const unknownDateMarkup = renderFuelTripCalculatorMarkup({
      locale: 'en', fuel: 'benzina', currency: 'CHF', id: 'unknown-date-trip', referencePrice: 1.8,
      referenceSource: 'TCS sample average', copy,
    });
    expect(unknownDateMarkup).toContain('Initial price date: date unavailable');
  });
});

describe('static fuel calculator script', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (window as Window & { dataLayer?: unknown[] }).dataLayer = [];
  });

  it('serializes a standalone helper, starts incomplete, then calculates after user input without sending input values', () => {
    const markup = renderFuelTripCalculatorMarkup({
      locale: 'en',
      fuel: 'diesel',
      currency: 'CHF',
      id: 'regional-diesel-trip',
      referencePrice: 1.9,
      alternativePrice: 1.8,
      referenceSource: 'TCS sample average',
      alternativeSource: 'TCS · Sample station',
      referenceDate: '16.10.2026',
      alternativeDate: '16.10.2026',
      copy,
    });
    document.body.innerHTML = markup;

    const script = document.querySelector('[data-fuel-trip-calculator] script')?.textContent;
    expect(script).toBeTruthy();
    expect(() => new Function(script!)()).not.toThrow();
    const root = document.querySelector<HTMLElement>('[data-fuel-trip-calculator]')!;
    const output = root.querySelector<HTMLElement>('[data-fuel-trip-output]')!;
    expect(output.textContent).toContain(copy.incomplete);
    expect(root.querySelector('[data-fuel-trip-result="net"]')?.hasAttribute('hidden')).toBe(true);

    const km = root.querySelector<HTMLInputElement>('[data-fuel-trip-field="additionalRoundTripKm"]')!;
    km.value = '10';
    km.dispatchEvent(new Event('input', { bubbles: true }));

    expect(output.textContent).toBe('');
    expect(root.querySelector('[data-fuel-trip-result="gross"]')?.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('[data-fuel-trip-result="costs"] [data-fuel-trip-value]')?.textContent).toContain('1.80');
    expect(root.querySelector('[data-fuel-trip-result="net"] [data-fuel-trip-value]')?.textContent).toContain('3.20');
    expect((window as Window & { dataLayer?: unknown[] }).dataLayer).toEqual([{
      event: 'fuel_trip_calculated',
      fuel_type: 'diesel',
      render_path: 'static',
      outcome: 'positive',
    }]);

    km.value = '-1';
    km.dispatchEvent(new Event('input', { bubbles: true }));
    expect(output.textContent).toContain(copy.invalid);
    expect((window as Window & { dataLayer?: unknown[] }).dataLayer).toHaveLength(1);
  });

});
