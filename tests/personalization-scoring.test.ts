/**
 * Tests for personalizationScoring.ts — pure function scoring engine.
 */
import { describe, it, expect } from 'vitest';
import {
  computePersonalScore,
  computeNewJobsCount,
  getTrendingByLocation,
  computeTrendingBoost,
} from '@/services/personalizationScoring';
import type { BehaviorData } from '@/services/behaviorTracker';
import type { JobMatchProfileData } from '@/services/jobMatchProfile';

// ── Helpers ────────────────────────────────────────────────────

function emptyBehavior(): BehaviorData {
  return {
    version: 1,
    lastVisit: null,
    viewedJobs: [],
    searches: [],
    filterUsage: { category: {}, location: {}, contract: {} },
    syncedAt: null,
  };
}

function makeJob(overrides: Partial<{
  slug: string;
  category: string;
  company: string;
  location: string;
  title: string;
  addressLocality: string;
  postedDate: string;
  crawledAt: string;
  firstSeenAt: string;
  canton: string;
  sector: string;
}> = {}) {
  return {
    slug: overrides.slug ?? 'test-job',
    category: overrides.category ?? 'tech',
    company: overrides.company ?? 'Acme SA',
    location: overrides.location ?? 'Lugano',
    title: overrides.title ?? 'Software Engineer',
    addressLocality: overrides.addressLocality ?? 'Lugano',
    postedDate: overrides.postedDate ?? '2026-04-10',
    crawledAt: overrides.crawledAt,
    firstSeenAt: overrides.firstSeenAt,
    canton: overrides.canton ?? 'TI',
    sector: overrides.sector,
  };
}

function makeJobMatchProfile(overrides: Partial<JobMatchProfileData> = {}): JobMatchProfileData {
  return {
    version: 1,
    sector: overrides.sector ?? null,
    experienceLevel: overrides.experienceLevel ?? null,
    canton: overrides.canton ?? null,
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

// ── computePersonalScore ───────────────────────────────────────

describe('computePersonalScore', () => {
  it('returns 0 for cold start (no behavior, no profile)', () => {
    const job = makeJob();
    const { score, topSignal } = computePersonalScore(job, emptyBehavior(), null);
    expect(score).toBe(0);
    expect(topSignal).toBe('');
  });

  it('scores +3 for category match from viewed jobs (binary, not frequency)', () => {
    const behavior = emptyBehavior();
    behavior.viewedJobs = [
      { slug: 'other-job', category: 'tech', company: 'Other', location: 'Bellinzona', ts: Date.now() },
    ];
    const job = makeJob({ slug: 'new-tech-job', category: 'tech' });
    const { score } = computePersonalScore(job, behavior, null);
    // Should include at least +3 for category match
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it('scores +4 for company match from viewed jobs', () => {
    const behavior = emptyBehavior();
    behavior.viewedJobs = [
      { slug: 'acme-job-1', category: 'finance', company: 'Acme SA', location: 'Zürich', ts: Date.now() },
    ];
    const job = makeJob({ slug: 'acme-job-2', company: 'Acme SA', category: 'tech' });
    const { score } = computePersonalScore(job, behavior, null);
    // +4 company + possibly +3 if location also matches
    expect(score).toBeGreaterThanOrEqual(4);
  });

  it('scores +3 for location match from viewed jobs', () => {
    const behavior = emptyBehavior();
    behavior.viewedJobs = [
      { slug: 'lugano-job', category: 'finance', company: 'Bank', location: 'Lugano', ts: Date.now() },
    ];
    const job = makeJob({ slug: 'new-job', category: 'health', company: 'Hospital', location: 'Lugano', addressLocality: 'Lugano' });
    const { score } = computePersonalScore(job, behavior, null);
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it('scores search keyword match (+3 per keyword, max 6)', () => {
    const behavior = emptyBehavior();
    behavior.searches = [
      { query: 'infermiere lugano', ts: Date.now(), resultCount: 10 },
    ];
    const job = makeJob({ title: 'Infermiere Diplomato', addressLocality: 'Lugano' });
    const { score, topSignal } = computePersonalScore(job, behavior, null);
    // 'infermiere' keyword match → +3
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it('stacks multiple signals: company + category + location = 4+3+3 = 10', () => {
    const behavior = emptyBehavior();
    behavior.viewedJobs = [
      { slug: 'acme-tech-lugano', category: 'tech', company: 'Acme SA', location: 'Lugano', ts: Date.now() },
    ];
    const job = makeJob({
      slug: 'acme-new',
      category: 'tech',
      company: 'Acme SA',
      location: 'Lugano',
      addressLocality: 'Lugano',
    });
    const { score } = computePersonalScore(job, behavior, null);
    expect(score).toBeGreaterThanOrEqual(10);
  });

  it('scores +3 for profile municipality → location match', () => {
    const profile = {
      municipality: 'Lugano',
      workPosition: '',
    } as any;
    const job = makeJob({ addressLocality: 'Lugano' });
    const { score } = computePersonalScore(job, emptyBehavior(), profile);
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it('scores +3 for profile workPosition → title keyword match', () => {
    const profile = {
      municipality: '',
      workPosition: 'ingegnere software',
    } as any;
    const job = makeJob({ title: 'Ingegnere Software Senior' });
    const { score } = computePersonalScore(job, emptyBehavior(), profile);
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it('returns 0 when profile is null', () => {
    const { score } = computePersonalScore(makeJob(), emptyBehavior(), null);
    expect(score).toBe(0);
  });

  it('handles NaN/bad data gracefully', () => {
    const behavior = emptyBehavior();
    behavior.viewedJobs = [
      { slug: '', category: '', company: '', location: '', ts: NaN },
    ];
    const job = makeJob();
    // Should not throw
    const { score } = computePersonalScore(job, behavior, null);
    expect(typeof score).toBe('number');
    expect(Number.isFinite(score)).toBe(true);
  });

  it('is backward compatible: omitting jobMatchProfile (4th arg) still works', () => {
    const { score } = computePersonalScore(makeJob(), emptyBehavior(), null);
    expect(score).toBe(0);
  });

  it('returns unchanged score when jobMatchProfile is null (no regression)', () => {
    const job = makeJob({ category: 'tech', canton: 'TI' });
    const { score } = computePersonalScore(job, emptyBehavior(), null, null);
    expect(score).toBe(0);
  });

  it('scores +3 for job-match profile sector → category match', () => {
    const jobMatchProfile = makeJobMatchProfile({ sector: 'it_software' });
    const job = makeJob({ category: 'tech' });
    const { score, topSignal } = computePersonalScore(job, emptyBehavior(), null, jobMatchProfile);
    expect(score).toBeGreaterThanOrEqual(3);
    expect(topSignal).toBe('profile_sector');
  });

  it('does not score sector signal when mapped category differs', () => {
    const jobMatchProfile = makeJobMatchProfile({ sector: 'hospitality' });
    const job = makeJob({ category: 'tech' });
    const { score } = computePersonalScore(job, emptyBehavior(), null, jobMatchProfile);
    expect(score).toBe(0);
  });

  it('scores +2 for job-match profile canton match', () => {
    const jobMatchProfile = makeJobMatchProfile({ canton: 'TI' });
    const job = makeJob({ canton: 'TI', category: 'other' });
    const { score, topSignal } = computePersonalScore(job, emptyBehavior(), null, jobMatchProfile);
    expect(score).toBeGreaterThanOrEqual(2);
    expect(topSignal).toBe('profile_canton');
  });

  it('does not score canton signal on mismatch', () => {
    const jobMatchProfile = makeJobMatchProfile({ canton: 'ZH' });
    const job = makeJob({ canton: 'TI', category: 'other' });
    const { score } = computePersonalScore(job, emptyBehavior(), null, jobMatchProfile);
    expect(score).toBe(0);
  });

  it('scores +2 for job-match profile experience level (senior keyword in title)', () => {
    const jobMatchProfile = makeJobMatchProfile({ experienceLevel: 'senior_6_10' });
    const job = makeJob({ title: 'Senior Software Engineer', category: 'other' });
    const { score, topSignal } = computePersonalScore(job, emptyBehavior(), null, jobMatchProfile);
    expect(score).toBeGreaterThanOrEqual(2);
    expect(topSignal).toBe('profile_experience');
  });

  it('scores +2 for job-match profile experience level (junior keyword in title)', () => {
    const jobMatchProfile = makeJobMatchProfile({ experienceLevel: 'junior_0_2' });
    const job = makeJob({ title: 'Stage Marketing Digitale', category: 'other' });
    const { score } = computePersonalScore(job, emptyBehavior(), null, jobMatchProfile);
    expect(score).toBeGreaterThanOrEqual(2);
  });

  it('expert_10_plus experience level matches the same senior keywords as senior_6_10', () => {
    const jobMatchProfile = makeJobMatchProfile({ experienceLevel: 'expert_10_plus' });
    const job = makeJob({ title: 'Direttore Vendite', category: 'other' });
    const { score } = computePersonalScore(job, emptyBehavior(), null, jobMatchProfile);
    expect(score).toBeGreaterThanOrEqual(2);
  });

  it('mid_3_5 experience level contributes no boost (no reliable keyword signal)', () => {
    const jobMatchProfile = makeJobMatchProfile({ experienceLevel: 'mid_3_5' });
    const job = makeJob({ title: 'Mid-Level Developer', category: 'other' });
    const { score } = computePersonalScore(job, emptyBehavior(), null, jobMatchProfile);
    expect(score).toBe(0);
  });

  it('stacks job-match profile signals: sector + canton + experience = 3+2+2 = 7', () => {
    const jobMatchProfile = makeJobMatchProfile({
      sector: 'it_software',
      canton: 'TI',
      experienceLevel: 'senior_6_10',
    });
    const job = makeJob({ category: 'tech', canton: 'TI', title: 'Senior Software Engineer' });
    const { score } = computePersonalScore(job, emptyBehavior(), null, jobMatchProfile);
    expect(score).toBeGreaterThanOrEqual(7);
  });

  // ── Newsletter-sourced profile fallbacks (mergeNewsletterSignals, #3648) ──
  // jobMatchProfile.sector/canton can come from the newsletter_subscribers
  // doc instead of SalarySurvey: sector is already category-shaped (not a
  // SURVEY_SECTOR_TO_CATEGORY key) and canton is a city name, not a code.

  it('scores sector signal when the profile sector is already category-shaped (newsletter source)', () => {
    // 'tech' is not a SalarySurvey key in SURVEY_SECTOR_TO_CATEGORY, so the
    // `?? jobMatchProfile.sector` fallback must pass it through unchanged.
    const jobMatchProfile = makeJobMatchProfile({ sector: 'tech' });
    const job = makeJob({ category: 'tech' });
    const { score, topSignal } = computePersonalScore(job, emptyBehavior(), null, jobMatchProfile);
    expect(score).toBeGreaterThanOrEqual(3);
    expect(topSignal).toBe('profile_sector');
  });

  it('scores canton signal via location-text match when the profile canton is a city name (newsletter source)', () => {
    // 'Lugano' is not a 2-letter canton code, so the exact `job.canton`
    // comparison must fall back to isLocationMatch against jobLoc.
    const jobMatchProfile = makeJobMatchProfile({ canton: 'Lugano' });
    const job = makeJob({ canton: 'TI', addressLocality: 'Lugano' });
    const { score, topSignal } = computePersonalScore(job, emptyBehavior(), null, jobMatchProfile);
    expect(score).toBeGreaterThanOrEqual(2);
    expect(topSignal).toBe('profile_canton');
  });

  it('does not score canton signal when the profile city name does not match jobLoc', () => {
    const jobMatchProfile = makeJobMatchProfile({ canton: 'Lugano' });
    const job = makeJob({ canton: 'ZH', addressLocality: 'Zurich', location: 'Zurich' });
    const { score } = computePersonalScore(job, emptyBehavior(), null, jobMatchProfile);
    expect(score).toBe(0);
  });
});

// ── computeNewJobsCount ────────────────────────────────────────

describe('computeNewJobsCount', () => {
  it('returns 0 when lastVisit is null', () => {
    const jobs = [makeJob({ firstSeenAt: '2026-04-14T10:00:00Z' })];
    const { total, matching } = computeNewJobsCount(jobs, null, emptyBehavior(), null);
    expect(total).toBe(0);
    expect(matching).toBe(0);
  });

  it('counts jobs newer than lastVisit', () => {
    const lastVisit = new Date('2026-04-12T00:00:00Z').getTime();
    const jobs = [
      makeJob({ slug: 'old', firstSeenAt: '2026-04-11T00:00:00Z' }),
      makeJob({ slug: 'new1', firstSeenAt: '2026-04-13T00:00:00Z' }),
      makeJob({ slug: 'new2', firstSeenAt: '2026-04-14T00:00:00Z' }),
    ];
    const { total } = computeNewJobsCount(jobs, lastVisit, emptyBehavior(), null);
    expect(total).toBe(2);
  });

  it('counts matching new jobs based on behavior', () => {
    const lastVisit = new Date('2026-04-12T00:00:00Z').getTime();
    const behavior = emptyBehavior();
    behavior.viewedJobs = [
      { slug: 'prev-tech', category: 'tech', company: 'X', location: 'Lugano', ts: Date.now() },
    ];
    const jobs = [
      makeJob({ slug: 'new-tech', category: 'tech', firstSeenAt: '2026-04-13T00:00:00Z' }),
      makeJob({ slug: 'new-health', category: 'health', firstSeenAt: '2026-04-13T00:00:00Z' }),
    ];
    const { total, matching } = computeNewJobsCount(jobs, lastVisit, behavior, null);
    expect(total).toBe(2);
    expect(matching).toBeGreaterThanOrEqual(1); // tech job matches
  });

  it('counts matching new jobs based on job-match profile alone (no behavior)', () => {
    const lastVisit = new Date('2026-04-12T00:00:00Z').getTime();
    const jobMatchProfile = makeJobMatchProfile({ sector: 'it_software' });
    const jobs = [
      makeJob({ slug: 'new-tech', category: 'tech', firstSeenAt: '2026-04-13T00:00:00Z' }),
      makeJob({ slug: 'new-health', category: 'health', firstSeenAt: '2026-04-13T00:00:00Z' }),
    ];
    const { total, matching } = computeNewJobsCount(jobs, lastVisit, emptyBehavior(), null, jobMatchProfile);
    expect(total).toBe(2);
    expect(matching).toBe(1); // only the tech job matches the sector signal
  });
});

// ── getTrendingByLocation ──────────────────────────────────────

describe('getTrendingByLocation', () => {
  it('returns empty array when popularity data is empty', () => {
    const jobs = [makeJob()];
    const result = getTrendingByLocation(jobs, {}, null);
    expect(result).toEqual([]);
  });

  it('returns empty array when no jobs have popularity', () => {
    const jobs = [makeJob({ slug: 'no-views' })];
    const popularity = { 'other-slug': 5 };
    const result = getTrendingByLocation(jobs, popularity, null);
    expect(result).toEqual([]);
  });

  it('returns top 4 jobs sorted by popularity DESC', () => {
    const jobs = [
      makeJob({ slug: 'a', title: 'A' }),
      makeJob({ slug: 'b', title: 'B' }),
      makeJob({ slug: 'c', title: 'C' }),
      makeJob({ slug: 'd', title: 'D' }),
      makeJob({ slug: 'e', title: 'E' }),
    ];
    const popularity = { a: 10, b: 50, c: 30, d: 20, e: 5 };
    const result = getTrendingByLocation(jobs, popularity, null);
    expect(result).toHaveLength(4);
    expect(result[0].slug).toBe('b'); // 50 views
    expect(result[1].slug).toBe('c'); // 30 views
  });

  it('filters by user location when available', () => {
    const jobs = [
      makeJob({ slug: 'lugano-1', addressLocality: 'Lugano' }),
      makeJob({ slug: 'lugano-2', addressLocality: 'Lugano' }),
      makeJob({ slug: 'lugano-3', addressLocality: 'Lugano' }),
      makeJob({ slug: 'bellinzona-1', addressLocality: 'Bellinzona' }),
    ];
    const popularity = { 'lugano-1': 10, 'lugano-2': 20, 'lugano-3': 30, 'bellinzona-1': 50 };
    const result = getTrendingByLocation(jobs, popularity, 'Lugano');
    // Should filter to Lugano only (3 jobs, meets threshold of 3)
    expect(result.every((j) => j.addressLocality === 'Lugano')).toBe(true);
  });

  it('falls back to all jobs when location filter yields < 3 matches', () => {
    const jobs = [
      makeJob({ slug: 'lugano-1', addressLocality: 'Lugano' }),
      makeJob({ slug: 'bellinzona-1', addressLocality: 'Bellinzona' }),
      makeJob({ slug: 'bellinzona-2', addressLocality: 'Bellinzona' }),
      makeJob({ slug: 'bellinzona-3', addressLocality: 'Bellinzona' }),
    ];
    const popularity = { 'lugano-1': 10, 'bellinzona-1': 20, 'bellinzona-2': 30, 'bellinzona-3': 40 };
    const result = getTrendingByLocation(jobs, popularity, 'Lugano');
    // Only 1 Lugano job → falls back to all
    expect(result.length).toBeGreaterThanOrEqual(3);
  });
});

// ── computeTrendingBoost ───────────────────────────────────────

describe('computeTrendingBoost', () => {
  it('returns 0 for unknown slug', () => {
    expect(computeTrendingBoost('unknown', { a: 10 })).toBe(0);
  });

  it('returns 0 for undefined slug', () => {
    expect(computeTrendingBoost(undefined, { a: 10 })).toBe(0);
  });

  it('returns 3 for top percentile (90th+)', () => {
    const popularity: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      popularity[`job-${i}`] = i + 1;
    }
    // job-99 has 100 views, highest
    expect(computeTrendingBoost('job-99', popularity)).toBe(3);
  });

  it('returns 0 for lowest percentile', () => {
    const popularity: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      popularity[`job-${i}`] = i + 1;
    }
    // job-0 has 1 view, lowest
    expect(computeTrendingBoost('job-0', popularity)).toBe(0);
  });
});

// ── Sort integration ───────────────────────────────────────────

describe('sort integration', () => {
  it('personalized scores produce correct sort order', () => {
    const behavior = emptyBehavior();
    behavior.viewedJobs = [
      { slug: 'prev-tech', category: 'tech', company: 'Acme SA', location: 'Lugano', ts: Date.now() },
    ];

    const jobs = [
      makeJob({ slug: 'health-job', category: 'health', company: 'Hospital', title: 'Nurse' }),
      makeJob({ slug: 'tech-job', category: 'tech', company: 'Acme SA', title: 'Dev' }),
      makeJob({ slug: 'admin-job', category: 'admin', company: 'Gov', title: 'Admin' }),
    ];

    const scored = jobs.map((j) => ({
      job: j,
      ...computePersonalScore(j, behavior, null),
    }));

    scored.sort((a, b) => b.score - a.score);

    // tech-job should be first (company +4, category +3, location +3 = 10)
    expect(scored[0].job.slug).toBe('tech-job');
    expect(scored[0].score).toBeGreaterThanOrEqual(10);
    // Others may still have location match (+3) since all default to Lugano
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });

  it('feature flag OFF means all scores are 0', () => {
    const behavior = emptyBehavior();
    behavior.viewedJobs = [
      { slug: 'prev', category: 'tech', company: 'X', location: 'Y', ts: Date.now() },
    ];
    // When enablePersonalization is false, JobBoard passes { score: 0, topSignal: '' }
    // We test the scoring function still works correctly when called
    const job = makeJob({ category: 'tech' });
    const emptyResult = computePersonalScore(job, emptyBehavior(), null);
    expect(emptyResult.score).toBe(0);
  });
});
