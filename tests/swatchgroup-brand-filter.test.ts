import { describe, it, expect } from 'vitest';
import {
  SHARED_POOL_BRAND_PATTERNS,
  filterSharedPoolJobsByBrand,
  isSharedSwatchPoolJob,
  selectSharedPoolBrandJobs,
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

  // ── issue #5392 / #5394 ──────────────────────────────────────
  //
  // Verbatim records from the live crawl pool, copied out of
  // data/jobs-crawler-summaries/by-crawler/swatchgroup.json as written by the
  // production run of 2026-08-09T21:52:40Z. The point of the sample is the
  // `companyKey` column: every pooled posting carries `swatch-group-assembly`
  // or `rado` regardless of who actually posted it, because the shared
  // crawler de-duplicates the group job-finder by URL across the
  // per-companyKey iterations and never re-stamps. Note also that the Comadur
  // row is persisted on the bare apex host while its siblings carry `www.`.
  const REAL_POOL_SAMPLE = [
    {
      id: 'company-7uavdc',
      company: 'EM Microelectronic-Marin Ltd',
      title: 'Sales & Business Development Manager',
      url: 'https://www.swatchgroup.com/en/job/31885',
      companyKey: 'swatch-group-assembly',
      companyDomain: 'swatchgroup.com',
    },
    {
      id: 'company-7ubhjn',
      company: 'Comadur SA',
      title: 'Comptable Polyvalent',
      url: 'https://swatchgroup.com/fr/job/32757',
      companyKey: 'swatch-group-assembly',
      companyDomain: 'swatchgroup.com',
    },
    {
      id: 'company-rado1',
      company: 'Rado Watch Co. Ltd.',
      title: 'Uhrmacher:in Produktion Lehrstelle 2027',
      url: 'https://www.swatchgroup.com/de/job/32620',
      companyKey: 'swatch-group-assembly',
      companyDomain: 'swatchgroup.com',
    },
    {
      id: 'company-eta1',
      company: 'ETA SA Manufacture Horlogère Suisse',
      title: 'Ingénieur',
      url: 'https://www.eta.ch/en/jobs/12345',
      companyKey: 'eta-sa-swatch-group',
      companyDomain: 'eta.ch',
    },
  ];

  describe('isSharedSwatchPoolJob', () => {
    it('recognises both the www and bare-apex swatchgroup.com hosts', () => {
      expect(isSharedSwatchPoolJob({ url: 'https://www.swatchgroup.com/en/job/1' })).toBe(true);
      expect(isSharedSwatchPoolJob({ url: 'https://swatchgroup.com/fr/job/32757' })).toBe(true);
    });

    it('rejects own-domain sub-brands and junk URLs', () => {
      expect(isSharedSwatchPoolJob({ url: 'https://www.eta.ch/en/jobs/1' })).toBe(false);
      expect(isSharedSwatchPoolJob({ url: 'https://www.swisstiming.com/company/job-offers/' })).toBe(false);
      expect(isSharedSwatchPoolJob({ url: 'not a url' })).toBe(false);
      expect(isSharedSwatchPoolJob({})).toBe(false);
    });

    it('falls back to companyDomain when the URL is unusable', () => {
      expect(isSharedSwatchPoolJob({ url: '', companyDomain: 'swatchgroup.com' })).toBe(true);
    });

    it('does not match a lookalike host', () => {
      expect(isSharedSwatchPoolJob({ url: 'https://notswatchgroup.com/en/job/1' })).toBe(false);
    });
  });

  describe('selectSharedPoolBrandJobs', () => {
    it('finds the genuine Comadur job stamped with a sibling companyKey (#5392)', () => {
      // This is the regression: narrowing by companyKey first yields [] here,
      // because the only Comadur posting in the pool is stamped
      // `swatch-group-assembly`.
      const byKeyFirst = REAL_POOL_SAMPLE.filter((j) => j.companyKey === 'comadur-swatch-group');
      expect(byKeyFirst).toEqual([]);

      const kept = selectSharedPoolBrandJobs('comadur-swatch-group', REAL_POOL_SAMPLE);
      expect(kept).toHaveLength(1);
      expect(kept[0].title).toBe('Comptable Polyvalent');
      expect(kept[0].company).toBe('Comadur SA');
    });

    it('re-stamps the correct companyKey on the jobs it claims', () => {
      const [job] = selectSharedPoolBrandJobs('comadur-swatch-group', REAL_POOL_SAMPLE);
      expect(job.companyKey).toBe('comadur-swatch-group');
    });

    it('does not mutate the pooled job objects it re-stamps', () => {
      const before = JSON.parse(JSON.stringify(REAL_POOL_SAMPLE));
      selectSharedPoolBrandJobs('comadur-swatch-group', REAL_POOL_SAMPLE);
      expect(REAL_POOL_SAMPLE).toEqual(before);
    });

    it('recovers the live Rado posting the key pre-filter used to hide', () => {
      const kept = selectSharedPoolBrandJobs('rado', REAL_POOL_SAMPLE);
      expect(kept.map((j) => j.company)).toEqual(['Rado Watch Co. Ltd.']);
      expect(kept[0].companyKey).toBe('rado');
    });

    it('still returns 0 for a brand with no genuine posting in the pool (#5394)', () => {
      expect(selectSharedPoolBrandJobs('nivarox-swatch-group', REAL_POOL_SAMPLE)).toEqual([]);
      expect(selectSharedPoolBrandJobs('swatch-group-assembly', REAL_POOL_SAMPLE)).toEqual([]);
    });

    it('never lets a shared-pool brand claim the whole pool', () => {
      for (const key of [...SHARED_POOL_BRAND_PATTERNS.keys()]) {
        expect(selectSharedPoolBrandJobs(key, REAL_POOL_SAMPLE).length).toBeLessThan(
          REAL_POOL_SAMPLE.length,
        );
      }
    });

    it('never claims a job from an own-domain sub-brand', () => {
      const etaJob = REAL_POOL_SAMPLE.find((j) => j.companyKey === 'eta-sa-swatch-group')!;
      for (const key of [...SHARED_POOL_BRAND_PATTERNS.keys()]) {
        expect(selectSharedPoolBrandJobs(key, REAL_POOL_SAMPLE)).not.toContainEqual(etaJob);
      }
    });

    it('keeps exact companyKey equality for own-domain sub-brands', () => {
      const kept = selectSharedPoolBrandJobs('eta-sa-swatch-group', REAL_POOL_SAMPLE);
      expect(kept).toHaveLength(1);
      expect(kept[0].company).toBe('ETA SA Manufacture Horlogère Suisse');
      // Unchanged object identity: no re-stamping path for these.
      expect(kept[0]).toBe(REAL_POOL_SAMPLE[3]);
    });

    it('returns [] for an own-domain key with nothing of its own in the pool', () => {
      expect(selectSharedPoolBrandJobs('swiss-timing-swatch-group', REAL_POOL_SAMPLE)).toEqual([]);
    });

    it('handles empty and non-array input gracefully', () => {
      expect(selectSharedPoolBrandJobs('rado', [])).toEqual([]);
      expect(selectSharedPoolBrandJobs('rado', undefined as unknown as [])).toEqual([]);
      expect(selectSharedPoolBrandJobs('eta-sa-swatch-group', null as unknown as [])).toEqual([]);
    });
  });
});
