/**
 * #3649 — "offerte simili" block on JobDetail.
 *
 * Regression coverage for the self-exclusion bug in the pre-existing
 * `relatedJobs` clustering: the filter compared raw `j.id !== selectedJob.id`.
 * Several crawlers ship jobs with `id: undefined` (scripts/lib/job-match-key.mjs,
 * #3411), and `dedupeJobsForListing` only guarantees uniqueness on the full
 * `buildListingDedupKey` — not on `.id` alone — so multiple genuinely different
 * jobs can share `id: undefined` in the same pool. Comparing raw ids meant an
 * id-less selected job wrongly excluded every other id-less job as "itself",
 * collapsing its similar-jobs list.
 *
 * The extracted `computeSimilarJobs` / `describeSimilarJobMatchReason` reuse
 * the existing sector/canton/company clustering signal (no new clustering
 * logic — see #3649 scope: "riusa, non reinventare la clusterizzazione") and
 * are exported so this can be tested without rendering the ~8500-line
 * JobBoard component.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  computeSimilarJobs,
  describeSimilarJobMatchReason,
} from '@/components/community/JobBoard.tsx';
import type { JobListing } from '@/components/community/JobBoard.tsx';

function makeJob(overrides: Partial<JobListing>): JobListing {
  return {
    id: 'test-id',
    title: 'Test Job',
    company: 'Test Company',
    location: 'Lugano',
    canton: 'TI',
    category: 'other',
    slug: 'test-job-test-company-lugano',
    postedDate: '2026-01-01',
    crawledAt: '2026-01-01',
    source: 'test',
    url: 'https://example.com',
    ...overrides,
  } as unknown as JobListing;
}

describe('describeSimilarJobMatchReason', () => {
  const source = makeJob({ category: 'tech', location: 'Lugano', company: 'Acme' });

  it('prioritizes category over location/company', () => {
    const target = makeJob({ category: 'tech', location: 'Bellinzona', company: 'Other' });
    expect(describeSimilarJobMatchReason(source, target)).toBe('category');
  });

  it('falls back to location when category differs', () => {
    const target = makeJob({ category: 'sales', location: 'Lugano', company: 'Other' });
    expect(describeSimilarJobMatchReason(source, target)).toBe('location');
  });

  it('falls back to company when category and location differ', () => {
    const target = makeJob({ category: 'sales', location: 'Bellinzona', company: 'Acme' });
    expect(describeSimilarJobMatchReason(source, target)).toBe('company');
  });

  it('reports other when nothing matches', () => {
    const target = makeJob({ category: 'sales', location: 'Bellinzona', company: 'Other' });
    expect(describeSimilarJobMatchReason(source, target)).toBe('other');
  });
});

describe('computeSimilarJobs — self-exclusion identity', () => {
  it('does not treat two distinct id-less jobs as the same job (regression #3649)', () => {
    // Two genuinely different vacancies that both ship id: undefined, as
    // happens for ferrovia-retica/julius-baer/mikron/relewant/etc (#3411).
    const source = makeJob({
      id: undefined,
      url: 'https://example.com/jobs/a',
      slug: 'source-job',
      category: 'tech',
    });
    const other = makeJob({
      id: undefined,
      url: 'https://example.com/jobs/b',
      slug: 'other-job',
      category: 'tech',
    });
    const result = computeSimilarJobs(source, [source, other]);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('other-job');
  });

  it('still excludes the source job itself when ids match', () => {
    const source = makeJob({ id: 'job-1', slug: 'source-job' });
    const same = makeJob({ id: 'job-1', slug: 'source-job' });
    const different = makeJob({ id: 'job-2', slug: 'different-job' });
    const result = computeSimilarJobs(source, [source, same, different]);
    expect(result.map((j) => j.slug)).toEqual(['different-job']);
  });

  it('excludes candidates without a slug', () => {
    const source = makeJob({ id: 'job-1', slug: 'source-job' });
    const noSlug = makeJob({ id: 'job-2', slug: undefined });
    const result = computeSimilarJobs(source, [source, noSlug]);
    expect(result).toHaveLength(0);
  });
});

describe('computeSimilarJobs — scoring and cap', () => {
  const source = makeJob({
    id: 'job-1',
    slug: 'source-job',
    category: 'tech',
    location: 'Lugano',
    company: 'Acme',
  });

  it('ranks category match above location and company matches', () => {
    const categoryMatch = makeJob({ id: 'job-2', slug: 'category-match', category: 'tech', location: 'Bellinzona', company: 'Other' });
    const locationMatch = makeJob({ id: 'job-3', slug: 'location-match', category: 'sales', location: 'Lugano', company: 'Other' });
    const companyMatch = makeJob({ id: 'job-4', slug: 'company-match', category: 'sales', location: 'Bellinzona', company: 'Acme' });
    const result = computeSimilarJobs(source, [companyMatch, locationMatch, categoryMatch]);
    expect(result.map((j) => j.slug)).toEqual(['category-match', 'location-match', 'company-match']);
  });

  it('breaks ties by freshness (crawledAt/postedDate) descending', () => {
    const older = makeJob({ id: 'job-2', slug: 'older', category: 'tech', crawledAt: '2026-01-01' });
    const newer = makeJob({ id: 'job-3', slug: 'newer', category: 'tech', crawledAt: '2026-06-01' });
    const result = computeSimilarJobs(source, [older, newer]);
    expect(result.map((j) => j.slug)).toEqual(['newer', 'older']);
  });

  it('caps the result at the given limit (default 6)', () => {
    const pool = Array.from({ length: 10 }, (_, i) =>
      makeJob({ id: `job-pool-${i}`, slug: `pool-${i}`, category: 'tech' }),
    );
    expect(computeSimilarJobs(source, pool)).toHaveLength(6);
    expect(computeSimilarJobs(source, pool, 3)).toHaveLength(3);
  });
});

describe('JobBoard — job_match_similar_click wiring (source assertions)', () => {
  // JobBoard.tsx is the single largest component in the repo (~8500 LOC), and
  // the unlocked-detail related-jobs block lives inside a long pre-existing
  // dense JSX line. Source assertions are the only viable way to guard both
  // click sites without making the suite brittle against unrelated refactors
  // (mirrors tests/community/JobBoard.sticky-sidebar.test.tsx).
  const SOURCE = readFileSync(
    resolve(__dirname, '../../components/community/JobBoard.tsx'),
    'utf8',
  );

  it('fires trackJobMatchSimilarClick from both related-jobs click sites', () => {
    const occurrences = SOURCE.match(/Analytics\.trackJobMatchSimilarClick\(/g) || [];
    expect(occurrences.length).toBe(2);
  });

  it('keys related-jobs cards and renderJobCard on buildListingDedupKey, not raw job.id', () => {
    // Both related-jobs render blocks, plus the shared renderJobCard used by
    // renderJobListWithAds for the 8 editorial-landing sections, key their
    // card on the fixed identity primitive; job.id alone can collide across
    // distinct jobs (#3649). renderJobListWithAds flattens renderJobCard's
    // output as a sibling of the interleaved ad node, so a raw job.id key
    // collision there is a real React duplicate-key risk, not just cosmetic.
    const occurrences = SOURCE.match(/key=\{buildListingDedupKey\(job\)\}/g) || [];
    expect(occurrences.length).toBe(3);
  });
});

describe('Analytics.trackJobMatchSimilarClick', () => {
  it('emits job_match_similar_click via the shared log() dispatcher', () => {
    const SOURCE = readFileSync(resolve(__dirname, '../../services/analytics.ts'), 'utf8');
    expect(SOURCE).toMatch(/trackJobMatchSimilarClick:\s*\(/);
    expect(SOURCE).toMatch(/log\('job_match_similar_click',/);
  });
});
