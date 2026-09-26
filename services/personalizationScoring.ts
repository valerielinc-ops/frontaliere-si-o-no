/**
 * Personalization Scoring Engine — pure functions, no side effects.
 *
 * Computes a personal relevance score (0-39) for each job based on:
 * - Behavior signals (viewed jobs, search queries, filter usage)
 * - Profile signals (municipality, workPosition)
 * - Job-match profile signals (sector, canton, experience level — from
 *   SalarySurvey and/or the newsletter_subscribers profile for logged-in
 *   subscribers, merged via services/jobMatchProfile.ts#mergeNewsletterSignals)
 * - Trending signals (job popularity in user's location)
 *
 * Sort order: personalScore DESC → cantonRank ASC → date DESC → qualityScore DESC
 * When all scores are 0 (cold start), existing sort is preserved.
 * Users without an inferred job-match profile (null) get unchanged ordering.
 */

import type { BehaviorData } from '@/services/behaviorTracker';
import type { UserProfileData } from '@/components/pages/UserProfile';
import type { JobMatchProfileData } from '@/services/jobMatchProfile';
import {
 activeApplicationIntentJobKeys,
 buildApplicationIntentJobKey,
 PERSONAL_APPLICATION_INTENT_BOOST,
} from '@/services/applicationIntentRanking.mjs';
import {
 normalizeSearchText,
 extractKeywords,
 keywordOverlap,
 isCategoryMatch,
 isLocationMatch,
 isNormalizedLocationMatch,
} from '@/services/textUtils';

// ─── Types ──────────────────────────────────────────────────────

interface ScoredJob {
 /** Slug, category, company, location, title fields used for matching */
 id?: string;
 slug?: string;
 slugByLocale?: Partial<Record<string, string | null>> | null;
 companyKey?: string;
 category: string;
 company: string;
 location: string;
 title: string;
 addressLocality?: string;
 postedDate: string;
 crawledAt?: string;
 firstSeenAt?: string;
 canton?: string;
 sector?: string;
}

export interface PersonalScore {
 score: number;
 topSignal: string;
}

export interface PersonalScoringOptions {
 applicationIntentRankingEnabled?: boolean;
 /** Keep the application-intent treatment isolated from general personalization. */
 personalizationEnabled?: boolean;
 now?: number;
}

// ─── Job-match profile lookup tables ─────────────────────────────

// Maps SalarySurvey's broader sector taxonomy onto job listing categories
// (JobCategory in JobBoard.tsx) so isCategoryMatch can compare them. Exported
// so JobBoard.tsx's job-match alert CTA (issue #3650) can reuse the same
// mapping instead of duplicating it when it needs a JobCategory label to
// pre-fill the alert form.
export const SURVEY_SECTOR_TO_CATEGORY: Record<string, string> = {
 it_software: 'tech',
 pharma_biotech: 'health',
 finance_banking: 'finance',
 engineering: 'engineering',
 consulting: 'other',
 healthcare: 'health',
 education: 'other',
 hospitality: 'hospitality',
 construction: 'engineering',
 retail: 'sales',
 logistics: 'other',
 other: 'other',
};

// Title keywords for experience-level matching (tokenized via extractKeywords,
// exact-token match — not substring — to avoid false hits like "leadership").
// "mid_3_5" has no reliable keyword signal (titles rarely say "mid-level"),
// so it intentionally contributes no boost.
const JUNIOR_EXPERIENCE_KEYWORDS = new Set([
 'junior', 'stage', 'stagista', 'apprendista', 'apprendistato', 'praticante', 'tirocinante', 'entry',
]);
const SENIOR_EXPERIENCE_KEYWORDS = new Set([
 'senior', 'esperto', 'expert', 'lead', 'responsabile', 'direttore', 'director', 'chief', 'capo',
]);

function titleMatchesExperience(titleKeywords: ReadonlySet<string>, experienceLevel: string): boolean {
 const targetSet = experienceLevel === 'junior_0_2'
 ? JUNIOR_EXPERIENCE_KEYWORDS
 : experienceLevel === 'senior_6_10' || experienceLevel === 'expert_10_plus'
 ? SENIOR_EXPERIENCE_KEYWORDS
 : null;
 if (!targetSet) return false;
 for (const kw of titleKeywords) {
 if (targetSet.has(kw)) return true;
 }
 return false;
}

// ─── Scoring ────────────────────────────────────────────────────

/** Scores one job against inputs that {@link createPersonalScorer} compiled once. */
export type PersonalScorer = (job: ScoredJob) => PersonalScore;

/**
 * Compile the behavior/profile side of the scoring once and return a per-job
 * scorer.
 *
 * Why (#9583, INP on /cerca-lavoro-svizzera/): JobBoard scores the whole loaded
 * list (~12k jobs on the Switzerland-wide aggregator) whenever behaviorData
 * changes — on mount and after every deferred search keystroke, because
 * `trackSearch` refreshes it. The old per-job function rebuilt everything that
 * depends only on the user (viewed companies/locations/slugs, search keywords)
 * for EVERY job: with a returning user at the tracker caps (100 viewed jobs, 50
 * searches) that is ~400 `normalizeSearchText` calls per job, measured as a
 * single 14 s frame at 1x CPU (65 s at 4x) on the live page. React cannot yield
 * inside one component's useMemo, so `useDeferredValue` did not help: a tap
 * landing in that frame waits for all of it.
 *
 * The score is identical to the previous per-job computation, signal by signal
 * and in the same order (so `topSignal` ties resolve the same way); only the
 * user-side work moved out of the per-job loop.
 */
export function createPersonalScorer(
 behavior: BehaviorData,
 profile: UserProfileData | null,
 jobMatchProfile: JobMatchProfileData | null = null,
 options: PersonalScoringOptions = {},
): PersonalScorer {
 const applicationIntentJobKeys = options.applicationIntentRankingEnabled
 ? activeApplicationIntentJobKeys(behavior.applicationIntent, options.now)
 : new Set<string>();

 if (options.personalizationEnabled === false) {
  return (job) => applicationIntentJobKeys.has(buildApplicationIntentJobKey(job))
   ? { score: PERSONAL_APPLICATION_INTENT_BOOST, topSignal: 'application_intent' }
   : { score: 0, topSignal: '' };
 }

 const viewedJobs = behavior.viewedJobs;
 const viewedCompanies = new Set(viewedJobs.map((v) => normalizeSearchText(v.company)));
 const viewedCategories = new Set(viewedJobs.map((v) => v.category));
 // isLocationMatch is false for an empty side, so empty entries never match.
 const viewedLocations = [...new Set(
 viewedJobs.map((v) => (v.location ? normalizeSearchText(v.location) : '')).filter(Boolean),
 )];

 const searchKeywords = new Set<string>();
 for (const s of behavior.searches) {
 for (const kw of extractKeywords(s.query)) searchKeywords.add(kw);
 }

 // "Recently viewed similar": the first 10 chars of each viewed slug, as
 // normalized text. A job never counts as similar to itself, so the viewed
 // slug stays attached to its prefix.
 const viewedPrefixes: Array<{ slug: string | undefined; prefix: string }> = [];
 for (const v of viewedJobs) {
 const vTitle = normalizeSearchText(v.slug?.replace(/-/g, ' ') || '');
 if (vTitle) viewedPrefixes.push({ slug: v.slug, prefix: vTitle.slice(0, 10) });
 }
 const viewedSlugs = new Set(viewedPrefixes.map((v) => v.slug));
 // One alternation instead of one `includes` per viewed job (up to 100) per
 // job: over the ~22k-job list the per-prefix scan was ~100 ms of the pass at
 // 1x CPU, the compiled alternation ~14 ms (#9583). The self-exclusion only
 // matters for a job that was itself viewed — at most 100 of them — and those
 // keep the exact per-prefix scan.
 const anyViewedPrefix = viewedPrefixes.length > 0
 ? new RegExp([...new Set(viewedPrefixes.map((v) => v.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))].join('|'))
 : null;
 const titleContainsViewedPrefix = (jobTitleNorm: string, jobSlug: string | undefined): boolean => {
 if (!viewedSlugs.has(jobSlug)) return !!anyViewedPrefix && anyViewedPrefix.test(jobTitleNorm);
 return viewedPrefixes.some((v) => v.slug !== jobSlug && jobTitleNorm.includes(v.prefix));
 };

 const municipality = profile?.municipality ? normalizeSearchText(profile.municipality) : '';
 const profileKeywords = profile?.workPosition ? extractKeywords(profile.workPosition) : null;

 const matchCategory = jobMatchProfile?.sector
 ? (SURVEY_SECTOR_TO_CATEGORY[jobMatchProfile.sector] ?? jobMatchProfile.sector)
 : '';
 const matchCanton = jobMatchProfile?.canton || '';
 const matchCantonNorm = matchCanton ? normalizeSearchText(matchCanton) : '';
 const experienceLevel = jobMatchProfile?.experienceLevel || '';
 // The list repeats a few hundred localities and a couple of thousand
 // companies across ~12k rows: normalize each distinct raw value once per
 // scorer, and resolve the viewed-locations scan (up to 100 whole-token
 // comparisons) once per distinct job locality instead of once per job.
 const normalized = new Map<string, string>();
 const normalizeOnce = (raw: string): string => {
 let value = normalized.get(raw);
 if (value === undefined) {
 value = normalizeSearchText(raw);
 normalized.set(raw, value);
 }
 return value;
 };
 const companyKeywords = new Map<string, Set<string>>();
 const viewedLocationHit = new Map<string, boolean>();
 const matchesViewedLocation = (jobLocNorm: string): boolean => {
 let hit = viewedLocationHit.get(jobLocNorm);
 if (hit === undefined) {
 hit = viewedLocations.some((viewed) => isNormalizedLocationMatch(viewed, jobLocNorm));
 viewedLocationHit.set(jobLocNorm, hit);
 }
 return hit;
 };

 return (job) => {
 let score = 0;
 let topSignal = '';
 let topScore = 0;
 const addSignal = (pts: number, signal: string): void => {
 score += pts;
 if (pts > topScore) {
 topScore = pts;
 topSignal = signal;
 }
 };

 const jobLoc = job.addressLocality || job.location;
 const jobLocNorm = jobLoc ? normalizeOnce(jobLoc) : '';
 const jobLocationMatches = (normalizedOther: string): boolean =>
 !!jobLoc && isNormalizedLocationMatch(normalizedOther, jobLocNorm);
 let titleKeywords: Set<string> | undefined;
 const jobTitleKeywords = (): Set<string> => (titleKeywords ??= extractKeywords(job.title));

 // ── Behavior boost (0-15) ──

 // Viewed same company: +4
 if (viewedCompanies.size > 0 && viewedCompanies.has(normalizeOnce(job.company))) {
 addSignal(4, 'company');
 }

 // Viewed same category: +3
 if (viewedCategories.has(job.category)) {
 addSignal(3, 'category');
 }

 // Viewed same location: +3
 if (jobLoc && viewedLocations.length > 0 && matchesViewedLocation(jobLocNorm)) {
 addSignal(3, 'location');
 }

 // Search keyword match: +3 per keyword (max 6)
 if (searchKeywords.size > 0) {
 // Same count as keywordOverlap(searchKeywords, extractKeywords(`${title} ${company}`)):
 // extractKeywords splits on whitespace, so the keywords of the joined
 // string are the union of the two sides. The title side is shared with
 // the profile signals below and the company side repeats across the list.
 const titleSide = jobTitleKeywords();
 let companySide = companyKeywords.get(job.company);
 if (!companySide) companyKeywords.set(job.company, (companySide = extractKeywords(job.company)));
 let overlap = keywordOverlap(titleSide, searchKeywords);
 for (const kw of companySide) {
 if (!titleSide.has(kw) && searchKeywords.has(kw)) overlap++;
 }
 if (overlap > 0) {
 addSignal(Math.min(overlap * 3, 6), 'search');
 }
 }

 // Recently viewed similar: +2 (viewed any job with same slug prefix / title similarity)
 if (anyViewedPrefix) {
 const jobTitleNorm = normalizeSearchText(job.title);
 if (jobTitleNorm && titleContainsViewedPrefix(jobTitleNorm, job.slug)) {
 addSignal(2, 'similar');
 }
 }

 // ── Profile boost (0-10) ──

 // Municipality → location match: +3
 if (municipality && jobLocationMatches(municipality)) {
 addSignal(3, 'profile_location');
 }

 // workPosition → title keyword match: +3
 if (profileKeywords && keywordOverlap(profileKeywords, jobTitleKeywords()) > 0) {
 addSignal(3, 'profile_position');
 }

 // ── Job-match profile boost (0-7): sector/canton/experience from
 // SalarySurvey, or sector_interest/location_interest merged in from the
 // newsletter_subscribers profile (mergeNewsletterSignals) — see #3648 ──

 // Sector → category match: +3. jobMatchProfile.sector is either a
 // SalarySurvey key (mapped via SURVEY_SECTOR_TO_CATEGORY) or an
 // already-category-shaped string from the newsletter profile.
 if (matchCategory && isCategoryMatch(job.category, matchCategory)) {
 addSignal(3, 'profile_sector');
 }

 // Canton match: +2. jobMatchProfile.canton is either a 2-letter canton
 // code (SalarySurvey, compared exactly against job.canton) or a city
 // name from the newsletter profile (location_interest/geo_city — no
 // canton code, so fall back to a location-text match).
 if (matchCanton) {
 if (job.canton && matchCanton === job.canton) {
 addSignal(2, 'profile_canton');
 } else if (jobLocationMatches(matchCantonNorm)) {
 addSignal(2, 'profile_canton');
 }
 }

 // Experience level → title keyword match: +2
 if (experienceLevel && titleMatchesExperience(jobTitleKeywords(), experienceLevel)) {
 addSignal(2, 'profile_experience');
 }

 // A consented apply click is an exact-job signal, not evidence of completion.
 // One fixed increment is capped independently of repeat clicks and outranks
 // every individual passive browsing/profile signal.
 if (applicationIntentJobKeys.size > 0 && applicationIntentJobKeys.has(buildApplicationIntentJobKey(job))) {
 addSignal(PERSONAL_APPLICATION_INTENT_BOOST, 'application_intent');
 }

 return { score, topSignal };
 };
}

/**
 * Compute personal relevance score for a single job.
 * Binary matching: any view of category X = +3 for ALL X-category jobs (TEST-1 decision).
 *
 * For a list, build the scorer once with {@link createPersonalScorer} instead:
 * this wrapper recompiles the user-side inputs on every call.
 */
export function computePersonalScore(
 job: ScoredJob,
 behavior: BehaviorData,
 profile: UserProfileData | null,
 jobMatchProfile: JobMatchProfileData | null = null,
 options: PersonalScoringOptions = {},
): PersonalScore {
 return createPersonalScorer(behavior, profile, jobMatchProfile, options)(job);
}

/** Score of a job when personalization is off or has no signal for it. */
export const NO_PERSONAL_SCORE: PersonalScore = Object.freeze({ score: 0, topSignal: '' });

/** Score every job once with a compiled scorer, keyed by job object identity. */
export function scorePersonalJobs<J extends ScoredJob>(
 jobs: readonly J[],
 scorer: PersonalScorer,
): Map<J, PersonalScore> {
 const scores = new Map<J, PersonalScore>();
 for (const job of jobs) scores.set(job, scorer(job));
 return scores;
}

/**
 * Return `previous` when `next` holds the same items in the same order, else
 * `next`. A re-sort whose inputs changed but whose order did not (the common
 * case while a search keyword is being typed) then keeps the array identity
 * that identity-keyed consumers — JobBoard's search index — depend on.
 */
export function reuseIfSameOrder<T>(previous: readonly T[] | null, next: T[]): T[] {
 if (!previous || previous.length !== next.length) return next;
 for (let i = 0; i < next.length; i++) {
 if (previous[i] !== next[i]) return next;
 }
 return previous as T[];
}

// ─── New jobs counter ───────────────────────────────────────────

/**
 * Count new jobs since last visit, and how many match the user's behavior.
 */
export function computeNewJobsCount(
 jobs: ScoredJob[],
 lastVisit: number | null,
 behavior: BehaviorData,
 profile: UserProfileData | null,
 jobMatchProfile: JobMatchProfileData | null = null,
): { total: number; matching: number } {
 if (!lastVisit) return { total: 0, matching: 0 };

 const newJobs = jobs.filter((j) => {
 const ts = new Date(j.firstSeenAt || j.crawledAt || j.postedDate).getTime();
 return ts > lastVisit;
 });

 const scorePersonal = createPersonalScorer(behavior, profile, jobMatchProfile);
 const matching = newJobs.filter((j) => scorePersonal(j).score > 0).length;

 return { total: newJobs.length, matching };
}

// ─── Trending by location ───────────────────────────────────────

/**
 * Get trending jobs filtered by user's preferred location.
 * Falls back to all Ticino trending when no location preference exists.
 */
export function getTrendingByLocation(
 jobs: ScoredJob[],
 popularity: Record<string, number>,
 userLocation: string | null,
): ScoredJob[] {
 if (!popularity || Object.keys(popularity).length === 0) return [];

 // Filter to jobs with popularity data
 const withPopularity = jobs
 .filter((j) => j.slug && popularity[j.slug])
 .map((j) => ({ job: j, views: popularity[j.slug!] }));

 if (withPopularity.length === 0) return [];

 // If user has a location preference, filter to that location
 let filtered = withPopularity;
 if (userLocation) {
 const locationFiltered = withPopularity.filter((j) =>
 isLocationMatch(j.job.addressLocality || j.job.location, userLocation),
 );
 // Fall back to all if too few matches
 if (locationFiltered.length >= 3) {
 filtered = locationFiltered;
 }
 }

 // Sort by popularity DESC, take top 4
 return filtered
 .sort((a, b) => b.views - a.views)
 .slice(0, 4)
 .map((x) => x.job);
}

/**
 * Compute trending boost for a single job (0-3 pts, scaled by percentile).
 */
export function computeTrendingBoost(
 slug: string | undefined,
 popularity: Record<string, number>,
): number {
 if (!slug || !popularity[slug]) return 0;
 const views = popularity[slug];
 const allViews = Object.values(popularity).sort((a, b) => a - b);
 if (allViews.length === 0) return 0;
 const rank = allViews.findIndex((v) => v >= views);
 const percentile = rank / allViews.length;
 if (percentile >= 0.9) return 3;
 if (percentile >= 0.7) return 2;
 if (percentile >= 0.5) return 1;
 return 0;
}
