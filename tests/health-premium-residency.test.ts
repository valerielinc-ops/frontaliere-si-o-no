import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { buildEuPremiumSnapshot } from '../scripts/fetch-eu-health-premiums.mjs';
import { euMonthlyPremium, isCurrentEuPremiumSnapshot, statutoryEuFranchise } from '../services/healthPremiumResidency';

const sourceUrl = 'https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf';
const fixture = (year: number) => readFileSync(`tests/fixtures/health-eu/italy-${year}.csv`, 'utf8');

describe('official country-of-residence premiums', () => {
  it.each([2026, 2027])('parses official %i country/age/accident codes without using canton rates', year => {
    const data = buildEuPremiumSnapshot(fixture(year), { year, sourceUrl });
    expect(isCurrentEuPremiumSnapshot(data, year)).toBe(true);
    expect(isCurrentEuPremiumSnapshot(data, year + 1)).toBe(false);
    expect(data.residenceBasis).toBe('country');
    expect(data.countries.IT.insurers['1562'].name).toBe('Helsana');
  });

  it('matches independent Priminfo PDF 2026 Italy pages 41–42', () => {
    const data = buildEuPremiumSnapshot(fixture(2026), { year: 2026, sourceUrl });
    const helsana = data.countries.IT.insurers['1562'];
    expect(euMonthlyPremium(helsana, '26+', false)).toBe(279);
    expect(euMonthlyPremium(helsana, '26+', true)).toBe(300);
    expect(euMonthlyPremium(helsana, '19-25', false)).toBe(251.1);
    expect(euMonthlyPremium(helsana, '0-18', false)).toBe(64.2);
    const aquilana = data.countries.IT.insurers['32'];
    expect(euMonthlyPremium(aquilana, '0-18', false)).toBe(82.4);
    expect(aquilana.premiums['0-18'].withoutAccident.K3).toBe(41.2);
  });

  it('rejects a future-year file instead of relabelling it as the requested year', () => {
    expect(() => buildEuPremiumSnapshot(fixture(2027), { year: 2026, sourceUrl })).toThrow(/year mismatch/);
  });

  it('rejects incomplete age/accident coverage', () => {
    const text = fixture(2026).split('\n').filter(line => !line.startsWith('1562,EU IT,EU,2026,2025,PR-REG EU0,AKL-ERW,OHN-UNF')).join('\n');
    expect(() => buildEuPremiumSnapshot(text, { year: 2026, sourceUrl })).toThrow(/Incomplete/);
  });

  it('fails closed on invalid runtime data and unavailable premiums', () => {
    expect(isCurrentEuPremiumSnapshot({ schemaVersion: 1, year: 2026, residenceBasis: 'country', sourceUrl, fetchedAt: new Date().toISOString(), countries: { IT: { insurers: { x: {} } } } }, 2026)).toBe(false);
    expect(euMonthlyPremium(undefined, '26+', false)).toBeNull();
  });

  it('limits Italian residents to the statutory deductible independently of previous UI selections', () => {
    expect(statutoryEuFranchise('0-18')).toBe(0);
    expect(statutoryEuFranchise('19-25')).toBe(300);
    expect(statutoryEuFranchise('26+')).toBe(300);
  });
});

describe('exact domestic premium dimensions', () => {
  it('retains official CH age, accident and deductible values instead of multiplying the adult base', async () => {
    const { parseCSV } = await import('../scripts/fetch-health-premiums.mjs');
    const { buildDomesticHealthQuotes, assertDomesticHealthQuotes } = await import('../scripts/lib/domestic-health-premiums.mjs');
    const { domesticMonthlyPremium } = await import('../services/healthPremiumResidency');
    const rows = parseCSV(readFileSync('tests/fixtures/health-eu/domestic-2027-sample.csv', 'utf8'));
    const { isOrdinaryBagChildTier } = await import('../scripts/lib/health-premium-codes.mjs');
    const ordinaryChild = rows.find(row => row.Altersklasse === 'AKA_01_KIN' && row.Franchise.endsWith('0000') && row.Unfalleinschluss === 'OHN_UNF');
    const thirdChildDiscount = { ...ordinaryChild, Altersuntergruppe: 'K3', 'Prämie': '20' };
    expect(isOrdinaryBagChildTier(ordinaryChild)).toBe(true);
    expect(isOrdinaryBagChildTier(thirdChildDiscount)).toBe(false);
    const quotes = buildDomesticHealthQuotes([...rows, thirdChildDiscount]);
    expect(assertDomesticHealthQuotes(quotes)).toBe(quotes);
    const css = quotes.AG['0']['8'];
    expect(domesticMonthlyPremium(css, '26+', true, 300, 'praxis')).toBe(549.5);
    expect(domesticMonthlyPremium(css, '26+', false, 2500, 'praxis')).toBe(391.7);
    expect(domesticMonthlyPremium(css, '19-25', false, 300, 'praxis')).toBe(383.3);
    expect(domesticMonthlyPremium(css, '0-18', false, 0, 'praxis')).toBe(122.7);
    expect(domesticMonthlyPremium(css, '26+', false, 300, 'hmo')).toBeNull();
    expect(domesticMonthlyPremium(undefined, '26+', false, 300, 'standard')).toBeNull();
    quotes.AG['0']['8'].ERW.withoutAccident['2500'].praxis = NaN;
    expect(() => assertDomesticHealthQuotes(quotes)).toThrow(/amount/);
  });
});
