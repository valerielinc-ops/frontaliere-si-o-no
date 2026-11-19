import { describe, expect, it, vi } from 'vitest';
import { compareMonthlyRefresh } from '../scripts/compare-border-inventory-refresh.mjs';
import { buildFuelStationInventory } from '../scripts/update-fuel-station-inventory.mjs';
import { ITALY_PHARMACY_DATASET_PAGE, TICINO_PHARMACY_PDF_URL } from '../scripts/lib/pharmacy-border-parser.mjs';
import { OFCT_REGIONS } from '../scripts/lib/pharmacy-ticino-parser.mjs';

const first = '2026-11-01T00:00:00Z';

function fuel(...nodes: number[]) {
  return buildFuelStationInventory({
    features: nodes.map((node) => ({
      id: `node/${node}`,
      geometry: { type: 'Point', coordinates: [8.95, 46] },
      properties: { amenity: 'fuel', name: 'Same name' },
    })),
  }, { observedAt: '2026-10-31T23:59:59Z' });
}

const ticino = {
  id: 'ti-official-1',
  country: 'CH',
  canton: 'Ticino',
  sourceType: 'official',
  sourceUrl: TICINO_PHARMACY_PDF_URL,
};
const italy = {
  id: 'it-msal-10',
  ministryId: '10',
  country: 'IT',
  province: 'CO',
  sourceType: 'official',
  sourceUrl: ITALY_PHARMACY_DATASET_PAGE,
};
function pharmacyCatalogue<T>(...pharmacies: T[]) {
  return { _pharmacyCount: pharmacies.length, pharmacies };
}

describe('monthly inventory refresh evidence', () => {
  it('retains the fuel report until the candidate month is in HEAD', () => {
    const previous = fuel(1);
    const candidate = { ...fuel(1, 2), observedAt: first };
    const read = () => ({ previous, candidate });
    expect(compareMonthlyRefresh('fuel', first, read)).toContain('aggiunti 1');
    expect(compareMonthlyRefresh('fuel', '2026-11-08T04:17:00Z', read)).toContain('aggiunti 1');
    const readCandidate = vi.fn();
    expect(compareMonthlyRefresh('fuel', '2026-11-08T04:17:00Z', () => ({
      previous: candidate,
      get candidate() { return readCandidate(); },
    }))).toBe('');
    expect(readCandidate).not.toHaveBeenCalled();
  });

  it('uses the UTC month across a year boundary and rejects a non-UTC run timestamp', () => {
    const previous = { ...fuel(1), observedAt: '2026-12-31T23:59:59.999Z' };
    const snapshots = () => ({ previous, candidate: fuel(1) });
    expect(compareMonthlyRefresh('fuel', '2026-12-31T23:59:59Z', snapshots)).toBe('');
    expect(compareMonthlyRefresh('fuel', '2027-01-01T00:00:00.000Z', snapshots)).toContain('invariati 1');
    const read = vi.fn();
    expect(() => compareMonthlyRefresh('fuel', '2026-11-01T01:00:00+01:00', read)).toThrow(/UTC/);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 'legacy', '2026-11-31T00:00:00Z'])('compares a legacy baseline dated %s', (observedAt) => {
    expect(compareMonthlyRefresh('fuel', '2026-11-08T04:17:00Z', () => ({
      previous: { ...fuel(1), observedAt },
      candidate: fuel(1),
    }))).toContain('invariati 1');
  });

  it('retries both pharmacy catalogues until both HEAD snapshots are from the run month', () => {
    const ticinoCandidate = { ...pharmacyCatalogue(ticino), _fetchedAt: first };
    const italyCandidate = { ...pharmacyCatalogue(italy), _fetchedAt: first };
    const retry = '2026-11-02T02:30:00Z';
    for (const _fetchedAt of ['2026-10-31T23:59:59Z', undefined, first]) {
      const report = compareMonthlyRefresh('pharmacies', retry, (path) => path.includes('ticino') ? {
        previous: ticinoCandidate,
        candidate: ticinoCandidate,
      } : {
        previous: { ...italyCandidate, _fetchedAt },
        candidate: italyCandidate,
      });
      if (_fetchedAt === first) {
        expect(report).toBe('');
      } else {
        expect(report).toContain('Farmacie Ticino');
        expect(report).toContain('Farmacie Italia');
      }
    }
  });

  it('compares inventoryId and counts additions, removals and stable identities', () => {
    const previous = fuel(1, 2, 4);
    const candidate = fuel(2, 3, 5);
    previous.stations[1].id = 'legacy-display-id';
    Reflect.deleteProperty(previous.stations[2], 'inventoryId');
    expect(compareMonthlyRefresh('fuel', first, () => ({ previous, candidate })))
      .toContain('aggiunti 2, rimossi 1, non valutabili 1, invariati 1');
  });

  it('accounts for ambiguous historical duplicates and rejects candidate duplicates', () => {
    const previous = fuel(1);
    previous.stations.push(previous.stations[0]);
    previous.stationCount++;
    expect(compareMonthlyRefresh('fuel', first, () => ({ previous, candidate: fuel(1) })))
      .toContain('aggiunti 0, rimossi 0, non valutabili 3, invariati 0');
    expect(() => compareMonthlyRefresh('fuel', first, () => ({ previous: null, candidate: previous })))
      .toThrow(/duplicate candidate identity/);
  });

  it('requires a valid non-empty first inventory', () => {
    expect(compareMonthlyRefresh('fuel', first, () => ({ previous: null, candidate: fuel(1) })))
      .toContain('nuova baseline · aggiunti 1');
    expect(() => compareMonthlyRefresh('fuel', first, () => ({ previous: null, candidate: fuel() })))
      .toThrow(/empty candidate/);
    const candidate = fuel(1);
    Reflect.deleteProperty(candidate.stations[0], 'inventoryId');
    expect(() => compareMonthlyRefresh('fuel', first, () => ({ previous: null, candidate })))
      .toThrow(/missing or duplicate candidate identity/);
  });

  it('rejects unsupported fuel provenance and out-of-perimeter coordinates', () => {
    for (const overrides of [{ inventorySource: 'unknown' }, { lat: 0 }, { fuelTypes: ['jet'] }]) {
      const candidate = fuel(1);
      Object.assign(candidate.stations[0], overrides);
      expect(() => compareMonthlyRefresh('fuel', first, () => ({ previous: fuel(2), candidate })))
        .toThrow(/lacks source or scope evidence/);
    }
  });

  it('accepts official pharmacy identities with optional OSM enrichment', () => {
    const read = (path: string) => path.includes('ticino') ? {
      previous: null,
      candidate: pharmacyCatalogue({ ...ticino, fieldSources: { coordinates: { sourceType: 'directory' } } }),
    } : {
      previous: pharmacyCatalogue({ ...italy, id: 'it-msal-20', ministryId: '20' }),
      candidate: pharmacyCatalogue(italy),
    };
    const report = compareMonthlyRefresh('pharmacies', first, read);
    expect(report).toContain('nuova baseline · aggiunti 1, rimossi 0');
    expect(report).toContain('aggiunti 1, rimossi 1');
  });

  it.each([TICINO_PHARMACY_PDF_URL, OFCT_REGIONS[0].url])('counts a new official Ticino identity from %s', (sourceUrl) => {
    const addition = { ...ticino, id: 'ti-official-2', sourceUrl };
    const report = compareMonthlyRefresh('pharmacies', first, (path) => path.includes('ticino') ? {
      previous: pharmacyCatalogue(ticino),
      candidate: pharmacyCatalogue(ticino, addition),
    } : {
      previous: pharmacyCatalogue(italy),
      candidate: pharmacyCatalogue(italy),
    });
    expect(report).toMatch(/Farmacie Ticino[^\n]*aggiunti 1, rimossi 0, non valutabili 0, invariati 1/);
  });

  it.each([
    { sourceUrl: 'https://www.openstreetmap.org/' },
    { sourceUrl: 'https://www4.ti.ch.example.invalid/Lista_Farmacie.pdf' },
    { sourceUrl: ` ${TICINO_PHARMACY_PDF_URL}` },
    { sourceUrl: TICINO_PHARMACY_PDF_URL.replace('https://', 'https://user:pass@') },
    { sourceUrl: TICINO_PHARMACY_PDF_URL.replace('/fileadmin/', ':444/fileadmin/') },
    { sourceType: 'directory' },
    { canton: 'Geneva' },
  ])('rejects a new Ticino record with unsupported evidence %j', (overrides) => {
    expect(() => compareMonthlyRefresh('pharmacies', first, () => ({
      previous: null,
      candidate: pharmacyCatalogue({ ...ticino, ...overrides }),
    }))).toThrow(/lacks source or scope evidence/);
  });

  it.each([{ ministryId: '' }, { ministryId: '20' }, { province: 'MI' }])(
    'requires a matching Ministry identity and border province %j',
    (overrides) => {
      expect(() => compareMonthlyRefresh('pharmacies', first, (path) => ({
        previous: null,
        candidate: path.includes('ticino')
          ? pharmacyCatalogue(ticino)
          : pharmacyCatalogue({ ...italy, ...overrides }),
      }))).toThrow(/lacks source or scope evidence/);
    },
  );
});
