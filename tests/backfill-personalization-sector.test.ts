import { describe, expect, it } from 'vitest';
import { computeSectorCorrection } from '../scripts/backfill-personalization-sector.mjs';

/**
 * The backfill repairs ONLY the #3146 bug signature: an EXPLICIT on-site
 * category filter that an old, non-de-duped derivation overrode with a repeated
 * mis-tagged viewed-job category. It must never re-derive on drifted browsing
 * data nor touch an intentionally-set sector.
 */
describe('backfill-personalization-sector — computeSectorCorrection', () => {
  it('corrects a stale sector when an explicit filter was overridden by repeated mis-tagged views (#2993)', () => {
    const correction = computeSectorCorrection(
      { sector_interest: 'admin', job_category: 'admin' },
      {
        filterUsage: { category: { health: 1 } }, // explicit on-site filter
        viewedJobs: Array.from({ length: 10 }, () => ({ category: 'admin' })), // ATS mis-tag noise
      },
      [],
    );
    expect(correction).toEqual({ sector_interest: 'health', job_category: 'health' });
  });

  it('is a no-op when the stored sector already matches the explicit filter', () => {
    const correction = computeSectorCorrection(
      { sector_interest: 'health', job_category: 'health' },
      { filterUsage: { category: { health: 2 } }, viewedJobs: [{ category: 'health' }] },
      [],
    );
    expect(correction).toBeNull();
  });

  it('does NOT re-derive on drifted views — only moves TO an explicitly-filtered category', () => {
    // Stored health, no explicit filter, views now lean tech. The old value is
    // not a bug footprint (no explicit filter behind tech) → leave it.
    const correction = computeSectorCorrection(
      { sector_interest: 'Sanita / Ospedali', job_category: 'Sanita / Ospedali' },
      { filterUsage: {}, viewedJobs: Array.from({ length: 5 }, () => ({ category: 'tech' })) },
      [],
    );
    expect(correction).toBeNull();
  });

  it('does NOT overwrite a sector that the user also explicitly filtered by', () => {
    // Both health and admin explicitly filtered; stored admin is a real choice.
    const correction = computeSectorCorrection(
      { sector_interest: 'admin', job_category: 'admin' },
      { filterUsage: { category: { admin: 1, health: 5 } }, viewedJobs: [] },
      [],
    );
    expect(correction).toBeNull();
  });

  it('is a no-op when there is no personalization data', () => {
    expect(computeSectorCorrection({ sector_interest: 'admin' }, null, [])).toBeNull();
  });
});
