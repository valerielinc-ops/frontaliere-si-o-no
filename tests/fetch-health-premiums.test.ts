import { describe, expect, it } from 'vitest';
import {
  assertHealthPremiumsOutput,
  assertHealthPremiumsSnapshot,
  HEALTH_PREMIUMS_VALIDATION_MINIMUMS,
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

const DETAIL_CANTONS = ['TI', 'GR', 'VS'] as const;

function makePremiumInsurers(basePremium: number) {
  return Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => {
      const standard = basePremium + index;
      return [String(index + 1), {
        standard,
        byAgeClass: Object.fromEntries(
          HEALTH_PREMIUMS_VALIDATION_MINIMUMS.requiredAgeClasses.map((ageClass) => [ageClass, { standard }]),
        ),
      }];
    }),
  );
}

function makeValidSnapshot() {
  const insurers = Array.from({ length: 10 }, (_, index) => ({
    id: String(index + 1),
    name: `Insurer ${index + 1}`,
  }));
  const communes: Record<string, Array<{ name: string; bfsNr: number; plz: string; region: number }>> = {};
  const premiums: Record<string, any> = {};
  const ranked: Array<{ municipality: string; canton: string; bfsNr: number; avgPremium: number; numInsurers: number }> = [];
  let bfsNr = 10000;
  let communeIndex = 0;

  for (const canton of DETAIL_CANTONS) {
    communes[canton] = [];
    for (let index = 0; index < HEALTH_PREMIUMS_VALIDATION_MINIMUMS.communesPerDetailCanton[canton]; index += 1) {
      const commune = canton === 'TI' && index === 0
        ? { name: 'Lugano', bfsNr: 5192, plz: '6823', region: 1 }
        : { name: `${canton} Commune ${index}`, bfsNr: bfsNr++, plz: String(1000 + communeIndex), region: (index % 3) + 1 };
      const municipality = `${commune.plz}-${commune.name}`;
      const basePremium = 400 + communeIndex;
      communes[canton].push(commune);
      premiums[municipality] = {
        canton,
        region: commune.region,
        bfsNr: commune.bfsNr,
        insurers: makePremiumInsurers(basePremium),
      };
      ranked.push({
        municipality,
        canton,
        bfsNr: commune.bfsNr,
        avgPremium: basePremium + 4.5,
        numInsurers: insurers.length,
      });
      communeIndex += 1;
    }
  }

  for (let index = 0; index < HEALTH_PREMIUMS_VALIDATION_MINIMUMS.cantonPremiumBlocks; index += 1) {
    premiums[`Canton-${index}`] = {
      type: 'canton',
      canton: `C${index}`,
      region: null,
      insurers: makePremiumInsurers(500 + index),
    };
  }

  return {
    fetchedAt: '2026-09-15T00:00:00.000Z',
    year: 2026,
    insurers,
    communes,
    premiums,
    rankings: {
      cheapest: ranked.slice(0, HEALTH_PREMIUMS_VALIDATION_MINIMUMS.rankingEntries),
      mostExpensive: ranked.slice(-HEALTH_PREMIUMS_VALIDATION_MINIMUMS.rankingEntries).reverse(),
    },
  };
}

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
    const malformed = makeValidSnapshot();
    malformed.premiums['6823-Lugano'].insurers['1'] = { byAgeClass: { ERW: {} } };
    expect(() => assertHealthPremiumsSnapshot(malformed, { expectedYear: 2026, requireLugano: true }))
      .toThrow('premium block 6823-Lugano is empty, malformed, or lacks required insurer/model coverage');
  });

  it('rejects a commune map that is non-empty but not the consumer shape', () => {
    const malformed = makeValidSnapshot();
    (malformed.communes.TI as unknown as Array<unknown>)[0] = { status: 'temporarily unavailable' };
    expect(() => assertHealthPremiumsSnapshot(malformed, { expectedYear: 2026, requireLugano: true }))
      .toThrow('TI commune entry has unexpected shape');
  });

  it('rejects truncated premium cardinality before checking mirrors', () => {
    const malformed = makeValidSnapshot();
    malformed.premiums = Object.fromEntries(Object.entries(malformed.premiums).slice(0, 1));
    expect(() => assertHealthPremiumsSnapshot(malformed, { expectedYear: 2026, requireLugano: true }))
      .toThrow(`premiums must contain exactly ${HEALTH_PREMIUMS_VALIDATION_MINIMUMS.premiumBlocks} blocks`);
  });

  it('rejects five missing canton blocks even when the remaining payload is non-empty', () => {
    const malformed = makeValidSnapshot();
    for (let index = 0; index < 5; index += 1) delete malformed.premiums[`Canton-${index}`];
    expect(() => assertHealthPremiumsSnapshot(malformed, { expectedYear: 2026, requireLugano: true }))
      .toThrow(`premiums must contain exactly ${HEALTH_PREMIUMS_VALIDATION_MINIMUMS.premiumBlocks} blocks`);
  });

  it('rejects a premium block with truncated insurer/model coverage', () => {
    const malformed = makeValidSnapshot();
    const lugano = malformed.premiums['6823-Lugano'];
    lugano.insurers = Object.fromEntries(
      Object.entries(lugano.insurers).slice(0, HEALTH_PREMIUMS_VALIDATION_MINIMUMS.minInsurersPerBlock)
        .map(([id, models]) => [id, { standard: models.standard }]),
    );
    expect(() => assertHealthPremiumsSnapshot(malformed, { expectedYear: 2026, requireLugano: true }))
      .toThrow('premium block 6823-Lugano is empty, malformed, or lacks required insurer/model coverage');
  });

  it('rejects ranking arrays that are non-empty but truncated', () => {
    const malformed = makeValidSnapshot();
    malformed.rankings.cheapest = malformed.rankings.cheapest.slice(0, 1);
    malformed.rankings.mostExpensive = malformed.rankings.mostExpensive.slice(0, 1);
    expect(() => assertHealthPremiumsSnapshot(malformed, { expectedYear: 2026, requireLugano: true }))
      .toThrow(`each ranking must contain exactly ${HEALTH_PREMIUMS_VALIDATION_MINIMUMS.rankingEntries} entries`);
  });

  it('requires every commune and ranking to have matching premium coverage', () => {
    const malformed = makeValidSnapshot();
    delete malformed.premiums['6823-Lugano'];
    malformed.premiums['6823-Replacement'] = {
      canton: 'TI',
      region: 1,
      bfsNr: 99999,
      insurers: makePremiumInsurers(500),
    };
    expect(() => assertHealthPremiumsSnapshot(malformed, { expectedYear: 2026, requireLugano: true }))
      .toThrow('premium block 6823-Replacement has no matching commune');
  });

  it('accepts a valid current-year snapshot and rejects an unexpected year', () => {
    const valid = makeValidSnapshot();
    expect(assertHealthPremiumsSnapshot(valid, { expectedYear: 2026, requireLugano: true })).toBe(valid);
    expect(() => assertHealthPremiumsSnapshot({ ...valid, year: 2025 }, { expectedYear: 2026, requireLugano: true }))
      .toThrow('expected year 2026, got 2025');
  });
});
