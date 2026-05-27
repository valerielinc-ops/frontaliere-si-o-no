/**
 * Personalization Scoring Engine — pure functions, no side effects.
 *
 * Computes a personal relevance score (0-28) for each job based on:
 * - Behavior signals (viewed jobs, search queries, filter usage)
 * - Profile signals (municipality, workPosition)
 * - Trending signals (job popularity in user's location)
 *
 * Sort order: personalScore DESC → cantonRank ASC → date DESC → qualityScore DESC
 * When all scores are 0 (cold start), existing sort is preserved.
 */

import type { BehaviorData } from '@/services/behaviorTracker';
import type { UserProfileData } from '@/components/pages/UserProfile';
import {
 normalizeSearchText,
 extractKeywords,
 keywordOverlap,
 isCategoryMatch,
 isLocationMatch,
 isCompanyMatch,
} from '@/services/textUtils';

// ─── Types ──────────────────────────────────────────────────────

interface ScoredJob {
 /** Slug, category, company, location, title fields used for matching */
 slug?: string;
 category: string;
 company: string;
 location: string;
 title: string;
 addressLocality?: string;
 postedDate: string;
 crawledAt?: string;
 firstSeenAt?: string;
}

export interface PersonalScore {
 score: number;
 topSignal: string;
}

// ─── Scoring ────────────────────────────────────────────────────

/**
 * Compute personal relevance score for a single job.
 * Binary matching: any view of category X = +3 for ALL X-category jobs (TEST-1 decision).
 */
export function computePersonalScore(
 job: ScoredJob,
 behavior: BehaviorData,
 profile: UserProfileData | null,
): PersonalScore {
 let score = 0;
 let topSignal = '';
 let topScore = 0;

 function addSignal(pts: number, signal: string): void {
 score += pts;
 if (pts > topScore) {
 topScore = pts;
 topSignal = signal;
 }
 }

 // ── Behavior boost (0-15) ──

 // Viewed same company: +4
 const viewedCompanies = new Set(behavior.viewedJobs.map((v) => normalizeSearchText(v.company)));
 if (isCompanyMatch(job.company, '') === false) {
 const jobCompanyNorm = normalizeSearchText(job.company);
 if (viewedCompanies.has(jobCompanyNorm)) {
 addSignal(4, 'company');
 }
 }

 // Viewed same category: +3
 const viewedCategories = new Set(behavior.viewedJobs.map((v) => v.category));
 if (viewedCategories.has(job.category)) {
 addSignal(3, 'category');
 }

 // Viewed same location: +3
 const viewedLocations = behavior.viewedJobs.map((v) => v.location);
 const jobLoc = job.addressLocality || job.location;
 if (jobLoc && viewedLocations.some((loc) => isLocationMatch(loc, jobLoc))) {
 addSignal(3, 'location');
 }

 // Search keyword match: +3 per keyword (max 6)
 if (behavior.searches.length > 0) {
 const searchKeywords = new Set<string>();
 for (const s of behavior.searches) {
 for (const kw of extractKeywords(s.query)) {
 searchKeywords.add(kw);
 }
 }
 const jobKeywords = extractKeywords(`${job.title} ${job.company}`);
 const overlap = keywordOverlap(searchKeywords, jobKeywords);
 if (overlap > 0) {
 addSignal(Math.min(overlap * 3, 6), 'search');
 }
 }

 // Recently viewed similar: +2 (viewed any job with same slug prefix / title similarity)
 const jobTitleNorm = normalizeSearchText(job.title);
 if (jobTitleNorm && behavior.viewedJobs.some((v) => {
 if (v.slug === job.slug) return false; // same job doesn't count
 const vTitle = normalizeSearchText(v.slug?.replace(/-/g, ' ') || '');
 return vTitle && jobTitleNorm.includes(vTitle.slice(0, 10));
 })) {
 addSignal(2, 'similar');
 }

 // ── Profile boost (0-10) ──

 if (profile) {
 // Municipality → location match: +3
 if (profile.municipality && jobLoc && isLocationMatch(profile.municipality, jobLoc)) {
 addSignal(3, 'profile_location');
 }

 // workPosition → title keyword match: +3
 if (profile.workPosition) {
 const profileKeywords = extractKeywords(profile.workPosition);
 const titleKeywords = extractKeywords(job.title);
 if (keywordOverlap(profileKeywords, titleKeywords) > 0) {
 addSignal(3, 'profile_position');
 }
 }

 // Salary overlap: Phase 2
 }

 return { score, topSignal };
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
): { total: number; matching: number } {
 if (!lastVisit) return { total: 0, matching: 0 };

 const newJobs = jobs.filter((j) => {
 const ts = new Date(j.firstSeenAt || j.crawledAt || j.postedDate).getTime();
 return ts > lastVisit;
 });

 const matching = newJobs.filter((j) => {
 const { score } = computePersonalScore(j, behavior, profile);
 return score > 0;
 }).length;

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
