/**
 * Task 5 — verify the shared gate helper that decides whether a
 * (company × city) record earns a per-company × per-city SEO page.
 *
 * This predicate is the single source of truth for link emission: every
 * place that could render an `<a href>` or a sitemap `<loc>` pointing at
 * `/aziende-che-assumono/{city}/{company}/settimana-corrente/` MUST funnel
 * through this check so the link graph never points at an un-generated page
 * (the root cause of the "empty shell" pages fixed in Phase 3).
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_JOBS_PER_COMPANY_IN_CITY,
  companyCityMeetsThreshold,
} from '../../build-plugins/weeklyEmployersData';

describe('companyCityMeetsThreshold', () => {
  it('exports the threshold constant as 3 (documented contract)', () => {
    expect(MIN_JOBS_PER_COMPANY_IN_CITY).toBe(3);
  });

  it('rejects records with fewer active jobs than the threshold', () => {
    expect(companyCityMeetsThreshold({ active: 0 })).toBe(false);
    expect(companyCityMeetsThreshold({ active: 1 })).toBe(false);
    expect(companyCityMeetsThreshold({ active: 2 })).toBe(false);
  });

  it('accepts records that hit exactly the threshold', () => {
    expect(companyCityMeetsThreshold({ active: MIN_JOBS_PER_COMPANY_IN_CITY })).toBe(
      true,
    );
  });

  it('accepts records that clear the threshold', () => {
    expect(companyCityMeetsThreshold({ active: 3 })).toBe(true);
    expect(companyCityMeetsThreshold({ active: 10 })).toBe(true);
    expect(companyCityMeetsThreshold({ active: 999 })).toBe(true);
  });

  it('treats negative counts as failing (defensive against bad input)', () => {
    expect(companyCityMeetsThreshold({ active: -1 })).toBe(false);
    expect(companyCityMeetsThreshold({ active: -10 })).toBe(false);
  });
});
