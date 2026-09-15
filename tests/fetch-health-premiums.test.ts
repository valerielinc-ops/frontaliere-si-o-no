import { describe, expect, it } from 'vitest';
import {
  assertHealthPremiumsOutput,
  assertHealthPremiumsSnapshot,
  parseCSV,
  validatePremiumsCsvShape,
} from '../scripts/fetch-health-premiums.mjs';

const HEADER = [
  'Altersklasse',
  'Unfalleinschluss',
  'Hoheitsgebiet',
  'Kanton',
  'Region',
  'Versicherer',
  'Tariftyp',
  'Franchise',
  'Prämie',
  'Geschäftsjahr',
].join(';');

describe('health premiums producer guards', () => {
  it('rejects an empty BAG response before parsing rows', () => {
    expect(() => validatePremiumsCsvShape('\ufeff\r\n  ')).toThrow('BAG premiums CSV response is empty');
    expect(() => parseCSV('')).toThrow('BAG premiums CSV response is empty');
  });

  it('rejects a non-BAG or changed CSV header shape', () => {
    expect(() => parseCSV('status;message\nok;temporarily unavailable\n'))
      .toThrow('BAG premiums CSV has unexpected shape: missing required columns');
  });

  it('accepts a known BAG-shaped response and preserves its row', () => {
    const rows = parseCSV(`\ufeff${HEADER}\nAKL-ERW;OHN-UNF;CH;TI;TI-1;8;TAR-BASE;FRA-300;400.00;2026\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      Altersklasse: 'AKL-ERW',
      Unfalleinschluss: 'OHN-UNF',
      Hoheitsgebiet: 'CH',
      Prämie: '400.00',
      Geschäftsjahr: '2026',
    });
  });

  it('refuses to write an output with no usable premium or ranking entries', () => {
    expect(() => assertHealthPremiumsOutput({
      relevantPremiums: [],
      output: { insurers: [], premiums: {} },
      communeRankings: [],
    })).toThrow('Refusing to write incomplete health-premiums dataset');
  });

  it('accepts a sufficiently populated generated output', () => {
    const output = {
      insurers: Array.from({ length: 10 }, (_, index) => ({ id: index + 1 })),
      premiums: { '6823-Lugano': { insurers: {} } },
    };
    expect(assertHealthPremiumsOutput({
      relevantPremiums: [{ Altersklasse: 'AKL-ERW' }],
      output,
      communeRankings: [{ municipality: '6823-Lugano' }],
    })).toBe(output);
  });

  it('rejects a non-empty snapshot whose nested premium shape is unusable', () => {
    const malformed = {
      fetchedAt: '2026-09-15T00:00:00.000Z',
      year: 2026,
      insurers: Array.from({ length: 10 }, (_, index) => ({ id: String(index + 1), name: `Insurer ${index + 1}` })),
      communes: { TI: [] },
      premiums: { '6823-Lugano': { insurers: { '1': { byAgeClass: { ERW: {} } } } } },
      rankings: {
        cheapest: [{ municipality: '6823-Lugano', avgPremium: 400, numInsurers: 1 }],
        mostExpensive: [{ municipality: '6823-Lugano', avgPremium: 400, numInsurers: 1 }],
      },
    };
    expect(() => assertHealthPremiumsSnapshot(malformed, { expectedYear: 2026, requireLugano: true }))
      .toThrow('premium block 6823-Lugano is empty or malformed');
  });

  it('accepts a valid current-year snapshot and rejects an unexpected year', () => {
    const valid = {
      fetchedAt: '2026-09-15T00:00:00.000Z',
      year: 2026,
      insurers: Array.from({ length: 10 }, (_, index) => ({ id: String(index + 1), name: `Insurer ${index + 1}` })),
      communes: { TI: [] },
      premiums: {
        '6823-Lugano': {
          canton: 'TI',
          region: 1,
          insurers: { '1': { standard: 400, byAgeClass: { ERW: { standard: 400 } } } },
        },
      },
      rankings: {
        cheapest: [{ municipality: '6823-Lugano', avgPremium: 400, numInsurers: 1 }],
        mostExpensive: [{ municipality: '6823-Lugano', avgPremium: 400, numInsurers: 1 }],
      },
    };
    expect(assertHealthPremiumsSnapshot(valid, { expectedYear: 2026, requireLugano: true })).toBe(valid);
    expect(() => assertHealthPremiumsSnapshot({ ...valid, year: 2025 }, { expectedYear: 2026, requireLugano: true }))
      .toThrow('expected year 2026, got 2025');
  });
});
