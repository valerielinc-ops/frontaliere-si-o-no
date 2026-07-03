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

  it('clicked location wins when browsing is light (strongest signal, #3025)', () => {
    const patch = derivePersonalizationPatch({
      subscriber: {},
      personalization: { viewedJobs: [{ location: 'Lugano' }] }, // weight 2
      clicked: { locations: ['Bellinzona'], company: 'EOC' }, // weight 5
    });
    expect(patch?.location_interest).toBe('Bellinzona');
    expect(patch?.job_company).toBe('EOC');
  });

  it('no-clobber still holds with a clicked signal present', () => {
    const patch = derivePersonalizationPatch({
      subscriber: { job_company: 'Existing SA' },
      clicked: { locations: ['Lugano'], company: 'EOC' },
    });
    expect(patch?.job_company).toBeUndefined(); // already set → not clobbered
    expect(patch?.location_interest).toBe('Lugano'); // empty → filled from click
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

  it('explicit category filter beats MANY repeated mis-tagged viewed-job categories (#2993)', () => {
    // Regression: a nurse who filtered by "health" once but whose 10 viewed EOC
    // roles are mis-tagged "admin" must derive sector=health, not admin. Passive
    // repetition is de-duped (distinct viewed category = weight 2) so the explicit
    // filter (weight 3) wins.
    const patch = derivePersonalizationPatch({
      subscriber: {},
      personalization: {
        filterUsage: { category: { health: 1 } }, // explicit → weight 1*3 = 3
        viewedJobs: Array.from({ length: 10 }, () => ({ category: 'admin' })), // de-duped → weight 2
        searches: [{ query: 'infermiere', ts: 1 }],
      },
    });
    expect(patch?.sector_interest).toBe('health');
    expect(patch?.job_category).toBe('health');
  });

  it('de-dups repeated viewed companies so one curiosity employer cannot dominate', () => {
    const patch = derivePersonalizationPatch({
      subscriber: {},
      personalization: {
        // 5 views of A (de-duped → 1) vs an explicit clicked employer B (weight 5).
        viewedJobs: Array.from({ length: 5 }, () => ({ company: 'Acme A' })),
        // no clicked here — distinct-A weight 1 is the only company signal.
      },
    });
    expect(patch?.job_company).toBe('Acme A');
  });

  it('stale filterUsage with all-zero counts yields null patch (zero-weight guard, #3378)', () => {
    // A doc where every filterUsage counter was explicitly zeroed — the key
    // exists but the interaction count is 0, so it must not be treated as
    // positive signal (would wrongly derive a category/location from noise).
    const patch = derivePersonalizationPatch({
      subscriber: {},
      personalization: {
        filterUsage: { category: { 'Sanita / Ospedali': 0 }, location: { Lugano: 0 } },
      },
    });
    expect(patch).toBeNull();
  });

  it('mixed zero/positive filterUsage: only the positive-count entry wins (#3378)', () => {
    const patch = derivePersonalizationPatch({
      subscriber: {},
      personalization: {
        filterUsage: {
          category: { 'Sanita / Ospedali': 0, IT: 3 },
          location: { Lugano: 0 },
        },
      },
    });
    // Positive-count entry wins; zero-count entry must not interfere.
    expect(patch?.job_category).toBe('IT');
    // Location filterUsage is all-zero → falls back to nothing (no viewedJobs).
    expect(patch?.location_interest).toBeUndefined();
  });
});
