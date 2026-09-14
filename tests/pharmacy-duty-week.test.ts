// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildDutyWeekModel } from '../services/pharmacies/dutyWeek';
import type { PharmacyDuty, PharmacyDutiesDataset } from '../services/pharmacies/types';

const NOW = new Date('2026-09-14T12:00:00.000Z');
const WEEK = '2026-09-14';
const CATALOG_IDS = new Set(['pharmacy-1']);
const REGIONS = ['Mendrisiotto', 'Luganese', 'Bellinzonese', 'Biasca e Valli'];

function duty(region: string, index: number): PharmacyDuty {
  const day = String(15 + index).padStart(2, '0');
  return {
    id: `duty-${index}`,
    pharmacyId: 'pharmacy-1',
    coverageType: 'region',
    coverageName: region,
    startsAt: `2026-09-${day}T06:00:00.000Z`,
    endsAt: `2026-09-${day}T18:00:00.000Z`,
    dutyType: 'day',
    status: 'verified',
    sourceUrl: 'https://www.ofct.ch/farmacieturno/',
    sourceType: 'official',
    fetchedAt: '2026-09-14T11:00:00.000Z',
    verifiedAt: '2026-09-14T11:00:00.000Z',
  };
}

function dataset(overrides: Record<string, unknown> = {}): PharmacyDutiesDataset {
  return {
    _source: 'https://www.ofct.ch/farmacieturno/',
    _sourceRegions: ['https://www.ofct.ch/farmacieturno/'],
    _fetchedAt: '2026-09-14T11:00:00.000Z',
    _errors: [],
    _warnings: [],
    _preservedRegions: [],
    duties: REGIONS.map(duty),
    releaseId: 'release-1',
    ...overrides,
  } as unknown as PharmacyDutiesDataset;
}

function build(overrides: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  return buildDutyWeekModel(dataset(overrides), WEEK, {
    now: NOW,
    catalogReleaseId: 'release-1',
    catalogPharmacyIds: CATALOG_IDS,
    ...options,
  });
}

describe('weekly pharmacy duty read model', () => {
  it('is ready only with four verified regions and one shared release', () => {
    const model = build();
    expect(model.status).toBe('ready');
    expect(model.indexable).toBe(true);
    expect(model.missingRegions).toEqual([]);
    expect(model.unresolvedPharmacyIds).toEqual([]);
  });

  it('fails closed when the release contract is not published', () => {
    const model = build({ releaseId: undefined });
    expect(model.status).toBe('not_published');
    expect(model.indexable).toBe(false);
  });

  it('marks old source data stale', () => {
    const model = build({ _fetchedAt: '2026-09-11T11:00:00.000Z' });
    expect(model.status).toBe('stale');
    expect(model.indexable).toBe(false);
  });

  it('marks missing or preserved regions partial', () => {
    const withoutRegion = REGIONS.slice(0, 3).map(duty);
    const missing = build({ duties: withoutRegion });
    expect(missing.status).toBe('partial');
    expect(missing.missingRegions).toEqual(['Biasca e Valli']);

    const preserved = build({ _preservedRegions: ['Locarnese'] });
    expect(preserved.status).toBe('partial');
    expect(preserved.indexable).toBe(false);
  });

  it('marks release conflicts and unresolved pharmacies non-indexable', () => {
    const conflict = build({ releaseId: 'release-2' });
    expect(conflict.status).toBe('conflicting');
    expect(conflict.indexable).toBe(false);

    const unresolved = build({ duties: REGIONS.map(duty) }, { catalogPharmacyIds: new Set(['different-pharmacy']) });
    expect(unresolved.status).toBe('partial');
    expect(unresolved.unresolvedPharmacyIds).toEqual(['pharmacy-1']);
    expect(unresolved.indexable).toBe(false);
  });

  it('does not throw for a malformed duties array', () => {
    const model = build({ duties: undefined });
    expect(model.indexable).toBe(false);
    expect(model.status).toBe('partial');
  });

  it('marks an empty completed week expired', () => {
    const model = build({ duties: [] }, { now: new Date('2026-09-22T12:00:00.000Z') });
    expect(model.status).toBe('expired');
    expect(model.indexable).toBe(false);
  });
});
