import { describe, it, expect } from 'vitest';
import {
  SHARED_POOL_BRAND_PATTERNS,
  filterSharedPoolJobsByBrand,
} from '../scripts/lib/swatchgroup-brand-filter.mjs';

// Real hiringOrganization.name values observed live on the swatchgroup.com
// group job-finder (2026-07-18, issue #4392) — none of them are rado,
// comadur, nivarox or "swatch group assembly".
const REAL_POOL_COMPANIES = [
  'Omega Ltd.',
  'ETA SA Manufacture Horlogère Suisse',
  'The Swatch Group (Deutschland) GmbH',
  'Renata AG',
  'The Swatch Group Les Boutiques Ltd',
  'Tissot Ltd',
  'Longines Watch Co. Francillon Ltd.',
  'Hamilton International Ltd',
  'Swatch Ltd',
  'EM Microelectronic-Marin Ltd',
  'Montres Breguet Ltd',
  'The Swatch Group Research and Development Ltd',
  'The Swatch Group Services Ltd',
  'The Swatch Group Ltd',
  'ICB Ingénieurs Conseils en Brevets SA',
  'Swatch Group (France) S.A.S.',
];

function jobsFor(companies: string[]) {
  return companies.map((company, i) => ({
    id: `job-${i}`,
    company,
    companyKey: 'placeholder', // the buggy blindly-stamped key; must be ignored
  }));
}

describe('swatchgroup-brand-filter', () => {
  describe('SHARED_POOL_BRAND_PATTERNS', () => {
    it('covers exactly the 4 companyKeys affected by issue #4392', () => {
      expect([...SHARED_POOL_BRAND_PATTERNS.keys()].sort()).toEqual(
        ['comadur-swatch-group', 'nivarox-swatch-group', 'rado', 'swatch-group-assembly'].sort(),
      );
    });

    it('does not cover the own-domain sub-brands (eta-sa, swiss-timing)', () => {
      expect(SHARED_POOL_BRAND_PATTERNS.has('eta-sa-swatch-group')).toBe(false);
      expect(SHARED_POOL_BRAND_PATTERNS.has('swiss-timing-swatch-group')).toBe(false);
    });
  });

  describe('filterSharedPoolJobsByBrand', () => {
    it('rejects the entire real shared pool for all 4 companyKeys (live evidence: 0 genuine matches today)', () => {
      const jobs = jobsFor(REAL_POOL_COMPANIES);
      for (const key of ['rado', 'comadur-swatch-group', 'nivarox-swatch-group', 'swatch-group-assembly']) {
        expect(filterSharedPoolJobsByBrand(key, jobs)).toEqual([]);
      }
    });

    it('keeps a genuine Rado job by legal-entity name', () => {
      const jobs = [
        { id: 'a', company: 'Rado Watch Co. Ltd' },
        { id: 'b', company: 'Omega Ltd.' },
      ];
      const kept = filterSharedPoolJobsByBrand('rado', jobs);
      expect(kept).toHaveLength(1);
      expect(kept[0].id).toBe('a');
    });

    it('keeps a genuine Comadur job and rejects lookalikes', () => {
      const jobs = [
        { id: 'a', company: 'Comadur SA' },
        { id: 'b', company: 'The Swatch Group Ltd' },
      ];
      expect(filterSharedPoolJobsByBrand('comadur-swatch-group', jobs).map((j) => j.id)).toEqual(['a']);
    });

    it('keeps a genuine Nivarox job (Nivarox-FAR SA legal name)', () => {
      const jobs = [
        { id: 'a', company: 'Nivarox-FAR SA' },
        { id: 'b', company: 'ETA SA Manufacture Horlogère Suisse' },
      ];
      expect(filterSharedPoolJobsByBrand('nivarox-swatch-group', jobs).map((j) => j.id)).toEqual(['a']);
    });

    it('keeps a genuine Swatch Group Assembly job but not the plain holding company', () => {
      const jobs = [
        { id: 'a', company: 'Swatch Group Assembly SA' },
        { id: 'b', company: 'The Swatch Group Ltd' },
        { id: 'c', company: 'The Swatch Group Research and Development Ltd' },
      ];
      expect(filterSharedPoolJobsByBrand('swatch-group-assembly', jobs).map((j) => j.id)).toEqual(['a']);
    });

    it('does not word-boundary-false-positive (e.g. "rado" inside another word)', () => {
      const jobs = [{ id: 'a', company: 'Corado Trading SA' }];
      expect(filterSharedPoolJobsByBrand('rado', jobs)).toEqual([]);
    });

    it('is a no-op passthrough for companyKeys outside the shared-pool map', () => {
      const jobs = jobsFor(['Anything Ltd']);
      expect(filterSharedPoolJobsByBrand('eta-sa-swatch-group', jobs)).toEqual(jobs);
      expect(filterSharedPoolJobsByBrand('swiss-timing-swatch-group', jobs)).toEqual(jobs);
      expect(filterSharedPoolJobsByBrand('some-unrelated-company', jobs)).toEqual(jobs);
    });

    it('handles missing/empty company field and empty job list gracefully', () => {
      expect(filterSharedPoolJobsByBrand('rado', [{ id: 'a' }])).toEqual([]);
      expect(filterSharedPoolJobsByBrand('rado', [])).toEqual([]);
      expect(filterSharedPoolJobsByBrand('rado', undefined as unknown as [])).toEqual([]);
    });

    it('is case-insensitive', () => {
      const jobs = [{ id: 'a', company: 'rado watch co. ltd' }];
      expect(filterSharedPoolJobsByBrand('rado', jobs)).toHaveLength(1);
    });
  });
});
