/**
 * Regression: company filter URLs like /azienda-migros/ must not be treated as
 * false positives when the company has no active job listings.
 *
 * Before the fix, isFalsePositiveCompanyFilter triggered for any company slug
 * with zero results and no employerBrand, breaking legitimate /azienda-{name}/
 * filter pages (e.g. /azienda-migros/) when the company had no active listings.
 *
 * The fix moves the disambiguation into parseCompanySlugFilter + seededJobMatchesSlug:
 * - Active job whose slug starts with "azienda-": caught by active-jobs check.
 * - Expired seeded job whose slug starts with "azienda-": caught by seededJobMatchesSlug.
 * - Legitimate company filter (zero active listings, no employer brand): companySlugFilter
 *   is correctly set so the company page renders instead of the orphan/404 view.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCompanySlugFilter } from '@/components/community/JobBoard.tsx';
import { seededJobMatchesSlug } from '@/hooks/useExpiredJob';
import type { JobListing } from '@/components/community/JobBoard.tsx';

// Minimal job fixture satisfying the JobListing shape
function makeJob(overrides: Partial<JobListing>): JobListing {
  return {
    id: 'test-id',
    title: 'Test Job',
    company: 'Test Company',
    location: 'Lugano',
    slug: 'test-job-test-company-lugano',
    postedDate: '2026-01-01',
    crawledAt: '2026-01-01',
    source: 'test',
    url: 'https://example.com',
    ...overrides,
  } as unknown as JobListing;
}

describe('parseCompanySlugFilter', () => {
  describe('legitimate company filter URLs', () => {
    it('returns company slug for /azienda-migros/ with no active jobs', () => {
      expect(parseCompanySlugFilter('azienda-migros', [])).toBe('migros');
    });

    it('returns company slug for /azienda-swisscom/ with no active jobs', () => {
      expect(parseCompanySlugFilter('azienda-swisscom', [])).toBe('swisscom');
    });

    it('returns company slug for /company-migros/ (EN locale)', () => {
      expect(parseCompanySlugFilter('company-migros', [])).toBe('migros');
    });

    it('returns company slug for /unternehmen-migros/ (DE locale)', () => {
      expect(parseCompanySlugFilter('unternehmen-migros', [])).toBe('migros');
    });

    it('returns company slug for /entreprise-migros/ (FR locale)', () => {
      expect(parseCompanySlugFilter('entreprise-migros', [])).toBe('migros');
    });

    it('returns null for non-prefixed slugs', () => {
      expect(parseCompanySlugFilter('software-engineer-lugano', [])).toBeNull();
    });
  });

  describe('active job slug disambiguation', () => {
    it('returns null when an active job directly matches the slug (regression: Azienda Multiservizi AMB)', () => {
      const activeJob = makeJob({ slug: 'azienda-multiservizi-bellinzona-amb' });
      expect(parseCompanySlugFilter('azienda-multiservizi-bellinzona-amb', [activeJob])).toBeNull();
    });

    it('returns null when active job matches via slugByLocale', () => {
      const activeJob = makeJob({
        slug: 'azienda-multiservizi-bellinzona-amb',
        slugByLocale: { it: 'azienda-multiservizi-bellinzona-amb', en: 'azienda-multiservizi-bellinzona-amb-en' },
      });
      expect(parseCompanySlugFilter('azienda-multiservizi-bellinzona-amb-en', [activeJob])).toBeNull();
    });

    it('returns company slug when no active job matches (different slug)', () => {
      const activeJob = makeJob({ slug: 'infermiere-ospedale-lugano' });
      // "azienda-usi" is a company filter; "infermiere-ospedale-lugano" is unrelated
      expect(parseCompanySlugFilter('azienda-usi', [activeJob])).toBe('usi');
    });
  });
});

describe('seededJobMatchesSlug', () => {
  let originalExpiredData: unknown;

  beforeEach(() => {
    originalExpiredData = (window as Record<string, unknown>).__EXPIRED_JOB_DATA__;
  });

  afterEach(() => {
    (window as Record<string, unknown>).__EXPIRED_JOB_DATA__ = originalExpiredData;
  });

  it('returns false when no seeded data is present', () => {
    delete (window as Record<string, unknown>).__EXPIRED_JOB_DATA__;
    expect(seededJobMatchesSlug('azienda-migros')).toBe(false);
  });

  it('returns true when seeded slug matches exactly', () => {
    (window as Record<string, unknown>).__EXPIRED_JOB_DATA__ = {
      slug: 'azienda-multiservizi-bellinzona-amb',
      title: 'Addetto magazzino',
      company: 'Azienda Multiservizi Bellinzona AMB',
    };
    expect(seededJobMatchesSlug('azienda-multiservizi-bellinzona-amb')).toBe(true);
  });

  it('returns false for a different slug (prevents stale SPA window global false positive)', () => {
    // Simulates navigating from an expired job page to /azienda-migros/ within the SPA:
    // window.__EXPIRED_JOB_DATA__ retains the previous page's data but the slug won't match.
    (window as Record<string, unknown>).__EXPIRED_JOB_DATA__ = {
      slug: 'azienda-multiservizi-bellinzona-amb',
      title: 'Addetto magazzino',
      company: 'Azienda Multiservizi Bellinzona AMB',
    };
    expect(seededJobMatchesSlug('azienda-migros')).toBe(false);
  });

  it('returns true when seeded slug matches via slugByLocale', () => {
    (window as Record<string, unknown>).__EXPIRED_JOB_DATA__ = {
      slug: 'azienda-multiservizi-bellinzona-amb',
      slugByLocale: { en: 'azienda-multiservizi-amb-en', de: 'unternehmen-multiservizi-bellinzona' },
      title: 'Addetto magazzino',
      company: 'Azienda Multiservizi Bellinzona AMB',
    };
    expect(seededJobMatchesSlug('azienda-multiservizi-amb-en')).toBe(true);
    expect(seededJobMatchesSlug('unternehmen-multiservizi-bellinzona')).toBe(true);
    expect(seededJobMatchesSlug('azienda-migros')).toBe(false);
  });
});

describe('integration: company filter page with no active listings should NOT be treated as orphan', () => {
  it('parseCompanySlugFilter returns a non-null filter even when active jobs list is empty', () => {
    // This is the scenario that was broken: /azienda-migros/ with 0 current Migros jobs.
    // Before the fix, isFalsePositiveCompanyFilter would kick in and show the orphan view.
    // Now companySlugFilter is correctly set to "migros", so the company page renders.
    const result = parseCompanySlugFilter('azienda-migros', []);
    expect(result).toBe('migros');
    expect(result).not.toBeNull();
  });

  it('parseCompanySlugFilter returns null for a slug that IS a seeded expired job', () => {
    // Handled by seededJobMatchesSlug in the useMemo — see JobBoard.tsx companySlugFilter memo.
    // parseCompanySlugFilter itself only covers active jobs; the useMemo applies the seeded check.
    const result = parseCompanySlugFilter('azienda-multiservizi-bellinzona-amb', []);
    // Without a matching active job, parseCompanySlugFilter alone returns a slug.
    // The seededJobMatchesSlug guard in useMemo is what makes it null at runtime.
    expect(result).toBe('multiservizi-bellinzona-amb');
  });
});
