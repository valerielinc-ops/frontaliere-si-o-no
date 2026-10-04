import { afterEach, describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { fetchPremiumsCsv, PREMIUM_CSV_REQUIRED_HEADERS } from '../scripts/fetch-health-premiums.mjs';
import { httpFetchWithRetry } from '../scripts/lib/transient-fetch.mjs';

vi.mock('../scripts/lib/transient-fetch.mjs', () => ({ httpFetchWithRetry: vi.fn() }));

const year = new Date().getUTCFullYear();
function csv(territory: 'CH' | 'EU', businessYear: number) {
  const headers = PREMIUM_CSV_REQUIRED_HEADERS.map(header => header === 'Kanton' && territory === 'EU' ? 'Land' : header);
  const values: Record<string, string | number> = {
    Altersklasse: 'AKL-ERW', Unfalleinschluss: 'OHN-UNF', Hoheitsgebiet: territory,
    Kanton: 'TI', Land: 'EU IT', Region: 'PR-REG EU0', Versicherer: 1562,
    Tariftyp: 'TAR-BASE', Franchise: 'FRA-300', Prämie: 279, Geschäftsjahr: businessYear,
  };
  return `${headers.join(';')}\n${headers.map(header => values[header]).join(';')}\n`;
}
function archive() {
  const zip = new AdmZip();
  zip.addFile('Prämien_CH.csv', Buffer.from(csv('CH', year)));
  zip.addFile('Prämien_EU.csv', Buffer.from(csv('EU', year)));
  zip.addFile('Prämien_CHEU.csv', Buffer.from('must not select this combined file'));
  const bytes = zip.toBuffer();
  return { ok: true, headers: new Headers({ 'content-type': 'application/zip' }), arrayBuffer: async () => bytes };
}

afterEach(() => vi.clearAllMocks());

describe('BAG publication-year rollover', () => {
  it.each(['CH', 'EU'] as const)('selects the archived %s file when current publication is already next year', async territory => {
    vi.mocked(httpFetchWithRetry)
      .mockResolvedValueOnce(new Response(csv(territory, year + 1)))
      .mockResolvedValueOnce(archive() as Response);
    const downloaded = await fetchPremiumsCsv(year, territory);
    expect(downloaded.csvText).toBe(csv(territory, year));
    expect(downloaded.sourceUrl).toContain(`#Prämien_${territory}.csv`);
    expect(downloaded.regionsUrl).toContain(`praemienregionen_${year}.xlsx`);
    expect(httpFetchWithRetry).toHaveBeenCalledTimes(2);
  });

  it('retains the direct CH source when its actual year matches', async () => {
    vi.mocked(httpFetchWithRetry).mockResolvedValueOnce(new Response(csv('CH', year)));
    const downloaded = await fetchPremiumsCsv(year);
    expect(downloaded.csvText).toBe(csv('CH', year));
    expect(downloaded.sourceUrl).not.toContain('#');
    expect(downloaded.regionsUrl).toBe('https://www.priminfo.admin.ch/downloads/praemienregionen.xlsx');
    expect(httpFetchWithRetry).toHaveBeenCalledTimes(1);
  });
});

// Published 2027 BAG categories remain distinct: PRAXIS combines the former
// HMO and GP categories, while PHARM/FLEX are new and cannot be relabelled HMO.
describe('BAG domestic schema compatibility', () => {
  it('normalises domestic row coordinates without conflating model categories', async () => {
    const { BAG_AGE_CLASSES, BAG_ACCIDENT_COVER, BAG_MODELS, bagFranchiseAmount, bagSwissRegion } = await import('../scripts/lib/health-premium-codes.mjs');
    expect(BAG_AGE_CLASSES.AKA_03_ERW).toBe(BAG_AGE_CLASSES['AKL-ERW']);
    expect(BAG_ACCIDENT_COVER.OHN_UNF).toBe(BAG_ACCIDENT_COVER['OHN-UNF']);
    expect(bagSwissRegion('PR_REG_1')).toBe(bagSwissRegion('PR-REG CH1'));
    expect(bagFranchiseAmount('FRA_01_E_0300')).toBe(bagFranchiseAmount('FRA-300'));
    expect(bagFranchiseAmount('FRA_01_K_0000')).toBe(0);
    expect(BAG_MODELS.BASE).toBe('standard');
    expect(BAG_MODELS.PRAXIS).toBe('praxis');
    expect(BAG_MODELS.PHARM).toBe('pharm');
    expect(BAG_MODELS.FLEX).toBe('flex');
    expect(BAG_MODELS.TEL_DIG).toBe('tel_dig');
    expect(BAG_MODELS['TAR-HMO']).toBe('hmo');
    expect(bagSwissRegion('unexpected')).toBeNull();
    expect(bagFranchiseAmount('unexpected')).toBeNaN();
  });
});
