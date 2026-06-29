import { describe, expect, it } from 'vitest';
import {
  derivePersonalizationPatch,
  PERSONALIZATION_FIELDS,
} from '../scripts/lib/subscriber-personalization.mjs';

describe('derivePersonalizationPatch', () => {
  it('fills location/sector from browsing filter usage (weighted)', () => {
    const patch = derivePersonalizationPatch({
      subscriber: {},
      personalization: {
        filterUsage: { location: { Lugano: 5, Bellinzona: 1 }, category: { 'Sanita / Ospedali': 3 } },
      },
    });
    expect(patch).toMatchObject({
      location_interest: 'Lugano',
      geo_city: 'Lugano',
      sector_interest: 'Sanita / Ospedali',
      job_category: 'Sanita / Ospedali',
    });
  });

  it('falls back to viewed-job cities/companies when no filter usage', () => {
    const patch = derivePersonalizationPatch({
      subscriber: {},
      personalization: {
        viewedJobs: [
          { location: 'Mendrisio', category: 'IT / Tecnologia', company: 'Tether' },
          { location: 'Mendrisio', category: 'IT / Tecnologia', company: 'Tether' },
          { location: 'Chiasso', category: 'Finanza', company: 'BPS' },
        ],
      },
    });
    expect(patch?.location_interest).toBe('Mendrisio');
    expect(patch?.job_company).toBe('Tether');
    expect(patch?.sector_interest).toBe('IT / Tecnologia');
  });

  it('derives location/sector from the user alerts when no browsing data', () => {
    const patch = derivePersonalizationPatch({
      subscriber: {},
      personalization: null,
      alerts: [
        { locations: ['Lugano'], sectors: ['Sanita / Ospedali'], keywords: ['infermiere'] },
      ],
    });
    expect(patch?.location_interest).toBe('Lugano');
    expect(patch?.sector_interest).toBe('Sanita / Ospedali');
    expect(patch?.job_search_query).toBe('infermiere');
  });

  it('NO-CLOBBER: never overwrites an explicit existing value', () => {
    const patch = derivePersonalizationPatch({
      subscriber: { location_interest: 'Locarno', geo_city: 'Locarno' },
      personalization: { filterUsage: { location: { Lugano: 9 } } },
    });
    // location_interest + geo_city already set → not in patch; sector still empty so absent too.
    expect(patch?.location_interest).toBeUndefined();
    expect(patch?.geo_city).toBeUndefined();
  });

  it('uses the most RECENT search for job_search_query', () => {
    const patch = derivePersonalizationPatch({
      subscriber: {},
      personalization: {
        searches: [
          { query: 'magazziniere', ts: 100 },
          { query: 'infermiere notturno', ts: 999 },
        ],
      },
    });
    expect(patch?.job_search_query).toBe('infermiere notturno');
  });

  it('returns null when there is nothing to fill', () => {
    expect(derivePersonalizationPatch({ subscriber: {}, personalization: null, alerts: [] })).toBeNull();
    // All fields already populated → null.
    const full = Object.fromEntries(PERSONALIZATION_FIELDS.map((f) => [f, 'x']));
    expect(derivePersonalizationPatch({
      subscriber: full,
      personalization: { filterUsage: { location: { Lugano: 9 } } },
    })).toBeNull();
  });

  it('tolerates malformed input without throwing', () => {
    expect(derivePersonalizationPatch({})).toBeNull();
    expect(derivePersonalizationPatch({ subscriber: null, personalization: { viewedJobs: 'nope', filterUsage: 7 } as never })).toBeNull();
    expect(derivePersonalizationPatch()).toBeNull();
  });

  it('filter usage outranks a single viewed-job city (weighting holds)', () => {
    const patch = derivePersonalizationPatch({
      subscriber: {},
      personalization: {
        filterUsage: { location: { Bellinzona: 2 } }, // weight 2*3 = 6
        viewedJobs: [{ location: 'Lugano' }, { location: 'Lugano' }], // weight 2+2 = 4
      },
    });
    expect(patch?.location_interest).toBe('Bellinzona');
  });
});
