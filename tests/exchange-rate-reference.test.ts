import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// Il tasso vero cambia ogni giorno: qui conta che la costante segua il file.
vi.mock('../data/exchange-rate-snapshot.json', () => ({ currentRate: 1.0777, rateDate: '2026-10-30' }));

import { DEFAULT_EXCHANGE_RATE, DEFAULT_EXCHANGE_RATE_DATE } from '../constants';
import { buildSpreadExample } from '../services/spreadExample';
import { buildReferenceNetScenario } from '../services/referenceNetScenario';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

describe('tasso CHF/EUR di riferimento', () => {
  it('è quello dello snapshot di /cambio-franco-euro/, con la sua data', () => {
    expect(DEFAULT_EXCHANGE_RATE).toBe(1.0777);
    expect(DEFAULT_EXCHANGE_RATE_DATE).toBe('2026-10-30');
  });

  it('il comparatore non ha un secondo tasso live', () => {
    const source = read('components/comparators/CurrencyExchange.tsx');
    expect(source).not.toContain('useExchangeRate');
    expect(source).toContain('const realRate = DEFAULT_EXCHANGE_RATE;');
  });

  it('le pagine non ripetono il cambio rovesciato 0,94', () => {
    const inverted = /(?<![\d.,])0[,.]94(?:00)?(?!\d)\s*(?:EUR|\)|euro)|1 CHF = 0[,.]9/;
    for (const rel of [
      'build-plugins/editorialContent.ts',
      'components/fisco/NewFrontierTaxSimHub.tsx',
      'components/shared/LeadMagnetCTA.tsx',
      'services/seo/faq-translations.ts',
      'services/locales/it-comparatori.ts',
      'services/locales/en-comparatori.ts',
      'services/locales/de-comparatori.ts',
      'services/locales/fr-comparatori.ts',
    ]) {
      expect(read(rel), rel).not.toMatch(inverted);
    }
  });

  it("l'esempio sullo spread segue il tasso e il formato della lingua", () => {
    expect(buildSpreadExample(1.1, 'it').real).toBe('1,1000');
    expect(buildSpreadExample(1.1, 'en-US').real).toBe('1.1000');
    expect(buildSpreadExample(1.1, 'en-US').spread).toBe('2.66');
  });
});

describe('scenario netto di riferimento', () => {
  it('ricompone il netto dal lordo, nel motore del calcolatore', () => {
    const s = buildReferenceNetScenario(1.08, '2026-10-30');
    expect(s.grossCHF - s.socialCHF - s.sourceTaxCHF).toBeCloseTo(s.swissNetCHF, 6);
    expect(s.newNetMonthlyCHF).toBeCloseTo(s.newNetAnnualCHF / 12, 6);
    expect(s.newNetAnnualEUR).toBeCloseTo(s.newNetAnnualCHF * 1.08, 6);
    expect(s.oldNetAnnualCHF).toBeGreaterThan(s.newNetAnnualCHF);
  });
});
