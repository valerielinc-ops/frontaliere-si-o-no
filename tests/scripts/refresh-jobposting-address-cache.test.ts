import { describe, expect, it } from 'vitest';
import {
  buildQuery,
  matchAddress,
  processLookupBatches,
  queryLindasWithRetry,
  registryNameKey,
  collectUnmatchedCacheLookups,
  sameLocality,
} from '../../scripts/refresh-jobposting-address-cache.mjs';

function zefixBinding({
  company = 'https://register.ld.admin.ch/zefix/company/123',
  registeredName = 'Müller & Söhne AG',
  locality = 'Zürich',
  region = 'ZH',
  street = 'Bahnhofstrasse 10',
  postalCode = '8001',
} = {}) {
  return {
    company: { value: company },
    registeredName: { value: registeredName },
    locality: { value: locality },
    region: { value: region },
    street: { value: street },
    postalCode: { value: postalCode },
  };
}

describe('Zefix LINDAS JobPosting address refresh', () => {
  it('queries exact locality and canton literals without scanning or normalizing graph strings', () => {
    const query = buildQuery([{ locality: 'Zurich', region: 'ZH' }]);

    expect(query).toContain('schema:legalName ?registeredName');
    expect(query).toContain('schema:addressLocality ?locality');
    expect(query).toContain('schema:addressRegion ?region');
    expect(query).toContain('"Zurich" "ZH"');
    expect(query).toContain('"Zürich" "ZH"');
    expect(query).not.toMatch(/\bFILTER\b|\bCONTAINS\b|\bLCASE\b/i);

    const descriptiveLocalityQuery = buildQuery([{ locality: 'Baden, Aargau', region: 'AG' }]);
    expect(descriptiveLocalityQuery).toContain('"Baden, Aargau" "AG"');
    expect(descriptiveLocalityQuery).toContain('"Baden" "AG"');
  });

  it('normalizes punctuation and a terminal legal form while preserving other name words', () => {
    expect(registryNameKey('Müller & Söhne SA')).toBe('muller sohne');
    expect(registryNameKey('Suisse Banque SA')).toBe('suisse banque');
    expect(registryNameKey('AG Immobilien GmbH')).toBe('ag immobilien');
    expect(['SA', 'AG', 'Sagl', 'GmbH'].map((form) => registryNameKey(`Müller ${form}`)))
      .toEqual(['muller', 'muller', 'muller', 'muller']);
  });

  it('accepts only an exact normalized company and canton-scoped city match', () => {
    const request = {
      key: 'muller sohne sa|zurich|ZH',
      companyName: 'Müller & Söhne SA',
      locality: 'Zurich',
      region: 'ZH',
    };
    expect(matchAddress(request, [zefixBinding()], new Set(['8001']))).toMatchObject({
      status: 'matched',
      companyFound: true,
      ambiguous: false,
      address: { streetAddress: 'Bahnhofstrasse 10', postalCode: '8001' },
    });
    expect(matchAddress(request, [zefixBinding({ locality: 'Basel', region: 'BS' })]))
      .toMatchObject({ status: 'not-found', companyFound: false });
    expect(matchAddress(request, [zefixBinding({ registeredName: 'Müller Sohn AG' })]))
      .toMatchObject({ status: 'not-found', companyFound: false });
  });

  it('keeps multiple exact entities, conflicting postcodes, and multiple addresses ambiguous', () => {
    const request = {
      key: 'muller sohne sa|zurich|ZH',
      companyName: 'Müller & Söhne SA',
      locality: 'Zurich',
      region: 'ZH',
    };
    expect(matchAddress(request, [
      zefixBinding(),
      zefixBinding({ company: 'https://register.ld.admin.ch/zefix/company/456' }),
    ])).toMatchObject({ status: 'ambiguous', ambiguous: true, reason: 'multiple-companies' });
    expect(matchAddress(request, [zefixBinding()], new Set(['8002'])))
      .toMatchObject({ status: 'ambiguous', ambiguous: true, reason: 'postal-code-conflict' });
    expect(matchAddress(request, [zefixBinding({ postalCode: '18001' })]))
      .toMatchObject({ status: 'address-unavailable', companyFound: true, ambiguous: false });
    expect(matchAddress(request, [
      zefixBinding(),
      zefixBinding({ street: 'Limmatquai 20', postalCode: '8001' }),
    ])).toMatchObject({ status: 'ambiguous', ambiguous: true, reason: 'multiple-addresses' });
  });

  it('resolves a curated employer alias only to its exact registered name and records provenance', async () => {
    const request = {
      key: 'coop city|basel|BS',
      companyName: 'Coop City',
      locality: 'Basel',
      region: 'BS',
    };
    const result = await processLookupBatches([request], {
      queryBatch: async () => [zefixBinding({ registeredName: 'Coop Genossenschaft', locality: 'Basel', region: 'BS' })],
      batchDelayMs: 0,
      checkedAt: () => '2026-01-01T00:00:00.000Z',
    });

    expect(result.entries[request.key]).toMatchObject({
      status: 'matched',
      companyName: 'Coop City',
      registeredName: 'Coop Genossenschaft',
      matchType: 'alias',
      streetAddressSource: 'zefix-registry',
      streetAddress: 'Bahnhofstrasse 10',
    });
    expect(result.summary.sameCityAddresses).toBe(1);
  });

  it('keeps an alias unresolved when it maps to multiple registered entities', () => {
    const request = {
      key: 'abb svizzera|baden|AG',
      companyName: 'Coop City',
      locality: 'Baden',
      region: 'AG',
    };
    expect(matchAddress(request, [
      zefixBinding({ company: 'https://register.ld.admin.ch/zefix/company/1', registeredName: 'Coop Genossenschaft', locality: 'Baden', region: 'AG' }),
      zefixBinding({ company: 'https://register.ld.admin.ch/zefix/company/2', registeredName: 'Coop Genossenschaft', locality: 'Baden', region: 'AG' }),
    ])).toMatchObject({ status: 'ambiguous', companyFound: true, ambiguous: true, reason: 'multiple-companies' });
  });

  it('does not replace a cached match with a later non-match and only retries non-matches in the selected cache slice', async () => {
    const request = {
      key: 'muller sohne sa|zurich|ZH',
      companyName: 'Müller & Söhne SA',
      locality: 'Zürich',
      region: 'ZH',
    };
    const cachedMatch = {
      status: 'matched',
      source: 'zefix-lindas',
      companyName: request.companyName,
      streetAddress: 'Existing Street 1',
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      streetAddressSource: 'zefix-registry',
    };
    const result = await processLookupBatches([request], {
      entries: { [request.key]: cachedMatch },
      queryBatch: async () => [],
      batchDelayMs: 0,
    });

    expect(result.entries[request.key]).toEqual(cachedMatch);
    expect(collectUnmatchedCacheLookups({
      'a|town|ZH': { ...cachedMatch, status: 'matched' },
      'b|town|ZH': { status: 'not-found', companyName: 'Company B', addressLocality: 'Town', addressRegion: 'ZH' },
    }, 1, 1)).toEqual([{
      key: 'b|town|ZH',
      companyName: 'Company B',
      locality: 'Town',
      region: 'ZH',
    }]);
  });

  it('normalizes accent and a verified canton suffix in localities, without parsing descriptive text', () => {
    expect(sameLocality('Zürich', 'Zurich', 'ZH')).toBe(true);
    expect(sameLocality('Rüti', 'Rüti (ZH)', 'ZH')).toBe(true);
    expect(sameLocality('Bellinzona', 'Bellinzona, Ticino', 'TI')).toBe(true);
    expect(sameLocality('Bellinzona', 'Bellinzona CH-TI', 'TI')).toBe(true);
    expect(sameLocality('Rüti', 'Rüti (AG)', 'ZH')).toBe(false);
    expect(sameLocality('Bellinzona', 'Bellinzona, Aargau', 'TI')).toBe(false);
    expect(sameLocality('Baden', 'Baden, Aargau', 'ZH')).toBe(false);
  });

  it('retries failed requests with backoff and never overlaps requests', async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const sleeps: number[] = [];
    const result = await queryLindasWithRetry([{ locality: 'Zürich', region: 'ZH' }], {
      query: async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        if (calls < 3) throw new Error('temporary timeout');
        return ['ok'];
      },
      sleep: async (ms) => { sleeps.push(ms); },
      maxAttempts: 4,
      retryDelaysMs: [25, 50, 100],
    });

    expect(result).toEqual(['ok']);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([25, 50]);
    expect(maxActive).toBe(1);
  });

  it('persists each successful locality batch and leaves a failed batch eligible for a later run', async () => {
    const requests = Array.from({ length: 11 }, (_, index) => ({
      key: `company ${index}|unknown town ${index}|ZH`,
      companyName: `Company ${index}`,
      locality: `Unknown Town ${index}`,
      region: 'ZH',
    }));
    const savedSnapshots: Record<string, unknown>[] = [];
    let calls = 0;
    const result = await processLookupBatches(requests, {
      queryBatch: async (batch) => {
        calls++;
        if (calls === 2) throw new Error('temporary timeout after retries');
        return [zefixBinding({
          company: 'https://register.ld.admin.ch/zefix/company/123',
          registeredName: 'Company 0 AG',
          locality: batch[0].locality,
          region: 'ZH',
        })];
      },
      saveBatch: async (entries) => { savedSnapshots.push({ ...entries }); },
      checkedAt: () => '2026-01-01T00:00:00.000Z',
      batchDelayMs: 0,
    });

    expect(calls).toBe(2);
    expect(savedSnapshots).toHaveLength(1);
    expect(savedSnapshots[0][requests[0].key]).toMatchObject({ status: 'matched' });
    expect(result.entries[requests[0].key]).toMatchObject({ status: 'matched' });
    expect(result.entries[requests[10].key]).toBeUndefined();
    expect(result.summary).toMatchObject({
      searchedCompanies: 11,
      companiesFound: 1,
      sameCityAddresses: 1,
      notFound: 9,
      failedBatches: 1,
      failedCompanies: 1,
    });
  });

  it('waits between LINDAS locality batches', async () => {
    const requests = Array.from({ length: 11 }, (_, index) => ({
      key: `company ${index}|town ${index}|ZH`,
      companyName: `Company ${index}`,
      locality: `Town ${index}`,
      region: 'ZH',
    }));
    const delays: number[] = [];
    await processLookupBatches(requests, {
      queryBatch: async () => [],
      pauseBetweenBatches: async (ms) => { delays.push(ms); },
    });
    expect(delays).toEqual([1_000]);
  });
});
