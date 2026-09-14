import { describe, expect, it } from 'vitest';
import {
  assertHealthPremiumsOutput,
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
});
