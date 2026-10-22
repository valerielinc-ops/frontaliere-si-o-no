// @vitest-environment node
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { expect, it } from 'vitest';

it('executes the serialized calculator from an esbuild keepNames transform', () => {
  const source = readFileSync(new URL('../build-plugins/shared/fuelTripCalculator.ts', import.meta.url), 'utf8');
  const compiledModule = { exports: {} as Record<string, unknown> };
  const compiled = transformSync(source, { loader: 'ts', target: 'es2022', format: 'cjs', keepNames: true });
  new Function('module', 'exports', compiled.code)(compiledModule, compiledModule.exports);

  const inlineScript = compiledModule.exports.fuelTripCalculatorInlineScript as () => string;
  const script = inlineScript();
  expect(script).not.toContain('__name');

  const values: Record<string, string> = {
    referencePrice: '2',
    alternativePrice: '1.5',
    liters: '50',
    additionalRoundTripKm: '20',
    vehicleCostPerKm: '0.2',
    otherTripCosts: '1',
    monthlyTrips: '4',
  };
  const fields = Object.entries(values).map(([name, value]) => ({
    value,
    getAttribute: (attribute: string) => attribute === 'data-fuel-trip-field' ? name : null,
    addEventListener: () => undefined,
  }));
  const output = { textContent: '' };
  const root = {
    getAttribute: (name: string) => ({
      'data-currency': 'EUR',
      'data-locale': 'it',
      'data-fuel': 'benzina',
    }[name] ?? null),
    querySelectorAll: (selector: string) => selector === '[data-fuel-trip-field]' ? fields : [],
    querySelector: (selector: string) => selector === '[data-fuel-trip-output]' ? output : null,
  };
  const documentMock = { querySelectorAll: () => [root] };
  const windowMock: { dataLayer?: unknown[] } = {};

  expect(() => new Function('document', 'window', script)(documentMock, windowMock)).not.toThrow();
  expect(output.textContent).toBe('');
  expect(windowMock.dataLayer).toBeUndefined();
});
