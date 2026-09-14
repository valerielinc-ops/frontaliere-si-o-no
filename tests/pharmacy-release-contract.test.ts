import { describe, expect, it } from 'vitest';

import catalogueJson from '../data/pharmacies-ticino-complete.json';
import dutiesJson from '../data/pharmacy-duties-ticino.json';
import {
  buildPharmacyReleaseContract,
} from '../scripts/import-pharmacies-border.mjs';
import {
  getPharmacyReleaseEvaluation,
  publicDutiesForRegion,
} from '../services/pharmacies/duties';
import {
  PHARMACY_RELEASE_REGION_KEYS,
  validatePharmacyReleaseContract,
  type PharmacyCatalogueDataset,
  type PharmacyDuty,
  type PharmacyDutiesDataset,
} from '../services/pharmacies/types';

const CATALOGUE_FETCHED_AT = '2026-09-14T10:00:00.000Z';
const DUTIES_FETCHED_AT = '2026-09-14T11:00:00.000Z';
const NOW = new Date('2026-09-14T12:00:00.000Z');
const REGION_DEFINITIONS = [
  { key: 'mendrisiotto', name: 'Mendrisiotto', url: 'https://www.ofct.ch/mendrisiotto/' },
  { key: 'luganese', name: 'Luganese', url: 'https://www.ofct.ch/luganese/' },
  { key: 'bellinzonese', name: 'Bellinzonese', url: 'https://www.ofct.ch/bellinzonese/' },
  { key: 'biasca-e-valli', name: 'Biasca e Valli', url: 'https://www.ofct.ch/biasca-e-valli/' },
] as const;

function makeDuty(region: (typeof REGION_DEFINITIONS)[number], index: number, overrides: Partial<PharmacyDuty> = {}): PharmacyDuty {
  return {
    id: `duty-${region.key}-${index}`,
    pharmacyId: `pharmacy-${region.key}`,
    coverageType: 'region',
    coverageName: region.name,
    startsAt: '2026-09-14T08:00:00.000Z',
    endsAt: '2026-09-15T08:00:00.000Z',
    dutyType: 'day',
    status: 'verified',
    sourceUrl: region.url,
    sourceType: 'official',
    fetchedAt: DUTIES_FETCHED_AT,
    verifiedAt: DUTIES_FETCHED_AT,
    ...overrides,
  };
}

const BASE_DUTIES = REGION_DEFINITIONS.map((region, index) => makeDuty(region, index));

function makeCatalogue(overrides: Record<string, unknown> = {}) {
  return {
    _source: 'https://catalogue.test/',
    _fetchedAt: CATALOGUE_FETCHED_AT,
    _errors: [],
    pharmacies: [],
    ...overrides,
  };
}

function makeDuties(overrides: Record<string, unknown> = {}) {
  return {
    _source: 'https://duties.test/',
    _sourceRegions: REGION_DEFINITIONS.map((region) => region.url),
    _fetchedAt: DUTIES_FETCHED_AT,
    _lastSuccessfulFetchAt: DUTIES_FETCHED_AT,
    _errors: [],
    _warnings: [],
    _preservedRegions: [],
    _successfulRegions: [...PHARMACY_RELEASE_REGION_KEYS],
    duties: BASE_DUTIES,
    ...overrides,
  };
}

function makePair(
  catalogueOverrides: Record<string, unknown> = {},
  dutiesOverrides: Record<string, unknown> = {},
) {
  const catalogue = makeCatalogue(catalogueOverrides);
  const duties = makeDuties(dutiesOverrides);
  const release = buildPharmacyReleaseContract({
    catalogue,
    duties,
    evaluatedAt: duties._fetchedAt,
  });
  return {
    catalogue: { ...catalogue, _release: release } as PharmacyCatalogueDataset,
    duties: { ...duties, _release: release } as PharmacyDutiesDataset,
    release,
  };
}

describe('pharmacy atomic release contract', () => {
  it('derives a deterministic releaseId from the exact catalogue and duties payloads', () => {
    const pair = makePair();
    const reorderedCatalogue = {
      pharmacies: [...pair.catalogue.pharmacies],
      _errors: [...pair.catalogue._errors],
      _fetchedAt: pair.catalogue._fetchedAt,
      _source: pair.catalogue._source,
    };
    const sameRelease = buildPharmacyReleaseContract({
      catalogue: reorderedCatalogue,
      duties: pair.duties,
      evaluatedAt: DUTIES_FETCHED_AT,
    });
    const changedRelease = buildPharmacyReleaseContract({
      catalogue: { ...reorderedCatalogue, pharmacies: [{ id: 'new-record' }] },
      duties: pair.duties,
      evaluatedAt: DUTIES_FETCHED_AT,
    });

    expect(sameRelease.releaseId).toBe(pair.release.releaseId);
    expect(pair.release.releaseId).toMatch(/^pharmacy-v1-[a-f0-9]{64}$/);
    expect(changedRelease.releaseId).not.toBe(pair.release.releaseId);
  });

  it('exposes the checked-in release as fresh and limited to the four OFCT regions', () => {
    const catalogue = catalogueJson as unknown as PharmacyCatalogueDataset;
    const duties = dutiesJson as unknown as PharmacyDutiesDataset;
    const evaluation = getPharmacyReleaseEvaluation(duties, new Date('2026-09-14T19:00:00.000Z'), catalogue);

    expect(validatePharmacyReleaseContract(catalogue._release)).toEqual([]);
    expect(validatePharmacyReleaseContract(duties._release)).toEqual([]);
    expect(catalogue._release).toMatchObject({
      scope: { country: 'CH', canton: 'Ticino', regions: [...PHARMACY_RELEASE_REGION_KEYS] },
      timezone: 'Europe/Zurich',
    });
    expect(evaluation).toMatchObject({ state: 'fresh', publishable: true, releaseId: catalogue._release.releaseId });
    expect(Object.keys(evaluation.regions)).toEqual([...PHARMACY_RELEASE_REGION_KEYS]);
    expect(Object.values(evaluation.regions).every((region) => region.state === 'fresh' && region.coverage === 'covered')).toBe(true);
    expect(Object.keys(evaluation.regions)).not.toContain('locarnese');
    expect(publicDutiesForRegion(duties, 'Mendrisiotto', new Date('2026-09-14T19:00:00.000Z'), catalogue)).not.toHaveLength(0);
  });

  it('fails closed on a catalogue/duties mismatch or a stale snapshot', () => {
    const pair = makePair();
    const changedCataloguePayload = makeCatalogue({ pharmacies: [{ id: 'changed' }] });
    const changedCatalogueRelease = buildPharmacyReleaseContract({
      catalogue: changedCataloguePayload,
      duties: pair.duties,
      evaluatedAt: DUTIES_FETCHED_AT,
    });
    const changedCatalogue = { ...changedCataloguePayload, _release: changedCatalogueRelease } as PharmacyCatalogueDataset;
    const mismatch = getPharmacyReleaseEvaluation(pair.duties, NOW, changedCatalogue);
    expect(mismatch).toMatchObject({ state: 'conflicting', publishable: false });
    expect(publicDutiesForRegion(pair.duties, 'Mendrisiotto', NOW, changedCatalogue)).toEqual([]);

    const staleFetchedAt = '2026-09-10T00:00:00.000Z';
    const staleDuties = makeDuties({
      _fetchedAt: staleFetchedAt,
      _lastSuccessfulFetchAt: staleFetchedAt,
      duties: BASE_DUTIES.map((duty) => ({ ...duty, fetchedAt: staleFetchedAt, verifiedAt: staleFetchedAt })),
    });
    const staleRelease = buildPharmacyReleaseContract({
      catalogue: makeCatalogue(),
      duties: staleDuties,
      evaluatedAt: staleFetchedAt,
    });
    const staleDataset = { ...staleDuties, _release: staleRelease } as PharmacyDutiesDataset;
    const staleCatalogue = { ...makeCatalogue(), _release: staleRelease } as PharmacyCatalogueDataset;
    const stale = getPharmacyReleaseEvaluation(staleDataset, NOW, staleCatalogue);
    expect(stale).toMatchObject({ state: 'stale', publishable: false });
    expect(publicDutiesForRegion(staleDataset, 'Mendrisiotto', NOW, staleCatalogue)).toEqual([]);
  });

  it('marks a preserved region partial, blocks only that region, and keeps existing expiry behavior', () => {
    const preserved = makePair({}, {
      _preservedRegions: ['luganese'],
      _successfulRegions: ['mendrisiotto', 'bellinzonese', 'biasca-e-valli'],
    });
    const evaluation = getPharmacyReleaseEvaluation(preserved.duties, NOW, preserved.catalogue);
    expect(evaluation.state).toBe('partial');
    expect(evaluation.regions.luganese).toMatchObject({ state: 'partial', coverage: 'partial', preserved: true });
    expect(publicDutiesForRegion(preserved.duties, 'Luganese', NOW, preserved.catalogue)).toEqual([]);
    expect(publicDutiesForRegion(preserved.duties, 'Mendrisiotto', NOW, preserved.catalogue)).toHaveLength(1);

    const firstDuty = preserved.duties.duties[0];
    const beforeEnd = new Date(Date.parse(firstDuty.endsAt) - 1);
    const afterEnd = new Date(Date.parse(firstDuty.endsAt) + 1);
    expect(publicDutiesForRegion(preserved.duties, firstDuty.coverageName, beforeEnd, preserved.catalogue)).toHaveLength(1);
    expect(publicDutiesForRegion(preserved.duties, firstDuty.coverageName, afterEnd, preserved.catalogue)).toEqual([]);
  });

  it('represents unknown, not_published, expired, and conflicting states explicitly', () => {
    const base = makePair();
    const unknown = getPharmacyReleaseEvaluation({ ...base.duties, _release: undefined } as unknown as PharmacyDutiesDataset, NOW, base.catalogue);
    expect(unknown.state).toBe('unknown');

    const withoutRegion = makePair({}, { duties: BASE_DUTIES.filter((duty) => duty.coverageName !== 'Luganese') });
    expect(getPharmacyReleaseEvaluation(withoutRegion.duties, NOW, withoutRegion.catalogue).regions.luganese.state).toBe('not_published');

    const expired = makePair({}, {
      duties: BASE_DUTIES.map((duty) => duty.coverageName === 'Mendrisiotto'
        ? { ...duty, endsAt: '2026-09-13T08:00:00.000Z' }
        : duty),
    });
    expect(getPharmacyReleaseEvaluation(expired.duties, NOW, expired.catalogue).regions.mendrisiotto.state).toBe('expired');

    const conflicting = makePair({}, {
      duties: BASE_DUTIES.map((duty) => duty.coverageName === 'Mendrisiotto'
        ? { ...duty, status: 'conflicting' }
        : duty),
    });
    expect(getPharmacyReleaseEvaluation(conflicting.duties, NOW, conflicting.catalogue).regions.mendrisiotto.state).toBe('conflicting');
  });
});
