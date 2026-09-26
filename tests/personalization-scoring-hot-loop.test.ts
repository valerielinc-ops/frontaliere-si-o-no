/**
 * #9583 — INP on /cerca-lavoro-svizzera/.
 *
 * JobBoard scores the whole loaded list (~12k jobs on the Switzerland-wide
 * aggregator) whenever behaviorData changes: on mount and after every deferred
 * search keystroke (trackSearch refreshes it). The per-job scorer used to
 * recompile the user-side inputs (viewed companies/locations/slugs, search
 * keywords) for EVERY job: ~400 normalizeSearchText calls per job for a
 * returning user at the tracker caps, one synchronous 14 s frame at 1x CPU.
 *
 * These tests pin:
 *  1. the work per job no longer scales with the user's history (counted, not
 *     timed — deterministic on any machine);
 *  2. the compiled scorer returns exactly what the old per-job semantics did;
 *  3. JobBoard scores the list once and keeps the sorted array identity when
 *     the order did not change (the search index is keyed on it);
 *  4. JobBoard computes the sort keys that do not depend on personalization
 *     (foreign filter, canton rank, calendar day) once per list, not on every
 *     personal-score change.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const normalizeCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('@/services/textUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/textUtils')>();
  return {
    ...actual,
    normalizeSearchText: (value: string) => {
      normalizeCalls.count++;
      return actual.normalizeSearchText(value);
    },
  };
});

import {
  computePersonalScore,
  computeNewJobsCount,
  createPersonalScorer,
  scorePersonalJobs,
  reuseIfSameOrder,
  SURVEY_SECTOR_TO_CATEGORY,
} from '@/services/personalizationScoring';
import {
  normalizeSearchText,
  extractKeywords,
  keywordOverlap,
  isCategoryMatch,
  isLocationMatch,
} from '@/services/textUtils';
import type { BehaviorData } from '@/services/behaviorTracker';
import type { JobMatchProfileData } from '@/services/jobMatchProfile';

// ── Deterministic fixtures ──────────────────────────────────────

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const CATEGORIES = ['tech', 'health', 'finance', 'engineering', 'hospitality', 'sales', 'other'];
const LOCATIONS = ['Lugano', 'Lugano Paradiso', 'Bellinzona', 'Mendrisio', 'Chiasso', 'Zürich', 'Bern', 'Bernex', 'Genève', 'Locarno', ''];
const COMPANIES = ['Acme SA', 'Banca Stato', 'EOC', 'Migros Ticino', 'UBS AG', 'Clinica Varini', 'Città di Lugano', ''];
const TITLES = [
  'Software Engineer', 'Senior Software Engineer', 'Junior Developer', 'Infermiere diplomato',
  'Responsabile vendite', 'Stagista marketing', 'Ingegnere civile', 'Lead Data Scientist',
  'Cameriere', 'Contabile', 'Apprendista impiegato di commercio', 'Head Chef',
];
const QUERIES = ['infermiere lugano', 'software', 'banca', 'ingegnere civile', 'stage', 'contabile bellinzona', 'chef'];
const CANTONS = ['TI', 'ZH', 'BE', 'GE', ''];

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function makeJobs(n: number, rand: () => number) {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  return Array.from({ length: n }, (_, i) => {
    const title = pick(TITLES);
    const loc = pick(LOCATIONS);
    return {
      slug: `${slugify(title)}-${i}`,
      category: pick(CATEGORIES),
      company: pick(COMPANIES),
      location: loc,
      addressLocality: rand() < 0.5 ? loc : undefined,
      title,
      postedDate: '2026-09-20',
      canton: pick(CANTONS) || undefined,
    };
  });
}

/** A returning user at the behaviorTracker caps (100 viewed jobs, 50 searches). */
function cappedBehavior(rand: () => number, jobs: ReturnType<typeof makeJobs>): BehaviorData {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  return {
    version: 1,
    lastVisit: null,
    viewedJobs: Array.from({ length: 100 }, () => {
      const j = pick(jobs);
      return { slug: j.slug, category: j.category, company: j.company, location: j.location, ts: 0 };
    }),
    searches: Array.from({ length: 50 }, () => ({ query: pick(QUERIES), ts: 0, resultCount: 1 })),
    filterUsage: { category: {}, location: {}, contract: {} },
    syncedAt: null,
  };
}

function jobMatch(overrides: Partial<JobMatchProfileData>): JobMatchProfileData {
  return { version: 1, sector: null, experienceLevel: null, canton: null, updatedAt: 0, ...overrides } as JobMatchProfileData;
}

// ── Reference: the pre-#9583 per-job semantics, spelled out ─────

const JUNIOR = new Set(['junior', 'stage', 'stagista', 'apprendista', 'apprendistato', 'praticante', 'tirocinante', 'entry']);
const SENIOR = new Set(['senior', 'esperto', 'expert', 'lead', 'responsabile', 'direttore', 'director', 'chief', 'capo']);

function referenceScore(
  job: ReturnType<typeof makeJobs>[number],
  behavior: BehaviorData,
  profile: { municipality?: string; workPosition?: string } | null,
  jm: JobMatchProfileData | null,
) {
  let score = 0;
  let topSignal = '';
  let topScore = 0;
  const add = (pts: number, signal: string) => {
    score += pts;
    if (pts > topScore) { topScore = pts; topSignal = signal; }
  };
  const viewedCompanies = new Set(behavior.viewedJobs.map((v) => normalizeSearchText(v.company)));
  if (viewedCompanies.has(normalizeSearchText(job.company))) add(4, 'company');
  if (new Set(behavior.viewedJobs.map((v) => v.category)).has(job.category)) add(3, 'category');
  const jobLoc = job.addressLocality || job.location;
  if (jobLoc && behavior.viewedJobs.some((v) => isLocationMatch(v.location, jobLoc))) add(3, 'location');
  if (behavior.searches.length > 0) {
    const kws = new Set<string>();
    for (const s of behavior.searches) for (const kw of extractKeywords(s.query)) kws.add(kw);
    const overlap = keywordOverlap(kws, extractKeywords(`${job.title} ${job.company}`));
    if (overlap > 0) add(Math.min(overlap * 3, 6), 'search');
  }
  const jobTitleNorm = normalizeSearchText(job.title);
  if (jobTitleNorm && behavior.viewedJobs.some((v) => {
    if (v.slug === job.slug) return false;
    const vTitle = normalizeSearchText(v.slug?.replace(/-/g, ' ') || '');
    return vTitle && jobTitleNorm.includes(vTitle.slice(0, 10));
  })) add(2, 'similar');
  if (profile) {
    if (profile.municipality && jobLoc && isLocationMatch(profile.municipality, jobLoc)) add(3, 'profile_location');
    if (profile.workPosition && keywordOverlap(extractKeywords(profile.workPosition), extractKeywords(job.title)) > 0) add(3, 'profile_position');
  }
  if (jm) {
    if (jm.sector && isCategoryMatch(job.category, SURVEY_SECTOR_TO_CATEGORY[jm.sector] ?? jm.sector)) add(3, 'profile_sector');
    if (jm.canton) {
      if (job.canton && jm.canton === job.canton) add(2, 'profile_canton');
      else if (jobLoc && isLocationMatch(jm.canton, jobLoc)) add(2, 'profile_canton');
    }
    if (jm.experienceLevel) {
      const target = jm.experienceLevel === 'junior_0_2' ? JUNIOR
        : jm.experienceLevel === 'senior_6_10' || jm.experienceLevel === 'expert_10_plus' ? SENIOR : null;
      if (target && [...extractKeywords(job.title)].some((kw) => target.has(kw))) add(2, 'profile_experience');
    }
  }
  return { score, topSignal };
}

beforeEach(() => {
  normalizeCalls.count = 0;
});

describe('personal scoring over the whole list does not rescan the user history per job (#9583)', () => {
  const N = 2000;

  it('scorePersonalJobs: normalizeSearchText calls stay O(jobs + history), not O(jobs × history)', () => {
    const rand = lcg(9583);
    const jobs = makeJobs(N, rand);
    const behavior = cappedBehavior(rand, jobs);
    normalizeCalls.count = 0;
    const scores = scorePersonalJobs(jobs, createPersonalScorer(behavior, { municipality: 'Lugano', workPosition: 'ingegnere software' } as never, jobMatch({ canton: 'Lugano' })));
    expect(scores.size).toBe(N);
    // History compiles once (~300 calls); each job then costs at most a
    // handful (company, title, location). The old code spent ~400 per job.
    expect(normalizeCalls.count).toBeLessThan(400 + N * 4);
  });

  it('computeNewJobsCount scores the new jobs with one compiled scorer', () => {
    const rand = lcg(4302);
    const jobs = makeJobs(N, rand);
    const behavior = cappedBehavior(rand, jobs);
    normalizeCalls.count = 0;
    const { total } = computeNewJobsCount(jobs, Date.parse('2026-09-01'), behavior, null, null);
    expect(total).toBe(N);
    expect(normalizeCalls.count).toBeLessThan(400 + N * 4);
  });
});

describe('createPersonalScorer is equivalent to the per-job semantics', () => {
  const profiles = [
    null,
    { municipality: 'Lugano', workPosition: 'ingegnere software' },
    { municipality: 'Bern', workPosition: '' },
  ];
  const jobMatches: Array<JobMatchProfileData | null> = [
    null,
    jobMatch({ sector: 'it_software', experienceLevel: 'senior_6_10', canton: 'TI' }),
    jobMatch({ sector: 'hospitality', experienceLevel: 'junior_0_2', canton: 'Lugano' }),
    jobMatch({ sector: 'unknown-sector', experienceLevel: 'mid_3_5', canton: 'Bern' }),
  ];

  it('matches score and topSignal on every job for every profile combination', () => {
    const rand = lcg(20260924);
    // Small list: the reference is the slow per-job path this PR removed.
    const jobs = makeJobs(120, rand);
    const behaviors = [
      cappedBehavior(rand, jobs),
      { ...cappedBehavior(rand, jobs), searches: [] },
      { ...cappedBehavior(rand, jobs), viewedJobs: [] },
    ];
    let compared = 0;
    let nonZero = 0;
    const mismatches: string[] = [];
    for (const behavior of behaviors) {
      for (const profile of profiles) {
        for (const jm of jobMatches) {
          const scorer = createPersonalScorer(behavior, profile as never, jm);
          jobs.forEach((job, i) => {
            const expected = referenceScore(job, behavior, profile, jm);
            const got = scorer(job);
            if (got.score !== expected.score || got.topSignal !== expected.topSignal) {
              mismatches.push(`${job.slug}: got ${JSON.stringify(got)} want ${JSON.stringify(expected)}`);
            }
            // The single-job wrapper (openDetail) goes through the same scorer.
            if (i % 10 === 0) {
              const single = computePersonalScore(job, behavior, profile as never, jm);
              if (single.score !== expected.score || single.topSignal !== expected.topSignal) {
                mismatches.push(`computePersonalScore ${job.slug}`);
              }
            }
            compared++;
            if (expected.score > 0) nonZero++;
          });
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBe(3 * 3 * 4 * 120);
    // The fixture must actually exercise the signals, not compare zeros.
    expect(nonZero).toBeGreaterThan(compared / 2);
  });
});

describe('"similar" signal: one compiled alternation, a job is never similar to itself', () => {
  const job = (slug: string, title: string) => ({
    slug, title, category: 'other', company: '', location: '', postedDate: '2026-09-20',
  });
  const viewing = (...slugs: string[]): BehaviorData => ({
    version: 1,
    lastVisit: null,
    viewedJobs: slugs.map((slug) => ({ slug, category: 'none', company: 'Viewed Co', location: '', ts: 0 })),
    searches: [],
    filterUsage: { category: {}, location: {}, contract: {} },
    syncedAt: null,
  });

  it('matches another job that contains a viewed prefix, not the viewed job itself', () => {
    const viewed = job('infermiere-cure-generali-eoc-1', 'Infermiere cure generali');
    const sibling = job('infermiere-cure-generali-eoc-2', 'Infermiere cure generali');
    const unrelated = job('contabile-senior-3', 'Contabile senior');
    const scorer = createPersonalScorer(viewing(viewed.slug), null);
    expect(scorer(viewed)).toEqual({ score: 0, topSignal: '' });
    expect(scorer(sibling)).toEqual({ score: 2, topSignal: 'similar' });
    expect(scorer(unrelated)).toEqual({ score: 0, topSignal: '' });
  });

  it('a viewed job still counts as similar through ANOTHER viewed job with the same prefix', () => {
    const a = job('infermiere-cure-generali-eoc-1', 'Infermiere cure generali');
    const b = job('infermiere-cure-generali-eoc-2', 'Infermiere cure generali');
    const scorer = createPersonalScorer(viewing(a.slug, b.slug), null);
    expect(scorer(a).topSignal).toBe('similar');
    expect(scorer(b).topSignal).toBe('similar');
  });

  it('no viewed jobs: no similar signal and no regex to test', () => {
    expect(createPersonalScorer(viewing(), null)(job('x-1', 'Infermiere'))).toEqual({ score: 0, topSignal: '' });
  });
});

describe('reuseIfSameOrder', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const c = { id: 'c' };

  it('returns the previous array when the order is identical', () => {
    const previous = [a, b, c];
    expect(reuseIfSameOrder(previous, [a, b, c])).toBe(previous);
  });

  it('returns the new array when the order, length or items differ', () => {
    const previous = [a, b, c];
    const swapped = [b, a, c];
    const shorter = [a, b];
    const other = [a, b, { id: 'c' }];
    expect(reuseIfSameOrder(previous, swapped)).toBe(swapped);
    expect(reuseIfSameOrder(previous, shorter)).toBe(shorter);
    expect(reuseIfSameOrder(previous, other)).toBe(other);
    const first = [a];
    expect(reuseIfSameOrder(null, first)).toBe(first);
  });
});

describe('JobBoard wiring (#9583)', () => {
  // JobBoard is not mountable in a unit test (see other jobboard-* tests):
  // the invariants are pinned on its source.
  const SRC = readFileSync(resolve(__dirname, '../components/community/JobBoard.tsx'), 'utf8');

  it('scores the list once and shares the scores between the pill count and the sort', () => {
    expect(SRC).toMatch(/personalScoreByJob = useMemo\([\s\S]{0,200}scorePersonalJobs\(jobs, createPersonalScorer\(/);
    expect(SRC).toContain('personal: personalScoreByJob?.get(keys.job) ?? NO_PERSONAL_SCORE');
    // No per-job computePersonalScore over a list: the only call left is the
    // single job opened by openDetail (one click, one job).
    expect(SRC.match(/computePersonalScore\(/g)?.length).toBe(1);
    expect(SRC).toMatch(/const openDetail = [\s\S]{0,900}computePersonalScore\(job, behaviorData/);
  });

  it('keeps the sorted array identity when the order did not change', () => {
    expect(SRC).toContain('reuseIfSameOrder(sortedJobsRef.current, withMeta.map(({ job }) => job))');
  });

  it('computes the personalization-independent sort keys once per list, not per score change', () => {
    // The foreign filter + canton rank + calendar day are ~200 ms over the
    // ~22k-job list at 1x CPU; they must live in a memo keyed on `jobs` only.
    const keys = SRC.match(/const jobSortKeys = useMemo\(\(\) => \{([\s\S]*?)\n \}, \[([^\]]*)\]\);/);
    expect(keys, 'jobSortKeys memo').not.toBeNull();
    expect(keys![2]).toBe('jobs');
    expect(keys![1]).toContain('isForeignLocation(');
    expect(keys![1]).toContain('dayTs(');
    const sorted = SRC.match(/const sortedJobs = useMemo\(\(\) => \{([\s\S]*?)\n \}, \[([^\]]*)\]\);/);
    expect(sorted, 'sortedJobs memo').not.toBeNull();
    expect(sorted![2]).toBe('jobSortKeys, personalScoreByJob, enableApplicationIntentRanking');
    expect(sorted![1]).not.toContain('isForeignLocation(');
    expect(sorted![1]).not.toContain('dayTs(');
  });
});
