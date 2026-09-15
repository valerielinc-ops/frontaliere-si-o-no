// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildPharmacyReleaseContract } from '../scripts/import-pharmacies-border.mjs';
import { buildDutyWeekModel } from '../services/pharmacies/dutyWeek';
import type {
  PharmacyCatalogueDataset,
  PharmacyDuty,
  PharmacyDutiesDataset,
  PharmacyReleaseContract,
} from '../services/pharmacies/types';

const NOW = new Date('2026-09-14T12:00:00.000Z');
const WEEK = '2026-09-14';
const REGIONS = [
  { key: 'mendrisiotto', name: 'Mendrisiotto', url: 'https://www.ofct.ch/mendrisiotto/' },
  { key: 'luganese', name: 'Luganese', url: 'https://www.ofct.ch/luganese/' },
  { key: 'bellinzonese', name: 'Bellinzonese', url: 'https://www.ofct.ch/bellinzonese/' },
  { key: 'biasca-e-valli', name: 'Biasca e Valli', url: 'https://www.ofct.ch/biasca-e-valli/' },
  { key: 'locarnese', name: 'Locarnese', url: 'https://www.farmacielocarnese.ch/' },
] as const;

const CATALOGUE_FETCHED_AT = '2026-09-14T10:00:00.000Z';
const DUTIES_FETCHED_AT = '2026-09-14T11:00:00.000Z';

const BASE_PHARMACY = {
  id: 'pharmacy-1',
  name: 'Farmacia di test',
  slug: 'farmacia-di-test',
  address: 'Via Test 1',
  postalCode: '6900',
  city: 'Lugano',
  canton: 'Ticino',
  country: 'CH',
  sourceUrl: 'https://catalogue.test/pharmacy-1',
  sourceType: 'official',
  lastVerifiedAt: CATALOGUE_FETCHED_AT,
} as const;

function duty(region: (typeof REGIONS)[number], index: number): PharmacyDuty {
  const day = String(15 + index).padStart(2, '0');
  return {
    id: `duty-${region.key}`,
    pharmacyId: 'pharmacy-1',
    coverageType: 'region',
    coverageName: region.name,
    startsAt: `2026-09-${day}T06:00:00.000Z`,
    endsAt: `2026-09-${day}T18:00:00.000Z`,
    dutyType: 'day',
    status: 'verified',
    sourceUrl: region.url,
    sourceType: 'official',
    fetchedAt: DUTIES_FETCHED_AT,
    verifiedAt: DUTIES_FETCHED_AT,
  };
}

const BASE_DUTIES = REGIONS.map(duty);

function makeCatalogue(overrides: Record<string, unknown> = {}): PharmacyCatalogueDataset {
  return {
    _source: 'https://catalogue.test/',
    _fetchedAt: CATALOGUE_FETCHED_AT,
    _errors: [],
    pharmacies: [BASE_PHARMACY],
    ...overrides,
  } as unknown as PharmacyCatalogueDataset;
}

function makeDuties(overrides: Record<string, unknown> = {}): PharmacyDutiesDataset {
  return {
    _source: 'https://duties.test/',
    _sourceRegions: REGIONS.map((region) => region.url),
    _fetchedAt: DUTIES_FETCHED_AT,
    _lastSuccessfulFetchAt: DUTIES_FETCHED_AT,
    _errors: [],
    _warnings: [],
    _preservedRegions: [],
    _successfulRegions: REGIONS.map((region) => region.key),
    duties: BASE_DUTIES,
    ...overrides,
  } as unknown as PharmacyDutiesDataset;
}

function makePair(
  catalogueOverrides: Record<string, unknown> = {},
  dutiesOverrides: Record<string, unknown> = {},
): { catalogue: PharmacyCatalogueDataset; duties: PharmacyDutiesDataset; release: PharmacyReleaseContract } {
  const catalogue = makeCatalogue(catalogueOverrides);
  const duties = makeDuties(dutiesOverrides);
  const release = buildPharmacyReleaseContract({
    catalogue,
    duties,
    evaluatedAt: duties._fetchedAt,
  }) as PharmacyReleaseContract;
  return {
    catalogue: { ...catalogue, _release: release },
    duties: { ...duties, _release: release },
    release,
  };
}

function build(pair: { catalogue: PharmacyCatalogueDataset; duties: PharmacyDutiesDataset }, options: { now?: Date; maxAgeMs?: number } = {}) {
  return buildDutyWeekModel(pair.duties, WEEK, {
    now: NOW,
    catalogue: pair.catalogue,
    ...options,
  });
}

describe('weekly pharmacy duty read model', () => {
  it('is ready only with five verified Ticino regions and one valid P0 release', () => {
    const pair = makePair();
    const model = build(pair);

    expect(pair.duties._release.timezone).toBe('Europe/Zurich');
    expect(model.status).toBe('ready');
    expect(model.indexable).toBe(true);
    expect(model.timezone).toBe('Europe/Zurich');
    expect(model.releaseId).toBe(pair.release.releaseId);
    expect(model.missingRegions).toEqual([]);
    expect(model.unresolvedPharmacyIds).toEqual([]);
    expect(model.reason).toBe('all declared Ticino duty regions have fresh, verified data');
  });

  it('fails closed when the P0 release contract is missing', () => {
    const pair = makePair();
    const model = build({
      catalogue: pair.catalogue,
      duties: { ...pair.duties, _release: undefined } as unknown as PharmacyDutiesDataset,
    });

    expect(model.status).toBe('unknown');
    expect(model.indexable).toBe(false);
    expect(model.releaseId).toBeNull();
  });

  it('marks a valid but old snapshot stale', () => {
    const fetchedAt = '2026-09-11T11:00:00.000Z';
    const pair = makePair({}, {
      _fetchedAt: fetchedAt,
      _lastSuccessfulFetchAt: fetchedAt,
      duties: BASE_DUTIES.map((candidate) => ({ ...candidate, fetchedAt, verifiedAt: fetchedAt })),
    });
    const model = build(pair);

    expect(model.status).toBe('stale');
    expect(model.indexable).toBe(false);
  });

  it('marks missing or preserved Ticino regions partial', () => {
    const withoutRegion = makePair({}, { duties: BASE_DUTIES.filter((duty) => duty.coverageName !== 'Biasca e Valli') });
    const missing = build(withoutRegion);
    expect(missing.status).toBe('partial');
    expect(missing.missingRegions).toEqual(['Biasca e Valli']);
    expect(missing.indexable).toBe(false);

    const preserved = makePair({}, { _preservedRegions: ['luganese'] });
    const preservedModel = build(preserved);
    expect(preservedModel.status).toBe('partial');
    expect(preservedModel.indexable).toBe(false);
  });

  it('marks release conflicts and unresolved catalogue identities non-indexable', () => {
    const pair = makePair();
    const differentPair = makePair({ pharmacies: [{ ...BASE_PHARMACY, id: 'different-pharmacy', slug: 'different-pharmacy' }] });
    const conflict = build({ duties: pair.duties, catalogue: differentPair.catalogue });
    expect(conflict.status).toBe('conflicting');
    expect(conflict.indexable).toBe(false);

    const unresolvedPair = makePair({ pharmacies: [{ ...BASE_PHARMACY, id: 'different-pharmacy', slug: 'different-pharmacy' }] });
    const unresolved = build(unresolvedPair);
    expect(unresolved.status).toBe('partial');
    expect(unresolved.unresolvedPharmacyIds).toEqual(['pharmacy-1']);
    expect(unresolved.indexable).toBe(false);
  });

  it('uses the same effective catalogue for default evaluation and identity validation', () => {
    const pair = makePair();
    const model = buildDutyWeekModel(pair.duties, WEEK, { now: NOW });

    expect(model.indexable).toBe(false);
    expect(model.unresolvedPharmacyIds).toEqual(['pharmacy-1']);
  });

  it('uses Europe/Zurich local-midnight bounds for Monday edges', () => {
    const earlyMonday = {
      ...BASE_DUTIES[0],
      startsAt: '2026-09-13T22:15:00.000Z',
      endsAt: '2026-09-13T22:45:00.000Z',
    };
    const nextEarlyMonday = {
      ...BASE_DUTIES[1],
      startsAt: '2026-09-20T22:15:00.000Z',
      endsAt: '2026-09-20T22:45:00.000Z',
    };
    const pair = makePair({}, {
      duties: [earlyMonday, nextEarlyMonday, ...BASE_DUTIES.slice(2)],
    });
    const model = build(pair);
    const mendrisiotto = model.regions.find((region) => region.key === 'mendrisiotto');
    const luganese = model.regions.find((region) => region.key === 'luganese');

    expect(mendrisiotto?.duties.map((candidate) => candidate.id)).toContain(earlyMonday.id);
    expect(luganese?.duties.map((candidate) => candidate.id)).not.toContain(nextEarlyMonday.id);
  });

  it.each(['aggregate state', 'regional status', 'snapshot hash'] as const)('fails closed when P0 release %s is tampered', (label) => {
    const pair = makePair();
    const changes = label === 'aggregate state'
      ? { state: 'partial' as const }
      : label === 'regional status'
        ? { regions: { ...pair.release.regions, mendrisiotto: { ...pair.release.regions.mendrisiotto, coverage: 'partial' as const } } }
        : { snapshots: { ...pair.release.snapshots, duties: { ...pair.release.snapshots.duties, sha256: '0'.repeat(64) } } };
    const tamperedCatalogue = {
      ...pair.catalogue,
      _release: { ...pair.release, ...changes },
    } as PharmacyCatalogueDataset;
    const model = build({ duties: pair.duties, catalogue: tamperedCatalogue });

    expect(model.status).toBe('conflicting');
    expect(model.indexable).toBe(false);
    expect(model.reason).toContain('release integrity');
  });

  it('reads timezone only from nested _release and rejects unsupported zones', () => {
    const pair = makePair();
    const tamperedDuties = {
      ...pair.duties,
      timezone: 'Europe/Zurich',
      _release: { ...pair.release, timezone: 'Europe/Rome' },
    } as unknown as PharmacyDutiesDataset;
    const model = build({ duties: tamperedDuties, catalogue: pair.catalogue });

    expect(model.timezone).toBe('Europe/Rome');
    expect(model.status).toBe('unknown');
    expect(model.indexable).toBe(false);
    expect(model.reason).toContain('unsupported timezone Europe/Rome');
  });

  it('does not throw for a malformed duties array', () => {
    const pair = makePair();
    const model = build({
      catalogue: pair.catalogue,
      duties: { ...pair.duties, duties: undefined } as unknown as PharmacyDutiesDataset,
    });

    expect(model.indexable).toBe(false);
    expect(model.missingRegions).toEqual(REGIONS.map((region) => region.name));
  });

  it.each([
    ['duties', { duties: [null] }, {}],
    ['pharmacies', {}, { pharmacies: [null] }],
    ['incomplete duty', { duties: [{ id: 'incomplete-duty' }] }, {}],
    ['incomplete pharmacy', {}, { pharmacies: [{ id: 'incomplete-pharmacy' }] }],
  ] as const)('fails closed without dereferencing an invalid %s entry', (_label, dutiesOverrides, catalogueOverrides) => {
    const pair = makePair(catalogueOverrides, dutiesOverrides);
    const model = build(pair);

    expect(model.status).toBe('unknown');
    expect(model.indexable).toBe(false);
    expect(model.unresolvedPharmacyIds).toEqual([]);
    expect(model.reason).toContain('invalid entries');
  });

  it('fails closed for explicitly null runtime snapshots', () => {
    const model = buildDutyWeekModel(null as unknown as PharmacyDutiesDataset, WEEK, {
      now: NOW,
      catalogue: null as unknown as PharmacyCatalogueDataset,
    });

    expect(model.status).toBe('unknown');
    expect(model.indexable).toBe(false);
    expect(model.regions.every((region) => region.duties.length === 0)).toBe(true);
    expect(model.reason).toContain('invalid entries');
  });

  it('marks an empty completed week expired', () => {
    const pair = makePair({}, { duties: [] });
    const model = build(pair, { now: new Date('2026-09-22T12:00:00.000Z') });

    expect(model.status).toBe('expired');
    expect(model.indexable).toBe(false);
  });
});
