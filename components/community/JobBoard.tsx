/**
 * JobBoard — Ticino job board for cross-border workers
 *
 * - Listing: latest crawled jobs, 10 per page + pagination.
 * - Detail: dedicated SEO-friendly page per job (slug route), with sidebar widgets and related jobs.
 */

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { resilientImport } from '@/services/resilientImport';
import { cdnDataUrl } from '@/services/cdnDataBase';
import { cdnImageUrl } from '@/services/cdnImageBase';
import { requestJobAlertOpen } from '@/services/jobAlertOpenSignal';
import { baseCompanySlug, rawCompanySlug } from '@/build-plugins/shared/companyProfileSlug.mjs';
const JobAlertForm = lazyRetry(() => import('@/components/community/JobAlertForm'));
const JobAlertStickyBanner = lazyRetry(() => import('@/components/community/JobAlertStickyBanner'));
const JobAlertEndCard = lazyRetry(() => import('@/components/community/JobAlertEndCard'));
const JobDetailAlertPrompt = lazyRetry(() => import('@/components/community/JobDetailAlertPrompt'));
const JobDetailJobAlertButton = lazyRetry(() => import('@/components/community/JobDetailJobAlertButton'));
const CompanyFollowCta = lazyRetry(() => import('@/components/community/CompanyFollowCta'));
// Eager, and tiny: a placeholder that arrives with its own chunk reserves nothing.
import CompanyFollowPlaceholder from '@/components/community/CompanyFollowPlaceholder';
const JobMatchAlertCta = lazyRetry(() => import('@/components/community/JobMatchAlertCta'));
const JobBoardFilterAlertCta = lazyRetry(() => import('@/components/community/JobBoardFilterAlertCta'));
const SavedJobsAlertNudge = lazyRetry(() => import('@/components/community/SavedJobsAlertNudge'));
const SaveSignInPromptModal = lazyRetry(() => import('@/components/community/SaveSignInPromptModal'));
const ArticleRailAdStack = lazyRetry(() => import('@/components/shared/ArticleRailAdStack'));
const PartnerRecommendations = lazyRetry(() => import('@/components/shared/PartnerRecommendations'));
import { reportCaughtError } from '@/services/errorReporter';
import { trackJobView } from '@/services/jobViewsService';
import { trackPublisherJobView, trackPublisherApplyClick } from '@/services/publisherAnalyticsService';
import PublisherApplyForm from '@/components/community/PublisherApplyForm';
import { renderPublisherMarkdown } from '@/services/publisherMarkdown';
import { useRailGridCollapse, RAIL_GRID_CLASS_X, RAIL_ASIDE_CLASS_X } from '@/components/shared/useRailGridCollapse';
import {
 fetchAggregatedJobs,
 fetchAllJobs,
 fetchJobsForCanton,
 getDefaultCantonForVisit,
 scopeJobsToCanton,
 AGGREGATE_CANTON_CODE,
 type Job as RawJob,
} from '@/services/jobsService';
import { normalizeSearchText, buildStemmedHaystack, stemSearchToken } from '@/services/textUtils';
import { professionSynonymText } from '@/services/professionSynonyms';
import { cantonSearchTokens, CANTON_CODES, getCantonLabel } from '@/services/cantonList';
import {
  loadSavedJobs,
  toggleSavedJob,
  ensureSavedJob,
  deriveSavedJobsAlertCriteria,
  loadNudgeState,
  saveNudgeState,
  shouldShowSavedJobsNudge,
  recordNudgeDismissed,
  recordNudgeAccepted,
  SAVED_JOBS_CHANGED_EVENT,
  SAVED_JOBS_NUDGE_THRESHOLD,
  type SavedJobEntry,
} from '@/services/savedJobsService';
import {
  savePendingSaveJobIntent,
  consumePendingSaveJobIntent,
  peekPendingSaveJobIntent,
  type SaveJobSurface,
} from '@/services/pendingSaveJob';
import {
 type BehaviorData,
 getBehaviorData,
 trackJobViewBehavior,
 trackSearch as trackSearchBehavior,
 trackFilterUsage,
 getLastVisitTimestamp,
 updateLastVisit,
} from '@/services/behaviorTracker';
import {
 computePersonalScore,
 computeNewJobsCount,
 getTrendingByLocation,
 computeTrendingBoost,
 SURVEY_SECTOR_TO_CATEGORY,
} from '@/services/personalizationScoring';
import { type JobMatchProfileData, loadJobMatchProfile, mergeNewsletterSignals } from '@/services/jobMatchProfile';
import NewJobsCounter from '@/components/community/NewJobsCounter';
import TrendingSection from '@/components/community/TrendingSection';
import JobBoardResultsLoader from '@/components/community/JobBoardResultsLoader';
import EmployerHubCta from '@/components/community/EmployerHubCta';
import PopularSearchChips from '@/components/community/PopularSearchChips';
import EmployerBrandHub from '@/components/jobs/EmployerBrandHub';
import { getEmployerBrandBySlug } from '@/services/employerBrands';
// NOT a static `import … from '@/data/job-popularity.json'`: Rollup inlines a
// static JSON import into this chunk, which put 3.6 MB of a 4.1 MB JobBoard.js
// on the modulepreloaded critical path of /cerca-lavoro-ticino/ (#5001).
import { loadJobPopularity, EMPTY_JOB_POPULARITY } from '@/services/jobPopularityService';
import type { JobNetEstimate } from '@/services/jobNetEstimate';
import {
 ArrowLeft,
 ArrowUpRight,
 BellRing,
 BookOpen,
 Bookmark,
 Briefcase,
 Building2,
 Calculator,
 Calendar,
 CheckCircle2,
 ChevronDown,
 ChevronLeft,
 ChevronRight,
 ChevronsLeft,
 ChevronsRight,
 Clock,
 Euro,
 Eye,
 Heart,
 Loader2,
 Mail,
 MapPin,
 Search,
 Shield,
 SlidersHorizontal,
 Sparkles,
 Star,
 ArrowRight,
 Tag,
 TrendingUp,
 UserCheck,
 Users,
 X,
} from 'lucide-react';
import { type Locale, useLocale, useTranslation, getCantonI18nParams } from '@/services/i18n';
import { loadBlogMeta } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
// Type-only: jobAlertService itself is always dynamically imported below (code
// splitting) — this import is erased at build time, no bundle/runtime impact.
import type { JobAlert } from '@/services/jobAlertService';
import { fetchUserAlertsCached, invalidateUserAlertsCache } from '@/services/userAlertsCache';
import { suggestSimilarTerms } from '@/services/search/fuzzySearchSuggestions';
import { buildJobCopyAttribution, shouldAttributeCopy } from '@/services/jobCopyAttribution';
import { wasNewsletterAutologinAttempted } from '@/services/newsletterAutologinSignal';
import { buildPath, parsePath, registerJobSlugMap, getJobMetaForSlug, ensureJobSlugEntriesLoaded, isJobSlugReady, preloadBlogData, JOB_BOARD_CANTON_AGGREGATE } from '@/services/router';
import { resolveJobCanton } from '@/build-plugins/shared/cantonSection';
import { isKnownCityHub } from '@/build-plugins/cityJobsHub';
import { normalizeCitySlug } from '@/build-plugins/shared/cantonCities';
import { firstPageIndexFileName } from '@/build-plugins/shared/slimJobIndex';
import { buildJobTitleWithLocation, buildTitleWithBrand } from '@/build-plugins/shared/titleSuffix';
import { buildJobPostingSchema, type JobInput } from '@/build-plugins/shared/jobPostingSchema';
import { buildJobPostingFaqPairs, type JobFaqPair } from '@/build-plugins/shared/jobPostingFaq';
import { getCantonDisplayName } from '@/build-plugins/shared/cantonDisplay';
import { useNavigation } from '@/services/NavigationContext';
import AdSenseBanner from '@/components/shared/AdSenseBanner';
import Callout from '@/components/shared/Callout';
import { SkeletonJobDetail, SkeletonJobBoard, SkeletonLine } from '@/components/shared/Skeletons';
import { useExpiredJob, hasSeededExpiredData, seededJobMatchesSlug } from '@/hooks/useExpiredJob';
import { readClusterSearchSeed } from '@/services/clusterSearchSeed';
import { useKillSwitches } from '@/hooks/useKillSwitches';
import JobExpiredView from '@/components/community/JobExpiredView';
import JobOrphanView from '@/components/community/JobOrphanView';
import { AD_SLOTS, shouldPlaceInfeedAd } from '@/services/adsenseSlots';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { eagerAuth, getAuthEmail, promptOneTap, renderGoogleButton, isLinkedInSignInAvailable, signInWithLinkedIn, saveAuthJobContext } from '@/services/authService';
import {
 parseJobDescription,
 type Block as JobDescBlock,
 type Inline as JobDescInline,
} from '@/build-plugins/shared/jobDescription/parser';
import { useAuthGateHeadlineVariant } from '@/services/authGateExperiment';
import { useNewsletterAutologinInFlight } from '@/hooks/useNewsletterAutologinInFlight';
import {
 isMultiLocation,
 normalizeJobCategory,
 normalizeJobContract,
 resolveCompanyLogoUrl,
 resolveCompanyWebsiteHost,
} from '@/services/jobDataNormalization';
import {
 sanitizeJobTitle,
 cleanCanonicalItems,
 slugifyJobPart,
 getSearchSlugPrefix,
 getJobBoardSectionSlug,
 buildSearchSlug,
 parseSearchSlugFilter,
 RELATED_SEARCH_STOPWORDS,
 extractRelatedTopicTokens,
 isValidRelatedSearchTerm,
 buildRelatedSearches,
 stripSearchQueryBoilerplate,
} from '@/services/relatedSearchClusters';
export { buildSearchSlug } from '@/services/relatedSearchClusters';
import {
 buildFallbackCanonicalContent,
 type CanonicalLocaleContent,
} from '@/services/jobs/canonicalFallback';
// Re-export for tests/consumers that imported the helper from this file
// (e.g. tests/jobboard-italian-lowercase-list-parsing.test.ts).
export { buildFallbackCanonicalContent } from '@/services/jobs/canonicalFallback';
import { handleCompanyLogoError, generateInitialsLogo } from '@/services/logoService';
import { deriveJobPostalCode, getJobLocationSnapshot } from '@/services/jobLocationSnapshot';
import { getJobSalaryContext } from '@/data/salaryData';
import {
 upsertNewsletterSubscriber,
 markNewsletterSubscribedLocally,
} from '@/services/newsletterSubscribers';
import { consentProof } from '@/services/consentTexts';
import ConsentNotice from '@/components/shared/ConsentNotice';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import { requestSlot, releaseSlot, POPUP_PRIORITY } from '@/services/popupQueue';
import { isCrawlerVisitorAgent } from '@/functions/src/lib/returnVisit.js';
import type { Article } from '@/data/blog-articles-data';
// Layer 2D — Internal linking: cross-feature SEO page builders (sidebar "Strumenti correlati").
import { buildCurrentWeekPath } from '@/build-plugins/weeklyEmployersData';
import { buildHubPath as buildJobMarketHubPath } from '@/build-plugins/jobMarketSnapshotData';
import { buildHealthPremiumsCantonPath } from '@/build-plugins/healthPremiumsData';
import { formatJobLocation } from '../../scripts/lib/job-location-display.mjs';
import {
 buildJobCareVariantLandingModel,
 buildJobLocationLandingModel,
 buildJobLocationSectorLandingModel,
 buildJobLocationTypeLandingModel,
 buildJobNursesHubLandingModel,
 buildJobOfficialGazetteLandingModel,
 buildJobPartTimeLandingModel,
 buildJobSectorRegionLandingModel,
 buildJobTodayLandingModel,
 resolveEditorialJobLandingDescriptor,
} from '../../build-plugins/jobEditorialLanding';

// ─── Parameterized region defaults ────────────────────────────────────
// Central defaults for data fallbacks when job fields are missing.
// Change these when expanding beyond TI/GR.
// See scripts/lib/crawler-location-config.mjs for the crawler-side switch.
const DEFAULT_CANTON = 'TI';
const DEFAULT_CANTON_DISPLAY = 'Ticino';
const DEFAULT_POSTAL_CODE = '6900';
const TARGET_CANTONS_ORDERED = ['TI', 'GR', 'VS'] as const;

// Search-broaden floor: when a canton-scoped search yields FEWER than this many
// in-canton results, the cross-canton tier is merged in (appended) so the page
// shows a useful number of listings instead of a near-empty result set. Mirrors
// the documented "SPA may over-recover vs the static landing" intent — broadening
// never de-indexes a canonical page, it only fills the hydrated board.
const BROADEN_BELOW = 10;
// Rank boost applied to a broadened cross-canton job whose LOCATION matches a
// city named in the query (e.g. "…lausanne" → jobs physically in Lausanne sort
// above jobs that merely mention the city in their description). Large enough to
// dominate token-hit score so city-relevant listings lead the broadened tail.
const CITY_MATCH_BOOST = 1000;

// Memoized stemmed haystack for the broaden tiers (cross-canton / cross-locale).
// Those tiers scan the locale-wide unscoped pool (thousands of jobs) and used to
// rebuild `buildStemmedHaystack(...)` inline on EVERY render while a seeded
// 0-result landing broadens — the dominant cost behind the "expansion is slow to
// load" report. The haystack is a pure function of (job, locale), so cache it on
// a WeakMap (auto-evicts with the job object, no leak). Re-derived only when the
// locale changes, since the localized title/description differ per locale.
//
// Reference stability — WeakMap hit-rate analysis:
// The cache key is the job object reference. References are stable because
// `unscopedJobs` and `crossLocaleJobs` are React state populated once per
// session via one-shot guards (searchBroadenFetchAttempted,
// companyBroadenFetchAttempted, crossLocaleFetchAttempted). React never
// recreates state values on re-render; the same JobListing objects live in
// state until unmount or an explicit setState call. Therefore:
//   • After the first scan (initial state set), every subsequent recompute of
//     crossCantonFallbackJobs / crossLocaleFallbackJobs (triggered by query /
//     filter / date-range changes) hits the cache — O(1) lookup, no rebuild.
//   • The only expected misses are (a) first scan after the pool loads
//     (cold-start, unavoidable) and (b) locale changes, where the localized
//     title/description differ so a fresh haystack is correct.
// The perf fix from PR #2062 does fire in the live render path.
const broadenHaystackCache = new WeakMap<JobListing, { locale: string; hay: string }>();
function getBroadenHaystack(job: JobListing, locale: string): string {
  const cached = broadenHaystackCache.get(job);
  if (cached && cached.locale === locale) return cached.hay;
  const description = job.descriptionByLocale?.[locale] ?? job.description;
  const localizedTitle = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title);
  const synonyms = professionSynonymText(localizedTitle);
  const hay = buildStemmedHaystack(
    `${localizedTitle} ${job.company} ${job.location} ${job.contract} ${job.category} ${job.sector || ''} ${cantonSearchTokens(job.canton)} ${description || ''} ${synonyms}`,
  );
  broadenHaystackCache.set(job, { locale, hay });
  return hay;
}

// ── Job-alert CTA eligibility: shared getUserAlerts cache + shown-once guard ──
// (review PR #4338, bug G). The job-match-pill and job-board-filter CTAs each
// run an eligibility effect that fetches getUserAlerts(userId) to compute
// already-subscribed/quota-full. The board-filter effect depends on
// boardFilterAlertKeywordLabel, which falls back to the free-text search box —
// every debounced keystroke re-ran the whole effect, re-fetching Firestore and
// re-emitting the 'shown' impression event on every character typed. Caching
// the fetch per userId for the session (module state, not persisted — a fresh
// load always re-checks server-side) and gating the impression event behind a
// "once per surface per session" guard fixes both halves without changing what
// the user sees. Applied to BOTH sibling CTAs (job_match_pill, job_board_filters)
// since they share the identical construct; NOT applied to job_detail_prompt's
// own getUserAlerts read/shown-event (line ~3008/3046 below) — that effect is
// keyed on selectedJob?.id and fires once per DISTINCT job navigation, a
// genuinely new impression each time, not a re-fire of the same one. A
// session-wide once-guard there would silently suppress real per-job
// impressions, an actual regression beyond this bug's scope — left untouched.
// The cache itself moved to services/userAlertsCache.ts (#5012): the CompanyAlert
// CTA now also writes from the SSG employer pages, the expired view and the
// orphan view, which cannot reach a file-private cache — their follows used to
// leave it stale for the rest of the session. Same semantics, one module up.

const shownAlertCtaSurfaces = new Set<string>();

function trackJobAlertCtaShownOnce(surface: 'job_match_pill' | 'job_board_filters', keyword: string): void {
  if (shownAlertCtaSurfaces.has(surface)) return;
  shownAlertCtaSurfaces.add(surface);
  Analytics.trackJobAlertCtaShown(surface, keyword);
}

// Foreign country/city keywords — jobs matching these are EXCLUDED entirely.
// These are locations outside Switzerland that should never appear on a Swiss job board.
const FOREIGN_LOCATION_KEYWORDS = [
 'london', 'paris', 'milan', 'milano', 'berlin', 'munich', 'münchen',
 'frankfurt', 'hamburg', 'vienna', 'wien', 'madrid', 'barcelona',
 'amsterdam', 'brussels', 'bruxelles', 'stockholm', 'oslo', 'copenhagen',
 'tokyo', 'beijing', 'shanghai', 'singapore', 'bangkok', 'mumbai',
 'dubai', 'new york', 'los angeles', 'toronto', 'sydney', 'melbourne',
 'rome', 'roma', 'napoli', 'torino', 'bologna', 'genova', 'palermo',
 'venezia', 'florence', 'firenze', 'kuala lumpur', 'luxembourg',
 'jersey',
 'united kingdom', 'germany', 'france', 'netherlands', 'belgium',
 'austria', 'ireland', 'denmark', 'norway', 'sweden', 'finland',
 'portugal', 'spain', 'poland', 'czech', 'romania', 'hungary',
 'croatia', 'greece', 'japan', 'china', 'india', 'thailand',
 'philippines', 'indonesia', 'malaysia', 'vietnam', 'south korea',
 'taiwan', 'hong kong', 'australia', 'new zealand', 'canada',
 'united states', 'mexico', 'brazil', 'argentina', 'chile',
 'south africa', 'nigeria', 'kenya', 'egypt', 'israel', 'qatar',
 'saudi arabia', 'bahrain', 'liechtenstein',
 'ruggell', 'barberà del vallès', 'barbera del valles',
];
// Swiss cities that contain substrings of foreign city names (e.g. Münchenstein contains München)
const SWISS_FALSE_POSITIVE_GUARD = ['münchenstein', 'münchenbuchsee', 'münchenwiler', 'romanshorn', 'romandie'];
const isForeignLocation = (locality: string) => {
 const lower = locality.toLowerCase();
 if (SWISS_FALSE_POSITIVE_GUARD.some(s => lower.includes(s))) return false;
 return FOREIGN_LOCATION_KEYWORDS.some(kw => lower.includes(kw));
};

// Non-target Swiss cities — jobs in these locations are kept but sorted AFTER target cantons.
const NON_TARGET_SWISS_CITY_KEYWORDS = [
 'zurich', 'zürich', 'geneva', 'genève', 'geneve', 'bern', 'berne',
 'basel', 'lausanne', 'winterthur', 'luzern', 'lucerne', 'st. gallen',
 'schaffhausen', 'solothurn', 'aarau', 'cheseaux',
];
const isNonTargetSwissCity = (locality: string) => {
 const lower = locality.toLowerCase();
 return NON_TARGET_SWISS_CITY_KEYWORDS.some(kw => lower.includes(kw));
};

// Combined check for sorting: non-target = foreign OR non-target Swiss
const isNonTargetCity = (locality: string) =>
 isForeignLocation(locality) || isNonTargetSwissCity(locality);

const CANTON_DISPLAY: Record<string, string> = {
 'TI': 'Ticino', 'GR': 'Graubünden', 'ZH': 'Zürich', 'BE': 'Bern',
 'LU': 'Luzern', 'BS': 'Basel', 'GE': 'Genève', 'VD': 'Vaud',
 'AG': 'Aargau', 'SG': 'St. Gallen', 'VS': 'Valais', 'FR': 'Fribourg',
 'NE': 'Neuchâtel', 'ZG': 'Zug', 'SH': 'Schaffhausen', 'SO': 'Solothurn',
 'BL': 'Basel-Landschaft', 'TG': 'Thurgau', 'SZ': 'Schwyz', 'GL': 'Glarus',
 'JU': 'Jura', 'NW': 'Nidwalden', 'OW': 'Obwalden', 'AR': 'Appenzell AR',
 'AI': 'Appenzell AI', 'UR': 'Uri',
};

const CANTON_FALLBACK_POSTAL: Record<string, string> = {
 'TI': '6900', 'GR': '7000', 'ZH': '8001', 'BE': '3001',
 'LU': '6003', 'BS': '4001', 'GE': '1201', 'VD': '1003',
 'AG': '5001', 'SG': '9001', 'VS': '1950', 'FR': '1700',
 'NE': '2000', 'ZG': '6300', 'SH': '8200', 'SO': '4500',
 'BL': '4410', 'TG': '8500', 'SZ': '6430', 'GL': '8750',
 'JU': '2800', 'NW': '6370', 'OW': '6060', 'AR': '9100',
 'AI': '9050', 'UR': '6460',
};

type ContractType = 'full-time' | 'part-time' | 'temporary' | 'internship' | 'contract';
type JobCategory = 'tech' | 'finance' | 'health' | 'engineering' | 'admin' | 'hospitality' | 'sales' | 'other';
type DateRange = 'all' | '24h' | '3d' | '7d' | '30d' | '90d';

export interface JobListing {
 id: string;
 slug?: string;
 slugByLocale?: Partial<Record<Locale, string>>;
 company: string;
 companyKey?: string;
 title: string;
 titleByLocale?: Partial<Record<Locale, string>>;
 location: string;
 canton: string;
 category: JobCategory;
 contract: ContractType;
 salaryMin?: number;
 salaryMax?: number;
 baseSalary?: {
 value?: {
 minValue?: number;
 maxValue?: number;
 currency?: string;
 };
 currency?: string;
 };
 currency: 'CHF' | 'EUR';
 description: string;
 descriptionByLocale?: Partial<Record<Locale, string>>;
 requirements: string[];
 requirementsByLocale?: Partial<Record<Locale, string[]>>;
 streetAddress?: string;
 postalCode?: string;
 addressLocality?: string;
 addressCountry?: string;
 featured: boolean;
 postedDate: string;
 crawledAt?: string;
 firstSeenAt?: string;
 url?: string;
 applyUrl?: string;
 source?: string;
 companyDomain?: string;
 /** Publisher-provided logo URL (https-only, projected from the publish form). */
 companyLogo?: string | null;
 /** Markdown description (sponsored publisher ads only). */
 descriptionMd?: string | null;
 sector?: string;
 previousSlugs?: string[];
 previousSlugsByLocale?: Partial<Record<string, string[]>>;
 canonicalContent?: {
 version?: number;
 generatedAt?: string;
 byLocale?: Partial<Record<Locale, {
 summary?: string[];
 sections?: Array<{
 id?: string;
 heading?: string;
 paragraphs?: string[];
 bullets?: string[];
 }>;
 responsibilities?: string[];
 requirements?: string[];
 benefits?: string[];
 process?: string[];
 highlights?: string[];
 keywords?: string[];
 readingMinutes?: number;
 }>>;
 };
}

const JOB_EMAIL_ACCESS_KEY = 'frontaliere_job_email_access';

// Delay before the saved-jobs alert nudge toast slides in (#4467) — long
// enough to not collide with the save interaction that triggered it.
const SAVED_NUDGE_SHOW_DELAY_MS = 1200;
const JOB_AUTH_REDIRECT_SLUG_KEY = 'frontaliere_job_auth_redirect_slug';

/** Module-level cache for per-job detail data (fetched on-demand when detail view opens). */
const jobDetailCache = new Map<string, Promise<Partial<JobListing>>>();

/** Resolved (settled) detail payloads, keyed by job id. Lets a later full-index
 * load re-apply enrichment it would otherwise clobber when it replaces `jobs`
 * (e.g. after a seeded first paint — see readSeededJob / finalize). */
const resolvedJobDetail = new Map<string, Partial<JobListing>>();

/**
 * Cap for the per-job detail caches. A long browsing session (many distinct
 * detail views, cross-canton jumps) otherwise grows `jobDetailCache` and
 * `resolvedJobDetail` without bound (#1516 item3). LRU-on-write: re-inserting a
 * key moves it to newest, so the active/most-recent job is never evicted (it is
 * read at the enrichment-loading check + the finalize re-enrich). Generous cap
 * covers heavy sessions while bounding heap to ~50 small detail payloads.
 */
const DETAIL_CACHE_MAX = 50;

function rememberInDetailCache<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) {
    map.delete(key); // re-insert below → moves to newest (LRU on write)
  } else if (map.size >= DETAIL_CACHE_MAX) {
    const oldest = map.keys().next().value; // Map preserves insertion order
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/**
 * Fetch a single job's detail data (~15KB) instead of the full locale file (~11MB).
 * Per-job detail files are generated at build time by localeJobsSplitPlugin. (FRO-detail-split)
 */
function fetchJobDetail(jobId: string): Promise<Partial<JobListing>> {
 if (!jobDetailCache.has(jobId)) {
 const promise = fetch(cdnDataUrl(`/data/job-detail/${jobId}.json`))
 .then((res) => { if (!res.ok) throw new Error(`${res.status}`); return res.json(); })
 .then((data: unknown) => {
 const detail = (data && typeof data === 'object' ? data : {}) as Partial<JobListing>;
 if (Object.keys(detail).length > 0) rememberInDetailCache(resolvedJobDetail, jobId, detail);
 return detail;
 })
 .catch(() => ({} as Partial<JobListing>));
 rememberInDetailCache(jobDetailCache, jobId, promise);
 }
 return jobDetailCache.get(jobId)!;
}

/**
 * Resilient variant of fetchJobDetail. window.__JOB_SEED__ bakes the job's
 * stable id at build time, but that id is a hash of a URL-derived fingerprint
 * (buildStableId) and is NOT carried forward when a crawled job's source URL
 * rotates (e.g. Coop's UUID-keyed posting URLs). The already-deployed static
 * page then carries an id that no longer exists in the regenerated dataset, so
 * /data/job-detail/<seed-id>.json 404s and the detail view shows the generic
 * "scovato nel monitoraggio" placeholder behind the unlock gate instead of the
 * real description.
 *
 * The slug, unlike the id, IS bridged (previousSlugs) and the live
 * jobs-slug-map.json maps it → the current id. So when the baked id misses,
 * resolve the current id from the slug map and retry once — mirroring the
 * slug→id bridge already used for cross-canton shard resolution.
 */
async function fetchJobDetailResilient(jobId: string, slug?: string | null): Promise<Partial<JobListing>> {
 const primary = await fetchJobDetail(jobId);
 if (Object.keys(primary).length > 0 || !slug) return primary;
 await ensureJobSlugEntriesLoaded([slug]);
 const liveId = getJobMetaForSlug(slug)?.id;
 if (!liveId || liveId === jobId) return primary;
 return fetchJobDetail(liveId);
}

const ARTICLE_STOP_WORDS = new Set(['del', 'dei', 'per', 'con', 'sul', 'fra', 'tra', 'una', 'non', 'che', 'come', 'cosa', 'dal', 'the', 'and', 'for', 'with', 'von', 'und', 'les', 'des', 'pour', 'dans']);
// A literal year (formerly '2025'/'2026'/'2027') would need rewriting every
// January (issue #5560); a four-digit-year test is a no-op for any year.
const YEAR_SLUG_TOKEN_RE = /^(19|20)\d{2}$/;

function slugTopicWordsJob(id: string): Set<string> {
 return new Set(id.split('-').filter(w => w.length > 2 && !ARTICLE_STOP_WORDS.has(w) && !YEAR_SLUG_TOKEN_RE.test(w)));
}

function saveJobAuthRedirectSlug(slug: string): void {
 try {
 sessionStorage.setItem(JOB_AUTH_REDIRECT_SLUG_KEY, slug);
 } catch {
 // Ignore storage failures (private mode / quota); auth can still complete.
 }
}

function readJobAuthRedirectSlug(): string | null {
 try {
 return sessionStorage.getItem(JOB_AUTH_REDIRECT_SLUG_KEY);
 } catch {
 return null;
 }
}

function clearJobAuthRedirectSlug(): void {
 try {
 sessionStorage.removeItem(JOB_AUTH_REDIRECT_SLUG_KEY);
 } catch {
 // Ignore storage failures.
 }
}

/** Find articles related to a job based on job-title/keyword ↔ article-slug overlap */
function getRelatedArticlesForJob(
 job: JobListing,
 articles: Article[],
 locale: Locale,
 t: (key: string) => string,
 count = 3,
): Article[] {
 const jobTitle = (job.titleByLocale?.[locale] ?? job.title).toLowerCase();
 const jobWords = new Set(jobTitle.split(/[\s\-/,()]+/).filter(w => w.length > 2 && !ARTICLE_STOP_WORDS.has(w)));
 const jobKeywords = (job.canonicalContent?.byLocale?.[locale]?.keywords ?? []).map(k => k.toLowerCase());

 const scoreArticle = (article: Article): number => {
 let score = 0;
 const articleWords = slugTopicWordsJob(article.id);

 for (const w of articleWords) {
 if (jobWords.has(w)) score += 4;
 if (jobKeywords.some(k => k.includes(w))) score += 2;
 }

 const articleTitle = t(`blog.article.${article.id}.title`).toLowerCase();
 if (!articleTitle.startsWith('blog.article.')) {
 const titleWords = articleTitle.split(/[\s\-/,()]+/).filter(w => w.length > 2 && !ARTICLE_STOP_WORDS.has(w));
 for (const w of titleWords) {
 if (jobWords.has(w)) score += 2;
 }
 }

 return score;
 };

 // Newest articles first — recency is preferred when scores tie or thresholds are met.
 const byDate = [...articles].sort((a, b) => b.date.localeCompare(a.date));

 // Stage 1: try the 5 most recent and return matches by score.
 const recentMatches = byDate.slice(0, 5)
 .map(article => ({ article, score: scoreArticle(article) }))
 .filter(x => x.score >= 4)
 .sort((a, b) => b.score - a.score)
 .slice(0, count)
 .map(x => x.article);
 if (recentMatches.length > 0) return recentMatches;

 // Stage 2: extend to the full archive in date order, take the first `count` that hit the threshold.
 const archiveMatches: Article[] = [];
 for (const article of byDate.slice(5)) {
 if (scoreArticle(article) >= 4) {
 archiveMatches.push(article);
 if (archiveMatches.length >= count) break;
 }
 }
 return archiveMatches;
}

/** Filter params that can be passed from SiteSearch to pre-apply filters on mount */
interface JobBoardFilterParams {
 location?: string;
 query?: string;
}

interface JobBoardProps {
 onPostJob?: () => void;
 initialJobSlug?: string;
 /** Pre-applied filters from SiteSearch navigation (location, search query) */
 initialFilterParams?: JobBoardFilterParams | null;
 /** Called after filter params have been consumed so they aren't re-applied */
 onFilterParamsConsumed?: () => void;
 onJobRouteChange?: (slug?: string, canton?: string) => void;
 isLoggedIn?: boolean;
 authUser?: any | null;
 authLoading?: boolean;
 onGoogleAuthRequired?: () => Promise<any | null>;
 onFacebookAuthRequired?: () => Promise<any | null>;
 onRequireAuth?: () => void;
 /** Personalization feature flag (from Firebase Remote Config) */
 enablePersonalization?: boolean;
 /** User profile data for personalization scoring */
 userProfile?: import('@/components/pages/UserProfile').UserProfileData | null;
 /**
  * P7 — URL-driven canton pre-filter. When the user lands on
  * /cerca-lavoro-{canton}/, the router passes the 2-letter canton code
  * (e.g. 'TI', 'ZH', 'GE') here. JobBoard fetches that canton's shard
  * exclusively. Special value `'_AGGREGATE_'` (also exported as
  * AGGREGATE_CANTON_CODE) means "aggregator" — fetch top-N cantons
  * deduped. Undefined/null falls back to getDefaultCantonForVisit()
  * (referrer-aware default).
  */
 initialFilterCanton?: string | null;
}

const CATEGORY_EMOJI: Record<JobCategory, string> = {
 tech: '💻',
 finance: '💰',
 health: '🏥',
 engineering: '⚙️',
 admin: '📋',
 hospitality: '🏨',
 sales: '🛒',
 other: '📌',
};

const contractLabelKey: Record<ContractType, string> = {
 'full-time': 'fullTime',
 'part-time': 'partTime',
 temporary: 'temporary',
 contract: 'contract',
 internship: 'internship',
};

/**
 * Map a normalized contract type to the schema.org / publish-form
 * `employmentType` enum (FULL_TIME, PART_TIME, …). Shared by the JobPosting
 * structured data and the "Sei l'azienda?" claim pre-fill stash so a crawled
 * listing seeds the publisher form's employmentType instead of leaving it at
 * the default.
 */
const CONTRACT_TO_EMPLOYMENT_TYPE: Record<ContractType, string> = {
 'full-time': 'FULL_TIME',
 'part-time': 'PART_TIME',
 temporary: 'TEMPORARY',
 internship: 'INTERN',
 contract: 'CONTRACTOR',
};

/** Append UTM referral parameters to an external job URL. */
function buildReferralUrl(raw: string, job: JobListing): string {
 try {
 const u = new URL(raw);
 u.searchParams.set('utm_source', 'frontaliereticino');
 u.searchParams.set('utm_medium', 'referral');
 u.searchParams.set('utm_campaign', 'job-board');
 u.searchParams.set('utm_content', job.slug || job.id);
 return u.toString();
 } catch {
 // Malformed URL — return as-is
 return raw;
 }
}

function companyLogoUrl(job: JobListing): string | null {
 const explicitLogo = resolveCompanyLogoUrl({
 company: job.company,
 companyKey: job.companyKey,
 companyDomain: job.companyDomain,
 url: job.url,
 companyLogo: job.companyLogo,
 });
 // cdnImageUrl rewrites a same-origin /images/{brands,…} logo path to the CDN
 // at runtime when offloaded (#1360); external favicon/clearbit URLs pass through
 // unchanged. CDN-down degrades via the <img onError> chain (handleCompanyLogoError).
 if (explicitLogo) return cdnImageUrl(explicitLogo);

 // No curated logo. We deliberately do NOT fall back to a Google favicon
 // (`s2/favicons`): it serves a generic grey-globe PNG for domains Google
 // can't resolve (e.g. crawled companies on ATS sub-domains) which browsers
 // render even on a 404, so onError never fires and the user sees the
 // broken-looking grey globe. Use the deterministic coloured-initials badge
 // instead — same data URI the static SEO renderer emits, so SPA and
 // pre-rendered HTML match.
 if (job.company && job.company.trim().length > 0) {
 return generateInitialsLogo(job.company);
 }
 return null;
}

function normalizeIncomingJob(raw: any): JobListing {
 const title = String(raw?.title || '').trim();
 const description = String(raw?.description || '').trim();
 const company = String(raw?.company || '').trim() || 'Azienda';
 const companyKey = String(raw?.companyKey || '').trim() || undefined;
 const canonicalHost = resolveCompanyWebsiteHost({
 company,
 companyKey,
 companyDomain: String(raw?.companyDomain || '').trim(),
 url: String(raw?.url || '').trim(),
 });

 return {
 ...raw,
 id: String(raw?.id || raw?.slug || `${company}-${title}`),
 company,
 companyKey,
 title,
 location: String(raw?.location || '').trim() || DEFAULT_CANTON_DISPLAY,
 canton: String(raw?.canton || '').trim() || DEFAULT_CANTON,
 category: normalizeJobCategory(raw?.category, `${title} ${String(raw?.department || '')}`) as JobCategory,
 contract: normalizeJobContract(raw?.contract, title, description) as ContractType,
 currency: String(raw?.currency || '').toUpperCase() === 'EUR' ? 'EUR' : 'CHF',
 description,
 requirements: Array.isArray(raw?.requirements)
 ? raw.requirements.map((item: unknown) => String(item || '').trim()).filter(Boolean)
 : [],
 featured: Boolean(raw?.featured),
 postedDate: String(raw?.postedDate || '').trim() || new Date().toISOString().slice(0, 10),
 companyDomain: canonicalHost || String(raw?.companyDomain || '').trim() || undefined,
 sector: String(raw?.sector || '').trim() || undefined,
 };
}

/**
 * Build-seeded slim job record for the active job-detail page, injected by
 * jobsSeoPagesPlugin as `window.__JOB_SEED__`. Seeding `jobs` with this record
 * lets `selectedJob` resolve from the first paint — the detail view renders
 * immediately and fetches only /data/job-detail/<id>.json for the body, instead
 * of blocking on the ~1.2 MB (gzip) slim index. Returns null when absent (board
 * pages, SPA navigation) or malformed. (companion to the bridge/expired seeds)
 */
function readSeededJob(): JobListing | null {
 try {
 // Same document-scoping as the bridge global: __JOB_SEED__ is an inline
 // script belonging to ONE job-detail page and is never cleared by SPA
 // navigation, so without this the docstring's "returns null on SPA
 // navigation" was simply untrue. A stale seed did real damage: `finalize`
 // prepends it to the listing (a Ticino job at the top of the Zurich board
 // after /cerca-lavoro-ticino/<job>/ → /cerca-lavoro-zurigo/), and the
 // `if (seededJob)` branch of the load effect defers the index fetch to
 // requestIdleCallback — correct on a detail page where the index is
 // below-the-fold, wrong on a listing where the index IS the content.
 if (!onSeededDocument()) return null;
 const raw = (window as unknown as Record<string, unknown>).__JOB_SEED__;
 if (raw && typeof raw === 'object'
 && typeof (raw as { slug?: unknown }).slug === 'string'
 && (raw as { slug: string }).slug.trim()
 && typeof (raw as { id?: unknown }).id === 'string'
 && (raw as { id: string }).id.trim()) {
 return normalizeIncomingJob(raw);
 }
 } catch { /* SSR or missing */ }
 return null;
}

function contractTranslationKey(job: Pick<JobListing, 'contract' | 'title' | 'description'>): string {
 const normalized = normalizeJobContract(job.contract, job.title, job.description) as ContractType;
 return `jobBoard.contract.${contractLabelKey[normalized]}`;
}

function categoryTranslationKey(job: Pick<JobListing, 'category' | 'title'>): string {
 const normalized = normalizeJobCategory(job.category, job.title) as JobCategory;
 return `jobBoard.filter.${normalized}`;
}

function normalizeParagraphs(text: string): string[] {
 const clean = String(text || '').replace(/\s+/g, ' ').trim();
 if (!clean) return [];

 const byNewline = clean.split(/\n+/).map((p) => p.trim()).filter(Boolean);
 if (byNewline.length > 1) return byNewline;

 // Chunk long single-paragraph content into readable blocks.
 // Lookbehind-free sentence split: Safari <16.4 / many in-app browsers throw
 // "Invalid regular expression: invalid group specifier name" on (?<=…) and the
 // whole lazy chunk fails to parse. Capture the punctuation, drop the trailing
 // whitespace, split on a NUL sentinel absent from job text — byte-identical output.
 const sentences = clean.replace(/([.!?])\s+/g, '$1\u0000').split('\u0000').filter(Boolean);
 const blocks: string[] = [];
 let buffer = '';
 for (const sentence of sentences) {
 const candidate = buffer ? `${buffer} ${sentence}` : sentence;
 if (candidate.length > 320 && buffer) {
 blocks.push(buffer);
 buffer = sentence;
 } else {
 buffer = candidate;
 }
 }
 if (buffer) blocks.push(buffer);
 return blocks.length > 0 ? blocks : [clean];
}

/**
 * Pre-process a description that may have no newlines: inject \n before
 * common markdown-like structures so the line-by-line parser can detect them.
 */
/** Common job-description section headings across IT/EN/DE/FR.
 * Used by normalizeDescriptionBreaks to re-inject structure into flat text.
 * Shared pattern — reusable across different crawlers and renderers. */
const JOB_SECTION_KEYWORDS = [
 // IT — tasks & responsibilities
 'Mansioni', 'Compiti', 'Responsabilità', 'Il tuo lavoro', 'Il tuo nuovo lavoro',
 'Le tue mansioni', 'Le tue attività', 'Cosa ti aspetta', 'Descrizione del ruolo',
 // IT — requirements
 'Requisiti', 'Profilo', 'Il tuo profilo', 'Cosa porti con te', 'Cosa ti chiediamo',
 'Formazione e competenze', 'Competenze richieste',
 // IT — benefits & offer
 'Cosa ti offriamo', 'I tuoi vantaggi', 'Offriamo', 'Vantaggi',
 'Agevolazioni', 'Perfezionamento', 'Comunicazione & Cultura',
 'Assicurazione', 'Vacanze', 'Salute',
 // IT — contact & other
 'Le tue persone di contatto', 'Contatti', 'Sede di lavoro', 'Informazioni aggiuntive',
 // EN
 'Your tasks', 'Your responsibilities', 'What you will do', 'Role description',
 'What we offer', 'What we expect', 'Your profile', 'Requirements', 'Benefits',
 'Your benefits', 'What you bring', 'About us', 'Contact',
 'Key Responsibilities', 'Role Focus', 'Experience & Skills Required',
 'What Success Looks Like', 'Our Commitment to Diversity and Inclusion',
 'Qualifications', 'Skills', 'Education', 'Responsibilities',
 'Job Description', 'Job Summary', 'Who We Are', 'Who You Are',
 'What You Bring', 'Nice to Have', 'Preferred Qualifications',
 // DE
 'Deine Aufgaben', 'Ihre Aufgaben', 'Aufgaben', 'Was wir bieten',
 'Was wir erwarten', 'Dein Profil', 'Ihr Profil', 'Anforderungen', 'Vorteile',
 'Deine Vorteile', 'Ihre Vorteile', 'Kontakt', 'Über uns',
 // FR
 'Vos missions', 'Vos tâches', 'Ce que nous offrons', 'Ce que nous attendons',
 'Votre profil', 'Exigences', 'Avantages', 'Vos avantages', 'Contact', 'À propos',
].join('|');

/**
 * Pre-process a description that may have no newlines: inject \n before
 * common markdown-like structures so the line-by-line parser can detect them.
 */
function normalizeDescriptionBreaks(raw: string): string {
 let s = raw;
 // 1. Insert \n before ## headings that appear inline.
 // Use [^#\n] to avoid splitting WITHIN ## markers (e.g. ## → #\n#)
 s = s.replace(/([^#\n])\s*(#{1,3}\s)/g, '$1\n$2');
 // 2. Insert \n before bullet items that appear inline (after sentence-ending punctuation)
 s = s.replace(/([.!?:])\s+(-\s)/g, '$1\n$2');
 // 3. Split on common section title patterns — match after punctuation or after word boundary
 // (many crawled descriptions don't have punctuation before section titles)
 // 3a. Handle section keyword at the very start of the string (no preceding whitespace)
 s = s.replace(new RegExp(`^(?=${JOB_SECTION_KEYWORDS})(?=[A-ZÀ-ÖÙ-Ü])`), '## ');
 // 3b. Handle section keywords mid-text (preceded by whitespace)
 const sectionRe = new RegExp(
 `(\\s)(?=${JOB_SECTION_KEYWORDS})(?=[A-ZÀ-ÖÙ-Ü])`,
 'g'
 );
 s = s.replace(sectionRe, '\n## ');
 // 4. Sub-section labels ending with" :" (e.g."Agevolazioni :","Vacanze :")
 // followed by comma-separated items → split into heading + bullet list
 s = s.replace(
 /## ((?:Agevolazioni|Perfezionamento|Comunicazione (?:& |e )Cultura|Assicurazione|Vacanze|Salute|[A-ZÀ-Ü][^\n:]{2,40}))\s*:\s*([^\n]+)/g,
 (_match, heading: string, body: string) => {
 const items = body.split(/,\s*/).map(i => i.trim()).filter(Boolean);
 if (items.length >= 2) {
 return `## ${heading}\n${items.map(i => `- ${i}`).join('\n')}`;
 }
 return `## ${heading}\n${body}`;
 }
 );
 // 5. Split flat section bodies into bullet points.
 // After section headings are injected, some sections have a single long paragraph
 // where individual tasks/requirements are concatenated without line breaks.
 // Detect sentence boundaries and convert to bullet points.
 s = splitSectionBodiesIntoBullets(s);
 return s;
}

/**
 * After section headings (## ...) are injected, detect flat paragraph blocks
 * within each section and split them into bullet points at sentence boundaries.
 *
 * Only applies when:
 * - The section body is a single long line (>120 chars)
 * - The body has no existing bullets or sub-headings
 *
 * Heuristic: split at sentence-end + capital-letter boundaries, while
 * avoiding false splits inside abbreviations ("ecc.","dott.","art.").
 */
function splitSectionBodiesIntoBullets(text: string): string {
 // Split into sections: everything between ## lines
 const sections = text.split(/(?=\n## )/);

 return sections.map(section => {
 // If this section has a heading, process its body
 const headingMatch = section.match(/^(\n## [^\n]+)\n([\s\S]*)$/);
 if (!headingMatch) return section; // No heading → leave as-is

 const heading = headingMatch[1];
 const body = headingMatch[2].trim();

 // Skip if body already has structure (bullets, headings, or multiple lines)
 if (!body || body.length < 120) return section;
 if (/^[-•*]\s/m.test(body)) return section; // already has bullets
 if (/^#{1,3}\s/m.test(body)) return section; // has sub-headings
 if ((body.match(/\n/g) || []).length >= 3) return section; // already split

 // Try ' - ' as list separator before sentence-boundary splitting
 // Handles Italian infinitive lists (organizzare, collaborare, etc.)
 const dashParts = body.split(/ - (?=[a-zA-ZÀ-ÖÙ-Üà-öù-ü])/);
 if (dashParts.length >= 3) {
 const cleanedDashParts = dashParts.map((s) => s.trim()).filter((s) => s.length > 8);
 if (cleanedDashParts.length >= 3) {
 return `${heading}\n${cleanedDashParts.map((item) => `- ${item}`).join('\n')}`;
 }
 }

 // Try to split body into bullet items at sentence boundaries
 const items = splitFlatTextIntoItems(body);
 if (items.length >= 2) {
 return `${heading}\n${items.map(item => `- ${item}`).join('\n')}`;
 }
 return section;
 }).join('');
}

/** Common abbreviations that end with a period but are NOT sentence boundaries. */
const ABBREVIATION_PATTERN = /(?:ecc|etc|dott|sig|ing|arch|prof|art|nr|tel|fax|p\.es|ca|vs|es|cfr|pag|par|cap|vol|sez|all|min|max|approx|incl)$/i;

/**
 * Split a flat paragraph of text into logical items (tasks, requirements, etc.)
 * by detecting sentence boundaries.
 *
 * Strategy:
 * - Primary: split after sentence-ending punctuation (. ! ? )) followed by a Capital letter
 * - Secondary: split at implicit boundaries where a lowercase word is followed
 * by a Capital-letter word that starts a new independent clause (no period)
 * - Guard: don't split after known abbreviations (ecc., dott., etc.)
 * - Guard: don't split if resulting items would be too short (<30 chars)
 */
function splitFlatTextIntoItems(text: string): string[] {
 const items: string[] = [];
 let current = '';

 // Tokenize by splitting on spaces while preserving the space.
 // Lookbehind-free (Safari <16.4 compat): insert a NUL sentinel after every
 // whitespace char, then split on it — keeps trailing whitespace attached to
 // each token exactly like the old /(?<=\s)/ split did.
 const words = text.replace(/(\s)/g, '$1\u0000').replace(/\u0000$/, '').split('\u0000');

 for (const word of words) {
 const trimmed = word.trimStart();
 const prevText = current.trimEnd();

 // Check if this word starts a new sentence/item
 if (prevText.length >= 30 && trimmed.length > 0) {
 const startsWithCapital = /^[A-ZÀ-ÖÙ-Ü]/.test(trimmed);

 if (startsWithCapital) {
 // Case A: previous text ends with sentence-ending punctuation
 const endsWithPunctuation = /[.!?)]$/.test(prevText);
 const isAbbreviation = ABBREVIATION_PATTERN.test(prevText.replace(/[.)]$/, ''));

 // Case B: previous text does NOT end with punctuation, but this looks
 // like a new independent clause (capital letter, not a common word
 // that follows naturally like"Il","La","Un","Per", etc. which
 // might be mid-sentence continuations)
 const looksLikeNewClause = !endsWithPunctuation &&
 /[a-zà-öù-ü)]$/.test(prevText) &&
 /^[A-ZÀ-ÖÙ-Ü][a-zà-öù-ü]/.test(trimmed) &&
 // Only split at implicit boundaries if the preceding word is short
 // (end of a task phrase) — avoid splitting mid-sentence continuations
 prevText.length >= 50;

 if ((endsWithPunctuation && !isAbbreviation) || looksLikeNewClause) {
 items.push(current.trim());
 current = '';
 }
 }
 }

 current += word;
 }

 if (current.trim()) {
 items.push(current.trim());
 }

 // Validate: all items should be reasonable length
 // If any item is too short (<25 chars), merge it with the previous one
 const merged: string[] = [];
 for (const item of items) {
 if (merged.length > 0 && item.length < 25) {
 merged[merged.length - 1] += ' ' + item;
 } else {
 merged.push(item);
 }
 }

 // Only return split result if we got at least 2 meaningful items
 return merged.length >= 2 ? merged : [text];
}

/** Render an Inline[] from the shared parser AST into React text/strong/em. */
function renderInlines(inlines: JobDescInline[]): React.ReactNode {
 return inlines.map((tok, i) => {
 if (tok.kind === 'strong') return <strong key={i}>{tok.value}</strong>;
 if (tok.kind === 'em') return <em key={i}>{tok.value}</em>;
 return <React.Fragment key={i}>{tok.value}</React.Fragment>;
 });
}

/** Render a Block[] from the shared parser AST as JSX. */
function renderJobDescBlocks(blocks: JobDescBlock[]): React.ReactNode[] {
 return blocks.map((block, i) => {
 if (block.kind === 'heading') {
 // S5: real H2 for sections, H3 for sub-sections. S3: no border-l stripe,
 // hierarchy via type weight + spacing only.
 if (block.level === 2) {
 return (
 <h2
 key={`h2-${i}`}
 className="text-base font-semibold font-display text-heading mt-6 mb-2 first:mt-0"
 >
 {renderInlines(block.children)}
 </h2>
 );
 }
 return (
 <h3
 key={`h3-${i}`}
 className="text-sm font-semibold text-heading mt-4 mb-1 first:mt-0"
 >
 {renderInlines(block.children)}
 </h3>
 );
 }
 if (block.kind === 'paragraph') {
 return (
 <p key={`p-${i}`} className="text-sm leading-relaxed text-body">
 {renderInlines(block.children)}
 </p>
 );
 }
 const ListTag = block.ordered ? 'ol' : 'ul';
 const listClass = block.ordered
 ? 'space-y-1.5 pl-5 list-decimal marker:text-accent'
 : 'space-y-1.5 pl-4 list-disc marker:text-accent';
 return (
 <ListTag key={`list-${i}`} className={listClass}>
 {block.items.map((item, j) => (
 <li key={j} className="text-sm leading-relaxed text-body">
 {renderInlines(item)}
 </li>
 ))}
 </ListTag>
 );
 });
}

/** Parse crawled markdown-like job description into structured JSX blocks
 * via the shared parser (`@/build-plugins/shared/jobDescription/parser`).
 * The shared parser fixes S1 (literal `**`), S2 (mis-promotion of prose to
 * heading), S4 (dedup), S8 (separator stripping). The render layer enforces
 * S3 (no border-l stripe) and S5 (real H2 hierarchy). */
export function renderFormattedDescription(raw: string): React.ReactNode {
 const text = String(raw || '').trim();
 if (!text) return null;
 const blocks = parseJobDescription(text);
 if (blocks.length === 0) {
 return normalizeParagraphs(text).map((p, i) => (
 <p key={i} className="text-sm leading-relaxed text-body">{p}</p>
 ));
 }
 return renderJobDescBlocks(blocks);
}

const NOISY_REQUIREMENT_PATTERNS = [
 /^how you will make a difference/i,
 /^skills that will make you succeed/i,
 /^streamlined recruitment process/i,
 /^eligibility requirements/i,
 /^job description/i,
 /^stellenbeschreibung/i,
 /^beschreibung/i,
 /^profil$/i,
 /^requirements?$/i,
 /^requisiti$/i,
 /^competenze richieste$/i,
 /hiring manager/i,
 /recruiter/i,
 /potential business case/i,
 /streamlined recruitment/i,
 /eligibility requirements/i,
];

function sanitizeRequirementTokens(items: string[]): string[] {
 const out: string[] = [];
 const seen = new Set<string>();
 for (const raw of items) {
 const chunks = String(raw || '')
 .split(/(?:\n|;|•|·|▪|◦|\u2022|\u25AA)/g)
 .map((s) => s.replace(/\s+/g, ' ').replace(/^[\s\-–—•·▪◦,:;()]+|[\s\-–—•·▪◦,:;()]+$/g, '').trim())
 .filter(Boolean);
 for (const chunk of chunks) {
 if (chunk.length < 8 || chunk.length > 120) continue;
 if (/[<>]/.test(chunk)) continue;
 if (NOISY_REQUIREMENT_PATTERNS.some((rx) => rx.test(chunk))) continue;
 const key = chunk.toLowerCase();
 if (seen.has(key)) continue;
 seen.add(key);
 out.push(chunk);
 if (out.length >= 10) return out;
 }
 }
 return out;
}

// `CanonicalLocaleContent` is now defined in
// `@/services/jobs/canonicalFallback` (imported at the top of this file).

const CANONICAL_COPY_BY_LOCALE: Record<'it' | 'en' | 'de' | 'fr', {
 summary: string;
 highlights: string;
 responsibilities: string;
 requirements: string;
 benefits: string;
 process: string;
 keywords: string;
 details: string;
 reading: string;
}> = {
 it: {
 summary: 'Panoramica',
 highlights: 'Punti chiave',
 responsibilities: 'Mansioni principali',
 requirements: 'Competenze richieste',
 benefits: 'Cosa offre l’azienda',
 process: 'Come candidarsi',
 keywords: 'Ricerche correlate',
 details: 'Dettagli del ruolo',
 reading: 'Tempo di lettura',
 },
 en: {
 summary: 'Role overview',
 highlights: 'Key points',
 responsibilities: 'Main responsibilities',
 requirements: 'Required skills',
 benefits: 'What the company offers',
 process: 'Application process',
 keywords: 'Related searches',
 details: 'Role details',
 reading: 'Reading time',
 },
 de: {
 summary: 'Rollenüberblick',
 highlights: 'Kernpunkte',
 responsibilities: 'Hauptaufgaben',
 requirements: 'Geforderte Kompetenzen',
 benefits: 'Was das Unternehmen bietet',
 process: 'Bewerbungsprozess',
 keywords: 'Verwandte Suchen',
 details: 'Stellendetails',
 reading: 'Lesezeit',
 },
 fr: {
 summary: 'Vue d’ensemble du poste',
 highlights: 'Points clés',
 responsibilities: 'Responsabilités principales',
 requirements: 'Compétences requises',
 benefits: 'Ce que l’entreprise offre',
 process: 'Processus de candidature',
 keywords: 'Recherches associées',
 details: 'Détails du poste',
 reading: 'Temps de lecture',
 },
};

function getCanonicalCopy(locale: Locale) {
 return CANONICAL_COPY_BY_LOCALE[(locale in CANONICAL_COPY_BY_LOCALE ? locale : 'it') as 'it' | 'en' | 'de' | 'fr'];
}

const CONTACT_EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CONTACT_TOKEN_REGEX = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:(?:\+|00)\d[\d\s()./-]{5,}\d|\b\d[\d\s()./-]{6,}\d\b))/gi;
const ISO_DATE_CONTACT_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_RANGE_CONTACT_REGEX = /\b\d{4}\s*\/\s*\d{4}\b/;
const PUBLIC_SITE_URL = 'https://frontaliereticino.ch';

// BLOCK-B: Regionalize for national expansion — currently hardcodes Ticino/Tessin text
const MAILTO_COPY_BY_LOCALE: Record<'it' | 'en' | 'de' | 'fr', {
 subject: (jobTitle: string, company: string) => string;
 intro: (jobTitle: string, company: string) => string;
 placeholder: string;
 footerLead: string;
 footerCta: string;
}> = {
 it: {
 subject: (jobTitle, company) => `Candidatura per ${jobTitle} - ${company}`,
 intro: (jobTitle, company) => `Buongiorno,\n\nvi contatto in merito alla posizione"${jobTitle}" presso ${company}.`,
 placeholder: '[Scrivi qui il tuo messaggio]',
 footerLead: 'Offerta trovata su Frontaliere Ticino.',
 footerCta: 'Torna su frontaliereticino.ch per altre offerte, stipendi netti e dritte utili per frontalieri.',
 },
 en: {
 subject: (jobTitle, company) => `Application for ${jobTitle} - ${company}`,
 intro: (jobTitle, company) => `Hello,\n\nI am reaching out regarding the"${jobTitle}" position at ${company}.`,
 placeholder: '[Write your message here]',
 footerLead: 'Job found on Frontaliere Ticino.',
 footerCta: 'Come back to frontaliereticino.ch for more jobs, net salary tools and cross-border work tips.',
 },
 de: {
 subject: (jobTitle, company) => `Bewerbung fur ${jobTitle} - ${company}`,
 intro: (jobTitle, company) => `Guten Tag,\n\nich kontaktiere Sie wegen der Position"${jobTitle}" bei ${company}.`,
 placeholder: '[Schreiben Sie hier Ihre Nachricht]',
 footerLead: 'Stellenangebot gefunden auf Frontaliere Ticino.',
 footerCta: 'Kommen Sie auf frontaliereticino.ch zuruck fur weitere Jobs, Nettolohn-Tools und Tipps fur Grenzganger.',
 },
 fr: {
 subject: (jobTitle, company) => `Candidature pour ${jobTitle} - ${company}`,
 intro: (jobTitle, company) => `Bonjour,\n\nje vous contacte au sujet du poste"${jobTitle}" chez ${company}.`,
 placeholder: '[Ecrivez votre message ici]',
 footerLead: 'Offre trouvee sur Frontaliere Ticino.',
 footerCta: 'Revenez sur frontaliereticino.ch pour d autres offres, des outils salaire net et des conseils frontaliers.',
 },
};

function getMailtoCopy(locale: Locale) {
 return MAILTO_COPY_BY_LOCALE[(locale in MAILTO_COPY_BY_LOCALE ? locale : 'it') as 'it' | 'en' | 'de' | 'fr'];
}

function normalizeContactPhone(phone: string): string {
 const trimmed = String(phone || '').trim();
 const withIntlPrefix = trimmed.replace(/^00/, '+');
 const cleaned = withIntlPrefix.replace(/[^\d+]/g, '');
 return cleaned.startsWith('+') ? `+${cleaned.slice(1).replace(/\+/g, '')}` : cleaned.replace(/\+/g, '');
}

export function isLikelyPhone(value: string): boolean {
 const normalized = String(value || '').trim();
 if (ISO_DATE_CONTACT_REGEX.test(normalized)) return false;
 if (YEAR_RANGE_CONTACT_REGEX.test(normalized)) return false;
 const digits = normalized.replace(/\D/g, '');
 return digits.length >= 7;
}

function buildContactMailto(email: string, job: JobListing, locale: Locale, jobUrl: string): string {
 const copy = getMailtoCopy(locale);
 const jobTitle = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title);
 const subject = copy.subject(jobTitle, job.company);
 const body = [
 copy.intro(jobTitle, job.company),
 '',
 copy.placeholder,
 '',
 '---',
 copy.footerLead,
 jobUrl,
 copy.footerCta,
 PUBLIC_SITE_URL,
 ].join('\n');

 return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function renderContactRichText(
 text: string,
 job: JobListing,
 locale: Locale,
 jobUrl: string,
): React.ReactNode[] {
 const normalized = String(text || '').trim();
 if (!normalized) return [];

 const nodes: React.ReactNode[] = [];
 let lastIndex = 0;
 let match: RegExpExecArray | null;

 CONTACT_TOKEN_REGEX.lastIndex = 0;
 while ((match = CONTACT_TOKEN_REGEX.exec(normalized)) !== null) {
 const [raw] = match;
 const start = match.index;
 const end = start + raw.length;

 if (start > lastIndex) nodes.push(normalized.slice(lastIndex, start));

 if (raw.includes('@')) {
 const email = raw.match(CONTACT_EMAIL_REGEX)?.[0] || raw;
 nodes.push(
 <a
 key={`email-${start}-${email}`}
 href={buildContactMailto(email, job, locale, jobUrl)}
 className="font-semibold text-accent underline decoration-accent-border underline-offset-2 hover:text-accent "
 >
 {email}
 </a>
 );
 } else if (isLikelyPhone(raw)) {
 nodes.push(
 <a
 key={`phone-${start}-${raw}`}
 href={`tel:${normalizeContactPhone(raw)}`}
 className="font-semibold text-success underline decoration-success-border underline-offset-2 hover:text-success "
 >
 {raw}
 </a>
 );
 } else {
 nodes.push(raw);
 }

 lastIndex = end;
 }

 if (lastIndex < normalized.length) nodes.push(normalized.slice(lastIndex));
 return nodes.length > 0 ? nodes : [normalized];
}

function cleanHighlightChips(value: unknown, max = 6): string[] {
 if (!Array.isArray(value)) return [];
 const seen = new Set<string>();
 const out: string[] = [];
 for (const item of value) {
 const clean = stripCanonicalLeadLabel(String(item || '').replace(/\s+/g, ' ').trim());
 if (!clean) continue;
 if (clean.length < 4 || clean.length > 90) continue;
 const words = clean.split(/\s+/).filter(Boolean);
 if (words.length < 2 || words.length > 12) continue;
 if (/[:;|]/.test(clean) && words.length > 8) continue;
 if (/[.!?]\s/.test(clean) && words.length > 8) continue;
 if (/^(requisiti|competenze|mansioni|dettagli|cosa offriamo|profilo|contatti)$/i.test(clean)) continue;
 // Filter section-header fragments that contain ' - ' separator
 if (/ - /.test(clean) && words.length > 3) continue;
 const key = canonicalItemKey(clean);
 if (!key || seen.has(key)) continue;
 seen.add(key);
 out.push(clean);
 if (out.length >= max) break;
 }
 return out;
}

function stripCanonicalLeadLabel(value: string): string {
 return String(value || '')
 .replace(/\s+/g, ' ')
 .replace(
 /^(?:mansioni principali|mansioni|compiti|responsabilita principali|responsabilita|requisiti necessari|requisiti auspicati|requisiti|competenze richieste|profilo richiesto|profilo|osservazioni|benefit|cosa offre l'azienda|cosa offre l’azienda|cosa ti offriamo|come candidarsi|contatti|dettagli(?: del ruolo| ulteriori)?|note|main responsibilities|required skills|requirements|benefits|application process|contacts?|role details|stellendetails|détails du poste)\s*[:\-–—]?\s*/i,
 ''
 )
 .trim();
}

function canonicalItemKey(value: string): string {
 return stripCanonicalLeadLabel(String(value || ''))
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9\s]/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();
}

/**
 * Normalised key for deduping/matching city names across diacritic and
 * separator variants (Z\u00fcrich/Zurich, Gen\u00e8ve/Geneve, Davos-Platz/Davos Platz).
 * Used by BOTH the location-filter option list and the filter predicate so a
 * merged option still matches every spelling variant present in the data.
 */
function normalizeLocalityKey(value: string): string {
 return String(value || '')
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9]+/g, ' ')
 .trim();
}

function canonicalItemsEquivalent(a: string, b: string): boolean {
 const ka = canonicalItemKey(a);
 const kb = canonicalItemKey(b);
 if (!ka || !kb) return false;
 if (ka === kb) return true;

 const short = ka.length <= kb.length ? ka : kb;
 const long = ka.length > kb.length ? ka : kb;
 if (short.length >= 28 && long.includes(short)) return true;

 const tokensA = new Set(ka.split(' ').filter((t) => t.length >= 3));
 const tokensB = new Set(kb.split(' ').filter((t) => t.length >= 3));
 const minTokens = Math.min(tokensA.size, tokensB.size);
 if (minTokens < 5) return false;
 let overlap = 0;
 for (const token of tokensA) {
 if (tokensB.has(token)) overlap += 1;
 }
 return overlap / minTokens >= 0.85;
}

function isResidualNoteMeaningful(value: string): boolean {
 const clean = stripCanonicalLeadLabel(String(value || '').replace(/\s+/g, ' ').trim());
 if (!clean) return false;
 if (clean.length < 20) return false;
 if (/^(?:osservazioni|requisiti|mansioni|compiti|dettagli|note|contatti|chiave|\?)$/i.test(clean)) return false;
 if (!/[a-zA-ZÀ-ÖØ-öø-ÿ0-9]/.test(clean)) return false;
 return true;
}

function isDetailLikeSection(section: { id: string; heading: string }): boolean {
 const scope = `${String(section.id || '')} ${String(section.heading || '')}`.toLowerCase();
 return /(detail|dettagl|note|append|extra|altro|misc|ulterior)/.test(scope);
}

function dedupeSectionItems(items: string[], baseline: string[], max: number, requireResidualMeaning: boolean): string[] {
 const out: string[] = [];
 for (const raw of items) {
 const clean = String(raw || '').replace(/\s+/g, ' ').trim();
 if (!clean || clean.length < 3) continue;
 const normalized = stripCanonicalLeadLabel(clean) || clean;
 if (requireResidualMeaning && !isResidualNoteMeaningful(normalized)) continue;
 if (baseline.some((existing) => canonicalItemsEquivalent(normalized, existing))) continue;
 if (out.some((existing) => canonicalItemsEquivalent(normalized, existing))) continue;
 out.push(normalized);
 if (out.length >= max) break;
 }
 return out;
}

function normalizeCanonicalSections(value: unknown): CanonicalLocaleContent['sections'] {
 if (!Array.isArray(value)) return [];
 const out: CanonicalLocaleContent['sections'] = [];
 for (const raw of value) {
 const section = raw as {
 id?: unknown;
 heading?: unknown;
 paragraphs?: unknown;
 bullets?: unknown;
 };
 const heading = String(section?.heading || '').replace(/\s+/g, ' ').trim();
 const paragraphs = cleanCanonicalItems(section?.paragraphs, 8);
 const bullets = cleanCanonicalItems(section?.bullets, 10);
 if (!heading && paragraphs.length === 0 && bullets.length === 0) continue;
 out.push({
 id: String(section?.id || 'details').trim() || 'details',
 heading: heading || 'Details',
 paragraphs,
 bullets,
 });
 if (out.length >= 8) break;
 }
 return out;
}

// Fallback canonical-content splitter is now defined in
// `@/services/jobs/canonicalFallback` (imported at the top of this file).
// The shared module is consumed by both this SPA component and
// `build-plugins/jobsSeoPagesPlugin.ts` so the hydrated DOM and the static
// HTML emitted to dist/ render the same sectioned job-detail timeline.

function isSparseCanonicalContent(content: CanonicalLocaleContent | undefined | null): boolean {
 if (!content) return true;
 const summary = cleanCanonicalItems(content.summary, 3);
 const responsibilities = cleanCanonicalItems(content.responsibilities, 12);
 const requirements = cleanCanonicalItems(content.requirements, 12);
 const benefits = cleanCanonicalItems(content.benefits, 10);
 const process = cleanCanonicalItems(content.process, 8);
 const sections = normalizeCanonicalSections(content.sections);
 const sectionItems = sections.reduce((total, section) => (
 total + cleanCanonicalItems(section.paragraphs, 8).length + cleanCanonicalItems(section.bullets, 10).length
 ), 0);

 return summary.length === 0 || (responsibilities.length + requirements.length + benefits.length + process.length + sectionItems) < 3;
}

function canonicalContentRichnessScore(content: CanonicalLocaleContent | undefined | null): number {
 if (!content) return 0;
 const summary = cleanCanonicalItems(content.summary, 3);
 const responsibilities = cleanCanonicalItems(content.responsibilities, 12);
 const requirements = cleanCanonicalItems(content.requirements, 12);
 const benefits = cleanCanonicalItems(content.benefits, 10);
 const process = cleanCanonicalItems(content.process, 8);
 const sections = normalizeCanonicalSections(content.sections);
 const sectionItems = sections.reduce((total, section) => (
 total + cleanCanonicalItems(section.paragraphs, 8).length + cleanCanonicalItems(section.bullets, 10).length
 ), 0);

 return (
 summary.length * 2 +
 responsibilities.length * 3 +
 requirements.length * 3 +
 benefits.length * 2 +
 process.length * 2 +
 sectionItems
 );
}

function readCanonicalLocaleContent(job: JobListing, locale: Locale, description: string, requirements: string[]): CanonicalLocaleContent {
 const byLocale = job.canonicalContent?.byLocale;
 // Cast: byLocale entries use all-optional fields but functions expect the full type
 const selected = byLocale?.[locale] as unknown as CanonicalLocaleContent | undefined;
 const fallbackCanonical = buildFallbackCanonicalContent(description, requirements, locale);
 if (!selected || isSparseCanonicalContent(selected)) return fallbackCanonical;
 if (canonicalContentRichnessScore(selected) + 6 < canonicalContentRichnessScore(fallbackCanonical)) {
 return fallbackCanonical;
 }

 const summary = cleanCanonicalItems(selected.summary, 3);
 const rawSections = normalizeCanonicalSections(selected.sections);
 const structuredRequirements = cleanCanonicalItems(selected.requirements, 12);
 const reading = Number(selected.readingMinutes);
 const responsibilities = cleanCanonicalItems(selected.responsibilities, 12);
 const mergedRequirements = structuredRequirements.length > 0
 ? structuredRequirements
 : cleanCanonicalItems(requirements, 12);
 const benefits = cleanCanonicalItems(selected.benefits, 10);
 const process = cleanCanonicalItems(selected.process, 8);
 const highlights = cleanCanonicalItems(selected.highlights, 8);
 const keywords = cleanCanonicalItems(selected.keywords, 8);
 const effectiveSummary = summary.length > 0 ? summary : fallbackCanonical.summary;

 // Global baseline used for semantic dedup:
 // details/notes must contain only residual, meaningful content not already used elsewhere.
 const baseline: string[] = [
 ...effectiveSummary,
 ...responsibilities,
 ...mergedRequirements,
 ...benefits,
 ...process,
 ...highlights,
 ...keywords,
 ];

 const sections: CanonicalLocaleContent['sections'] = [];
 for (const section of rawSections) {
 const detailLike = isDetailLikeSection(section);
 const cleanedParagraphs = dedupeSectionItems(section.paragraphs, baseline, 8, detailLike);
 const cleanedBullets = dedupeSectionItems(section.bullets, [...baseline, ...cleanedParagraphs], 10, detailLike);
 if (cleanedParagraphs.length === 0 && cleanedBullets.length === 0) continue;
 const cleanedSection = {
 ...section,
 paragraphs: cleanedParagraphs,
 bullets: cleanedBullets,
 };
 sections.push(cleanedSection);
 baseline.push(...cleanedParagraphs, ...cleanedBullets);
 }

 return {
 summary: effectiveSummary,
 sections,
 responsibilities,
 requirements: mergedRequirements,
 benefits,
 process,
 highlights,
 keywords,
 readingMinutes: Number.isFinite(reading) && reading > 0
 ? Math.round(reading)
 : Math.max(1, Math.round(String(description || '').replace(/\s+/g, ' ').trim().split(/\s+/).length / 180)),
 };
}

// Both were hand-written copies of the shared normalisation (#5012 review): the token an
// alert is saved under and the token the router compares must come from the SAME function,
// or a CompanyAlert silently never matches. They now delegate \u2014 the local names are kept
// only because this file references them in several places.
const slugifyCompany = rawCompanySlug;
const canonicalCompanyRouteSlug = baseCompanySlug;

export function getJobBoardCompanyRoutePrefix(locale: Locale): string {
 switch (locale) {
 case 'en':
 return 'company';
 case 'de':
 return 'unternehmen';
 case 'fr':
 return 'entreprise';
 default:
 return 'azienda';
 }
}

export function buildCompanySearchSlug(company: string, companyKey: string | undefined, locale: Locale): string {
 return `${getJobBoardCompanyRoutePrefix(locale)}-${canonicalCompanyRouteSlug(company, companyKey)}`;
}

function companyRouteSlugCandidates(company: string, companyKey?: string): Set<string> {
 const out = new Set<string>();
 const canonical = canonicalCompanyRouteSlug(company, companyKey);
 const raw = slugifyCompany(company);
 if (canonical) out.add(canonical);
 if (raw) out.add(raw);
 if (canonical === 'lidl') {
 out.add('lidl-svizzera');
 out.add('lidl-svizzera-dl-ag');
 out.add('lidl-svizzera-logistica');
 }
 return out;
}

function deriveLocalizedJobSlug(job: JobListing, locale: Locale): string {
 const explicit = String(job.slugByLocale?.[locale] || '').trim();
 if (explicit) return explicit;
 // When loaded from the slim locale index, slugByLocale is stripped but
 // the slug field is already flattened to the correct locale value.
 // Check it BEFORE falling through to the title-company-location derivation,
 // which can produce a different (wrong) slug when the company name differs
 // from the companyKey used during crawl-time slug generation.
 const canonical = String(job.slug || '').trim();
 if (canonical) return canonical;
 const localizedTitle = String(job.titleByLocale?.[locale] || job.title || '').trim();
 const fallback = slugifyJobPart(`${localizedTitle}-${job.company}-${job.location}`) || slugifyJobPart(localizedTitle);
 return fallback || '';
}

function matchesRouteSlug(job: JobListing, routeSlug: string): boolean {
 const target = String(routeSlug || '').trim();
 if (!target) return false;
 if (job.slug === target) return true;
 for (const locale of (['it', 'en', 'de', 'fr'] as const)) {
 if (deriveLocalizedJobSlug(job, locale) === target) return true;
 }
 // Legacy slug aliases (renamed active jobs), flat and locale-aware.
 // NB: records loaded from the slim locale index NO LONGER carry these fields
 // (build-plugins/shared/slimJobIndex.ts dropped them — they duplicated the
 // sharded slug map). Historic-slug resolution now happens BEFORE this call, by
 // mapping the route slug to the job's current slug via `aliasCanonical`; see
 // `selectedJob`. These two checks are kept as a defensive no-op for any caller
 // that still passes a full (non-slim) record — e.g. tests, or a future
 // per-canton shard payload built from data/jobs.json — and must not be read as
 // "the historic fallback happens here".
 if (job.previousSlugs?.includes(target)) return true;
 if (job.previousSlugsByLocale) {
 for (const arr of Object.values(job.previousSlugsByLocale)) {
 if (arr?.includes(target)) return true;
 }
 }
 return false;
}

export function parseCompanySlugFilter(initialJobSlug?: string, activeJobs?: JobListing[]): string | null {
 if (!initialJobSlug) return null;
 const prefixes = ['azienda-', 'company-', 'unternehmen-', 'entreprise-'];
 const hit = prefixes.find((p) => initialJobSlug.startsWith(p));
 if (!hit) return null;
 // If this slug directly matches an active job, the company name in the slug is a
 // coincidence (e.g. company "Azienda Multiservizi Bellinzona AMB" whose slug starts
 // with "azienda-"). Don't treat it as a company filter in that case.
 if (activeJobs?.some(j => matchesRouteSlug(j, initialJobSlug))) return null;
 const slug = initialJobSlug.slice(hit.length).trim();
 return slug || null;
}

function getJobBoardLocationRoutePrefix(locale: Locale): string {
 switch (locale) {
 case 'en': return 'location';
 case 'de': return 'standort';
 case 'fr': return 'localite';
 default: return 'localita';
 }
}

function slugifyLocation(location: string): string {
 return String(location || '')
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9]+/g, '-')
 .replace(/^-+|-+$/g, '');
}

export function buildLocationSearchSlug(location: string, locale: Locale): string {
 return `${getJobBoardLocationRoutePrefix(locale)}-${slugifyLocation(location)}`;
}

function parseLocationSlugFilter(initialJobSlug?: string): string | null {
 if (!initialJobSlug) return null;
 const prefixes = ['localita-', 'location-', 'standort-', 'localite-'];
 const hit = prefixes.find((p) => initialJobSlug.startsWith(p));
 if (!hit) return null;
 const slug = initialJobSlug.slice(hit.length).trim();
 return slug || null;
}

export function shouldRestoreJobBoardListState(previousSlug?: string, nextSlug?: string): boolean {
 const wasOnDetail = Boolean(
 previousSlug
 && !parseCompanySlugFilter(previousSlug)
 && !parseSearchSlugFilter(previousSlug)
 && !parseLocationSlugFilter(previousSlug)
 );
 const isBackToPlainList = !nextSlug;
 return wasOnDetail && isBackToPlainList;
}

function readSearchQueryFromUrl(): string {
 if (typeof window === 'undefined') return '';
 try {
 const params = new URLSearchParams(window.location.search || '');
 return String(params.get('q') || '').trim();
 } catch {
 return '';
 }
}

/**
 * `window.__BRIDGE_TARGET_SLUG__` — written into the static HTML of a job
 * BRIDGE page (a URL that is one of the job's old slugs) by
 * build-plugins/jobsSeoPagesPlugin, carrying the job's CURRENT slug. Its mere
 * presence is the repo-wide marker for "this URL is a job page", which ~15 dist
 * validators also key off (e.g. scripts/validate-canonical.mjs).
 *
 * A module-level reader rather than a hook so the slug-filter parsers can
 * consult it from ANY position in the component — including the `searchQuery`
 * useState initializer, which runs before any hook declared further down.
 *
 * SCOPED TO THE PAGE THAT SHIPPED IT. The global is baked into the static HTML
 * of ONE bridge URL and is never updated (nor cleared) by SPA navigation, so
 * after a soft-navigation off that page it is stale. That staleness used to be
 * harmless — `companySlugFilter` took precedence over `selectedJob` — but now
 * that the filters short-circuit on `isBridgePage`, an uncleared global would
 * null out the NEW route's company/location/search filter and re-render the
 * previous job on, say, /cerca-lavoro-ticino/azienda-coop/. Honouring it only
 * while we are still on the originating pathname keeps it a first-paint signal.
 * Mirrors `seededJobMatchesSlug`, which guards __EXPIRED_JOB_DATA__ the same way
 * ("prevents stale window globals from a previous SPA navigation").
 *
 * Captured at module load: the chunk is evaluated during the document's initial
 * load, so this is the pathname the inline script belongs to. If it ever were
 * evaluated later, the global would simply be absent and the reader returns
 * undefined — resolution falls back to the shard path, which still resolves.
 *
 * Shared by every build-seeded global read in this file (`__BRIDGE_TARGET_SLUG__`,
 * `__JOB_SEED__`): they are all inline scripts belonging to ONE document, so
 * they are all valid under exactly the same condition.
 */
const SEEDED_GLOBALS_PATHNAME: string | null =
 typeof window !== 'undefined' ? window.location.pathname : null;

/** True while we are still on the page whose HTML carried the inline seeds. */
function onSeededDocument(): boolean {
 return typeof window !== 'undefined' && window.location.pathname === SEEDED_GLOBALS_PATHNAME;
}

function readBridgeTargetSlug(): string | undefined {
 if (!onSeededDocument()) return undefined;
 const value = (window as unknown as Record<string, unknown>).__BRIDGE_TARGET_SLUG__;
 return typeof value === 'string' && value ? value : undefined;
}

function readPageFromUrl(): number {
 if (typeof window === 'undefined') return 1;
 try {
 const params = new URLSearchParams(window.location.search || '');
 const p = parseInt(params.get('page') || '', 10);
 return p >= 1 ? p : 1;
 } catch {
 return 1;
 }
}

/**
 * Salary-range filter (issue #4307 scope item 3 — calculator's reverse
 * bridge: "Offerte nella tua fascia (±15%) in <cantone>"). `?salarioMin=`/
 * `?salarioMax=` are CHF annual figures; `max` is dropped (treated as
 * unset) unless it is a finite number >= `min`, so a malformed pair never
 * silently filters out every job.
 */
function readSalaryRangeFromUrl(): { min: number | null; max: number | null } {
 if (typeof window === 'undefined') return { min: null, max: null };
 try {
 const params = new URLSearchParams(window.location.search || '');
 const minRaw = parseInt(params.get('salarioMin') || '', 10);
 const maxRaw = parseInt(params.get('salarioMax') || '', 10);
 const min = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : null;
 const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : null;
 return { min, max: (min !== null && max !== null && max >= min) ? max : null };
 } catch {
 return { min: null, max: null };
 }
}

/** Update URL query params without pushing to history (avoids bloating back stack). */
function syncQueryParamsToUrl(updates: Record<string, string | null>) {
 if (typeof window === 'undefined') return;
 try {
 const params = new URLSearchParams(window.location.search || '');
 for (const [key, value] of Object.entries(updates)) {
 if (value === null || value === '') params.delete(key);
 else params.set(key, value);
 }
 const qs = params.toString();
 const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
 if (newUrl !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
 window.history.replaceState(window.history.state, '', newUrl);
 }
 } catch { /* non-critical */ }
}

// normalizeSearchText extracted to services/textUtils.ts for reuse by personalizationScoring

function normalizeUrlForDedup(raw: string): string {
 const value = String(raw || '').trim();
 if (!value) return '';
 try {
 const u = new URL(value);
 u.hash = '';
 return `${u.origin}${u.pathname}${u.search}`.toLowerCase();
 } catch {
 return value.toLowerCase();
 }
}

export function buildListingDedupKey(job: JobListing): string {
 // Stable crawler-assigned id is the strongest dedup signal — preserves
 // distinct vacancies that share an ATS landing URL (e.g. Galenica's
 // `jobs.galenica.com/it/jobs/#job.id=NNNN`, where the job-id lives in
 // the hash and `normalizeUrlForDedup` strips it). Aligns with the
 // build-side dedup heuristic in `jobsSeoPagesPlugin.ts:dedupKey`.
 const id = String(job.id || '').trim();
 if (id) return `id|${id}`;
 const company = normalizeSearchText(job.company);
 const title = normalizeSearchText(sanitizeJobTitle(job.title));
 const location = normalizeSearchText(job.location);
 const url = normalizeUrlForDedup(job.url || '');
 const source = normalizeSearchText(job.source || '');
 if (url) return `url|${url}`;
 return `meta|${company}|${title}|${location}|${source}`;
}

function scoreListingJob(job: JobListing): number {
 let score = 0;
 const description = String(job.description || '').trim();
 if (description) score += Math.min(40, Math.floor(description.length / 120));
 if (job.salaryMin) score += 6;
 if (job.salaryMax) score += 3;
 if (job.canonicalContent?.byLocale) score += 8;
 if (job.slug || (job.slugByLocale && Object.keys(job.slugByLocale).length > 0)) score += 3;
 const ts = new Date(job.crawledAt || job.postedDate || '').getTime();
 if (!Number.isNaN(ts)) score += Math.floor(ts / 1_000_000_000);
 return score;
}

export function dedupeJobsForListing(jobs: JobListing[]): JobListing[] {
 const byKey = new Map<string, JobListing>();
 for (const job of jobs) {
 const key = buildListingDedupKey(job);
 const existing = byKey.get(key);
 if (!existing) {
 byKey.set(key, job);
 continue;
 }
 byKey.set(key, scoreListingJob(job) > scoreListingJob(existing) ? job : existing);
 }
 return Array.from(byKey.values());
}

/** Why a job was surfaced as "similar" to the currently-viewed job, in priority order. */
export type SimilarJobMatchReason = 'category' | 'location' | 'company' | 'other';

/**
 * Explains *why* a related job matched, mirroring the same category/location/
 * company priority used by the scoring pass in computeSimilarJobs below. Used
 * for analytics attribution (job_match_similar_click).
 */
export function describeSimilarJobMatchReason(source: JobListing, target: JobListing): SimilarJobMatchReason {
 if (target.category === source.category) return 'category';
 if (target.location === source.location) return 'location';
 if (target.company === source.company) return 'company';
 return 'other';
}

/**
 * "Similar jobs" cluster for the JobDetail view — same sector/canton/company
 * heuristic already used elsewhere in the listing, scoped to a single source job.
 *
 * Self-exclusion compares `buildListingDedupKey`, NOT raw `.id`: several
 * crawlers ship jobs with `id: undefined` (see scripts/lib/job-match-key.mjs,
 * #3411), and `dedupeJobsForListing` only guarantees uniqueness on the full
 * dedup key — not on `.id` alone. Comparing raw ids meant every other id-less
 * job in the pool got wrongly treated as "the same job" as an id-less selected
 * job, and silently excluded from that job's own similar-jobs list.
 */
export function computeSimilarJobs(source: JobListing, pool: JobListing[], limit = 6): JobListing[] {
 const sourceKey = buildListingDedupKey(source);
 const withScore = pool
 .filter((j) => j.slug && buildListingDedupKey(j) !== sourceKey)
 .map((j) => {
 let score = 0;
 if (j.category === source.category) score += 3;
 if (j.location === source.location) score += 2;
 if (j.company === source.company) score += 1;
 const freshness = new Date(j.crawledAt || j.postedDate).getTime();
 return { job: j, score, freshness };
 });
 return withScore
 .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.freshness - a.freshness))
 .slice(0, limit)
 .map((x) => x.job);
}

// NOTE: currently unreferenced elsewhere in this file (pre-existing —
// related-jobs uses computeSimilarJobs' field-based scoring, not query
// text). Kept in sync with the live matchers below so it's ready if a
// query-driven caller is wired up later.
function queryMatchesJob(job: JobListing, query: string, locale: Locale): boolean {
 const queryTokens = normalizeSearchText(query).split(' ').filter(Boolean);
 if (queryTokens.length === 0) return true;
 const description = job.descriptionByLocale?.[locale] ?? job.description;
 const localizedTitle = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title);
 // Profession-taxonomy synonyms (it/de/fr/en) so a query in one language
 // matches a job title written in another (e.g. "nurse" ↔ "Infermiera").
 const synonyms = professionSynonymText(localizedTitle);
 const haystack = normalizeSearchText(`${localizedTitle} ${job.company} ${job.location} ${cantonSearchTokens(job.canton)} ${description} ${synonyms}`);
 return queryTokens.every((token) => haystack.includes(token));
}

/** Date-range facet → lookback window. Module-level because both the strict
 * tier and the build-seed tier derive their cutoff from it; inline copies would
 * be the same literal in two places. */
const DATE_RANGE_MS: Record<DateRange, number> = {
  all: 0,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

// --- Memoized JobCard to avoid re-renders on filter/sort ---
interface JobCardProps {
 job: JobListing;
 jobHref: string;
 salary: string | null;
 logo: string | null;
 isNew: boolean;
 postedLabel: string;
 locale: string;
 t: (key: string, params?: Record<string, string>) => string;
 onSelect: (job: JobListing) => void;
 /** Whether the job is in the visitor's saved list (#4466). */
 saved: boolean;
 /** Toggle save/unsave for this job. */
 onToggleSave: (job: JobListing) => void;
}
const JobCard = React.memo(({ job, jobHref, salary, logo, isNew, postedLabel, locale, t, onSelect, saved, onToggleSave }: JobCardProps) => (
 <article
 key={job.id}
 className={`relative rounded-xl border p-3 sm:p-4 transition-colors min-h-[72px] ${
 job.featured
 ? 'border-warning-border bg-warning-subtle hover:border-warning'
 : 'border-edge bg-surface/50 hover:border-accent-border'
 }`}
 >
 {/* Save toggle: absolutely positioned (out of flow → zero CLS) with a
 matching pr-9 gutter reserved on the title block below so text never
 reflows under it. Sibling of the <a>, never nested inside it (a11y). */}
 <button
 type="button"
 onClick={() => onToggleSave(job)}
 aria-pressed={saved}
 aria-label={saved ? t('jobBoard.save.remove') : t('jobBoard.save.add')}
 className={`absolute top-1 right-1 z-10 inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg transition-colors ${
 saved ? 'text-accent' : 'text-muted hover:text-accent'
 }`}
 >
 <Bookmark className={`w-5 h-5 ${saved ? 'fill-current' : ''}`} aria-hidden="true" />
 </button>
 <a
 href={jobHref}
 onClick={(e) => { e.preventDefault(); onSelect(job); }}
 className="block cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg"
 >
 <div className="flex items-start gap-3">
 <div className="w-10 h-10 sm:w-14 sm:h-14 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden border border-edge shrink-0">
 {logo ? (
 <img src={logo} alt={`Logo ${job.company}`} className="w-7 h-7 sm:w-10 sm:h-10 object-contain" width={40} height={40} loading="lazy" onError={handleCompanyLogoError} />
 ) : (
 <span className="text-base sm:text-lg">{CATEGORY_EMOJI[job.category]}</span>
 )}
 </div>
 <div className="min-w-0 flex-1 pr-9">
 <h2 className="text-sm sm:text-base font-bold font-display text-heading leading-tight">
 {sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title)}
 {job.featured && <Star className="inline-block w-3.5 h-3.5 ml-1.5 text-warning fill-warning" />}
 {job.featured && (
 <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide rounded-full bg-accent-subtle text-link align-middle">
 {t('jobBoard.sponsored')}
 </span>
 )}
 {isNew && (
 <span className="ml-1.5 sm:ml-2 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide rounded-full bg-success-subtle text-success">
 <Sparkles className="w-2.5 h-2.5" />
 {t('jobBoard.badge.new')}
 </span>
 )}
 </h2>
 <p className="text-xs sm:text-sm text-subtle mt-0.5 line-clamp-2">
 {job.company} · {isMultiLocation(job.location) ? t('jobBoard.location.multiLocation') : formatJobLocation(job.location, job.canton)}
 </p>
 {salary && (
 <span className="mt-1 inline-flex items-center gap-1 text-xs sm:text-sm font-semibold text-success">
 <Euro className="w-3.5 h-3.5" />
 {salary}
 </span>
 )}
 </div>
 </div>

 <div className="mt-2 sm:mt-3 flex flex-wrap items-center gap-2 sm:gap-1.5 text-xs text-muted">
 <span className="inline-flex items-center gap-1">
 <MapPin className="w-3 h-3" />
 {isMultiLocation(job.location) ? t('jobBoard.location.multiLocation') : job.location}
 </span>
 <span className="px-1.5 py-0.5 rounded bg-surface-raised text-subtle">
 {t(contractTranslationKey(job))}
 </span>
 <span className="inline-flex items-center gap-1">
 <Clock className="w-3 h-3" />
 {postedLabel}
 </span>
 </div>
 </a>
 </article>
));
JobCard.displayName = 'JobCard';

/**
 * JobBoardRailShell — wraps a cerca-lavoro listing/editorial page view in the
 * same monetisation chrome the job-detail view already carries (#2948): a
 * desktop top leaderboard + the 3-column full-height side-rail grid (180px rails
 * @xl widening to 300px @xlw, half-page creatives only at xlw). Below xl it
 * collapses to a single column, so mobile/tablet layout is byte-identical to
 * before. Module-level (never defined inside render) so the persistent GPT rail
 * slots are not remounted as the visitor navigates between board views.
 *
 * The center column keeps its own `space-y-6` rhythm (the wrapped branch root),
 * so existing listing/editorial spacing is unchanged; the shell only adds the
 * banner above and the rail gutters beside it.
 */
const JobBoardRailShell: React.FC<{ isDesktopLg: boolean; children: React.ReactNode }> = ({ isDesktopLg, children }) => {
 const { onLeftEmptyResolved, onRightEmptyResolved, style: railStyle } = useRailGridCollapse();
 return (
 <div className="space-y-6">
 {isDesktopLg && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBDETAIL_TOP_BANNER.slot}
 adFormat={AD_SLOTS.JOBDETAIL_TOP_BANNER.format}
 fullWidthResponsive={AD_SLOTS.JOBDETAIL_TOP_BANNER.fullWidthResponsive}
 />
 )}
 <div className={RAIL_GRID_CLASS_X} style={railStyle}>
 <aside className={RAIL_ASIDE_CLASS_X}>
 <Suspense fallback={null}><ArticleRailAdStack side="left" onEmptyResolved={onLeftEmptyResolved} /></Suspense>
 </aside>
 <div className="min-w-0">{children}</div>
 <aside className={RAIL_ASIDE_CLASS_X}>
 <Suspense fallback={null}><ArticleRailAdStack side="right" onEmptyResolved={onRightEmptyResolved} /></Suspense>
 </aside>
 </div>
 </div>
 );
};
JobBoardRailShell.displayName = 'JobBoardRailShell';

const JobBoard: React.FC<JobBoardProps> = ({
 onPostJob,
 initialJobSlug,
 initialFilterParams,
 onFilterParamsConsumed,
 onJobRouteChange,
 isLoggedIn = false,
 authUser = null,
 authLoading = false,
 onGoogleAuthRequired,
 onFacebookAuthRequired,
 onRequireAuth,
 enablePersonalization = false,
 userProfile = null,
 initialFilterCanton = null,
}) => {
 const { t } = useTranslation();
 const [locale] = useLocale();
 const { headline: gateHeadline } = useAuthGateHeadlineVariant(locale, t('jobBoard.gate.title'));
 // Hold the detail skeleton (not the auth gate) while a newsletter autologin is
 // exchanging — the visitor is about to be signed in; flashing the gate is noise.
 const newsletterAutologinInFlight = useNewsletterAutologinInFlight();
 const nav = useNavigation();
 const pageSize = 10;
 // Runtime kill-switches for the "Strumenti correlati" sidebar cross-links.
 // Toggle via Firebase Remote Config — each `<li>` respects its own flag.
 const killSwitches = useKillSwitches();
 // Collapses the 300px xlw rail gutter (both auth-gate and job-detail views
 // below) when ArticleRailAdStack resolves an all-empty verdict per side —
 // shared with JobOrphanView/JobExpiredView/BlogArticles (issue 4830).
 const { onLeftEmptyResolved, onRightEmptyResolved, style: railStyle } = useRailGridCollapse();

 // Canton-aware {canton}/{cantonPrep} interpolation params for the H1,
 // subtitle and CTAs. Derived from the URL-driven `initialFilterCanton`
 // (e.g. 'BASILEA', 'ZH', '_AGGREGATE_') so a per-canton page renders its
 // own canton name instead of always defaulting to "Ticino". Null/legacy TI
 // → 'TI', preserving the existing Ticino copy on the legacy hub.
 const cantonI18n = useMemo(
 () => getCantonI18nParams(initialFilterCanton || 'TI'),
 // eslint-disable-next-line react-hooks/exhaustive-deps
 [initialFilterCanton, locale],
 );

 /**
  * The pathname the build-injected inline scripts belong to, read during render
  * so it is the post-navigation value on the render a navigation triggers.
  *
  * Both seeds below key their memo on it, because both their guards compare
  * PATHNAMES. A coarser key (the route slug) can stay equal across two
  * different pathnames — `/cerca-lavoro-ticino/ricerca-X/` and
  * `/cerca-lavoro-svizzera/ricerca-X/` are different pages with the same slug,
  * and some slugs really do exist in both families — which leaves the guard
  * unreachable and pins the previous page's seed on screen.
  */
 const seedPathname = typeof window === 'undefined' ? '' : window.location.pathname;

 // Build-injected slim record for THIS active job-detail page (window.__JOB_SEED__),
 // or null on board pages / SPA navigation. Read once per mount.
 // The dep is NOT `[]`: the guard inside readSeededJob is inert unless the memo
 // actually re-runs after a soft-navigation (same reason as bridgeTargetSlug
 // below). At mount the pathname matches, so the seeded first paint is
 // unchanged; only later routes correctly see null.
 //
 // It is the PATHNAME rather than `initialJobSlug` (PR #5328's original key) for
 // the same reason the cluster seed below uses it: the guard compares pathnames,
 // so a key that can stay equal across two different pathnames leaves the guard
 // unreachable and pins a stale seed. Keying on what the guard actually tests
 // makes the two impossible to drift apart.
 const seededJob = useMemo(() => readSeededJob(), [seedPathname]);
 // Seed the jobs array so `selectedJob` resolves on the first frame — no orphan
 // flash, no wait on the ~1.2 MB (gzip) slim index. The full index load below
 // replaces this array; `finalize` re-applies any detail fetched meanwhile and
 // keeps the seed if the loaded shard doesn't contain it (clobber-proof).
 /**
  * Build-computed result set for a related-search cluster landing. The page's
  * static HTML lists jobs this SPA cannot re-find: the emitter matches against
  * the job DESCRIPTION, the slim index this board loads carries none (measured:
  * 30 jobs printed, 6 surviving the client matcher, and the losses are
  * on-intent). Rather than recompute a worse answer, take the one the build
  * already published. Same `[initialJobSlug]` dep as `seededJob`: the inline
  * script belongs to ONE document and must go stale on a soft navigation —
  * `readClusterSearchSeed` re-checks the pathname it was emitted for.
  */
 const clusterSeed = useMemo(
   () => (seedPathname ? readClusterSearchSeed(seedPathname) : null),
   [seedPathname],
 );
 const clusterSeedJobs = useMemo<JobListing[]>(
   () => (clusterSeed ? dedupeJobsForListing(clusterSeed.j.map((raw) => normalizeIncomingJob(raw))) : []),
   [clusterSeed],
 );
 // Seeded into `jobs` too (not just into the result list) so the first frame
 // can resolve a card the user clicks before any shard has landed.
 const [jobs, setJobs] = useState<JobListing[]>(() => (seededJob ? [seededJob] : clusterSeedJobs));
 // Cross-canton fallback pool: the locale-wide unscoped corpus loaded by
 // `loadLegacyLocaleJobs` BEFORE `scopeJobsToCanton` narrows it. When a
 // canton-scoped search yields zero strict+OR matches we re-run the OR-match
 // against this pool (minus already-scoped IDs) so users on a cluster URL
 // always see something — e.g. `/cerca-lavoro-basilea/ricerca-genitori-...`
 // with no in-canton match surfaces matches from other cantons under a
 // "no in-canton results" banner. Populated only via the legacy path; when
 // shards land it'll need a separate aggregator fetch (deferred).
 const [unscopedJobs, setUnscopedJobs] = useState<JobListing[]>([]);
 // Tier 4 (cross-locale) pool: lazily loaded slim indexes for the locales the
 // user is NOT currently browsing. Activates only when Tiers 1-3 all return
 // zero so the search box never returns "0 risultati" while jobs in other
 // locale corpora (DE/FR/EN titles for the same canton) would have matched.
 // Same slug + canonical job id across locale shards, so the displayed result
 // is the IT-locale record when available (see crossLocaleFetchAttempted).
 const [crossLocaleJobs, setCrossLocaleJobs] = useState<JobListing[]>([]);
 const crossLocaleFetchAttempted = useRef(false);
 // Company-hub broadening: when a company-filtered URL (e.g.
 // /cerca-lavoro-ticino/azienda-grace-la-margna-st-moritz/) has zero matches
 // in the canton-scoped shard — because the employer's HQ is in another
 // canton (Grace La Margna → GR) — we lazy-load the locale-wide pool so the
 // company-broadening tier can surface its openings Switzerland-wide instead
 // of rendering the empty-state. One-shot per mount.
 const companyBroadenFetchAttempted = useRef(false);
 // Search-broaden: when a canton-scoped SEARCH yields a thin in-canton set
 // (< BROADEN_BELOW) we lazy-load the locale-wide pool so the cross-canton tier
 // can fill the page. Closes the gap left by `unscopedJobs` (populated only via
 // the legacy path) for the healthy-shard search case. One-shot per mount.
 const searchBroadenFetchAttempted = useRef(false);
 const [jobsLoading, setJobsLoading] = useState(true);
 // In-flight count of the lazy broaden / cross-locale fallback fetches. A thin
 // canton-scoped search/company page reads `filteredJobs.length === 0` after the
 // initial index loads, then bumps to the real count once these pools land — so
 // while any are pending we show a loading state instead of the "0 / no results"
 // flash. Incremented when a fetch starts, decremented when it settles.
 const [pendingFallbacks, setPendingFallbacks] = useState(0);
 // True until the AUTHORITATIVE full job index has landed. On aggregate / TI
 // routes a tiny first-page slim payload paints early (jobsLoading flips false)
 // for a fast LCP. For a SEARCH/company view that provisional payload yields a
 // misleading count + fallback banner (e.g. "1 offerta", then "0", then "34")
 // before the real shard replaces it. The effect-level first-paint skip can miss
 // this on SSG hydration (the load effect runs before `searchQuery` syncs from
 // the slug), so we ALSO suppress at render: while this is true a search/company
 // view shows the loading skeleton instead of the provisional count + cards.
 const [fullLoadPending, setFullLoadPending] = useState(true);
 // Flips true only once the terminal cross-locale (Tier 4) fallback has fully
 // settled — i.e. AFTER its fetch + the (heavy, ~2s) parse/dedup of the en/de/fr
 // indexes AND `setCrossLocaleJobs`. Set in the same batch as the results, so
 // there is never a frame where it reads "settled" while the 0-result count is
 // still stale. A 0-result search holds the skeleton until this is true instead
 // of flashing "0 / no results" during the cross-locale processing window.
 const [crossLocaleSettled, setCrossLocaleSettled] = useState(false);
 // Flips true once the company-hub broadening (Tier 3.5) fallback has fully
 // settled — i.e. AFTER the locale-wide pool fetch + parse/dedup AND
 // `setUnscopedJobs`. Same batching guarantee as `crossLocaleSettled`: set in
 // the same batch as the results so there is never a frame where it reads
 // "settled" while the 0-result count is still stale. A company-only view (no
 // search) holds the skeleton until this is true instead of flashing "0 / no
 // results" during the pool-processing window.
 const [companyBroadenSettled, setCompanyBroadenSettled] = useState(false);
 const [enrichmentLoading, setEnrichmentLoading] = useState(false);
 // FRO-353: Feature flag for Job Alerts (controlled via Firebase Remote Config)
 const [enableJobAlerts, setEnableJobAlerts] = useState(false);
 useEffect(() => {
 resilientImport(() => import('@/services/firebase'), (m) => typeof m.getConfigValue === 'function').then(({ getConfigValue }) =>
 getConfigValue('ENABLE_JOB_ALERTS').then((v) => setEnableJobAlerts(v === 'true'))
 ).catch(() => {});
 }, []);
 // Job-detail alert prompt: gentle 1-tap subscription when a logged-in user
 // opens a single job detail. Post-auth prompts were removed 2026-05-19
 // (88% dismiss rate · 0 conversions in 30 days → dead weight); the
 // job-detail surface is now the only conversion path beyond the inline form.
 const [jobDetailPromptVisible, setJobDetailPromptVisible] = useState(false);
 // Post-apply in-page state (issues #5040 / #5039). `handleApply` hands the
 // user off to the employer's ATS in a NEW TAB and, until now, changed nothing
 // on our page: the visitor came back to a page that looked exactly as they had
 // left it, with no record that they had applied. That is also why PostHog
 // classified the apply click as a `$dead_click` — its heuristic calls a click
 // dead when no DOM mutation / scroll / selection follows within 2.5s, and a
 // `window.open` produces none. 805 of 1890 dead clicks over 14d (42.6%) carry
 // `$dead_click_visibility_changed_timeout`, the signature of exactly this
 // "click backgrounded the tab" pattern, and "Candidati" is the single largest
 // own-app cluster. Rendering real confirmation is the honest fix: the user
 // gets feedback, and the click stops being dead because the page genuinely
 // responded.
 const [appliedJobId, setAppliedJobId] = useState<string | null>(null);
 const [jobDetailPromptCategory, setJobDetailPromptCategory] = useState<string | null>(null);
 useEffect(() => {
 isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {});
 }, []);
 // Bridge-page guard (see readBridgeTargetSlug): on a job bridge page the URL
 // segment is the job's OLD slug, not a search keyword. 13 historic slugs start
 // with ricerca-/search-/suche-/recherche- (measured on prod 2026-08-07) and
 // would otherwise seed the search box, filtering the listing on a job URL.
 const [searchQuery, setSearchQuery] = useState(() => (readBridgeTargetSlug() ? null : parseSearchSlugFilter(initialJobSlug)) || readSearchQueryFromUrl());
 const deferredSearchQuery = useDeferredValue(searchQuery);
 // Search input is uncontrolled (defaultValue, no `value` prop): keystrokes paint
 // natively in the DOM with zero React involvement, so typing never waits on this
 // ~8500-line monolith's render (profiled at 400-500ms/keystroke under throttled
 // CPU — one giant Fiber, no child boundary to interrupt mid-render). `searchQuery`
 // itself only updates 200ms after typing pauses, driving the (already-deferred)
 // filtering and secondary chrome (clear button, chip highlight). Non-typing
 // writers (chips, clear button, autocomplete, URL sync) go through
 // `applySearchQuery` so a stale pending debounce can't clobber their change; the
 // sync effect below reflects any of these back into the input's DOM value.
 const applySearchQuery = useCallback((value: React.SetStateAction<string>) => {
 if (searchDebounceTimerRef.current) {
 clearTimeout(searchDebounceTimerRef.current);
 searchDebounceTimerRef.current = null;
 }
 setSearchQuery(value);
 }, []);
 useEffect(() => {
 return () => {
 if (searchDebounceTimerRef.current) clearTimeout(searchDebounceTimerRef.current);
 };
 }, []);
 useEffect(() => {
 if (searchInputRef.current && searchInputRef.current.value !== searchQuery) {
 searchInputRef.current.value = searchQuery;
 }
 }, [searchQuery]);
 // Post-auth prompt trigger effect: see definition below, after
 // `bestRelatedSearchKeyword` is in scope (needs selectedJob + sortedJobs +
 // indexedQueryMatch, all declared further down).
 const [selectedCategory, setSelectedCategory] = useState<JobCategory | 'all'>('all');
 const [selectedContract, setSelectedContract] = useState<ContractType | 'all'>('all');
 const [selectedCompany, setSelectedCompany] = useState<string>('all');
 const [selectedDateRange, setSelectedDateRange] = useState<DateRange>('all');
 const [selectedLocation, setSelectedLocation] = useState<string>('all');
 const [selectedSector, setSelectedSector] = useState<string>('all');
 const [showNewOnly, setShowNewOnly] = useState(false);
 // INP: defer the filter atoms that feed the heavy job-filtering memos, exactly
 // as `deferredSearchQuery` defers the search box. A filter chip/dropdown click
 // updates the urgent atom (so the control's active highlight + the active-count
 // badge repaint instantly) while the expensive re-filter+re-render of the whole
 // jobs corpus runs in a non-blocking transition. Without this, every filter
 // click synchronously re-ran all five filter tiers before the next paint —
 // field p75 INP on the job board was 336ms (mobile 416ms). The deferred values
 // converge to the urgent ones within a frame, so the rendered output is byte-
 // identical; only the paint is unblocked. Feed these ONLY into the filter memos
 // below (via passingNonSearchFilters + the cutoff), never into UI-state reads.
 const deferredSelectedCategory = useDeferredValue(selectedCategory);
 const deferredSelectedContract = useDeferredValue(selectedContract);
 const deferredSelectedCompany = useDeferredValue(selectedCompany);
 const deferredSelectedDateRange = useDeferredValue(selectedDateRange);
 const deferredSelectedLocation = useDeferredValue(selectedLocation);
 const deferredSelectedSector = useDeferredValue(selectedSector);
 const deferredShowNewOnly = useDeferredValue(showNewOnly);
 // ── Saved jobs (#4466) + alert nudge (#4467) ──
 // localStorage-first list; loaded in a post-mount effect (same INP pattern
 // as behaviorData below) and kept in sync across surfaces via the
 // SAVED_JOBS_CHANGED_EVENT window event dispatched by the service.
 const [savedJobs, setSavedJobs] = useState<SavedJobEntry[]>([]);
 const [showSavedOnly, setShowSavedOnly] = useState(false);
 const deferredShowSavedOnly = useDeferredValue(showSavedOnly);
 // Account-gating follow-up: saving now requires a real Firebase login (no
 // anonymous/email-capture fallback). An anonymous tap stashes the pending
 // action here and opens SaveSignInPromptModal; the effect below replays it
 // once authUser.uid becomes truthy.
 const [saveAuthPromptOpen, setSaveAuthPromptOpen] = useState(false);
 const [savedNudge, setSavedNudge] = useState<{ categoryLabel: string; cantonCode: string | null; savedCount: number; category: string } | null>(null);
 // Once per SPA session: never re-arm the nudge after any show/dismiss cycle.
 const savedNudgeArmedRef = useRef(false);
 const [filtersExpanded, setFiltersExpanded] = useState(false);
 const searchInputRef = useRef<HTMLInputElement>(null);
 const searchDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
 const [linkedInAvailable, setLinkedInAvailable] = useState(false);
 const modalGoogleButtonRef = useRef<HTMLDivElement | null>(null);
 const inlineGoogleButtonRef = useRef<HTMLDivElement | null>(null);
 const authUnlockCandidateRef = useRef<string | null>(null);
 const wasLoggedInRef = useRef(isLoggedIn);
 // Job id whose detail was just unlocked by a fresh social (Google/FB) auth.
 // The job-detail alert prompt fires immediately (delay 0) for this job —
 // it's the highest-intent moment (the user just authed to read THIS job),
 // so we don't wait out the dwell timer before offering the one-tap alert.
 const justAuthedJobIdRef = useRef<string | null>(null);

 // ── Personalization: behavior data + derived state ──
 const [behaviorData, setBehaviorData] = useState<BehaviorData | null>(null);
 const [newJobsDismissed, setNewJobsDismissed] = useState(false);
 const [jobMatchProfile, setJobMatchProfile] = useState<JobMatchProfileData | null>(null);
 // INP: behaviorData/jobMatchProfile land via a post-mount effect (localStorage
 // read), not a user interaction — but every memo below that consumes them
 // re-scores the full loaded job list (up to ~12k on the Switzerland-wide
 // aggregator) via computePersonalScore. If that recompute lands while the
 // user taps a job card or filter, the click's own processing queues behind
 // it, inflating that unrelated interaction's INP (field p75 2064ms on
 // /cerca-lavoro-svizzera/, #4302). Deferring these enhancement-only inputs
 // lets React schedule the rescoring at low priority so it yields to a
 // concurrent click instead of blocking it — output is unchanged, only the
 // scheduling shifts.
 const deferredBehaviorData = useDeferredValue(behaviorData);
 const deferredJobMatchProfile = useDeferredValue(jobMatchProfile);
 const deferredUserProfile = useDeferredValue(userProfile);
 // Job-popularity map, fetched instead of bundled (#5001 — see
 // services/jobPopularityService.ts for the measurement that motivated it).
 // Starts as the frozen empty map: getTrendingByLocation() returns [] for it
 // and TrendingSection only renders at 3+ matches, so the pre-load state is
 // simply "no trending strip yet" — the same thing an offline user already saw.
 const [popularity, setPopularity] = useState<Record<string, number>>(EMPTY_JOB_POPULARITY);
 // Deferred for the same reason as the three values above (#4302): it is an
 // enhancement-only input that lands via a post-mount effect, and its arrival
 // re-runs getTrendingByLocation over the whole loaded list. Deferring lets
 // React yield that recompute to a concurrent tap instead of queueing the tap
 // behind it. Output unchanged, only the scheduling.
 const deferredPopularity = useDeferredValue(popularity);

 // Fetch it at idle, and only when personalization is on — it feeds nothing
 // else. Deferring past the authoritative job index keeps it from competing
 // with the listing paint. Mirrors the requestIdleCallback+timeout fallback
 // used by the seeded-detail index load below.
 useEffect(() => {
 if (!enablePersonalization) return;
 let cancelled = false;
 const start = (): void => {
 loadJobPopularity()
 .then((data) => {
 if (cancelled) return;
 // Keep the frozen empty map on a miss so memo deps stay stable.
 if (Object.keys(data).length > 0) setPopularity(data);
 })
 .catch(() => { /* loadJobPopularity never rejects; belt-and-braces */ });
 };
 const w = window as unknown as {
 requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
 cancelIdleCallback?: (handle: number) => void;
 };
 if (typeof w.requestIdleCallback === 'function') {
 const handle = w.requestIdleCallback(start, { timeout: 5000 });
 return () => { cancelled = true; w.cancelIdleCallback?.(handle); };
 }
 const timer = setTimeout(start, 2000);
 return () => { cancelled = true; clearTimeout(timer); };
 }, [enablePersonalization]);

 // Load behavior data on mount and update last visit
 useEffect(() => {
 if (!enablePersonalization) return;
 const data = getBehaviorData();
 setBehaviorData(data);
 updateLastVisit();
 }, [enablePersonalization]);

 // Load survey-derived job-match profile (sector/canton/experience level).
 // Independent of behaviorData: a user who only completed SalarySurvey (no
 // browsing history yet) still gets ranked/filtered results.
 useEffect(() => {
 if (!enablePersonalization) return;
 setJobMatchProfile(loadJobMatchProfile());
 }, [enablePersonalization]);

 // Saved jobs (#4466): post-mount localStorage read (INP pattern above) +
 // re-read on every mutation broadcast by services/savedJobsService.ts, so
 // the list card stars, the detail chip and the filter-pill counter stay in
 // sync no matter which surface toggled the save.
 useEffect(() => {
 setSavedJobs(loadSavedJobs());
 const onChanged = () => setSavedJobs(loadSavedJobs());
 window.addEventListener(SAVED_JOBS_CHANGED_EVENT, onChanged);
 return () => window.removeEventListener(SAVED_JOBS_CHANGED_EVENT, onChanged);
 }, []);

 const savedJobIds = useMemo(() => new Set(savedJobs.map((entry) => entry.id)), [savedJobs]);

 const performToggleSave = useCallback((job: JobListing, surface: 'list' | 'detail', uid: string) => {
 const result = toggleSavedJob({
 id: job.id,
 slug: job.slug ?? null,
 title: job.title,
 company: job.company,
 canton: job.canton ?? null,
 category: job.category ?? null,
 }, uid);
 Analytics.trackEvent(result === 'saved' ? 'job_saved' : 'job_unsaved', {
 job_id: job.id,
 job_canton: job.canton || '(none)',
 job_category: job.category || '(none)',
 job_company: job.company || '(none)',
 surface,
 });
 }, []);

 // Account-gating (#4466 follow-up): anonymous tap never writes — stash the
 // pending job in services/pendingSaveJob.ts (localStorage, survives a
 // magic-link email opened in a brand new tab) + open the sign-in modal.
 // The authUser?.uid replay effect below fires the actual save once sign-in
 // completes, in THIS tab or a fresh one.
 const handleToggleSave = useCallback((job: JobListing, surface: SaveJobSurface = 'list') => {
 const uid = authUser?.uid ?? null;
 if (!uid) {
 savePendingSaveJobIntent({
 kind: 'save_job',
 entry: {
 id: job.id,
 slug: job.slug ?? null,
 title: job.title,
 company: job.company,
 canton: job.canton ?? null,
 category: job.category ?? null,
 },
 surface,
 });
      // AUTH_GATE priority preempts the (lower-priority) newsletter
      // popup — without a queue slot, NewsletterPopup's own timer/
      // exit-intent trigger can claim the empty queue and render its
      // full-screen overlay on top of this modal.
      requestSlot('save-auth-prompt', POPUP_PRIORITY.AUTH_GATE);
 setSaveAuthPromptOpen(true);
 Analytics.trackEvent('save_signin_prompt_shown', { job_id: job.id, surface });
 return;
 }
 performToggleSave(job, surface, uid);
 }, [authUser?.uid, performToggleSave]);

 const handleToggleSaveFromList = useCallback(
 (job: JobListing) => handleToggleSave(job, 'list'),
 [handleToggleSave],
 );

 // Replays a pending save-job intent (bookmark tap) or opens the saved-only
 // filter (pill tap) whenever authUser?.uid becomes truthy. Gated ONLY on
 // uid — NOT on saveAuthPromptOpen — because the email magic-link path can
 // complete sign-in in a brand new tab where the modal was never rendered;
 // services/pendingSaveJob.ts (localStorage), not this component's own
 // state, is what survives that round-trip. ensureSavedJob (not
 // toggleSavedJob) is used so a second tab replaying the same intent around
 // the same time can't race a genuine toggle back off.
 useEffect(() => {
 const uid = authUser?.uid;
 if (!uid) return;
      releaseSlot('save-auth-prompt');
 setSaveAuthPromptOpen(false);
 const intent = consumePendingSaveJobIntent();
 if (!intent) return;
 if (intent.kind === 'save_job') {
 Analytics.trackEvent('save_signin_prompt_completed', { job_id: intent.entry.id, surface: intent.surface });
 const result = ensureSavedJob(intent.entry, uid);
 if (result === 'saved') {
 Analytics.trackEvent('job_saved', {
 job_id: intent.entry.id,
 job_canton: intent.entry.canton || '(none)',
 job_category: intent.entry.category || '(none)',
 job_company: intent.entry.company || '(none)',
 surface: intent.surface,
 });
 }
 } else {
 Analytics.trackEvent('save_signin_prompt_completed', { surface: 'saved_filter_pill' });
 setShowSavedOnly(true);
 }
 }, [authUser?.uid]);

 // Dismiss only closes the modal — it does NOT clear the pending intent.
 // The email path is inherently async (the link may be clicked later, in
 // another tab); closing the "check your email" card isn't abandonment.
 // The 15-minute TTL in pendingSaveJob.ts handles true abandonment.
 const handleSaveAuthPromptDismiss = useCallback(() => {
 const intent = peekPendingSaveJobIntent();
 Analytics.trackEvent(
 'save_signin_prompt_dismissed',
 intent?.kind === 'save_job' ? { job_id: intent.entry.id, surface: intent.surface } : { surface: 'saved_filter_pill' },
 );
      releaseSlot('save-auth-prompt');
 setSaveAuthPromptOpen(false);
 }, []);

 // Track filter usage changes
 useEffect(() => {
 if (!enablePersonalization) return;
 if (selectedCategory !== 'all') trackFilterUsage('category', selectedCategory);
 }, [enablePersonalization, selectedCategory]);
 useEffect(() => {
 if (!enablePersonalization) return;
 if (selectedLocation !== 'all') trackFilterUsage('location', selectedLocation);
 }, [enablePersonalization, selectedLocation]);
 useEffect(() => {
 if (!enablePersonalization) return;
 if (selectedContract !== 'all') trackFilterUsage('contract', selectedContract);
 }, [enablePersonalization, selectedContract]);

 // Track search queries (debounced via deferredSearchQuery)
 useEffect(() => {
 if (!enablePersonalization || !deferredSearchQuery.trim()) return;
 trackSearchBehavior(deferredSearchQuery.trim(), 0);
 setBehaviorData(getBehaviorData());
 }, [enablePersonalization, deferredSearchQuery]);

 // New jobs counter
 // computeNewJobsCount + the personal-score filter below iterate the full
 // job list — deferred so a behaviorData/jobMatchProfile update from the
 // post-mount effect doesn't block a concurrent click (see deferred* comment
 // above).
 const newJobsInfo = useMemo(() => {
 if (!enablePersonalization || !deferredBehaviorData) return { total: 0, matching: 0 };
 const lastVisit = getLastVisitTimestamp();
 return computeNewJobsCount(jobs, lastVisit, deferredBehaviorData, deferredUserProfile ?? null, deferredJobMatchProfile);
 }, [enablePersonalization, deferredBehaviorData, jobs, deferredUserProfile, deferredJobMatchProfile]);

 // Trending jobs for user's location
 const userLocation = userProfile?.municipality ?? null;
 const trendingJobs = useMemo(() => {
 if (!enablePersonalization) return [];
 return getTrendingByLocation(jobs, deferredPopularity, userLocation);
 }, [enablePersonalization, jobs, deferredPopularity, userLocation]);

 // Count of jobs whose personal score is boosted by any signal (behavior,
 // tax/onboarding profile, or job-match survey profile). Feeds both the
 // "Personalizzato per te" pill and the job_match_impression analytics event.
 const matchedJobCount = useMemo(() => {
 if (!enablePersonalization || !deferredBehaviorData) return 0;
 return jobs.filter((j) => computePersonalScore(j, deferredBehaviorData, deferredUserProfile ?? null, deferredJobMatchProfile).score > 0).length;
 }, [enablePersonalization, deferredBehaviorData, jobs, deferredUserProfile, deferredJobMatchProfile]);

 // Whether personalization is actively changing sort order (any job scored > 0)
 const isPersonalizationActive = matchedJobCount > 0;

 // Analytics: track personalization state
 useEffect(() => {
 if (!enablePersonalization || !behaviorData) return;
 if (isPersonalizationActive) {
 Analytics.trackSelectContent('personalization_active', 'job_board');
 Analytics.trackJobMatchImpression(matchedJobCount);
 } else if (behaviorData.viewedJobs.length === 0 && behaviorData.searches.length === 0) {
 Analytics.trackSelectContent('personalization_cold_start', 'job_board');
 }
 }, [enablePersonalization, isPersonalizationActive, behaviorData, matchedJobCount]);

 // Analytics: track new jobs banner shown
 useEffect(() => {
 if (!enablePersonalization || newJobsDismissed || newJobsInfo.total <= 0) return;
 Analytics.trackSelectContent('new_jobs_banner_shown', `total:${newJobsInfo.total}_matching:${newJobsInfo.matching}`);
 }, [enablePersonalization, newJobsInfo.total, newJobsInfo.matching, newJobsDismissed]);

 // Apply filter params from SiteSearch navigation (location, search query)
 useEffect(() => {
 if (!initialFilterParams) return;
 if (initialFilterParams.location) {
 setSelectedLocation(initialFilterParams.location);
 }
 if (initialFilterParams.query) {
 applySearchQuery(initialFilterParams.query);
 }
 // Signal to parent that params have been consumed so they aren't re-applied
 onFilterParamsConsumed?.();
 }, [initialFilterParams, onFilterParamsConsumed]);

 // Device breakpoints for conditional ad rendering (prevents CSS-hidden width=0 bug)
 const isMobile = useMediaQuery('(max-width: 767px)'); // md breakpoint
 const isDesktopLg = useMediaQuery('(min-width: 1024px)'); // lg breakpoint
 const isDesktopXl = useMediaQuery('(min-width: 1280px)'); // xl breakpoint

 // --- List state preservation across detail navigation ---
 const savedListState = useRef<{ page: number; scrollY: number } | null>(null);
 const skipPageReset = useRef(false);
 const prevSlugRef = useRef(initialJobSlug);

 // Restore page + scroll when returning from job detail to list
 useEffect(() => {
 const shouldRestore = shouldRestoreJobBoardListState(prevSlugRef.current, initialJobSlug);
 prevSlugRef.current = initialJobSlug;
 if (shouldRestore && savedListState.current) {
 const { page: savedPage, scrollY } = savedListState.current;
 skipPageReset.current = true;
 setPage(savedPage);
 savedListState.current = null;
 requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'instant' }));
 }
 }, [initialJobSlug]);

 // ⌘K / Ctrl+K keyboard shortcut to focus search
 useEffect(() => {
 const handler = (e: KeyboardEvent) => {
 if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
 e.preventDefault();
 searchInputRef.current?.focus();
 }
 };
 window.addEventListener('keydown', handler);
 return () => window.removeEventListener('keydown', handler);
 }, []);

 const activeFilterCount = useMemo(() => {
 let count = 0;
 if (searchQuery.trim()) count++;
 if (selectedCategory !== 'all') count++;
 if (selectedContract !== 'all') count++;
 if (selectedCompany !== 'all') count++;
 if (selectedDateRange !== 'all') count++;
 if (selectedLocation !== 'all') count++;
 if (selectedSector !== 'all') count++;
 if (showNewOnly) count++;
 if (showSavedOnly) count++;
 return count;
 }, [searchQuery, selectedCategory, selectedContract, selectedCompany, selectedDateRange, selectedLocation, selectedSector, showNewOnly, showSavedOnly]);

 const resetAllFilters = useCallback(() => {
 applySearchQuery('');
 setSelectedCategory('all');
 setSelectedContract('all');
 setSelectedCompany('all');
 setSelectedDateRange('all');
 setSelectedLocation('all');
 setSelectedSector('all');
 setShowNewOnly(false);
 setShowSavedOnly(false);
 }, []);
 const [page, setPage] = useState(() => readPageFromUrl());
 // Salary-range filter from the calculator's reverse bridge (issue #4307).
 const [salaryRangeFilter, setSalaryRangeFilter] = useState(() => readSalaryRangeFromUrl());
 const clearSalaryRangeFilter = useCallback(() => {
 setSalaryRangeFilter({ min: null, max: null });
 syncQueryParamsToUrl({ salarioMin: null, salarioMax: null });
 }, []);
 // Counter incremented on page/search changes to force ad slot remount
 const [adRefreshKey, setAdRefreshKey] = useState(0);
 // Mobile load-more: accumulate jobs instead of paginating
 const [mobileJobLimit, setMobileJobLimit] = useState(10);
 const [authGateOpen, setAuthGateOpen] = useState(false);
 const [pendingJob, setPendingJob] = useState<JobListing | null>(null);
 const [authBusy, setAuthBusy] = useState<'google' | 'facebook' | 'email' | 'linkedin' | null>(null);
 const [authError, setAuthError] = useState<string | null>(null);
 const [authNotice, setAuthNotice] = useState<{ kind: 'pending'; email: string } | null>(null);
 const [modalGoogleButtonReady, setModalGoogleButtonReady] = useState(false);
 const [inlineGoogleButtonReady, setInlineGoogleButtonReady] = useState(false);
 const [emailInput, setEmailInput] = useState('');
 const [emailAccessGranted, setEmailAccessGranted] = useState(
 () => !!localStorage.getItem(JOB_EMAIL_ACCESS_KEY)
 );
 // One home for the crawler pattern (#5705): functions/src/lib/returnVisit.js.
 // The identical regex used to sit here and in NewsletterPopup.tsx, and the
 // return-visit rule that decides whether a decayed job alert comes back must
 // give the same verdict as the gate that lets a crawler read the board.
 const isCrawlerVisitor = useMemo(() => isCrawlerVisitorAgent(navigator.userAgent || ''), []);
 const authResolved = !authLoading;
 const hasAccess = isLoggedIn || emailAccessGranted || isCrawlerVisitor;

 // A save tapped on the GATE, then unlocked by the email-capture form instead
 // of by signing in. `emailAccessGranted` grants access with NO Firebase uid,
 // so the replay effect above — correctly gated on uid, since `ensureSavedJob`
 // cannot write without one — never fires, and the intent would sit in
 // localStorage until its 15-minute TTL while the now-unlocked header shows
 // the bookmark as un-saved. The reader tapped save and nothing happened.
 // Re-ask instead of dropping it: the modal is the same one their tap opened,
 // and this is the moment it can actually be satisfied. Once per mount — a
 // ref, not state, so re-asking cannot loop through its own re-render.
 const gateSaveReaskedRef = useRef(false);
 useEffect(() => {
 if (!hasAccess || authUser?.uid || gateSaveReaskedRef.current) return;
 const intent = peekPendingSaveJobIntent();
 if (intent?.kind !== 'save_job' || intent.surface !== 'detail_gate') return;
 gateSaveReaskedRef.current = true;
 requestSlot('save-auth-prompt', POPUP_PRIORITY.AUTH_GATE);
 setSaveAuthPromptOpen(true);
 Analytics.trackEvent('save_signin_prompt_shown', { job_id: intent.entry.id, surface: 'detail_gate_unlocked' });
 }, [hasAccess, authUser?.uid]);
 // Bridge detection: the plugin writes window.__BRIDGE_TARGET_SLUG__ in the static HTML for old URLs.
 // Hoisted above the slug-filter memos below: its presence is the authoritative
 // "this URL is a JOB page, not a filter landing" signal, and they need it.
 // Deps on `seedPathname`, NOT `[initialJobSlug]` and NOT `[]`: its guard
 // (readBridgeTargetSlug -> onSeededDocument) compares PATHNAMES, and
 // `initialJobSlug` can stay equal across two different pathnames (a bridge
 // page and a search-cluster page can share a slug — see the previousSlugs
 // alias comment below). A slug-keyed memo would then pin the bridge slug of
 // the page we arrived on across a soft-navigation the guard is meant to
 // catch. Same fix, same reason as `seededJob`/`clusterSeed` above.
 const bridgeTargetSlug = useMemo(() => readBridgeTargetSlug(), [seedPathname]);

 // A bridge page IS a job page. Its URL is a job's OLD slug, and a handful of
 // those old slugs happen to start with a filter-landing prefix — measured on
 // prod 2026-08-07: 8 aliases start with azienda-/company-/unternehmen-/entreprise-
 // and 13 with ricerca-/search-/suche-/recherche-. Parsing them as company /
 // location / search landings sends an INDEXED URL to the wrong page.
 //
 // `parseCompanySlugFilter` used to catch the company ones by scanning
 // `jobs[].previousSlugs`, but the slim index no longer carries that field
 // (build-plugins/shared/slimJobIndex.ts). `parseSearchSlugFilter` never had
 // the guard at all, so the 13 search-prefixed aliases mis-parsed already —
 // same class of bug, closed here in the same PR (AGENTS.md §6).
 //
 // The build-injected global is the right signal: synchronous, present at
 // first paint, and set by the very plugin that emits the bridge page.
 const isBridgePage = !!bridgeTargetSlug;

 const companySlugFilter = useMemo(() => {
  if (isBridgePage) return null;
  const filter = parseCompanySlugFilter(initialJobSlug, jobs);
  if (!filter) return null;
  // If the build plugin seeded expired data specifically for this slug, the URL is
  // an expired job page — not a company filter page. This catches expired jobs whose
  // company name starts with "azienda-" etc. The slug-specific match prevents stale
  // window globals from a previous SPA navigation triggering a false positive.
  if (initialJobSlug && seededJobMatchesSlug(initialJobSlug)) return null;
  return filter;
 }, [initialJobSlug, jobs, isBridgePage]);
 const locationSlugFilter = useMemo(
 () => (isBridgePage ? null : parseLocationSlugFilter(initialJobSlug)),
 [initialJobSlug, isBridgePage],
 );
 const searchSlugFilter = useMemo(
 () => (isBridgePage ? null : parseSearchSlugFilter(initialJobSlug)),
 [initialJobSlug, isBridgePage],
 );
 // Title-cased search keyword for the search-landing H1 (e.g. "verkaufsberater
 // in tessin" → "Verkaufsberater In Tessin"). Keeps the keyword in the H1 after
 // hydration instead of falling back to the generic job-board title.
 const searchHeadingQuery = useMemo(
 () => (searchSlugFilter ? searchSlugFilter.replace(/(^|\s)(\p{L})/gu, (_m, p, c) => p + c.toUpperCase()) : ''),
 [searchSlugFilter],
 );

 useEffect(() => {
 const syncFromUrl = () => {
 // Same bridge-page guard as `searchSlugFilter` above (the third call site of
 // parseSearchSlugFilter): on a job bridge page the URL segment is a job's old
 // slug, not a search keyword, so it must not become the search query.
 const next = (isBridgePage ? null : parseSearchSlugFilter(initialJobSlug)) || readSearchQueryFromUrl();
 applySearchQuery((prev) => (prev === next ? prev : next));
 setPage(readPageFromUrl());
 setAdRefreshKey((k) => k + 1);
 };
 window.addEventListener('popstate', syncFromUrl);
 return () => window.removeEventListener('popstate', syncFromUrl);
 }, [initialJobSlug, isBridgePage]);

 useEffect(() => {
 const next = searchSlugFilter || readSearchQueryFromUrl();
 applySearchQuery((prev) => (prev === next ? prev : next));
 }, [searchSlugFilter, initialJobSlug]);

 /**
 * Initial-mount data load (D9 + D11 + E4).
 *
 * Source of truth migrated from monolithic `/data/jobs.json` → per-canton
 * shards via `services/jobsService.ts`. Shards carry raw Job objects without
 * locale-translated fields, so when (a) the shard pipeline is not yet
 * deployed for this build, or (b) the chosen shards return zero jobs, we
 * fall back to the legacy locale-aware loader (`fetchAllJobs()` / the slim
 * index files) which preserves existing UX during the rollout window.
 *
 * D11 — referrer-aware default canton:
 *   - referrer contains "frontaliere" → start on TI shard (single fetch).
 *   - otherwise → multi-canton aggregate across the top 8 Swiss cantons.
 *
 * Cancellation: the effect aborts state writes when `cancelled` flips to
 * true, so a locale change mid-flight cannot stomp the next load.
 */
 useEffect(() => {
 let cancelled = false;
 // Fresh load for this locale/canton → the authoritative index is pending again.
 setFullLoadPending(true);

 /** Top-N cantons fetched when no canton intent is detected (req #4). */
 const TOP_AGGREGATE_CANTONS: ReadonlyArray<string> = [
 'TI', 'GR', 'VS', 'ZH', 'BE', 'BS', 'GE', 'VD',
 ];

 /**
 * First-page slim asset (#2580): the first ~50 records of the slim index,
 * a tiny payload that lets page-1 cards paint immediately instead of waiting
 * on the ~1.9 MB full index + the synchronous normalize of all ~5.5k records.
 * Returns null on any miss (asset CDN-offloaded / 404 / parse error) so the
 * caller falls straight through to the full index — graceful degradation, no
 * hard dependency on the new asset existing.
 */
 const loadFirstPageSlim = async (): Promise<JobListing[] | null> => {
 try {
 const res = await fetch(cdnDataUrl(`/data/${firstPageIndexFileName(locale)}`));
 if (!res.ok) return null;
 const data = (await res.json()) as unknown;
 if (!Array.isArray(data) || data.length === 0) return null;
 return data as JobListing[];
 } catch {
 return null;
 }
 };

 /** Legacy slim-index fallback (FRO-386). The full `jobs-{locale}.json`
  * monolith tier was removed (its descriptions duplicated job-detail and are
  * never needed for listing); the slim index is now the sole listing source. */
 const loadLegacyLocaleJobs = async (): Promise<JobListing[]> => {
 const slimIndexUrl = `/data/jobs-${locale}-index.json`;
 try {
 const res = await fetch(cdnDataUrl(slimIndexUrl));
 if (res.ok) return (await res.json()) as JobListing[];
 throw new Error(`slim index ${res.status}`);
 } catch {
 // One discrete retry of the slim index (fetchAllJobs hits the same file)
 // so a transient 5xx doesn't cascade into a hard empty-listing failure.
 try {
 const all = (await fetchAllJobs(locale)) as unknown as JobListing[];
 return Array.isArray(all) ? all : [];
 } catch {
 return [];
 }
 }
 };

 const finalize = (raw: ReadonlyArray<JobListing>, unscopedRaw?: ReadonlyArray<JobListing>): void => {
 if (cancelled) return;
 const normalized = raw.map((job) => normalizeIncomingJob(job));
 const deduped = dedupeJobsForListing(normalized);
 // Re-apply any per-job detail already fetched (e.g. enriched onto the seeded
 // record before this full-index load landed) so replacing `jobs` doesn't drop it.
 const reEnriched = resolvedJobDetail.size === 0
 ? deduped
 : deduped.map((j) => {
 const d = j.id ? resolvedJobDetail.get(j.id) : undefined;
 return d ? { ...j, ...d } : j;
 });
 // Keep the build-seeded detail job if the loaded shard doesn't contain it
 // (cross-shard / bridge target): otherwise replacing `jobs` would null out
 // `selectedJob` and flash JobOrphanView at the jobsLoading===false boundary.
 let finalJobs: JobListing[] = reEnriched;
 if (seededJob?.id && !reEnriched.some((j) => j.id === seededJob.id)) {
 const d = resolvedJobDetail.get(seededJob.id);
 finalJobs = [d ? { ...seededJob, ...d } : seededJob, ...reEnriched];
 }
 setJobs(finalJobs);
 registerJobSlugMap(finalJobs);
 // Capture the unscoped pool for cross-canton fallback when canton-scoped
 // searches return zero. Same normalize+dedupe so cross-canton matches share
 // the JobListing shape downstream consumers expect.
 if (unscopedRaw && unscopedRaw.length > 0) {
 const normalizedFull = unscopedRaw.map((job) => normalizeIncomingJob(job));
 setUnscopedJobs(dedupeJobsForListing(normalizedFull));
 }
 setJobsLoading(false);
 };

 const run = async (): Promise<void> => {
 // P7.2 — URL-driven canton pre-filter takes precedence over
 // referrer-based default. /cerca-lavoro-zurigo/ → ZH shard;
 // /cerca-lavoro-svizzera/ → AGGREGATE; legacy /cerca-lavoro-ticino/
 // → TI (router sets jobBoardCanton:'TI' explicitly per P7.1).
 // Hoisted above try/catch so the catch block can scope its legacy
 // fallback to the same canton.
 const targetCanton = initialFilterCanton || getDefaultCantonForVisit();

 // Wrap the whole load so `fullLoadPending` clears once the authoritative
 // index settles via ANY exit (full shard, legacy fallback, empty-legacy
 // early-return, or error) — never on the provisional first-page paint below.
 try {
 // First-page fast paint (#2580): on listing routes (no build-time seed),
 // fetch the tiny first-page slim asset first and paint page-1 cards before
 // the full index lands. The full load below still runs and replaces `jobs`
 // with the complete (canton-scoped) set + the unscoped cross-canton pool, so
 // pagination/filtering/cross-canton search are unaffected. Best-effort: any
 // miss (asset 404 / parse) leaves `jobsLoading` true and the full path takes
 // over normally. Skipped for canton-scoped pages other than TI because the
 // first-page asset is recency-ordered/TI-dominant — painting it for, say,
 // /cerca-lavoro-zurigo/ would flash mostly-TI cards before the scoped set.
 //
 // Also skipped for any FILTERED view (active search / company / location) or
 // EDITORIAL LANDING (e.g. /cerca-lavoro-ticino/ultimi-3-giorni/, today landing): the
 // slim first-page is a recency-ordered generic payload, so filtering it (or rendering
 // it under an editorial subset) yields a misleading provisional count + fallback
 // banner (e.g. "1 offerta", then "0", then the real "34") before the authoritative
 // shard lands. (editorialLandingDescriptor is declared below via useMemo; this effect
 // closure reads it after render, so it is bound.) Holding the
 // jobsLoading skeleton (hero + skeleton cards, same LCP element) until the full
 // load is cleaner and avoids that flash; the unfiltered listing keeps the paint.
 const firstPaintEligible =
 !seededJob &&
 !searchQuery.trim() && !companySlugFilter && !locationSlugFilter && !editorialLandingDescriptor &&
 (targetCanton === AGGREGATE_CANTON_CODE || targetCanton === 'TI');
 if (firstPaintEligible) {
 const firstPage = await loadFirstPageSlim();
 if (firstPage && !cancelled) {
 finalize(scopeJobsToCanton(firstPage, targetCanton));
 }
 }

 try {
 const shardJobs: RawJob[] =
 targetCanton === AGGREGATE_CANTON_CODE
 ? await fetchAggregatedJobs(TOP_AGGREGATE_CANTONS, locale, { deduplicate: true })
 : await fetchJobsForCanton(targetCanton, locale);

 // Shards not yet deployed (every shard 404'd / empty) → legacy loader.
 // The legacy payload is the locale-wide monolith (~13 MB, all 26 cantons
 // mixed, TI-dominant). Without a post-filter the canton SERP degenerates
 // to a TI-biased listing — visible on every non-TI /cerca-lavoro-{canton}/
 // page until shards land. Aggregator keeps the full list.
 if (shardJobs.length === 0) {
 const legacy = await loadLegacyLocaleJobs();
 const legacyArr = Array.isArray(legacy) ? legacy : [];
 // legacyArr is the unscoped locale-wide pool. Pass it as the second
 // arg so the cross-canton fallback layer can search it when the
 // canton-scoped result set is empty (see `filteredJobs` cross-canton
 // tier). Only meaningful when targetCanton isn't the aggregator —
 // for the aggregator the scope IS already everywhere.
 const isAggregate = targetCanton === AGGREGATE_CANTON_CODE;
 finalize(
 scopeJobsToCanton(legacyArr, targetCanton),
 isAggregate ? undefined : legacyArr,
 );
 return;
 }

 finalize(shardJobs as unknown as JobListing[]);
 } catch (err: unknown) {
 // Service-level failure → try legacy path before giving up.
 console.warn('Failed to load jobs from shards:', err);
 reportCaughtError(err, 'jobBoard.loadJobs.shards');
 try {
 const legacy = await loadLegacyLocaleJobs();
 const legacyArr = Array.isArray(legacy) ? legacy : [];
 const isAggregate = targetCanton === AGGREGATE_CANTON_CODE;
 finalize(
 scopeJobsToCanton(legacyArr, targetCanton),
 isAggregate ? undefined : legacyArr,
 );
 } catch (legacyErr: unknown) {
 console.warn('Legacy locale-jobs fallback also failed:', legacyErr);
 reportCaughtError(legacyErr, 'jobBoard.loadJobs.legacy');
 if (!cancelled) setJobsLoading(false);
 }
 }
 } finally {
 // Authoritative index settled (or failed) — the count is no longer
 // provisional, so search/company views can stop holding the skeleton.
 if (!cancelled) setFullLoadPending(false);
 }
 };

 // On a seeded detail page (window.__JOB_SEED__) the first paint already has its
 // job, and the full canton index only powers below-the-fold related-jobs +
 // counters. Defer that fetch/parse to idle so it never competes with the detail
 // page's LCP/INP (#1516 item1). Listing routes have no seed → the index IS the
 // above-the-fold content → load it immediately. Mirrors the requestIdleCallback+
 // timeout fallback pattern used in hooks/useUIState.ts.
 if (seededJob) {
 const w = window as unknown as {
 requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
 cancelIdleCallback?: (handle: number) => void;
 };
 if (typeof w.requestIdleCallback === 'function') {
 const handle = w.requestIdleCallback(() => { if (!cancelled) void run(); }, { timeout: 3000 });
 return () => { cancelled = true; w.cancelIdleCallback?.(handle); };
 }
 const timer = setTimeout(() => { if (!cancelled) void run(); }, 200);
 return () => { cancelled = true; clearTimeout(timer); };
 }

 void run();
 return () => {
 cancelled = true;
 };
 }, [locale, initialFilterCanton]);

 const categories: { value: JobCategory | 'all'; labelKey: string }[] = [
 { value: 'all', labelKey: 'jobBoard.filter.all' },
 { value: 'tech', labelKey: 'jobBoard.filter.tech' },
 { value: 'finance', labelKey: 'jobBoard.filter.finance' },
 { value: 'health', labelKey: 'jobBoard.filter.health' },
 { value: 'engineering', labelKey: 'jobBoard.filter.engineering' },
 { value: 'admin', labelKey: 'jobBoard.filter.admin' },
 { value: 'hospitality', labelKey: 'jobBoard.filter.hospitality' },
 { value: 'sales', labelKey: 'jobBoard.filter.sales' },
 { value: 'other', labelKey: 'jobBoard.filter.other' },
 ];

 const contracts: { value: ContractType | 'all'; labelKey: string }[] = [
 { value: 'all', labelKey: 'jobBoard.contract.all' },
 { value: 'full-time', labelKey: 'jobBoard.contract.fullTime' },
 { value: 'part-time', labelKey: 'jobBoard.contract.partTime' },
 { value: 'temporary', labelKey: 'jobBoard.contract.temporary' },
 { value: 'contract', labelKey: 'jobBoard.contract.contract' },
 { value: 'internship', labelKey: 'jobBoard.contract.internship' },
 ];

 const dateRanges: { value: DateRange; labelKey: string }[] = [
 { value: 'all', labelKey: 'jobBoard.dateRange.all' },
 { value: '24h', labelKey: 'jobBoard.dateRange.24h' },
 { value: '3d', labelKey: 'jobBoard.dateRange.3d' },
 { value: '7d', labelKey: 'jobBoard.dateRange.7d' },
 { value: '30d', labelKey: 'jobBoard.dateRange.30d' },
 { value: '90d', labelKey: 'jobBoard.dateRange.90d' },
 ];

 const uniqueCompanies = useMemo(() => {
 const map = new Map<string, string>();
 for (const job of jobs) {
 const key = job.company.toLowerCase();
 if (!map.has(key)) map.set(key, job.company);
 }
 return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
 }, [jobs]);

 const uniqueLocalities = useMemo(() => {
 // Group localities by a diacritic/separator-insensitive key so spelling
 // variants (Zürich/Zurich, Genève/Geneve, Davos-Platz/Davos Platz) collapse
 // into a single option. `value` is the normalised key — the filter predicate
 // matches on the same key so the merged option still covers every variant.
 const groups = new Map<string, { count: number; spellings: Map<string, number> }>();
 for (const job of jobs) {
 const loc = (job.addressLocality || '').trim();
 if (loc && loc.length > 2) {
 const key = normalizeLocalityKey(loc);
 if (!key) continue;
 const g = groups.get(key) || { count: 0, spellings: new Map<string, number>() };
 g.count += 1;
 g.spellings.set(loc, (g.spellings.get(loc) || 0) + 1);
 groups.set(key, g);
 }
 }
 // Most common cities first; label = most frequent original spelling
 // (diacritic-bearing spelling wins ties so "Zürich" beats "Zurich").
 return Array.from(groups.entries())
 .sort((a, b) => b[1].count - a[1].count)
 .map(([value, g]) => {
 const label = Array.from(g.spellings.entries()).sort((a, b) => {
 if (b[1] !== a[1]) return b[1] - a[1];
 const aDia = a[0].normalize('NFD') !== a[0] ? 1 : 0;
 const bDia = b[0].normalize('NFD') !== b[0] ? 1 : 0;
 if (bDia !== aDia) return bDia - aDia;
 return a[0].localeCompare(b[0]);
 })[0][0];
 return { value, label };
 });
 }, [jobs]);

 const uniqueSectors = useMemo(() => {
 const counts = new Map<string, number>();
 for (const job of jobs) {
 const sec = (job.sector || '').trim();
 if (sec) {
 const key = sec.toLowerCase();
 counts.set(key, (counts.get(key) || 0) + 1);
 }
 }
 return Array.from(counts.entries())
 .sort((a, b) => b[1] - a[1])
 .map(([key]) => {
 const job = jobs.find(j => (j.sector || '').toLowerCase() === key);
 return job?.sector || key;
 });
 }, [jobs]);

 const editorialLandingDescriptor = useMemo(
 () => resolveEditorialJobLandingDescriptor(initialJobSlug || ''),
 [initialJobSlug],
 );

 // Historic-slug (previousSlugs) → canonical-slug resolution, resolved from the
 // SHARDED slug map rather than from the listing payload. The slim index no
 // longer carries `previousSlugs`/`previousSlugsByLocale` (they duplicated
 // /data/jobs-slug-map/{00..ff}.json and were 41,8% of jobs-it-index.json —
 // see build-plugins/shared/slimJobIndex.ts), so `matchesRouteSlug` alone can
 // no longer match a renamed job by its old slug. The bridge effect below
 // fetches the ~16 KB shard covering the route slug and records the mapping
 // here; `lookupSlug` then finds the job by its CURRENT slug.
 //
 // Stored as an {alias, canonical} pair rather than a bare string so a stale
 // value from a previous navigation can never be applied to a different slug
 // (no reset effect needed — the pair simply stops matching).
 //
 // NB this is the SECOND line of defence, not the first: a hard load of an
 // indexed legacy URL lands on the SSG bridge page, which already bakes
 // `window.__BRIDGE_TARGET_SLUG__` (bridgeTargetSlug) into the HTML. This tier
 // covers SPA soft-navigation to an old slug and any bridge page served
 // without that global.
 const [aliasCanonical, setAliasCanonical] = useState<{ alias: string; canonical: string } | null>(null);

 const selectedJob = useMemo(() => {
 if (companySlugFilter || locationSlugFilter || searchSlugFilter || editorialLandingDescriptor) return null;
 if (!initialJobSlug) return null;
 // When navigating via a previousSlug (bridge), use the current slug for job lookup
 const routeSlug = bridgeTargetSlug || initialJobSlug;
 const lookupSlug = aliasCanonical && aliasCanonical.alias === routeSlug
 ? aliasCanonical.canonical
 : routeSlug;
 // Primary lookup: the canton-scoped `jobs` array.
 const scoped = jobs.find((j) => matchesRouteSlug(j, lookupSlug));
 if (scoped) return scoped;
 // Cross-canton fallback: a legacy-TI bridge URL (`/cerca-lavoro-ticino/<slug>/`)
 // for a job that lives in another canton (e.g. BE) parses to jobBoardCanton='TI',
 // so `jobs` is scoped to TI and never contains the bridged job → it would fall
 // through to JobOrphanView ("Questo annuncio non è più disponibile") even though
 // the job is alive and its full content is pre-rendered. The locale-wide
 // `unscopedJobs` pool (loaded for cross-canton search) DOES contain it, so resolve
 // from there. This is deterministic (no dependency on the async bridge-rescue
 // fetch landing before the wholesale `setJobs` of the full load clobbers a merged
 // record), closing the timing race that intermittently showed the orphan banner.
 return unscopedJobs.find((j) => matchesRouteSlug(j, lookupSlug)) || null;
 }, [jobs, unscopedJobs, initialJobSlug, bridgeTargetSlug, aliasCanonical, companySlugFilter, locationSlugFilter, searchSlugFilter, editorialLandingDescriptor]);

 // Cross-canton bridge resolution: when a bridge URL (e.g.
 // /cerca-lavoro-ticino/<old-slug>/) points to a job that now lives in a
 // canton not included in the initial referrer-aware load (e.g. AI), the
 // slim `jobs` array won't contain it and the SPA would otherwise fall
 // through to `JobOrphanView` even though the job is alive. The static
 // crawler-facing fallback (pre-rendered) shows the correct content, so
 // there's an unacceptable mismatch between first-paint and hydration.
 //
 // Resolution order (cheapest → fattest):
 //   1. fetchJobsForCanton(canton) — per-canton shard. As of 2026-05-19 the
 //      shards are NOT built in CI (the SPA's primary path is the legacy
 //      slim locale index), so this returns [] every time on prod. Still
 //      attempted first in case the shard pipeline lands later.
 //   2. /data/jobs-${locale}-index.json — full locale corpus (~5 MB,
 //      already on the GHPages mirror, often warm in HTTP cache). Filter
 //      by `meta.id` for the single target job, merge that one record.
 const [bridgeFetchAttempted, setBridgeFetchAttempted] = useState<string | null>(null);
 useEffect(() => {
 if (jobsLoading) return;
 if (!initialJobSlug) return;
 if (selectedJob) return;
 const targetSlug = bridgeTargetSlug || initialJobSlug;
 if (bridgeFetchAttempted === targetSlug) return;
 let cancelled = false;
 (async () => {
 try {
 await ensureJobSlugEntriesLoaded([targetSlug]);
 if (cancelled) return;
 const meta = getJobMetaForSlug(targetSlug);
 // Historic-slug resolution (see `aliasCanonical` above). The shard just
 // fetched carries every previousSlugs* alias as a lookup key, so if this
 // route slug is a legacy alias we now know the job's CURRENT slug —
 // record it so `selectedJob` can find the job in the already-loaded
 // `jobs`/`unscopedJobs` arrays. This runs BEFORE the canton/id guard
 // below on purpose: a renamed job in an ALREADY-LOADED canton hits that
 // guard's early return, and without this line an indexed legacy URL
 // would fall through to JobOrphanView.
 const canonicalSlug = meta?.canonicalSlug;
 if (canonicalSlug && canonicalSlug !== targetSlug) {
 setAliasCanonical({ alias: targetSlug, canonical: canonicalSlug });
 }
 if (!meta?.canton || !meta?.id) return;
 // Skip only when we already hold THIS job — then there is nothing to
 // resolve. (Before per-canton shards landed this tested "do we hold any
 // job from that canton", inferring the target must be expired. That
 // inference breaks once `jobs` IS the canton shard: a shard served from a
 // slightly stale CDN copy, or a job whose `canton` differs between the
 // slug map and the index, both satisfy "same canton present" while the
 // target is absent — and the effect would return without ever attempting
 // the full-index fallback below, dropping a live indexed job onto
 // JobOrphanView. Matching on the stable id confirms presence instead of
 // guessing it.)
 const cantonCode = meta.canton;
 if (jobs.some((j) => j.id === meta.id)) return;
 let extra: ReadonlyArray<unknown> = await fetchJobsForCanton(cantonCode, locale);
 if (cancelled) return;
 if (!Array.isArray(extra) || extra.length === 0) {
 // Shard unavailable — fall back to the slim locale index (the
 // SPA's primary loader path). Filter to just the target job by
 // stable id so we don't replace `jobs` wholesale.
 try {
 const res = await fetch(cdnDataUrl(`/data/jobs-${locale}-index.json`));
 if (res.ok) {
 const all = await res.json();
 if (Array.isArray(all)) {
 const targetId = meta.id;
 const match = all.find((j: { id?: string }) => j?.id === targetId);
 if (match) extra = [match];
 // Seed the locale-wide pool so the `selectedJob` unscoped fallback can
 // resolve this (and any other) cross-canton bridge job deterministically,
 // independent of whether the canton-scoped `jobs` array retains the merge.
 if (!cancelled && all.length > 0) {
 setUnscopedJobs((prev) => prev.length > 0
 ? prev
 : dedupeJobsForListing(all.map((job: unknown) => normalizeIncomingJob(job))));
 }
 }
 }
 } catch {
 // Slim-index fetch failure — leave extra empty, fall through.
 }
 }
 if (cancelled || !Array.isArray(extra) || extra.length === 0) return;
 setJobs((prev) => {
 const seen = new Set(prev.map((j) => j.id));
 const merged = [...prev];
 for (const j of extra) {
 const candidate = j as { id?: string };
 if (candidate.id && !seen.has(candidate.id)) merged.push(j as unknown as JobListing);
 }
 return merged;
 });
 } catch {
 // Silently ignore — JobOrphanView is the acceptable fallback.
 } finally {
 if (!cancelled) setBridgeFetchAttempted(targetSlug);
 }
 })();
 return () => { cancelled = true; };
 }, [jobsLoading, initialJobSlug, selectedJob, bridgeTargetSlug, bridgeFetchAttempted, jobs, locale]);

 // FRO-detail-split: Lazily enrich slim job with per-job detail data (~15KB)
 // instead of fetching the full locale file (~11MB). Merges detail fields into
 // the jobs state so selectedJob recomputes with complete data automatically.
 const selectedJobId = selectedJob?.id ?? null;
 const selectedJobSlug = selectedJob?.slug ?? null;
 useEffect(() => {
 if (!selectedJobId) return;
 setEnrichmentLoading(true);
 // Pass the slug so a stale seed id (URL-rotation drift between the baked
 // __JOB_SEED__ and the regenerated detail files) falls back to slug→live-id
 // resolution instead of leaving the body empty. See fetchJobDetailResilient.
 fetchJobDetailResilient(selectedJobId, selectedJobSlug).then((detail) => {
 if (Object.keys(detail).length === 0) return;
 setJobs((prev) => prev.map((j) => (j.id === selectedJobId ? { ...j, ...detail } : j)));
 }).catch(() => {
 // Silently ignore — slim data already shown, detail enrichment is best-effort
 }).finally(() => {
 setEnrichmentLoading(false);
 });
 }, [selectedJobId, selectedJobSlug]);

 // Job-detail alert prompt — gating + 1.5 s reveal timer.
 // Trigger: single-job-detail view, logged-in user with email, feature flag on,
 // localStorage gating allows it, AND no existing alert covers this category.
 const isJobDetailView = selectedJob !== null;
 const userEmail = authUser?.email || null;
 const userId = authUser?.uid || null;

 // Job-match profile, part 2: merge in the newsletter_subscribers doc's
 // sector_interest/location_interest for logged-in subscribers (issue #3648
 // asks for "SalarySurvey / preferenze newsletter" as combined profile
 // sources — public Firestore read per firestore.rules, no new auth needed).
 // Fills gaps only: an explicit SalarySurvey answer always wins.
 useEffect(() => {
 if (!enablePersonalization || !authResolved || !userEmail) return;
 let cancelled = false;
 (async () => {
 try {
 const [{ getFirestore, doc, getDoc }, { app }] = await Promise.all([
 import('firebase/firestore'),
 import('@/services/firebase'),
 ]);
 const snap = await getDoc(doc(getFirestore(app), 'newsletter_subscribers', userEmail.toLowerCase()));
 if (cancelled || !snap.exists()) return;
 const data = snap.data() as Record<string, unknown>;
 const newsletterSignals = {
 sector_interest: typeof data.sector_interest === 'string' ? data.sector_interest : null,
 job_category: typeof data.job_category === 'string' ? data.job_category : null,
 location_interest: typeof data.location_interest === 'string' ? data.location_interest : null,
 geo_city: typeof data.geo_city === 'string' ? data.geo_city : null,
 };
 setJobMatchProfile((prev) => mergeNewsletterSignals(prev, newsletterSignals));
 } catch {
 // best-effort — ranking falls back to the SalarySurvey-only profile (or none)
 }
 })();
 return () => { cancelled = true; };
 }, [enablePersonalization, authResolved, userEmail]);

 // ── Job-match alert CTA (issue #3650, JM3) ──────────────────────────────
 // "Avvisami per ruoli come questo" pre-fills a job alert straight from the
 // JM1 profile (sector/canton, services/jobMatchProfile.ts) instead of
 // sending the user through JobAlertForm to re-enter filters they've
 // already given us. Category comes from the same sector→category table
 // computePersonalScore already uses (SURVEY_SECTOR_TO_CATEGORY), so the
 // CTA's keyword always matches the "Personalizzato per te" scoring it sits
 // next to. Canton is only used as a hard filter when it's a real 2-letter
 // canton code — the newsletter-merge signal above can carry a free-text
 // city instead (see mergeNewsletterSignals), which would silently produce
 // a zero-match alert if used as-is.
 const jobMatchAlertCategoryKey = useMemo(() => {
 const sector = jobMatchProfile?.sector;
 if (!sector) return null;
 const mapped = SURVEY_SECTOR_TO_CATEGORY[sector] ?? sector;
 return mapped in CATEGORY_EMOJI ? (mapped as JobCategory) : null;
 }, [jobMatchProfile]);

 const jobMatchAlertCategoryLabel = jobMatchAlertCategoryKey
 ? t(`jobBoard.filter.${jobMatchAlertCategoryKey}`)
 : '';

 const jobMatchAlertCantonCode = useMemo(() => {
 const canton = jobMatchProfile?.canton;
 if (!canton) return null;
 const upper = canton.trim().toUpperCase();
 return (CANTON_CODES as readonly string[]).includes(upper) ? upper : null;
 }, [jobMatchProfile]);

 // null = still checking (existing alerts / quota), false = hide (already
 // subscribed to this category or at the 3-alert cap), true = show.
 const [jobMatchAlertEligible, setJobMatchAlertEligible] = useState<boolean | null>(null);
 // Bug F (review PR #4338): onSubscribed used to call setJobMatchAlertEligible(false)
 // synchronously, unmounting JobMatchAlertCta in the same batch as its own
 // setStatus('success') — the "Alert attivato ✓" checkmark never painted. Delay
 // the hide so the child's success state has time to render first.
 const jobMatchAlertHideTimerRef = useRef<number | null>(null);

 useEffect(() => {
 setJobMatchAlertEligible(null);
 if (!enablePersonalization || !enableJobAlerts || !jobMatchAlertCategoryLabel || !userId || !userEmail) return;
 let cancelled = false;
 (async () => {
 try {
 const { getUserAlerts, findMatchingAlertForCategory, MAX_ALERTS_PER_USER } = await import(
 '@/services/jobAlertService'
 );
 // Shared, session-scoped cache (review PR #4338, bug G) — see the
 // module-level comment near fetchUserAlertsCached above.
 const existing = await fetchUserAlertsCached(userId, getUserAlerts);
 if (cancelled) return;
 const alreadySubscribed = Boolean(findMatchingAlertForCategory(existing, jobMatchAlertCategoryLabel));
 const quotaFull = existing.length >= MAX_ALERTS_PER_USER;
 setJobMatchAlertEligible(!alreadySubscribed && !quotaFull);
 } catch {
 // best-effort — hide the CTA rather than risk a duplicate/broken alert
 if (!cancelled) setJobMatchAlertEligible(false);
 }
 })();
 return () => {
 cancelled = true;
 // Clear any pending post-subscribe hide (Bug F) so a stale timer never
 // fires against a freshly re-evaluated CTA, and so it's cleared on unmount.
 if (jobMatchAlertHideTimerRef.current !== null) {
 window.clearTimeout(jobMatchAlertHideTimerRef.current);
 jobMatchAlertHideTimerRef.current = null;
 }
 };
 }, [enablePersonalization, enableJobAlerts, jobMatchAlertCategoryLabel, userId, userEmail]);

 const jobMatchAlertVisible = Boolean(
 enablePersonalization && enableJobAlerts && jobMatchAlertCategoryLabel && userId && userEmail && jobMatchAlertEligible,
 );

 // Impression is emitted by <JobMatchAlertCta onImpression> when the CTA is
 // genuinely on screen — NOT from an effect keyed on "is rendered". This block
 // renders inside a job list most visitors never scroll to, and the mount-based
 // version reported 300 impressions with 0 clicks and 0 conversions over 14d,
 // inflating the alert_funnel_conversion denominator (issue #5039).

 // ── Saved-jobs alert nudge (#4467, epic #4465) ───────────────────────────
 // At ≥SAVED_JOBS_NUDGE_THRESHOLD saved jobs, offer an email alert prefilled
 // with the dominant category/canton of the saved list. Non-invasive: fixed
 // toast (zero CLS), at most once per SPA session, 14-day cooldown after an
 // explicit dismiss, terminal after accept (gating in
 // services/savedJobsService.ts). Known users (userId+email) get a true
 // one-tap subscribe; anonymous users are routed to the always-mounted
 // JobAlertForm, which owns the auth/email-capture flow.
 useEffect(() => {
 if (!enableJobAlerts) return;
 if (savedNudgeArmedRef.current) return;
 if (savedJobs.length < SAVED_JOBS_NUDGE_THRESHOLD) return;
 if (!shouldShowSavedJobsNudge(savedJobs.length, loadNudgeState(), new Date())) return;
 const { category, cantonCode } = deriveSavedJobsAlertCriteria(savedJobs);
 if (!category || !(category in CATEGORY_EMOJI)) return;
 const label = t(`jobBoard.filter.${category}`);
 if (!label) return;
 let cancelled = false;
 let timerId: number | null = null;
 (async () => {
 // Known users: skip when an existing alert already covers the dominant
 // category, or the 3-alert quota is full (same eligibility checks as
 // the job-match pill above, same session-scoped cache).
 if (userId && userEmail) {
 try {
 const { getUserAlerts, findMatchingAlertForCategory, MAX_ALERTS_PER_USER } = await import(
 '@/services/jobAlertService'
 );
 const existing = await fetchUserAlertsCached(userId, getUserAlerts);
 if (cancelled) return;
 if (findMatchingAlertForCategory(existing, label) || existing.length >= MAX_ALERTS_PER_USER) return;
 } catch {
 return; // best-effort — skip rather than risk a duplicate/broken alert
 }
 }
 if (cancelled) return;
 timerId = window.setTimeout(() => {
 if (cancelled) return;
 savedNudgeArmedRef.current = true;
 setSavedNudge({ categoryLabel: label, cantonCode, savedCount: savedJobs.length, category });
 // `nudge_shown` fires from the nudge's own `onShown` (below), not here:
 // the toast queues for a popupQueue slot, so this is the moment it was
 // ARMED, not the moment it was seen.
 }, SAVED_NUDGE_SHOW_DELAY_MS);
 })();
 return () => {
 cancelled = true;
 if (timerId !== null) window.clearTimeout(timerId);
 };
 }, [enableJobAlerts, savedJobs, userId, userEmail]);

 const handleSavedNudgeClose = useCallback(() => setSavedNudge(null), []);

 // Fired on the accept TAP (known + anonymous) — the funnel step between
 // nudge_shown and alert_created.
 const handleSavedNudgeAcceptTapped = useCallback(() => {
 Analytics.trackEvent('nudge_accepted', {
 nudge: 'saved_jobs_alert',
 method: userId && userEmail ? 'one_tap' : 'form_redirect',
 });
 }, [userId, userEmail]);

 // One-tap create succeeded (known users only).
 const handleSavedNudgeAccepted = useCallback(() => {
 saveNudgeState(recordNudgeAccepted(loadNudgeState(), new Date()));
 invalidateUserAlertsCache();
 Analytics.trackEvent('alert_created', {
 source: 'saved_jobs_nudge',
 alert_keywords: savedNudge?.categoryLabel || '(none)',
 alert_canton: savedNudge?.cantonCode || '(none)',
 });
 Analytics.trackJobAlertCreated({
 keywords: savedNudge?.categoryLabel || '',
 location: savedNudge?.cantonCode || '',
 frequency: 'weekly',
 surface: 'saved_jobs_nudge',
 });
 }, [savedNudge]);

 const handleSavedNudgeDismissed = useCallback(() => {
 saveNudgeState(recordNudgeDismissed(loadNudgeState(), new Date()));
 Analytics.trackEvent('nudge_dismissed', { nudge: 'saved_jobs_alert' });
 }, []);

 // ── Job-board filter alert CTA (issue #4298) ─────────────────────────────
 // Same one-tap pattern as the job-match pill above, but driven by the
 // board's OWN active filters (profession dropdown + free-text search +
 // canton route) instead of the inferred JM1 profile — for a visitor who
 // filtered the list themselves without a personalization signal yet. List
 // view only; job-detail already has its own one-tap surfaces.
 const boardFilterAlertCantonCode = useMemo(() => {
 // Same route-driven resolution the data-loading effect uses (initialFilterCanton
 // → referrer-based default), not the JM1 survey profile the job-match pill uses.
 const canton = initialFilterCanton || getDefaultCantonForVisit();
 return canton && canton !== AGGREGATE_CANTON_CODE ? canton : null;
 }, [initialFilterCanton]);

 const boardFilterAlertKeywordLabel = useMemo(() => {
 const categoryLabel = selectedCategory !== 'all' ? t(`jobBoard.filter.${selectedCategory}`) : '';
 // Prefer the category label — validated taxonomy, same source the
 // job-detail one-tap prompt already uses. Free-text search is a fallback.
 return categoryLabel || searchQuery.trim();
 }, [selectedCategory, searchQuery, t]);

 // null = still checking (existing alerts / quota), false = hide, true = show.
 const [boardFilterAlertEligible, setBoardFilterAlertEligible] = useState<boolean | null>(null);
 // Bug F (review PR #4338): onSubscribed used to call setBoardFilterAlertEligible(false)
 // synchronously, unmounting JobBoardFilterAlertCta in the same batch as its own
 // setStatus('success') — the "Alert attivato ✓" checkmark never painted. Delay
 // the hide so the child's success state has time to render first.
 const boardFilterAlertHideTimerRef = useRef<number | null>(null);

 useEffect(() => {
 setBoardFilterAlertEligible(null);
 if (!enableJobAlerts || !boardFilterAlertKeywordLabel || !userId || !userEmail || isJobDetailView) return;
 let cancelled = false;
 (async () => {
 try {
 const { getUserAlerts, findMatchingAlertForCategory, MAX_ALERTS_PER_USER } = await import(
 '@/services/jobAlertService'
 );
 // Shared, session-scoped cache (review PR #4338, bug G) — dedupes the
 // Firestore read across every debounced search-text keystroke, which
 // previously re-ran this whole effect on every character typed. See the
 // module-level comment near fetchUserAlertsCached above.
 const existing = await fetchUserAlertsCached(userId, getUserAlerts);
 if (cancelled) return;
 const alreadySubscribed = Boolean(findMatchingAlertForCategory(existing, boardFilterAlertKeywordLabel));
 const quotaFull = existing.length >= MAX_ALERTS_PER_USER;
 if (alreadySubscribed) Analytics.trackJobAlertCtaSkipped('job_board_filters', 'already_subscribed');
 else if (quotaFull) Analytics.trackJobAlertCtaSkipped('job_board_filters', 'quota_full');
 setBoardFilterAlertEligible(!alreadySubscribed && !quotaFull);
 } catch {
 // best-effort — hide the CTA rather than risk a duplicate/broken alert
 if (!cancelled) setBoardFilterAlertEligible(false);
 }
 })();
 return () => {
 cancelled = true;
 // Clear any pending post-subscribe hide (Bug F) so a stale timer never
 // fires against a freshly re-evaluated CTA, and so it's cleared on unmount.
 if (boardFilterAlertHideTimerRef.current !== null) {
 window.clearTimeout(boardFilterAlertHideTimerRef.current);
 boardFilterAlertHideTimerRef.current = null;
 }
 };
 }, [enableJobAlerts, boardFilterAlertKeywordLabel, userId, userEmail, isJobDetailView]);

 const boardFilterAlertVisible = Boolean(
 enableJobAlerts && boardFilterAlertKeywordLabel && userId && userEmail && !isJobDetailView && boardFilterAlertEligible,
 );

 // Same as the job-match pill above: the impression comes from
 // <JobBoardFilterAlertCta onImpression> on real viewport visibility (#5039).

 useEffect(() => {
 try { console.log('[AlertDebug] enter', { detail: isJobDetailView, flag: enableJobAlerts, uid: !!userId, email: !!userEmail, inFlight: newsletterAutologinInFlight, jobId: selectedJob?.id }); } catch { /* noop */ }
 if (!isJobDetailView || !selectedJob) return;
 if (!enableJobAlerts) return;
 if (!userId || !userEmail) {
 // Diagnostic: a visitor who arrived on a newsletter autologin link but is
 // still anonymous here means the autologin never completed — the exact
 // failure that silently drops the prompt. Scoped to that cohort (not every
 // anonymous SEO view) so it stays a low-volume, high-signal event.
 // Guard: if the CF exchange is still in flight, defer — user may authenticate
 // shortly. Without this, the effect fires with userId=null before the exchange
 // settles, emitting a false no_auth for sessions that later succeed.
 if (newsletterAutologinInFlight) return;
 if (wasNewsletterAutologinAttempted()) {
 Analytics.trackJobAlertCtaSkipped('job_detail_prompt', 'no_auth');
 }
 return;
 }
 const categoryKey = categoryTranslationKey(selectedJob);
 const localizedCategory = (t(categoryKey) || '').trim();
 if (!localizedCategory) return;

 let cancelled = false;
 let timerId: number | null = null;

 (async () => {
 const [{ loadGatingState, shouldShowPrompt }, { getUserAlerts, findMatchingAlertForCategory, normalizeKeyword, MAX_ALERTS_PER_USER }] = await Promise.all([
 import('@/services/jobDetailAlertGating'),
 import('@/services/jobAlertService'),
 ]);
 if (cancelled) return;

 const state = loadGatingState();
 const normalized = normalizeKeyword(localizedCategory);
 if (!shouldShowPrompt(state, new Date(), normalized)) {
 Analytics.trackJobAlertCtaSkipped('job_detail_prompt', 'gating_capped');
 return;
 }

 let existing: Awaited<ReturnType<typeof getUserAlerts>>;
 try {
 // Shared, session-scoped cache (review PR #4338, bug G) — same
 // getUserAlerts(userId) read the job-match-pill/board-filter CTAs
 // already cache; reusing it here dedupes the Firestore read when
 // multiple surfaces resolve for the same user in one session. The
 // shown-once analytics guard is intentionally NOT applied to this
 // surface (see the module-level comment near trackJobAlertCtaShownOnce
 // above) — only the fetch is shared.
 existing = await fetchUserAlertsCached(userId, getUserAlerts);
 } catch {
 // Fail closed — never badger users on a degraded network. Emit a skip
 // signal so this silent drop shows up in GA4 (was an invisible 0-impression).
 Analytics.trackJobAlertCtaSkipped('job_detail_prompt', 'get_alerts_failed');
 return;
 }
 if (cancelled) return;
 if (findMatchingAlertForCategory(existing, localizedCategory)) {
 Analytics.trackJobAlertCtaSkipped('job_detail_prompt', 'already_subscribed');
 return;
 }
 // P2: don't prompt when the user is already at their alert quota — the
 // one-tap subscribe path would throw inside createAlert and surface as
 // a silent `error` event (3 such events on 2026-05-13 traced to this).
 if (existing.length >= MAX_ALERTS_PER_USER) {
 Analytics.trackJobAlertCtaSkipped('job_detail_prompt', 'quota_full');
 return;
 }

 // Leva B: a user who just authed via Google/FB to unlock THIS job is at
 // peak intent — show the one-tap alert offer immediately rather than
 // waiting out the dwell timer. Consume the ref so it fires only once.
 const justAuthed = justAuthedJobIdRef.current === selectedJob.id;
 if (justAuthed) justAuthedJobIdRef.current = null;
 // Show immediately (0 s) for peak-intent arrivals; 1.5 s dwell otherwise.
 // Newsletter-autologin visitors only become authenticated after a ~4 s token
 // exchange, and the 1.5 s timer then races (and usually loses) against the
 // AdSense/enrichment re-renders that re-run this effect — so the prompt often
 // never fires (observed: hasUser:true at +4 s, then no toast). They clicked a
 // job in an email = peak intent, so treat them like an in-app post-auth unlock.
 const showImmediately = justAuthed || wasNewsletterAutologinAttempted();
 try { console.log('[AlertDebug] arm timer', { delayMs: showImmediately ? 0 : 1500, existing: existing.length, category: localizedCategory }); } catch { /* noop */ }
 timerId = window.setTimeout(() => {
 if (cancelled) { try { console.log('[AlertDebug] timer cancelled before fire'); } catch { /* noop */ } return; }
 try { console.log('[AlertDebug] FIRE — prompt visible'); } catch { /* noop */ }
 setJobDetailPromptCategory(localizedCategory);
 setJobDetailPromptVisible(true);
 // The impression is NOT fired here any more. The toast waits for a
 // popupQueue slot (components/shared/BottomPromptShell.tsx), so "we
 // decided to show it" and "it is on screen" are different events, and
 // counting the first would inflate the denominator of the one
 // job-alert surface that actually converts. It fires from the
 // prompt's `onShown` instead — see jobDetailPromptJsx below.
 }, showImmediately ? 0 : 1500);
 })();

 return () => {
 cancelled = true;
 if (timerId !== null) window.clearTimeout(timerId);
 };
 // Depend on selectedJob?.id, not the object: the detail enrichment fetch
 // replaces selectedJob with a new ref for the SAME job, which re-ran this
 // effect and cancelled the reveal timer before it could fire — the residual
 // flake after the 0 s change. A real navigation changes the id and still
 // re-runs / re-arms.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [isJobDetailView, selectedJob?.id, enableJobAlerts, newsletterAutologinInFlight, userId, userEmail, t]);

 // Impression for the peak-intent alert offer inside the applied receipt. Fired
 // on appearance rather than via IntersectionObserver because the receipt is
 // rendered directly under the button the user just pressed — it is on screen by
 // construction, so an in-view check would add machinery without adding truth.
 useEffect(() => {
 if (!appliedJobId || !selectedJob || appliedJobId !== selectedJob.id) return;
 Analytics.trackJobAlertCtaShown('job_detail_button', (t(categoryTranslationKey(selectedJob)) || '').trim());
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [appliedJobId, selectedJob?.id]);

 // Drop the applied receipt when the user moves to a different job / leaves the
 // detail view, so it never leaks onto an unrelated listing.
 useEffect(() => {
 if (appliedJobId && (!isJobDetailView || selectedJob?.id !== appliedJobId)) {
 setAppliedJobId(null);
 }
 }, [appliedJobId, isJobDetailView, selectedJob?.id]);

 // Auto-unmount the prompt if the user logs out or leaves the detail view.
 useEffect(() => {
 if (!jobDetailPromptVisible) return;
 if (!isJobDetailView || !userEmail || !userId) {
 setJobDetailPromptVisible(false);
 setJobDetailPromptCategory(null);
 }
 }, [isJobDetailView, jobDetailPromptVisible, userEmail, userId]);

 const editorialJobTodayLanding = useMemo(() => {
 if (editorialLandingDescriptor?.kind !== 'today') return null;
 const baseUrl = typeof window !== 'undefined' ? window.location.origin : PUBLIC_SITE_URL;
 return buildJobTodayLandingModel({
 jobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug: deriveLocalizedJobSlug,
 baseUrl,
 sectionSlug: getJobBoardSectionSlug(locale),
 localePrefix: locale === 'it' ? '' : `/${locale}`,
 });
 }, [editorialLandingDescriptor, jobs, locale]);

 const editorialOfficialGazetteLanding = useMemo(() => {
 if (editorialLandingDescriptor?.kind !== 'official-gazette') return null;
 const baseUrl = typeof window !== 'undefined' ? window.location.origin : PUBLIC_SITE_URL;
 return buildJobOfficialGazetteLandingModel({
 jobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug: deriveLocalizedJobSlug,
 baseUrl,
 sectionSlug: getJobBoardSectionSlug(locale),
 localePrefix: locale === 'it' ? '' : `/${locale}`,
 });
 }, [editorialLandingDescriptor, jobs, locale]);

 const editorialLocationLanding = useMemo(() => {
 if (editorialLandingDescriptor?.kind !== 'location') return null;
 const baseUrl = typeof window !== 'undefined' ? window.location.origin : PUBLIC_SITE_URL;
 return buildJobLocationLandingModel({
 jobs,
 locale,
 location: editorialLandingDescriptor.location,
 now: new Date().toISOString(),
 localizedSlug: deriveLocalizedJobSlug,
 baseUrl,
 sectionSlug: getJobBoardSectionSlug(locale),
 localePrefix: locale === 'it' ? '' : `/${locale}`,
 });
 }, [editorialLandingDescriptor, jobs, locale]);

 const editorialLocationTypeLanding = useMemo(() => {
 if (editorialLandingDescriptor?.kind !== 'location-type') return null;
 const baseUrl = typeof window !== 'undefined' ? window.location.origin : PUBLIC_SITE_URL;
 return buildJobLocationTypeLandingModel({
 jobs,
 locale,
 location: editorialLandingDescriptor.location,
 typeKey: editorialLandingDescriptor.typeKey,
 now: new Date().toISOString(),
 localizedSlug: deriveLocalizedJobSlug,
 baseUrl,
 sectionSlug: getJobBoardSectionSlug(locale),
 localePrefix: locale === 'it' ? '' : `/${locale}`,
 });
 }, [editorialLandingDescriptor, jobs, locale]);

 const editorialLocationSectorLanding = useMemo(() => {
 if (editorialLandingDescriptor?.kind !== 'location-sector') return null;
 const baseUrl = typeof window !== 'undefined' ? window.location.origin : PUBLIC_SITE_URL;
 return buildJobLocationSectorLandingModel({
 jobs,
 locale,
 location: editorialLandingDescriptor.location,
 sectorKey: editorialLandingDescriptor.sectorKey,
 now: new Date().toISOString(),
 localizedSlug: deriveLocalizedJobSlug,
 baseUrl,
 sectionSlug: getJobBoardSectionSlug(locale),
 localePrefix: locale === 'it' ? '' : `/${locale}`,
 });
 }, [editorialLandingDescriptor, jobs, locale]);

 const editorialSectorRegionLanding = useMemo(() => {
 if (editorialLandingDescriptor?.kind !== 'sector-region') return null;
 const baseUrl = typeof window !== 'undefined' ? window.location.origin : PUBLIC_SITE_URL;
 return buildJobSectorRegionLandingModel({
 jobs,
 locale,
 sectorKey: editorialLandingDescriptor.sectorKey,
 now: new Date().toISOString(),
 localizedSlug: deriveLocalizedJobSlug,
 baseUrl,
 sectionSlug: getJobBoardSectionSlug(locale),
 localePrefix: locale === 'it' ? '' : `/${locale}`,
 });
 }, [editorialLandingDescriptor, jobs, locale]);

 const editorialNursesHubLanding = useMemo(() => {
 if (editorialLandingDescriptor?.kind !== 'nurses-hub') return null;
 const baseUrl = typeof window !== 'undefined' ? window.location.origin : PUBLIC_SITE_URL;
 return buildJobNursesHubLandingModel({
 jobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug: deriveLocalizedJobSlug,
 baseUrl,
 sectionSlug: getJobBoardSectionSlug(locale),
 localePrefix: locale === 'it' ? '' : `/${locale}`,
 });
 }, [editorialLandingDescriptor, jobs, locale]);

 const editorialPartTimeLanding = useMemo(() => {
 if (editorialLandingDescriptor?.kind !== 'part-time') return null;
 const baseUrl = typeof window !== 'undefined' ? window.location.origin : PUBLIC_SITE_URL;
 return buildJobPartTimeLandingModel({
 jobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug: deriveLocalizedJobSlug,
 baseUrl,
 sectionSlug: getJobBoardSectionSlug(locale),
 localePrefix: locale === 'it' ? '' : `/${locale}`,
 });
 }, [editorialLandingDescriptor, jobs, locale]);

 const editorialCareVariantLanding = useMemo(() => {
 if (editorialLandingDescriptor?.kind !== 'care-variant') return null;
 const baseUrl = typeof window !== 'undefined' ? window.location.origin : PUBLIC_SITE_URL;
 return buildJobCareVariantLandingModel({
 jobs,
 locale,
 clusterKey: editorialLandingDescriptor.clusterKey,
 now: new Date().toISOString(),
 localizedSlug: deriveLocalizedJobSlug,
 baseUrl,
 sectionSlug: getJobBoardSectionSlug(locale),
 localePrefix: locale === 'it' ? '' : `/${locale}`,
 });
 }, [editorialLandingDescriptor, jobs, locale]);

 // If we are on a specific job detail route, initialize Firebase Auth immediately.
 // Otherwise useAuth defers auth init until first interaction (for performance),
 // which can leave the detail page in loading state until a click/scroll happens.
 useEffect(() => {
 if (selectedJob && authLoading) eagerAuth();
 }, [selectedJob, authLoading]);

 // Deep-link from the static /lavoro/<slug>/candidatura/ CTA (publisher ads
 // with in-house / forward-email apply): once the detail view renders, bring
 // the apply form into view so the click lands on the form, not the header.
 useEffect(() => {
 if (!selectedJob) return;
 if (!/\/candidatura\/?$/.test(window.location.pathname)) return;
 document.getElementById('candidatura')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
 }, [selectedJob]);

 // sortedJobs re-scores + re-sorts every loaded job (up to ~12k on the
 // Switzerland-wide aggregator) as one synchronous block; it reads the
 // deferred* personalization inputs declared above so this resort yields to
 // a concurrent click instead of blocking it (see comment there, #4302).
 const sortedJobs = useMemo(() => {
 // Step 1: EXCLUDE foreign jobs entirely (London, Luxembourg, Singapore, etc.)
 const swissJobs = jobs.filter(j => {
 const loc = j.addressLocality || j.location || '';
 return !isForeignLocation(loc);
 });

 // Step 2: Canton priority + personalization scoring
 const cantonRank = (job: JobListing) => {
 if (job.addressLocality && isNonTargetSwissCity(job.addressLocality)) {
 return TARGET_CANTONS_ORDERED.length;
 }
 const idx = TARGET_CANTONS_ORDERED.indexOf(job.canton as typeof TARGET_CANTONS_ORDERED[number]);
 return idx >= 0 ? idx : TARGET_CANTONS_ORDERED.length;
 };
 const dayTs = (d: string | undefined) => {
 const t = new Date(d || 0);
 return new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
 };

 const shouldPersonalize = enablePersonalization && deferredBehaviorData;

 const withMeta = swissJobs.map(j => ({
 job: j,
 // Sponsored (featured) ads bought the top placement — they outrank every
 // other signal. Inventory is scarce by construction (FEATURED_SLOTS_PER_CANTON
 // caps featured at 6/canton in the projection), so this can't flood the list.
 sp: j.featured ? 1 : 0,
 rank: cantonRank(j),
 day: dayTs(j.crawledAt || j.postedDate),
 qs: j.qualityScore ?? 0,
 personal: shouldPersonalize
 ? computePersonalScore(j, deferredBehaviorData, deferredUserProfile ?? null, deferredJobMatchProfile)
 : { score: 0, topSignal: '' },
 }));
 withMeta.sort((a, b) =>
 (b.sp - a.sp)
 || (b.personal.score - a.personal.score)
 || (a.rank - b.rank)
 || (b.day - a.day)
 || (b.qs - a.qs)
 );
 return withMeta.map(({ job }) => job);
 }, [jobs, enablePersonalization, deferredBehaviorData, deferredUserProfile, deferredJobMatchProfile]);

 // Pre-built search index: caches normalised haystack per job so
 // queryMatchesJob doesn't recompute expensive string normalisation on every keystroke.
 // The map is stored WITH the (sortedJobs, locale) pair it was built from —
 // the same pair the build effect depends on. Keeping them in one state value
 // makes "which corpus does this index describe?" answerable, which a bare Map
 // cannot be: it is keyed by job OBJECT IDENTITY, so a `jobs` array replaced by
 // one of the SAME LENGTH holding different objects (the detail-enrichment
 // effect below re-creates exactly one job on every job-detail open) leaves a
 // map whose every key is stale while its size still matches. A size
 // comparison reads that as "complete" and hands the fallback tiers a corpus
 // that matches nothing — the 7,16 MB stampede this component is trying to
 // avoid. A locale switch has the same shape from the other side: same array
 // identity, haystacks built for the previous language.
 const [searchIndex, setSearchIndex] = useState<{
 readonly map: Map<JobListing, string>;
 readonly jobs: ReadonlyArray<JobListing> | null;
 readonly locale: Locale | null;
 }>(() => ({ map: new Map(), jobs: null, locale: null }));

 // Time-sliced, not fixed-count. A 50-job chunk per rAF frame makes the wall
 // clock a function of the FRAME COUNT, not of the work: 14.700 jobs (the
 // aggregate board) is 294 frames ≈ 4,9 s no matter how cheap each job gets —
 // measured as the 2,9 s → 8,1 s gap before
 // /cerca-lavoro-svizzera/ricerca-… could show its first result. Filling a
 // budget instead keeps the same "never block a frame" contract while letting
 // a fast device finish in a few frames (~264 ms of work for 14.700 jobs once
 // matchProfession got its alias index). The clock is read every 16 jobs so
 // the check itself stays off the hot path while keeping the per-frame FLOOR
 // (16) below the fixed 50 it replaces — a device slow enough to make a job
 // cost 10x the measured ~18 µs must still be able to yield sooner than
 // before, not later.
 useEffect(() => {
 const map = new Map<JobListing, string>();
 let i = 0;
 let raf = 0;
 let cancelled = false;
 const FRAME_BUDGET_MS = 8;
 const CLOCK_CHECK_MASK = 15;

 function processChunk() {
 const deadline = performance.now() + FRAME_BUDGET_MS;
 while (i < sortedJobs.length) {
 const job = sortedJobs[i];
 const description = job.descriptionByLocale?.[locale] ?? job.description;
 const localizedTitle = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title);
 // Stemmed + space-padded haystack so query matching tolerates Italian
 // plural/feminine variants (pulizie ↔ pulizia, infermieri ↔ infermiera)
 // while still requiring word-boundary alignment (cas ≠ cassa).
 // Also folds in profession-taxonomy synonyms (it/de/fr/en) so a query
 // like "nurse" or "Pflegefachfrau" surfaces a job titled "Infermiera".
 const synonyms = professionSynonymText(localizedTitle);
 map.set(job, buildStemmedHaystack(`${localizedTitle} ${job.company} ${job.location} ${job.contract} ${job.category} ${job.sector || ''} ${cantonSearchTokens(job.canton)} ${description} ${synonyms}`));
 i++;
 if ((i & CLOCK_CHECK_MASK) === 0 && performance.now() >= deadline) break;
 }
 // Unmount/dep-change between frames: drop the partial map on the floor
 // instead of committing it. The old cleanup set `i = sortedJobs.length`,
 // which made the already-queued frame take the `else` branch and publish a
 // HALF-BUILT index — every query then read zero hits against it.
 if (cancelled) return;
 if (i < sortedJobs.length) {
 raf = requestAnimationFrame(processChunk);
 } else {
 setSearchIndex({ map, jobs: sortedJobs, locale });
 }
 }

 // Scheduled even for an empty corpus: the commit is what publishes the
 // (jobs, locale) pair, and without it `searchIndexPending` would stay true
 // forever on a board that legitimately loaded zero jobs, permanently
 // disabling the very fallbacks that case needs.
 raf = requestAnimationFrame(processChunk);

 return () => {
 cancelled = true;
 if (raf) cancelAnimationFrame(raf);
 };
 }, [sortedJobs, locale]);

 // Fast query match using pre-built index — avoids re-normalising haystacks.
 const indexedQueryMatch = useCallback(
 (job: JobListing, query: string): boolean => {
 const queryTokens = normalizeSearchText(query).split(' ').filter(Boolean).map(stemSearchToken);
 if (queryTokens.length === 0) return true;
 const haystack = searchIndex.map.get(job) ?? '';
 // Stemmed query tokens prefix-match haystack words.
 // Why: 'infermie' (stem 'infermi') must match haystack word 'infermier'
 // — partial typing common in incremental search. Leading-space anchor
 // still enforces word-start alignment; trailing-space dropped so the
 // stem is treated as a prefix, not a closed token.
 return queryTokens.every((token) => haystack.includes(` ${token}`));
 },
 [searchIndex],
 );

 /**
  * True while a query is active but the incremental search index does not yet
  * cover every loaded job. In that window `indexedQueryMatch` reads an empty
  * haystack for the uncovered jobs, so EVERY tier reports zero matches — the
  * zero is an artefact of the build, not an answer about the corpus.
  *
  * The loading skeleton already held for exactly this reason. The lazy
  * broaden tiers did not, and they read the same provisional zero as "this
  * search found nothing, go fetch more corpus": on
  * /cerca-lavoro-svizzera/ricerca-offerte-lavoro-assistente-psicologo/ the
  * cross-locale tier fired in 4 runs out of 4 and pulled the DE/FR/EN slim
  * indexes — 7,16 MB over the wire, ~50 MB of JSON to parse — which were then
  * discarded, because once the index completed the strict tier had 8 results
  * all along. One flag for all four consumers so they cannot drift apart.
  */
 const searchIndexPending = Boolean(deferredSearchQuery.trim())
 && (searchIndex.jobs !== sortedJobs || searchIndex.locale !== locale);

 // Post-auth prompt removed 2026-05-19: PostHog 30-day data showed 88%
 // dismiss rate · 3 open · 0 accepts · 3 silent errors on
 // `post_auth_prompt_search`. Users only click 1 job per session so a
 // "second-job" trigger has no audience either — the job-detail prompt
 // (relaxed gating, max 2/day) carries conversions instead.

 // Helper: apply ALL non-search filters (company, location, category,
 // contract, sector, date, newOnly). Reused by both the strict AND-match
 // path below and the OR-fallback path so the two stay consistent.
 const passingNonSearchFilters = useCallback((job: JobListing, now: number, cutoff: number): boolean => {
 if (companySlugFilter) {
 const slugCandidates = companyRouteSlugCandidates(job.company, job.companyKey);
 if (!slugCandidates.has(companySlugFilter)) return false;
 }
 if (locationSlugFilter) {
 const jobLocSlug = slugifyLocation(job.addressLocality || job.location || '');
 if (jobLocSlug !== locationSlugFilter) return false;
 }
 if (deferredSelectedCategory !== 'all' && job.category !== deferredSelectedCategory) return false;
 if (deferredSelectedContract !== 'all' && job.contract !== deferredSelectedContract) return false;
 if (deferredSelectedCompany !== 'all' && job.company.toLowerCase() !== deferredSelectedCompany) return false;
 if (deferredSelectedLocation !== 'all' && normalizeLocalityKey(job.addressLocality || '') !== deferredSelectedLocation) return false;
 if (deferredSelectedSector !== 'all' && (job.sector || '').toLowerCase() !== deferredSelectedSector) return false;
 if (cutoff > 0) {
 const jobDate = new Date(job.crawledAt || job.postedDate).getTime();
 if (jobDate < cutoff) return false;
 }
 if (deferredShowNewOnly) {
 const jobTs = new Date(job.crawledAt || job.postedDate).getTime();
 if (now - jobTs >= 72 * 60 * 60 * 1000) return false;
 }
 // "Salvati" view (#4466): same mechanics as the new-only pill — an
 // AND-filter over the loaded pool keyed on the localStorage saved ids.
 if (deferredShowSavedOnly && !savedJobIds.has(job.id)) return false;
 if (salaryRangeFilter.min !== null) {
 // `?salarioMin=`/`?salarioMax=` are CHF annual figures (see readSalaryRangeFromUrl's
 // docblock above); job.salaryMin/salaryMax are raw numbers with no currency
 // normalization. An EUR-denominated posting's raw figures aren't CHF-comparable —
 // same mismatch the net-estimate widget already excludes via
 // `selectedJob.currency === 'EUR'` (below, ~line 5590). Apply the identical
 // exclusion here rather than silently comparing EUR numbers against a CHF band
 // (review PR #4338, bug I).
 if (job.currency === 'EUR') return false;
 const jobMinRaw = Number(job.salaryMin) || Number(job.baseSalary?.value?.minValue);
 if (!jobMinRaw || !Number.isFinite(jobMinRaw)) return false; // no salary data → can't match a salary-range filter
 const jobMaxRaw = Number(job.salaryMax) || Number(job.baseSalary?.value?.maxValue);
 const jobMax = (jobMaxRaw && Number.isFinite(jobMaxRaw) && jobMaxRaw > jobMinRaw) ? jobMaxRaw : jobMinRaw;
 const rangeMax = salaryRangeFilter.max ?? salaryRangeFilter.min;
 // Overlap test: job's [jobMinRaw, jobMax] must intersect the requested [min, rangeMax] band.
 if (jobMax < salaryRangeFilter.min || jobMinRaw > rangeMax) return false;
 }
 return true;
 }, [companySlugFilter, locationSlugFilter, deferredSelectedCategory, deferredSelectedContract, deferredSelectedCompany, deferredSelectedLocation, deferredSelectedSector, deferredShowNewOnly, deferredShowSavedOnly, savedJobIds, salaryRangeFilter]);

 // strictFilteredJobs: AND-match on every search token (current behavior).
 // The OR-fallback layer below kicks in when this is empty for a
 // multi-token query — typical for slug-driven URLs like
 // /cerca-lavoro-ticino/ricerca-koch-davos/ where no job has BOTH "koch"
 // and "davos" but many have one of the two.
 const strictFilteredJobs = useMemo(() => {
 const now = Date.now();
 const cutoff = deferredSelectedDateRange === 'all' ? 0 : now - DATE_RANGE_MS[deferredSelectedDateRange];
 const query = deferredSearchQuery.trim();
 return sortedJobs.filter((job) => {
 if (!passingNonSearchFilters(job, now, cutoff)) return false;
 if (query) return indexedQueryMatch(job, query);
 return true;
 });
 }, [sortedJobs, deferredSelectedDateRange, deferredSearchQuery, indexedQueryMatch, passingNonSearchFilters]);

 // Location vocabulary for the OR-fallback relevance floor. Stemmed tokens of
 // every job location currently in memory (canton-scoped + unscoped pool).
 // Used to discount location words when counting a query's CONTENT tokens —
 // mirrors the build plugin's city-strip before computing minOrScore so the
 // "koch davos" single-content-token city-drop recovery keeps minScore=1.
 //
 // Deliberate divergence from the static plugin (build-plugins/
 // relatedSearchClustersPlugin.ts): the static page discounts ONLY its own
 // target city (`stripCityFromKeyword`), whereas this set spans the WHOLE
 // in-memory corpus vocabulary. A query token equal to a non-page city can
 // therefore drop the SPA floor from 2 to 1 where static would keep 2 — so
 // the SPA can surface MORE recovery results than the static landing, never
 // fewer. This is intentional: the SPA OR-fallback is a "show SOMETHING"
 // safety net, never a canonical/indexed surface, so over-recovery can only
 // help the user and never de-indexes a page. The lockstep guarantee that
 // matters (and is asserted by the cluster guard test) is the boilerplate
 // strip, not the location discount.
 //
 // Collision guard: skip stopwords (RELATED_SEARCH_STOPWORDS) and short stems
 // (<=3 chars, which `stemSearchToken` leaves un-stemmed). Both are the tokens
 // most likely to also be legitimate role-content words; excluding them keeps
 // a short/ambiguous location word from wrongly discounting a real content
 // token and silently lowering the floor. Removing a token from the discount
 // set can only RAISE the floor (stricter) — it never surfaces more off-topic
 // jobs — so the guard is monotone-safe.
 const searchLocationTokens = useMemo<Set<string>>(() => {
 const set = new Set<string>();
 const addFrom = (arr: readonly JobListing[]) => {
 for (const j of arr) {
 const loc = `${j.addressLocality || ''} ${j.location || ''}`;
 for (const tok of normalizeSearchText(loc).split(' ')) {
 if (!tok) continue;
 const stem = stemSearchToken(tok);
 if (stem.length <= 3) continue;
 if (RELATED_SEARCH_STOPWORDS.has(stem)) continue;
 set.add(stem);
 }
 }
 };
 addFrom(sortedJobs);
 addFrom(unscopedJobs);
 return set;
 }, [sortedJobs, unscopedJobs]);

 // OR-fallback relevance floor, ported from the static cluster plugin
 // (build-plugins/relatedSearchClustersPlugin.ts: `minOrScore`). A query with
 // ≥2 CONTENT tokens (after stripping job-search boilerplate AND location
 // words) requires ≥2 token hits, so a single generic token (e.g. the trailing
 // "switzerland" template suffix) can't pull off-intent jobs into the OR
 // fallback. Single-content-token queries keep a floor of 1 so the legitimate
 // city-drop recovery still works. Keeps the hydrated SPA job set in lockstep
 // with the statically-emitted slug landing.
 const orFallbackMinScore = useMemo<number>(() => {
 const stripped = stripSearchQueryBoilerplate(deferredSearchQuery.trim());
 const contentTokens = normalizeSearchText(stripped)
 .split(' ')
 .filter(Boolean)
 .map(stemSearchToken)
 .filter((t) => !searchLocationTokens.has(t));
 return contentTokens.length >= 2 ? 2 : 1;
 }, [deferredSearchQuery, searchLocationTokens]);

 // Boilerplate-stripped query that seeds the OR-fallback scoring tiers below.
 // The floor (`orFallbackMinScore`) counts CONTENT tokens — i.e. after
 // `stripSearchQueryBoilerplate` removes the leading job-search prefixes and
 // the trailing nation/template suffixes — so the tokens we *score* against
 // the haystack must come from the SAME stripped query. Scoring the RAW query
 // would let a manually typed boilerplate query ("pizzaiolo salary
 // switzerland", entered in the box rather than via a pre-stripped slug) reach
 // the floor on boilerplate tokens alone (salary+switzerland) with zero real
 // content match. Slug-seeded queries arrive already stripped, so this only
 // changes the manual-search path. Never empty (helper falls back to the
 // original term), so a single-content query still scores its one real token.
 const orFallbackQuery = useMemo<string>(
 () => stripSearchQueryBoilerplate(deferredSearchQuery.trim()),
 [deferredSearchQuery],
 );

 // In-canton OR-fallback: partial token matches ranked by hit count, capped
 // at MAX_FALLBACK_RESULTS. Mirrors the build plugin's two-phase matching at
 // build/relatedSearchClustersPlugin.ts (AND first, then OR-fill up to
 // MAX_JOBS_PER_PAGE) so users landing on a slug URL see the SAME job set the
 // static cluster page would show.
 //
 // Fires whenever the strict AND tier is THIN (< BROADEN_BELOW), not only when
 // it returns zero. The previous gate was `strict.length > 0`: a slug whose AND
 // phase yielded a single job (e.g.
 // /cerca-lavoro-svizzera/ricerca-responsabile-…-cure-infermieristiche-m-f/)
 // stayed stuck at 1 result after hydration while the static HTML showed 30 —
 // the OR-fill never ran. Now it tops up the strict matches with partial-token
 // matches (excluding the strict ids, which `filteredJobs` lists first), so the
 // hydrated page matches the static cluster page instead of collapsing to 1
 // (which also removed the jarring static-30 → hydrated-1 layout shift).
 const MAX_FALLBACK_RESULTS = 30;
 const orFallbackInCantonJobs = useMemo<JobListing[]>(() => {
 const query = deferredSearchQuery.trim();
 if (!query || strictFilteredJobs.length >= BROADEN_BELOW) return [];

 // Score the boilerplate-stripped query so the matched tokens stay
 // consistent with the floor (`orFallbackMinScore`, which counts content
 // tokens) — see `orFallbackQuery` above.
 const queryTokens = normalizeSearchText(orFallbackQuery).split(' ').filter(Boolean).map(stemSearchToken);
 if (queryTokens.length < 2) return []; // single token: AND === OR, nothing to add

 const now = Date.now();
 const cutoff = deferredSelectedDateRange === 'all' ? 0 : now - DATE_RANGE_MS[deferredSelectedDateRange];

 // Exclude jobs already matched by the strict AND tier — this tier supplies
 // only the OR-fill tail; `filteredJobs` lists the strict matches first.
 const strictIds = new Set<string>();
 for (const j of strictFilteredJobs) strictIds.add(j.id);

 const scored: { job: JobListing; score: number }[] = [];
 for (const job of sortedJobs) {
 if (strictIds.has(job.id)) continue;
 if (!passingNonSearchFilters(job, now, cutoff)) continue;
 const haystack = searchIndex.map.get(job) ?? '';
 let score = 0;
 for (const t of queryTokens) {
 if (haystack.includes(` ${t}`)) score++;
 }
 if (score >= orFallbackMinScore) scored.push({ job, score });
 }
 scored.sort((a, b) => b.score - a.score);
 return scored.slice(0, MAX_FALLBACK_RESULTS).map((x) => x.job);
 }, [strictFilteredJobs, sortedJobs, deferredSearchQuery, orFallbackQuery, searchIndex, deferredSelectedDateRange, passingNonSearchFilters, orFallbackMinScore]);

 // Cross-canton OR-fallback (Tier 3): only fires when strict AND the in-
 // canton OR-fallback both returned zero. Searches the unscoped locale-wide
 // pool (jobs from BL, ZH, GE, … when the URL pinned us to TI/BS/etc) so
 // pages like `/cerca-lavoro-basilea/ricerca-genitori-liestal/` always
 // surface SOMETHING. Excludes IDs already in the canton-scoped pool so we
 // never double-render a job that the in-canton tiers already discarded by
 // date-range or non-search filter. Builds the haystack inline (no memoised
 // index) because this path runs only when both prior tiers are empty —
 // rare enough that an O(n) scan over ~13k jobs per relevant keystroke is
 // acceptable, and skipping the index keeps memory flat in the common case.
 const crossCantonFallbackJobs = useMemo<JobListing[]>(() => {
 const query = deferredSearchQuery.trim();
 if (!query) return [];
 // Broaden when the in-canton tiers returned FEWER than BROADEN_BELOW jobs
 // (was: only when they returned exactly zero). A single weak in-canton match
 // — e.g. a TI job whose description happens to mention "lausanne" — used to
 // suppress the much richer cross-canton set, leaving the page stuck at 1.
 // The in-canton result is whichever tier won: strict (AND) if it has any,
 // else the in-canton OR fallback. These are merged-with (not replaced) by the
 // consumer (`filteredJobs`), so this tier only supplies the broadened tail.
 // strict + OR-fill tail (the fill excludes strict ids, so no double count).
 const inCantonCount = strictFilteredJobs.length + orFallbackInCantonJobs.length;
 if (inCantonCount >= BROADEN_BELOW) return [];
 if (unscopedJobs.length === 0) return [];

 // Score the boilerplate-stripped query (see `orFallbackQuery`) so the
 // tokens match the floor's content-token count.
 const queryTokens = normalizeSearchText(orFallbackQuery).split(' ').filter(Boolean).map(stemSearchToken);
 if (queryTokens.length === 0) return [];

 // City-aware relevance: query tokens that are part of the location vocabulary
 // (`searchLocationTokens`) name a place ("lausanne"). A broadened job whose
 // own LOCATION matches one of them is far more relevant than a job that only
 // mentions the city in prose, so it gets CITY_MATCH_BOOST and leads the tail.
 const cityTokens = queryTokens.filter((t) => searchLocationTokens.has(t));

 const now = Date.now();
 const cutoff = deferredSelectedDateRange === 'all' ? 0 : now - DATE_RANGE_MS[deferredSelectedDateRange];

 const scopedIds = new Set<string>();
 for (const j of sortedJobs) scopedIds.add(j.id);

 const scored: { job: JobListing; score: number }[] = [];
 for (const job of unscopedJobs) {
 if (scopedIds.has(job.id)) continue;
 if (isForeignLocation(job.addressLocality || job.location || '')) continue;
 if (!passingNonSearchFilters(job, now, cutoff)) continue;
 const haystack = getBroadenHaystack(job, locale);
 let score = 0;
 for (const t of queryTokens) {
 if (haystack.includes(` ${t}`)) score++;
 }
 if (score < orFallbackMinScore) continue;
 let locBoost = 0;
 if (cityTokens.length > 0) {
 const locHay = buildStemmedHaystack(`${job.addressLocality || ''} ${job.location || ''}`);
 for (const ct of cityTokens) {
 if (locHay.includes(` ${ct}`)) { locBoost = CITY_MATCH_BOOST; break; }
 }
 }
 scored.push({ job, score: score + locBoost });
 }
 scored.sort((a, b) => b.score - a.score);
 return scored.slice(0, MAX_FALLBACK_RESULTS).map((x) => x.job);
 }, [strictFilteredJobs.length, orFallbackInCantonJobs.length, sortedJobs, deferredSearchQuery, orFallbackQuery, deferredSelectedDateRange, passingNonSearchFilters, unscopedJobs, locale, orFallbackMinScore, searchLocationTokens]);

 // Tier 4 trigger: lazy-load DE/FR/EN slim indexes when all in-locale tiers
 // returned zero for a non-empty query. Same job ID across locale shards so
 // we dedup against the already-loaded pool (sortedJobs ∪ unscopedJobs) to
 // avoid surfacing jobs the user already saw filtered-out. Fetch is one-shot
 // per session (crossLocaleFetchAttempted ref) — cross-locale corpora are
 // similarly sized to the IT one, so a per-keystroke refetch would waste
 // bandwidth without changing results.
 useEffect(() => {
 if (crossLocaleFetchAttempted.current) return;
 if (jobsLoading) return;
 // The zero below is only an answer once the index covers the corpus.
 if (searchIndexPending) return;
 const q = deferredSearchQuery.trim();
 if (!q) return;
 if (strictFilteredJobs.length > 0) return;
 if (orFallbackInCantonJobs.length > 0) return;
 if (crossCantonFallbackJobs.length > 0) return;
 crossLocaleFetchAttempted.current = true;
 setPendingFallbacks((n) => n + 1);
 let cancelled = false;
 const allLocales: ReadonlyArray<Locale> = ['it', 'en', 'de', 'fr'];
 const otherLocales = allLocales.filter((l) => l !== locale);
 (async () => {
 try {
 const responses = await Promise.allSettled(
 otherLocales.map(async (l) => {
 const res = await fetch(cdnDataUrl(`/data/jobs-${l}-index.json`));
 if (!res.ok) return [] as unknown[];
 const data = await res.json();
 return Array.isArray(data) ? (data as unknown[]) : [];
 }),
 );
 if (cancelled) return;
 const seen = new Set<string>();
 for (const j of unscopedJobs) seen.add(String(j.id || ''));
 for (const j of sortedJobs) seen.add(String(j.id || ''));
 const collected: JobListing[] = [];
 for (const r of responses) {
 if (r.status !== 'fulfilled') continue;
 for (const raw of r.value) {
 const id = String((raw as { id?: unknown })?.id ?? '');
 if (!id || seen.has(id)) continue;
 seen.add(id);
 collected.push(normalizeIncomingJob(raw));
 }
 }
 if (cancelled) return;
 setCrossLocaleJobs(dedupeJobsForListing(collected));
 } catch (err: unknown) {
 reportCaughtError(err, 'jobBoard.loadJobs.crossLocale');
 } finally {
 setPendingFallbacks((n) => n - 1);
 // Mark the terminal fallback settled (batched with setCrossLocaleJobs on the
 // success path, so results + settled flip together — no stale-0 frame).
 if (!cancelled) setCrossLocaleSettled(true);
 }
 })();
 return () => { cancelled = true; };
 }, [
 deferredSearchQuery, jobsLoading, locale,
 strictFilteredJobs.length, orFallbackInCantonJobs.length, crossCantonFallbackJobs.length,
 unscopedJobs, sortedJobs,
 // Load-bearing: on a search that is genuinely empty, the tier counts above
 // never change when the index completes, so without this dep the effect
 // would not re-run and the fallback would never fire at all.
 searchIndexPending,
 ]);

 // Shared locale-wide pool loader (slim index). Used by BOTH the company-hub
 // broaden and the search-broaden triggers so the fetch/normalize/dedupe path
 // lives in exactly one place (no copy-paste drift). The full jobs-{locale}.json
 // monolith fallback was removed (no longer shipped; listing needs no
 // descriptions). Returns the normalized pool, or null when nothing usable came
 // back; the caller owns the cancelled-guard + setState.
 const loadUnscopedPool = useCallback(async (): Promise<JobListing[] | null> => {
 let pool: unknown[] = [];
 const slimRes = await fetch(cdnDataUrl(`/data/jobs-${locale}-index.json`));
 if (slimRes.ok) {
 pool = await slimRes.json();
 }
 const arr = Array.isArray(pool) ? pool : [];
 if (arr.length === 0) return null;
 return dedupeJobsForListing(arr.map((job) => normalizeIncomingJob(job)));
 }, [locale]);

 // Company-hub broadening trigger: when a company filter is active and the
 // canton-scoped pool has ZERO openings for that employer (HQ in another
 // canton), lazy-load the locale-wide pool into `unscopedJobs` so the
 // company-broadening tier below can show its Swiss-wide openings instead of
 // the empty-state. One-shot per mount; skipped when the pool is already loaded.
 useEffect(() => {
 if (companyBroadenFetchAttempted.current) return;
 if (jobsLoading) return;
 if (!companySlugFilter) return;
 if (deferredSearchQuery.trim()) return; // search active → cross-locale tier owns the pool fetch
 if (strictFilteredJobs.length > 0) return; // employer has in-canton openings
 if (unscopedJobs.length > 0) return; // pool already available
 companyBroadenFetchAttempted.current = true;
 setPendingFallbacks((n) => n + 1);
 let cancelled = false;
 (async () => {
 try {
 const pool = await loadUnscopedPool();
 if (cancelled || !pool) return;
 setUnscopedJobs(pool);
 } catch (err: unknown) {
 reportCaughtError(err, 'jobBoard.loadJobs.companyBroaden');
 } finally {
 setPendingFallbacks((n) => n - 1);
 // Mark the terminal company-broaden fallback settled (batched with
 // setUnscopedJobs on the success path, so results + settled flip together —
 // no stale-0 frame). Mirrors the crossLocaleSettled pattern for Tier 4.
 if (!cancelled) setCompanyBroadenSettled(true);
 }
 })();
 return () => { cancelled = true; };
 }, [companySlugFilter, deferredSearchQuery, jobsLoading, strictFilteredJobs.length, unscopedJobs.length, locale, loadUnscopedPool]);

 // Search-broaden trigger: a canton-scoped SEARCH whose in-canton tiers are
 // thin (< BROADEN_BELOW) needs the locale-wide pool so the city-aware cross-
 // canton tier can fill the page. Distinct from the company trigger (no search)
 // and the cross-locale tier (other locales): this is same-locale, other-canton.
 // Skipped on the aggregate board (already nationwide) and when the pool is
 // already loaded. One-shot per mount (ref set only when we actually fetch, so a
 // later thin search still triggers if the first search was well-populated).
 useEffect(() => {
 if (searchBroadenFetchAttempted.current) return;
 if (jobsLoading) return;
 // The in-canton counts below are provisional until the index is complete.
 if (searchIndexPending) return;
 if (companySlugFilter) return; // company path owns its loader
 if (!deferredSearchQuery.trim()) return;
 if ((initialFilterCanton || getDefaultCantonForVisit()) === AGGREGATE_CANTON_CODE) return;
 if (unscopedJobs.length > 0) return; // pool already available
 // strict + OR-fill tail (the fill excludes strict ids, so no double count).
 const inCantonCount = strictFilteredJobs.length + orFallbackInCantonJobs.length;
 if (inCantonCount >= BROADEN_BELOW) return; // enough in-canton results already
 searchBroadenFetchAttempted.current = true;
 setPendingFallbacks((n) => n + 1);
 let cancelled = false;
 (async () => {
 try {
 const pool = await loadUnscopedPool();
 if (cancelled || !pool) return;
 setUnscopedJobs(pool);
 } catch (err: unknown) {
 reportCaughtError(err, 'jobBoard.loadJobs.searchBroaden');
 } finally {
 setPendingFallbacks((n) => n - 1);
 }
 })();
 return () => { cancelled = true; };
 // `searchIndexPending` is load-bearing, same reason as the cross-locale tier:
 // a genuinely thin search leaves every other dep unchanged when the index
 // completes, so the broaden would never fire without it.
 }, [companySlugFilter, deferredSearchQuery, jobsLoading, initialFilterCanton, strictFilteredJobs.length, orFallbackInCantonJobs.length, unscopedJobs.length, locale, loadUnscopedPool, searchIndexPending]);

 // Tier 4: cross-locale OR fallback. Same scoring as Tier 3, run against the
 // lazily-loaded DE/FR/EN pool. Job ID + slug are canonical across locale
 // shards, so the result still routes to the Italian URL via the existing
 // slug field — the only thing that may render in another language is the
 // title when no IT translation exists for that record.
 const crossLocaleFallbackJobs = useMemo<JobListing[]>(() => {
 const query = deferredSearchQuery.trim();
 if (!query) return [];
 if (strictFilteredJobs.length > 0) return [];
 if (orFallbackInCantonJobs.length > 0) return [];
 if (crossCantonFallbackJobs.length > 0) return [];
 if (crossLocaleJobs.length === 0) return [];

 // Score the boilerplate-stripped query (see `orFallbackQuery`) so the
 // tokens match the floor's content-token count.
 const queryTokens = normalizeSearchText(orFallbackQuery).split(' ').filter(Boolean).map(stemSearchToken);
 if (queryTokens.length === 0) return [];

 const now = Date.now();
 const cutoff = deferredSelectedDateRange === 'all' ? 0 : now - DATE_RANGE_MS[deferredSelectedDateRange];

 const scored: { job: JobListing; score: number }[] = [];
 for (const job of crossLocaleJobs) {
 if (isForeignLocation(job.addressLocality || job.location || '')) continue;
 if (!passingNonSearchFilters(job, now, cutoff)) continue;
 const haystack = getBroadenHaystack(job, locale);
 let score = 0;
 for (const t of queryTokens) {
 if (haystack.includes(` ${t}`)) score++;
 }
 if (score >= orFallbackMinScore) scored.push({ job, score });
 }
 scored.sort((a, b) => b.score - a.score);
 return scored.slice(0, MAX_FALLBACK_RESULTS).map((x) => x.job);
 }, [
 strictFilteredJobs.length, orFallbackInCantonJobs.length, crossCantonFallbackJobs.length,
 crossLocaleJobs, deferredSearchQuery, orFallbackQuery, deferredSelectedDateRange, passingNonSearchFilters, locale, orFallbackMinScore,
 ]);

 // Tier 3.5 — company-hub broadening. Fires when a company filter is active
 // but every in-canton tier (and the search cross-canton tier) returned zero:
 // typically a company-hub URL like
 // /cerca-lavoro-ticino/azienda-grace-la-margna-st-moritz/ whose employer
 // sits in another canton (Grace La Margna → GR). Drops the canton scope and
 // surfaces the employer's openings from the locale-wide `unscopedJobs` pool
 // so the page shows real listings + AdSense instead of the empty-state. No
 // search query required — distinct from the search-driven Tiers 3/4. The
 // company filter itself is still enforced via `passingNonSearchFilters`.
 //
 // Gated to the NO-query case: when the user types a search on a company hub
 // this tier stays out so the search-driven cross-locale Tier 4 can answer
 // the keyword instead of dumping every Swiss-wide opening for the employer
 // (which would ignore the query and mislead the "N positions" banner).
 const companyBroadeningFallbackJobs = useMemo<JobListing[]>(() => {
 if (!companySlugFilter) return [];
 if (deferredSearchQuery.trim()) return [];
 if (strictFilteredJobs.length > 0) return [];
 if (orFallbackInCantonJobs.length > 0) return [];
 if (crossCantonFallbackJobs.length > 0) return [];
 if (unscopedJobs.length === 0) return [];

 const now = Date.now();
 const cutoff = deferredSelectedDateRange === 'all' ? 0 : now - DATE_RANGE_MS[deferredSelectedDateRange];

 const scopedIds = new Set<string>();
 for (const j of sortedJobs) scopedIds.add(j.id);

 const matches: JobListing[] = [];
 for (const job of unscopedJobs) {
 if (scopedIds.has(job.id)) continue;
 if (isForeignLocation(job.addressLocality || job.location || '')) continue;
 if (!passingNonSearchFilters(job, now, cutoff)) continue; // company filter enforced here
 matches.push(job);
 }
 return matches.slice(0, MAX_FALLBACK_RESULTS);
 }, [companySlugFilter, deferredSearchQuery, strictFilteredJobs.length, orFallbackInCantonJobs.length, crossCantonFallbackJobs.length, unscopedJobs, sortedJobs, deferredSelectedDateRange, passingNonSearchFilters]);

 // filteredJobs: the tiered search result.
 //   1. strictFilteredJobs (AND across all tokens, in-canton)
 //   2. orFallbackInCantonJobs (partial-token OR, in-canton)
 //   3. crossCantonFallbackJobs (partial-token OR, other cantons, same locale)
 //   3.5 companyBroadeningFallbackJobs (company filter, Swiss-wide, no query)
 //   4. crossLocaleFallbackJobs (partial-token OR, other locale shards)
 // The canton-scoped intent stays primary, but when the in-canton tier returns
 // a thin set (< BROADEN_BELOW) the cross-canton tier is APPENDED rather than
 // replacing it: in-canton matches first, then the city-aware broadened tail,
 // deduped by id. crossCantonFallbackJobs is itself empty once in-canton fills
 // (>= BROADEN_BELOW), so the merge is a no-op on healthy pages.
 /**
  * True while the build's seeded result set is still the right answer for what
  * is on screen: the visitor has not changed the query away from the one this
  * page is about, and is not in a company/location view (those have their own
  * loaders and their own corpora). Facet filters are deliberately NOT part of
  * this test — they narrow the seeded set inside the tier rather than throwing
  * it away, which is what a visitor ticking "ultime 24h" expects.
  */
 const clusterSeedApplies = clusterSeedJobs.length > 0
   && !!clusterSeed
   && deferredSearchQuery.trim() === clusterSeed.q.trim()
   && !companySlugFilter
   && !locationSlugFilter;

 const filteredJobs = useMemo<JobListing[]>(() => {
 // Sponsored ads matching the query surface above organic results, even when
 // they arrive via a fallback tier (e.g. a sponsored ad from another canton
 // appended after in-canton matches). Stable partition — relative order
 // within each group is untouched, and featured is capped at 6/canton.
 const featuredFirst = (list: JobListing[]): JobListing[] => {
 if (!list.some((j) => j.featured)) return list;
 return [...list.filter((j) => j.featured), ...list.filter((j) => !j.featured)];
 };
 // Tier 0 — the answer the BUILD computed for this exact page. It is not a
 // faster route to the same set: it is a set this board cannot reach, because
 // the emitter matched against job descriptions and the slim index carries
 // none. Recomputing here would silently drop on-intent results the crawler
 // and the first paint both already showed.
 //
 // Scope is deliberately narrow. It holds only while the query is still the
 // page's own (`clusterSeed.q`, derived by the same parseSearchSlugFilter the
 // search box is prefilled with) and no company/location view is active — the
 // moment the visitor types, the normal tiers take over and this never fires
 // again for that keystroke. Facet filters still apply, so picking a canton or
 // a contract narrows the seeded set instead of discarding it.
 if (clusterSeedApplies) {
 const now = Date.now();
 const cutoff = deferredSelectedDateRange === 'all'
 ? 0
 : now - DATE_RANGE_MS[deferredSelectedDateRange];
 return featuredFirst(clusterSeedJobs.filter((job) => passingNonSearchFilters(job, now, cutoff)));
 }
 // Merge the strict AND matches (first) with the in-canton OR-fill tail
 // (already excludes strict ids) so a thin strict tier is topped up to the
 // static cluster page's job set instead of collapsing to a single result.
 const seenInCanton = new Set<string>();
 const inCanton: JobListing[] = [];
 for (const j of strictFilteredJobs) { if (!seenInCanton.has(j.id)) { seenInCanton.add(j.id); inCanton.push(j); } }
 for (const j of orFallbackInCantonJobs) { if (!seenInCanton.has(j.id)) { seenInCanton.add(j.id); inCanton.push(j); } }
 if (inCanton.length > 0) {
 if (crossCantonFallbackJobs.length === 0) return featuredFirst(inCanton);
 const seen = new Set<string>();
 const merged: JobListing[] = [];
 for (const j of inCanton) { if (!seen.has(j.id)) { seen.add(j.id); merged.push(j); } }
 for (const j of crossCantonFallbackJobs) { if (!seen.has(j.id)) { seen.add(j.id); merged.push(j); } }
 return featuredFirst(merged);
 }
 if (crossCantonFallbackJobs.length > 0) return featuredFirst(crossCantonFallbackJobs);
 if (companyBroadeningFallbackJobs.length > 0) return featuredFirst(companyBroadeningFallbackJobs);
 return featuredFirst(crossLocaleFallbackJobs);
 }, [clusterSeedApplies, clusterSeedJobs, deferredSelectedDateRange, passingNonSearchFilters,
 strictFilteredJobs, orFallbackInCantonJobs, crossCantonFallbackJobs, companyBroadeningFallbackJobs, crossLocaleFallbackJobs]);

 // A search/company view momentarily shows a non-authoritative `filteredJobs`:
 // either empty while the lazy broaden / cross-locale pools are still being
 // fetched, OR a misleading provisional count from the first-page slim paint
 // before the full shard lands (`fullLoadPending`). Treat both windows as
 // "loading" so the count + banner + cards never flash "1 / 0" before the real
 // results land. The `fullLoadPending` arm is what catches the provisional
 // count on SSG hydration, where the effect-level first-paint skip can miss it
 // (the load effect runs before `searchQuery` syncs from the slug). Covers the
 // in-flight fallback phase (pendingFallbacks) and the first frame after the
 // index load, before the fetch effects have fired (no fallback attempted yet).
 const anyFallbackAttempted =
 searchBroadenFetchAttempted.current
 || companyBroadenFetchAttempted.current
 || crossLocaleFetchAttempted.current;
 const resultsResolving =
 (Boolean(deferredSearchQuery.trim()) || Boolean(companySlugFilter))
 // ...unless the build already handed us the answer. With the cluster seed
 // applied `filteredJobs` is not provisional — it is the exact set this page
 // was emitted with, complete on the first frame — so holding the skeleton
 // until the shards land would spend the whole win on an animation. Every
 // window below is about waiting for a corpus we no longer need to wait for.
 && !clusterSeedApplies
 && (
 fullLoadPending
 || (filteredJobs.length === 0 && (
 pendingFallbacks > 0
 || !anyFallbackAttempted
 // Terminal cross-locale fallback (Tier 4) hasn't fully SETTLED yet. For a
 // 0-result search the in-canton tiers are all empty, so this fetch fires and
 // may still bring results — hold the skeleton across its entire lifecycle
 // (fetch + the heavy ~2s parse/dedup of the en/de/fr indexes), not just until
 // it's attempted, so the count never flashes "0" mid-processing. `settled`
 // flips true batched with the results, after which a still-empty set falls
 // through to the genuine empty-state (so a truly empty query isn't stuck).
 || (Boolean(deferredSearchQuery.trim()) && !crossLocaleSettled)
 // Terminal company-broaden fallback (Tier 3.5) hasn't fully SETTLED yet.
 // For a company-only view (no search) the in-canton tiers are empty, so
 // this fetch fires and may still bring results — hold the skeleton across
 // its entire lifecycle (fetch + parse/dedup of the locale-wide pool), not
 // just until it's attempted, so the count never flashes "0" mid-processing.
 // `settled` flips true batched with the results; a still-empty set then
 // falls through to the genuine empty-state (not stuck). Mirrors the
 // crossLocaleSettled guard for the search path (Tier 4).
 || (Boolean(companySlugFilter) && !deferredSearchQuery.trim() && !companyBroadenSettled)
 // The query-match search index (`searchIndex`) is built incrementally over
 // the loaded jobs via rAF chunks and only committed when complete. Until it
 // describes the CURRENT (jobs, locale) pair, `indexedQueryMatch` returns no
 // hits, so a search reads 0 even when matches exist. Hold the skeleton until
 // then; a still-0 result after that is a genuine empty-state. Same flag now
 // gates the lazy corpus-fetch tiers — see searchIndexPending.
 || searchIndexPending
 ))
 );

 // True when the result set is the in-canton OR-fallback (Tier 2). Keeps
 // the existing "No exact match for «…»" banner triggered.
 const isUsingSearchFallback = useMemo(() => {
 return Boolean(deferredSearchQuery.trim())
 && strictFilteredJobs.length === 0
 && orFallbackInCantonJobs.length > 0
 && crossCantonFallbackJobs.length === 0; // broadened → the broaden banner owns the message
 }, [deferredSearchQuery, strictFilteredJobs.length, orFallbackInCantonJobs.length, crossCantonFallbackJobs.length]);

 // True when SOME in-canton results exist but were thin (< BROADEN_BELOW) and
 // the city-aware cross-canton tier was appended. Distinct from the pure
 // cross-canton banner (which asserts ZERO in-canton offers) — here we DO have
 // a few local matches, so the copy says the search was *extended*.
 const isBroadenedSearch = useMemo(() => {
 return Boolean(deferredSearchQuery.trim())
 && (strictFilteredJobs.length > 0 || orFallbackInCantonJobs.length > 0)
 && crossCantonFallbackJobs.length > 0;
 }, [deferredSearchQuery, strictFilteredJobs.length, orFallbackInCantonJobs.length, crossCantonFallbackJobs.length]);

 // True when the result set is the cross-canton fallback (Tier 3). Drives
 // a distinct banner so users understand they're seeing jobs from outside
 // the canton they navigated into.
 const isCrossCantonFallback = useMemo(() => {
 return Boolean(deferredSearchQuery.trim())
 && strictFilteredJobs.length === 0
 && orFallbackInCantonJobs.length === 0
 && crossCantonFallbackJobs.length > 0;
 }, [deferredSearchQuery, strictFilteredJobs.length, orFallbackInCantonJobs.length, crossCantonFallbackJobs.length]);

 // True when the result set is the cross-locale fallback (Tier 4). Banner
 // signals that the displayed titles may not be in the current UI locale.
 const isCrossLocaleFallback = useMemo(() => {
 return Boolean(deferredSearchQuery.trim())
 && strictFilteredJobs.length === 0
 && orFallbackInCantonJobs.length === 0
 && crossCantonFallbackJobs.length === 0
 && crossLocaleFallbackJobs.length > 0;
 }, [deferredSearchQuery, strictFilteredJobs.length, orFallbackInCantonJobs.length, crossCantonFallbackJobs.length, crossLocaleFallbackJobs.length]);

 // True when the result set is the company-hub broadening tier (Tier 3.5):
 // a company-filtered page whose employer has no in-canton openings, now
 // showing its Swiss-wide listings. Drives a banner so the user understands
 // the scope was widened beyond the canton in the URL.
 const isBroadenedCompanyScope = useMemo(() => {
 return Boolean(companySlugFilter)
 && strictFilteredJobs.length === 0
 && orFallbackInCantonJobs.length === 0
 && crossCantonFallbackJobs.length === 0
 && companyBroadeningFallbackJobs.length > 0;
 }, [companySlugFilter, strictFilteredJobs.length, orFallbackInCantonJobs.length, crossCantonFallbackJobs.length, companyBroadeningFallbackJobs.length]);

 // Resolve the display name of the company when a company slug filter is active
 const companyDisplayName = useMemo(() => {
 if (!companySlugFilter) return null;
 const firstMatch = filteredJobs[0];
 return firstMatch?.company ?? null;
 }, [companySlugFilter, filteredJobs]);

 // Resolve the curated employer brand (EOC, …) by canonical slug.
 // Falls back to null for companies without a curated hub page.
 const employerBrand = useMemo(
 () => (companySlugFilter ? getEmployerBrandBySlug(companySlugFilter) : null),
 [companySlugFilter],
 );

 // All jobs for this employer, ignoring the secondary filters (search,
 // category, contract…). The curated hub shows an unfiltered count so the
 // page remains useful even when the user narrows the list afterwards.
 const employerBrandJobs = useMemo(() => {
 if (!employerBrand || !companySlugFilter) return [] as typeof sortedJobs;
 return sortedJobs.filter((job) => {
 const slugCandidates = companyRouteSlugCandidates(job.company, job.companyKey);
 return slugCandidates.has(companySlugFilter);
 });
 }, [employerBrand, companySlugFilter, sortedJobs]);

 // Resolve the display name of the location when a location slug filter is active
 const locationDisplayName = useMemo(() => {
 if (!locationSlugFilter) return null;
 const firstMatch = filteredJobs[0];
 return firstMatch?.addressLocality || firstMatch?.location || null;
 }, [locationSlugFilter, filteredJobs]);

 const relatedSearchSuggestions = useMemo(() => {
 const baseQuery = deferredSearchQuery.trim();
 if (!baseQuery) return [];
 const matching = sortedJobs.filter((job) => indexedQueryMatch(job, baseQuery));
 if (matching.length === 0) return [];

 const seen = new Set<string>();
 const normBase = normalizeSearchText(baseQuery);
 const out: string[] = [];
 const add = (term: string) => {
 const clean = String(term || '').replace(/\s+/g, ' ').trim();
 if (!isValidRelatedSearchTerm(clean)) return;
 const key = normalizeSearchText(clean);
 if (!key || key === normBase || seen.has(key)) return;
 // Validate candidate against the already-filtered matches instead of all jobs (O(n) vs O(n²))
 if (!matching.some((job) => indexedQueryMatch(job, clean))) return;
 seen.add(key);
 out.push(clean);
 };

 for (const job of matching.slice(0, 40)) {
 const title = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title).split(/[-–—|•·]/)[0]?.trim() || '';
 const company = String(job.company || '').trim();
 const location = String(job.location || '').trim();
 if (company && location) add(`${company} ${location}`);
 if (title && location) add(`${title} ${location}`);
 if (company) add(company);
 if (title) add(title);
 if (out.length >= 5) break;
 }

 return out.slice(0, 5);
 }, [deferredSearchQuery, sortedJobs, locale, indexedQueryMatch]);

 // Autocomplete suggestions as user types in job search
 const autocompleteSuggestions = useMemo(() => {
 const q = deferredSearchQuery.trim().toLowerCase();
 if (!q || q.length < 2) return [];
 const seen = new Set<string>();
 const suggestions: string[] = [];
 const add = (text: string) => {
 const clean = text.trim();
 if (!clean || clean.toLowerCase() === q) return;
 const key = clean.toLowerCase();
 if (seen.has(key)) return;
 seen.add(key);
 suggestions.push(clean);
 };
 for (const job of sortedJobs) {
 const title = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title).split(/[-–—|•·]/)[0]?.trim() || '';
 if (title.toLowerCase().startsWith(q)) add(title);
 const company = String(job.company || '').trim();
 if (company.toLowerCase().startsWith(q)) add(company);
 const location = String(job.location || '').trim();
 if (location.toLowerCase().startsWith(q)) add(location);
 if (suggestions.length >= 5) break;
 }
 return suggestions.slice(0, 5);
 }, [deferredSearchQuery, sortedJobs, locale]);

 // Smart 0-results (issue #4301): candidate pool of real job titles/
 // locations for fuzzy "did you mean" suggestions when the query matches
 // nothing (autocompleteSuggestions above only catches startsWith matches,
 // so a typo or an unrelated-but-close term surfaces nothing there).
 const zeroResultCandidatePool = useMemo(() => {
 if (filteredJobs.length !== 0) return [];
 const seen = new Set<string>();
 const out: string[] = [];
 for (const job of sortedJobs) {
 const title = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title).split(/[-–—|•·]/)[0]?.trim() || '';
 const location = String(job.location || '').trim();
 for (const candidate of [title, location]) {
 if (!candidate) continue;
 const key = candidate.toLowerCase();
 if (seen.has(key)) continue;
 seen.add(key);
 out.push(candidate);
 }
 if (out.length >= 300) break;
 }
 return out;
 }, [filteredJobs.length, sortedJobs, locale]);

 const zeroResultSuggestions = useMemo(() => {
 const q = deferredSearchQuery.trim();
 if (filteredJobs.length !== 0 || q.length < 2) return [];
 return suggestSimilarTerms(q, zeroResultCandidatePool, 5);
 }, [filteredJobs.length, deferredSearchQuery, zeroResultCandidatePool]);

 const editorialLandingSections = useMemo(() => {
 // Build slug→job index for O(1) lookups (Vercel rule 7.13)
 const slugIndex = new Map<string, JobListing>();
 for (const job of jobs) {
 if (job.slug) slugIndex.set(job.slug, job);
 if (job.slugByLocale) {
 for (const s of Object.values(job.slugByLocale) as (string | undefined)[]) {
 if (s) slugIndex.set(s, job);
 }
 }
 if (job.previousSlugs) {
 for (const s of job.previousSlugs) {
 if (s) slugIndex.set(s, job);
 }
 }
 if (job.previousSlugsByLocale) {
 for (const arr of Object.values(job.previousSlugsByLocale) as string[][]) {
 if (Array.isArray(arr)) for (const s of arr) {
 if (s) slugIndex.set(s, job);
 }
 }
 }
 // Index derived locale slugs (covers fallback generation in matchesRouteSlug)
 for (const loc of (['it', 'en', 'de', 'fr'] as const)) {
 const derived = deriveLocalizedJobSlug(job, loc);
 if (derived) slugIndex.set(derived, job);
 }
 }

 const resolveJobFromHref = (href: string): JobListing | null => {
 const slug = href.split('/').filter(Boolean).pop() || '';
 return slugIndex.get(slug) || null;
 };

 if (editorialOfficialGazetteLanding) {
 return [
 {
 id: 'official-competitions',
 label: editorialOfficialGazetteLanding.feed.label,
 jobs: editorialOfficialGazetteLanding.feed.jobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 {
 id: 'latest-public',
 label: editorialOfficialGazetteLanding.latestLabel,
 jobs: editorialOfficialGazetteLanding.latestJobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 ];
 }

 if (editorialJobTodayLanding) {
 return [
 {
 id: 'last-24-hours',
 label: editorialJobTodayLanding.sections.last24Hours.label,
 jobs: editorialJobTodayLanding.sections.last24Hours.jobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 {
 id: 'last-3-days',
 label: editorialJobTodayLanding.sections.last3Days.label,
 jobs: editorialJobTodayLanding.sections.last3Days.jobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 {
 id: 'part-time',
 label: editorialJobTodayLanding.sections.partTime.label,
 jobs: editorialJobTodayLanding.sections.partTime.jobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 ];
 }

 if (editorialLocationLanding) {
 return [
 {
 id: 'local-feed',
 label: editorialLocationLanding.feed.label,
 jobs: editorialLocationLanding.feed.jobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 {
 id: 'latest-local',
 label: editorialLocationLanding.latestLabel,
 jobs: editorialLocationLanding.latestJobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 ];
 }

 if (editorialLocationTypeLanding) {
 return [
 {
 id: 'local-type-feed',
 label: editorialLocationTypeLanding.feed.label,
 jobs: editorialLocationTypeLanding.feed.jobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 {
 id: 'latest-local-type',
 label: editorialLocationTypeLanding.latestLabel,
 jobs: editorialLocationTypeLanding.latestJobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 ];
 }

 if (editorialLocationSectorLanding) {
 return [
 {
 id: 'local-sector-feed',
 label: editorialLocationSectorLanding.feed.label,
 jobs: editorialLocationSectorLanding.feed.jobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 {
 id: 'latest-local-sector',
 label: editorialLocationSectorLanding.latestLabel,
 jobs: editorialLocationSectorLanding.latestJobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 ];
 }

 if (editorialNursesHubLanding) {
 return [
 {
 id: 'nurses-feed',
 label: editorialNursesHubLanding.feed.label,
 jobs: editorialNursesHubLanding.feed.jobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 {
 id: 'nurses-latest',
 label: editorialNursesHubLanding.latestLabel,
 jobs: editorialNursesHubLanding.latestJobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 ];
 }

 if (editorialSectorRegionLanding) {
 return [
 {
 id: 'sector-region-feed',
 label: editorialSectorRegionLanding.feed.label,
 jobs: editorialSectorRegionLanding.feed.jobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 {
 id: 'sector-region-latest',
 label: editorialSectorRegionLanding.latestLabel,
 jobs: editorialSectorRegionLanding.latestJobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 ];
 }

 if (editorialPartTimeLanding) {
 return [
 {
 id: 'part-time-feed',
 label: editorialPartTimeLanding.feed.label,
 jobs: editorialPartTimeLanding.feed.jobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 {
 id: 'part-time-latest',
 label: editorialPartTimeLanding.latestLabel,
 jobs: editorialPartTimeLanding.latestJobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 ];
 }

 if (editorialCareVariantLanding) {
 return [
 {
 id: 'care-variant-feed',
 label: editorialCareVariantLanding.feed.label,
 jobs: editorialCareVariantLanding.feed.jobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 {
 id: 'care-variant-latest',
 label: editorialCareVariantLanding.latestLabel,
 jobs: editorialCareVariantLanding.latestJobs.map((item) => resolveJobFromHref(item.href)).filter(Boolean) as JobListing[],
 },
 ];
 }
 return [];
 }, [editorialOfficialGazetteLanding, editorialJobTodayLanding, editorialLocationLanding, editorialLocationTypeLanding, editorialLocationSectorLanding, editorialSectorRegionLanding, editorialNursesHubLanding, editorialPartTimeLanding, editorialCareVariantLanding, jobs]);

 useEffect(() => {
 if (skipPageReset.current) { skipPageReset.current = false; return; }
 setPage(1);
 setMobileJobLimit(10);
 syncQueryParamsToUrl({ page: null });
 setAdRefreshKey((k) => k + 1);
 }, [deferredSearchQuery, selectedCategory, selectedContract, selectedCompany, selectedDateRange, showNewOnly, showSavedOnly]);

 // Sync search query to URL (?q=) and track in GA4
 useEffect(() => {
 if (!deferredSearchQuery.trim()) {
 syncQueryParamsToUrl({ q: null });
 return;
 }
 // Only sync if query didn't come from a slug route (avoid overwriting /ricerca-X URLs)
 if (!searchSlugFilter) {
 syncQueryParamsToUrl({ q: deferredSearchQuery.trim() });
 }
 Analytics.trackSearch(deferredSearchQuery.trim(), { resultsCount: filteredJobs.length, searchSource: 'job-board' });
 }, [deferredSearchQuery, searchSlugFilter, filteredJobs.length]);

 const totalPages = Math.max(1, Math.ceil(filteredJobs.length / pageSize));
 const currentPage = Math.min(page, totalPages);

 const pagedJobs = useMemo(() => {
 const start = (currentPage - 1) * pageSize;
 return filteredJobs.slice(start, start + pageSize);
 }, [filteredJobs, currentPage]);

 // Mobile: accumulate jobs via load-more; Desktop: use pagedJobs
 const mobileJobs = useMemo(() => filteredJobs.slice(0, mobileJobLimit), [filteredJobs, mobileJobLimit]);
 const displayJobs = isMobile ? mobileJobs : pagedJobs;
 const hasMoreMobileJobs = isMobile && mobileJobLimit < filteredJobs.length;

 const loadMoreMobile = useCallback(() => {
 setMobileJobLimit((prev) => prev + 10);
 setAdRefreshKey((k) => k + 1);
 }, []);

 // Infinite scroll sentinel for mobile
 const jobSentinelRef = useRef<HTMLDivElement>(null);
 useEffect(() => {
 if (!isMobile || !hasMoreMobileJobs) return;
 const el = jobSentinelRef.current;
 if (!el) return;
 const io = new IntersectionObserver(
 ([entry]) => { if (entry.isIntersecting) loadMoreMobile(); },
 { rootMargin: '200px' },
 );
 io.observe(el);
 return () => io.disconnect();
 }, [isMobile, hasMoreMobileJobs, loadMoreMobile]);

 // INP: computeSimilarJobs re-scores + sorts the full loaded pool (up to
 // ~12k on the Switzerland-wide aggregator) every time a job card is opened.
 // selectedJob updates synchronously as part of the click's route change, so
 // without deferring, this recompute lands in the SAME commit as the click's
 // paint and blocks the detail view from appearing (field p75 INP regression
 // on /cerca-lavoro-svizzera/, #4675 — persisted after #4324's personalization
 // defer). Deferring selectedJob here schedules the recompute at low
 // priority so it yields to the click's own paint first, same technique as
 // the deferred* personalization inputs above (#4302).
 const deferredSelectedJobForRelated = useDeferredValue(selectedJob);
 const relatedJobs = useMemo(() => {
 if (!deferredSelectedJobForRelated) return [];
 return computeSimilarJobs(deferredSelectedJobForRelated, sortedJobs);
 }, [deferredSelectedJobForRelated, sortedJobs]);

 // Expired/orphan/bridge cascade: fetch expired-jobs.json only when needed.
 // When build-time seeded data exists (window.__EXPIRED_JOB_DATA__), pass the slug
 // eagerly — even while jobs.json is still loading — so the hook can return the
 // seeded data synchronously and we render JobExpiredView instead of a spinner.
 const seeded = useMemo(() => hasSeededExpiredData(), []);
 const notFoundSlug = initialJobSlug && !companySlugFilter && !locationSlugFilter && !searchSlugFilter && !bridgeTargetSlug
 && (seeded || (!jobsLoading && !selectedJob))
 ? initialJobSlug
 : undefined;
 const { expiredJob, loading: expiredJobLoading } = useExpiredJob(notFoundSlug);

 // Related jobs for expired/bridge views — score by category/location from jobs store
 const relatedJobsForNotFound = useMemo(() => {
 const category = expiredJob?.sector;
 const company = expiredJob?.company;
 return sortedJobs
 .filter((j) => j.slug)
 .map((j) => {
 let score = 0;
 if (category && j.category === category) score += 3;
 if (company && j.company === company) score += 2;
 const freshness = new Date(j.crawledAt || j.postedDate).getTime();
 return { job: j, score, freshness };
 })
 .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.freshness - a.freshness))
 .slice(0, 6)
 .map((x) => x.job);
 }, [expiredJob, sortedJobs]);

 // Load blog meta translations + articles data for cross-linking (only when job selected).
 // preloadBlogData in the same gate: blogMetaReady implies BLOG_SLUGS present,
 // so the related-article hrefs below are canonical by construction (the slug
 // map no longer preloads unconditionally at App mount — #3528/#3532). Failure
 // swallowed: degrade to id-fallback hrefs instead of hiding the section.
 const [blogMetaReady, setBlogMetaReady] = useState(false);
 const [blogArticles, setBlogArticles] = useState<Article[]>([]);
 useEffect(() => {
 if (!selectedJob) return;
 Promise.all([
 loadBlogMeta(),
 preloadBlogData().catch(() => {}),
 // #4176: resilientImport so a transient CDN deploy-window failure on the
 // non-hashed blog-articles-data.js chunk self-heals instead of surfacing.
 resilientImport(() => import('@/data/blog-articles-data'), m => Array.isArray(m.ARTICLES)).then(m => m.ARTICLES),
 ]).then(([, , data]) => {
 setBlogArticles(data);
 setBlogMetaReady(true);
 }).catch(() => {});
 }, [selectedJob]);

 const relatedArticles = useMemo(() => {
 if (!selectedJob || !blogMetaReady || blogArticles.length === 0) return [];
 return getRelatedArticlesForJob(selectedJob, blogArticles, locale, t);
 }, [selectedJob, blogMetaReady, blogArticles, locale, t]);

 const detailDescription = useMemo(() => {
 if (!selectedJob) return '';
 return selectedJob.descriptionByLocale?.[locale] ?? selectedJob.description ?? '';
 }, [selectedJob, locale]);

 const detailParagraphs = useMemo(() => {
 if (!detailDescription) return [];
 return normalizeParagraphs(detailDescription);
 }, [detailDescription]);

 const selectedJobTitle = selectedJob ? sanitizeJobTitle(selectedJob.titleByLocale?.[locale] ?? selectedJob.title) : '';

 useEffect(() => {
 if (jobs.length === 0) return;
 // FRO: Skip dynamic schema injection for expired/orphan/bridge job pages —
 // the build plugin already injected a static JobPosting JSON-LD.
 // Guard 1: slug set but no active job found → expired/orphan page.
 if (initialJobSlug && !selectedJob) {
 return;
 }
 // Guard 2: page has __EXPIRED_JOB_DATA__ seeded by build plugin → expired page.
 // This catches the case where an expired slug also appears in an active job's
 // previousSlugs (slug rename history), making selectedJob non-null.
 if (hasSeededExpiredData()) {
 return;
 }
 // Guard 3: bridge page (old slug redirect) — build plugin handles schema.
 if (bridgeTargetSlug) {
 return;
 }

 const toIsoDateTime = (raw?: string): string => {
 if (!raw) return new Date().toISOString();
 const parsed = new Date(raw);
 if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
 const safe = new Date(`${raw}T00:00:00.000Z`);
 return Number.isNaN(safe.getTime()) ? new Date().toISOString() : safe.toISOString();
 };

 const toValidThrough = (postedRaw?: string): string => {
 const posted = new Date(toIsoDateTime(postedRaw));
 posted.setUTCDate(posted.getUTCDate() + 60);
 // Floor to now+30d (#3505): these are ACTIVE listings — a stale postedDate
 // must not emit an already-past validThrough (Google drops it as expired).
 const floor = new Date();
 floor.setUTCDate(floor.getUTCDate() + 30);
 return (posted.getTime() < floor.getTime() ? floor : posted).toISOString();
 };

 const jobsForSchema = selectedJob ? [selectedJob] : pagedJobs;
 const jobPostings = jobsForSchema.map((job): Record<string, unknown> | null => {
 const jobPath = buildJobPath(job);
 const canonicalUrl = `${window.location.origin}${jobPath}`;
 const description = (
 job.descriptionByLocale?.[locale] ||
 job.descriptionByLocale?.['it'] ||
 job.description ||
 ''
 ).trim();
 const localizedTitle = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title);
 const isRemote = /remote|telelavor|smart[-\s]?working|home office|hybrid/i.test(
 `${localizedTitle} ${description || ''} ${job.location || ''}`
 );
 // JSON-LD hiringOrganization.logo needs a fetchable URL — companyLogoUrl can
 // now return an inlined initials data: URI (fine for <img>, not for schema),
 // so fall back to the site icon for those rather than emitting a data URI.
 // Root-relative same-origin paths (CDN base not injected, e.g. dev) are
 // absolutized: schema.org `logo` is URL-typed and Google can ignore a
 // relative value (#3473). `//` = protocol-relative, never prefixed.
 const rawLogo = companyLogoUrl(job);
 const logo = rawLogo && !rawLogo.startsWith('data:')
 ? (rawLogo.startsWith('/') && !rawLogo.startsWith('//')
 ? `${window.location.origin}${rawLogo}`
 : rawLogo)
 : 'https://frontaliereticino.ch/icons/icon-512x512.png';
 const salaryMin = Number.isFinite(Number(job.salaryMin))
 ? Number(job.salaryMin)
 : Number(job.baseSalary?.value?.minValue);
 const salaryMax = Number.isFinite(Number(job.salaryMax))
 ? Number(job.salaryMax)
 : Number(job.baseSalary?.value?.maxValue);
 const salaryCurrency = String(job.currency || job.baseSalary?.currency || job.baseSalary?.value?.currency || 'CHF');
 // Sanitize address fields — reject crawler artifacts and non-geographic strings
 const isValidAddr = (s: string) => s && s.length <= 100 && (s.match(/\s/g) || []).length <= 8 && !/stampa|segnalazione|descrizione|annuncio|verifica|attività|dillo/i.test(s);
 const rawLocality = String(job.addressLocality || '').trim();
 const multiLoc = isMultiLocation(job.location) || isMultiLocation(rawLocality);
 const addressLocality = multiLoc ? 'Switzerland' : (isValidAddr(rawLocality) ? rawLocality : String(job.location || DEFAULT_CANTON_DISPLAY));
 const addressRegion = multiLoc ? 'CH' : String(job.canton || DEFAULT_CANTON);
 const addressCountry = String(job.addressCountry || 'CH');
 const postalCode = deriveJobPostalCode(job);
 const rawStreet = String(job.streetAddress || '').trim();
 const streetAddress = isValidAddr(rawStreet) ? rawStreet : '';
 const posting: Record<string, unknown> = {
 '@type': 'JobPosting',
 title: localizedTitle,
 description,
 inLanguage: locale,
 datePosted: toIsoDateTime(job.postedDate),
 validThrough: toValidThrough(job.postedDate),
 employmentType: CONTRACT_TO_EMPLOYMENT_TYPE[normalizeJobContract(job.contract, localizedTitle, description)] || 'OTHER',
 identifier: {
 '@type': 'PropertyValue',
 name: job.company,
 value: job.id,
 },
 hiringOrganization: {
 '@type': 'Organization',
 name: job.company,
 sameAs: (() => {
 const host = resolveCompanyWebsiteHost({
 company: job.company,
 companyKey: job.companyKey,
 companyDomain: job.companyDomain,
 url: job.url,
 });
 return host ? `https://www.${host}` : 'https://frontaliereticino.ch';
 })(),
 logo,
 },
 jobLocationType: isRemote ? 'TELECOMMUTE' : undefined,
 jobLocation: {
 '@type': 'Place',
 address: {
 '@type': 'PostalAddress',
 addressLocality: isRemote ? 'Switzerland' : addressLocality,
 addressRegion: isRemote ? 'CH' : addressRegion,
 addressCountry,
 postalCode: postalCode || CANTON_FALLBACK_POSTAL[addressRegion] || DEFAULT_POSTAL_CODE,
 streetAddress: streetAddress || addressLocality || DEFAULT_CANTON_DISPLAY,
 },
 },
 directApply: Boolean(job.url),
 url: canonicalUrl,
 };
 if (isRemote) {
 // Scoped to remote jobs only — an on-site job is not "open to applicants
 // from CH" in the schema.org sense (mirrors build-plugins/shared/jobPostingSchema.ts).
 posting.applicantLocationRequirements = {
 '@type': 'Country',
 name: 'CH',
 };
 }
 if (Number.isFinite(salaryMin)) {
 // FRO-maxValue: maxValue MUST always be present — GSC flags missing maxValue as quality issue.
 const effectiveMax = Number.isFinite(salaryMax) && salaryMax > salaryMin
 ? salaryMax
 : Math.round(salaryMin * 1.2);
 posting.baseSalary = {
 '@type': 'MonetaryAmount',
 currency: salaryCurrency,
 value: {
 '@type': 'QuantitativeValue',
 minValue: salaryMin,
 maxValue: effectiveMax,
 unitText: 'YEAR',
 },
 };
 } else {
 // Fallback: Ticino minimum wage ~CHF 41,080/year ensures baseSalary is always present
 posting.baseSalary = {
 '@type': 'MonetaryAmount',
 currency: 'CHF',
 value: {
 '@type': 'QuantitativeValue',
 minValue: 41080,
 maxValue: 49296,
 unitText: 'YEAR',
 },
 };
 }
 // Skip JobPosting if no meaningful description — an empty description is worse than no schema
 if (!description || description.length < 30) return null;
 return posting;
 }).filter((p): p is Record<string, unknown> => p !== null);

 // FRO: If viewing a single job but we can't generate a valid schema
 // (e.g., slim index loaded first without description), preserve the
 // static HTML's JobPosting injected by the build plugin. The full data
 // will load shortly and re-trigger this effect with a valid schema.
 if (selectedJob && jobPostings.length === 0) {
 return;
 }

 const script = document.createElement('script');
 script.type = 'application/ld+json';
 script.id = 'jobposting-structured-data';
 script.textContent = JSON.stringify({
 '@context': 'https://schema.org',
 '@graph': jobPostings,
 });

 // Remove any pre-existing JobPosting JSON-LD — both the SPA's own script
 // (identified by ID) and any static-HTML scripts injected by the build plugin
 // (which may lack this ID). This prevents duplicate/conflicting schemas.
 const prev = document.getElementById('jobposting-structured-data');
 if (prev) prev.remove();
 document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
 if (el.id === 'jobposting-structured-data') return; // already removed above
 try {
 const data = JSON.parse(el.textContent || '');
 const hasJobPosting = (obj: unknown): boolean => {
 if (!obj || typeof obj !== 'object') return false;
 const o = obj as Record<string, unknown>;
 if (o['@type'] === 'JobPosting') return true;
 if (Array.isArray(o['@graph'])) return (o['@graph'] as unknown[]).some(hasJobPosting);
 return false;
 };
 if (hasJobPosting(data)) el.remove();
 } catch { /* non-JSON or malformed — leave it */ }
 });
 document.head.appendChild(script);

 return () => {
 const el = document.getElementById('jobposting-structured-data');
 if (el) el.remove();
 };
 }, [jobs, pagedJobs, locale, selectedJob, initialJobSlug, expiredJob, bridgeTargetSlug]);

 // ── ItemList JSON-LD (docs/seo-action-plan-apr2026.md) ───────────────────
 // Emit a Schema.org ItemList pointing at the currently filtered job list.
 // Helps Google show a rich carousel for /cerca-lavoro-ticino/ plus its
 // sector/city hubs, lifting CTR on the long-tail listing URLs.
 // Skipped on detail view — the JobPosting schema above is authoritative.
 useEffect(() => {
 const ITEMLIST_ID = 'jobboard-itemlist-jsonld';
 const cleanup = () => {
 const el = document.getElementById(ITEMLIST_ID);
 if (el) el.remove();
 };

 // Skip ONLY on a real job-detail view. Search/company/location landing
 // pages also set initialJobSlug but render a job LIST, so they should still
 // emit ItemList for rich SERP carousels (previously suppressed by the bare
 // initialJobSlug check → landings shipped BreadcrumbList only).
 const isLandingList = !!(searchSlugFilter || companySlugFilter || locationSlugFilter || editorialLandingDescriptor);
 if (selectedJob || (initialJobSlug && !isLandingList)) {
 cleanup();
 return;
 }
 if (filteredJobs.length === 0) {
 cleanup();
 return;
 }

 const origin = typeof window !== 'undefined' && window.location?.origin
 ? window.location.origin
 : 'https://frontaliereticino.ch';

 const MAX_ITEMS = 20;
 const items = filteredJobs
 .slice(0, MAX_ITEMS)
 .map((job, index) => {
 const slug = deriveLocalizedJobSlug(job, locale);
 if (!slug) return null;
 const href = buildPath({ activeTab: 'job-board' as any, jobSlug: slug }, locale);
 const url = `${origin}${href}`;
 const localizedTitle = job.titleByLocale?.[locale] || job.title || '';
 const cleanTitle = sanitizeJobTitle(localizedTitle);
 const name = job.company
 ? `${cleanTitle} — ${job.company}`
 : cleanTitle;
 return {
 '@type': 'ListItem',
 position: index + 1,
 url,
 name: name.slice(0, 110),
 };
 })
 .filter((x): x is { '@type': 'ListItem'; position: number; url: string; name: string } => x !== null);

 if (items.length === 0) {
 cleanup();
 return;
 }

 const listName = companyDisplayName
 ? `${companyDisplayName} — ${t('jobBoard.title', cantonI18n)}`
 : searchHeadingQuery
 ? t('jobBoard.searchPageTitle', { query: searchHeadingQuery })
 : selectedSector !== 'all'
 ? `${selectedSector} — ${t('jobBoard.title', cantonI18n)}`
 : selectedLocation !== 'all'
 ? `${selectedLocation} — ${t('jobBoard.title', cantonI18n)}`
 : t('jobBoard.title', cantonI18n);

 const itemList = {
 '@context': 'https://schema.org',
 '@type': 'ItemList',
 name: listName,
 numberOfItems: items.length,
 itemListOrder: 'https://schema.org/ItemListOrderDescending',
 itemListElement: items,
 };

 cleanup();
 const script = document.createElement('script');
 script.type = 'application/ld+json';
 script.id = ITEMLIST_ID;
 script.textContent = JSON.stringify(itemList);
 document.head.appendChild(script);

 return cleanup;
 }, [filteredJobs, locale, selectedJob, initialJobSlug, selectedSector, selectedLocation, companyDisplayName, searchSlugFilter, companySlugFilter, locationSlugFilter, editorialLandingDescriptor, searchHeadingQuery, cantonI18n, t]);

 const formatSalary = (job: JobListing) => {
 if (!job.salaryMin) return null;
 const min = (job.salaryMin / 1000).toFixed(0);
 const max = job.salaryMax ? (job.salaryMax / 1000).toFixed(0) : null;
 return max ? `${job.currency} ${min}k – ${max}k` : `${job.currency} ${min}k+`;
 };

 const daysSincePosted = (dateStr: string) => {
 const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
 if (diff === 0) return t('jobBoard.today');
 if (diff === 1) return t('jobBoard.yesterday');
 return t('jobBoard.daysAgo', { days: String(diff) });
 };

 const NEW_JOB_MS = 72 * 60 * 60 * 1000; // 72 hours
 const isNewJob = (job: JobListing) => {
 const ts = new Date(job.firstSeenAt || job.postedDate).getTime();
 return Date.now() - ts < NEW_JOB_MS;
 };

 const buildJobPath = (jobOrSlug?: JobListing | string) => {
 const localizedSlug =
 typeof jobOrSlug === 'string'
 ? String(jobOrSlug || '').trim()
 : jobOrSlug
 ? deriveLocalizedJobSlug(jobOrSlug, locale)
 : '';
 // Defense-in-depth: if no slug resolved, return current pathname
 // instead of the listing page URL to preserve static HTML canonical.
 if (!localizedSlug) return window.location.pathname;
 // Canton-aware section: the per-job static page is emitted under the job's
 // OWN canton (/cerca-lavoro-zurigo/<slug>/), NOT the legacy TI default.
 // Without jobBoardCanton, buildPath() falls back to table.jobBoard
 // ('cerca-lavoro-ticino') and every non-TI job link collapses onto the TI
 // section — the SPA was overwriting the (correct) static card hrefs with
 // TI ones on hydration. Object branch resolves from the job exactly like
 // the build emitter (renderJobCardLi → resolveJobCanton); string branch
 // looks the canton up in the registered slug map (_canton).
 const jobCanton =
 typeof jobOrSlug === 'string'
 ? getJobMetaForSlug(jobOrSlug.trim())?.canton
 : jobOrSlug
 ? resolveJobCanton(jobOrSlug)
 : undefined;
 return buildPath({
 activeTab: 'job-board' as any,
 ...(jobCanton ? { jobBoardCanton: String(jobCanton).toUpperCase() } : {}),
 ...(localizedSlug ? { jobSlug: localizedSlug } : {}),
 }, locale);
 };

 // Editorial hub links (city / sector / type lists rendered on a canton
 // landing) carry their canton in the build-provided href's section segment.
 // The previous `href.split('/').filter(Boolean).pop()` + buildPath() WITHOUT
 // a canton stripped that section and rebuilt every link under the legacy TI
 // default. Recover the canton via the router's parsePath() (single source of
 // truth) so href + SPA nav stay on the right section. We deliberately keep
 // driving navigation through onJobRouteChange (jobSlug, NO staticOverlay) —
 // a city/sector hub URL parses to staticOverlay:true, and App skips the
 // React <main> on staticOverlay, so a soft-nav there would blank the page.
 const hubLinkRoute = (rawHref?: string): { canton?: string; slug: string } => {
 const path = String(rawHref || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
 if (!path) return { slug: '' };
 const r = parsePath(path).route;
 const hasInner = !!(r.jobSlug || r.jobBoardCity || r.jobBoardSector);
 // Build never emits a 2+-level hub path under a canton section (every
 // canonicalPath is `${section}/${slug}`), so the terminal segment is the
 // slug. Uppercase the canton for parity with buildJobPath / getJobMetaForSlug
 // (parsePath already returns uppercase ISO keys; this just makes it explicit).
 const parts = path.split('/').filter(Boolean);
 const slug = hasInner && parts.length ? parts[parts.length - 1] : '';
 return { canton: r.jobBoardCanton ? String(r.jobBoardCanton).toUpperCase() : undefined, slug };
 };

 // Anchor href for an editorial hub link, canton-aware. Falls back to the
 // job-board root when the href has no inner slug.
 const buildHubHref = (rawHref?: string): string => {
 const { canton, slug } = hubLinkRoute(rawHref);
 return buildPath({
 activeTab: 'job-board' as any,
 ...(canton ? { jobBoardCanton: canton } : {}),
 ...(slug ? { jobSlug: slug } : {}),
 }, locale);
 };

 useEffect(() => {
 // FRO: Expired job soft-landing pages — preserve static HTML metadata.
 // When we're on an expired job URL (initialJobSlug set, no selectedJob in
 // active dataset, and expiredJob resolved), the build plugin already injected
 // correct title, canonical, meta description, and structured data into the
 // static HTML. Skip all dynamic metadata updates to prevent overwriting.
 if (initialJobSlug && !selectedJob && (expiredJob || hasSeededExpiredData())) {
 return;
 }

 // When we're on a job detail URL but the job data is still loading
 // (selectedJob is null because jobs[] is empty or the job hasn't been
 // matched yet), preserve the static HTML metadata that the build plugin
 // already injected. Without this guard the canonical/title/OG tags would
 // momentarily revert to the generic listing-page values.
 if (initialJobSlug && !selectedJob && !companySlugFilter && !locationSlugFilter && !searchSlugFilter && !editorialLandingDescriptor) {
 return;
 }

 // FRO-SEO: When the user arrived via a previousSlug (bridge page), the
 // build plugin already set the correct canonical pointing to the current
 // slug URL. The SPA should NOT overwrite it — deriveLocalizedJobSlug()
 // would produce the current slug which differs from the URL, creating a
 // canonical mismatch that confuses Google's JS renderer.
 if (selectedJob && initialJobSlug) {
 const currentSlug = deriveLocalizedJobSlug(selectedJob, locale);
 // Check if initialJobSlug matches ANY current locale slug (not a previousSlug)
 const isCurrentSlug = currentSlug === initialJobSlug ||
 selectedJob.slug === initialJobSlug ||
 (['it', 'en', 'de', 'fr'] as const).some(l => deriveLocalizedJobSlug(selectedJob, l) === initialJobSlug);
 if (!isCurrentSlug) {
 // URL slug is a previousSlug → preserve static HTML canonical (already
 // points to the current slug via bridge page mechanism).
 // Still update title/description for user experience.
 const localizedDescription = selectedJob.descriptionByLocale?.[locale] ?? selectedJob.description;
 const localizedTitle = sanitizeJobTitle(selectedJob.titleByLocale?.[locale] ?? selectedJob.title);
 // Prefer the offer LOCATION over the brand suffix: the city rides in the
 // headline and " | Frontaliere Ticino" is dropped first when over the cap.
 const prevSlugCity = isMultiLocation(selectedJob.location) ? '' : String(selectedJob.location || '').trim();
 document.title = buildJobTitleWithLocation(localizedTitle, selectedJob.company, prevSlugCity, locale);
 const metaDesc = document.querySelector('meta[name="description"]');
 if (metaDesc) metaDesc.setAttribute('content', String(localizedDescription || '').slice(0, 160));
 return;
 }
 }

 // Defense-in-depth: if we're on a job detail URL (initialJobSlug is set)
 // but selectedJob is null, NEVER fall through to listing-page canonical.
 // Use the URL slug as canonical source instead of null.
 const canonicalSlugSource = selectedJob
 ? selectedJob
 : (companySlugFilter || locationSlugFilter || searchSlugFilter || editorialLandingDescriptor) && initialJobSlug
 ? initialJobSlug
 : initialJobSlug || selectedJob;
 const canonicalHref = `${window.location.origin}${buildJobPath(canonicalSlugSource)}`;
 let canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
 if (!canonical) {
 canonical = document.createElement('link');
 canonical.setAttribute('rel', 'canonical');
 document.head.appendChild(canonical);
 }
 canonical.setAttribute('href', canonicalHref);

 if (selectedJob) {
 const localizedDescription = selectedJob.descriptionByLocale?.[locale] ?? selectedJob.description;
 const localizedTitle = sanitizeJobTitle(selectedJob.titleByLocale?.[locale] ?? selectedJob.title);
 // Prefer the offer LOCATION over the brand suffix: the city rides inside the
 // headline ("{role} — {company} a {city}") and " | Frontaliere Ticino" is the
 // first thing dropped when the title exceeds the SERP cap. Mirrors the static
 // SSG composer so static <title> and JS-rendered document.title agree.
 const jobCity = isMultiLocation(selectedJob.location) ? '' : String(selectedJob.location || '').trim();
 const fullTitle = buildJobTitleWithLocation(localizedTitle, selectedJob.company, jobCity, locale);
 const descSnippet = String(localizedDescription || '').slice(0, 160);
 document.title = fullTitle;
 const metaDesc = document.querySelector('meta[name="description"]');
 if (metaDesc) {
 metaDesc.setAttribute('content', descSnippet);
 }

 // Set all OG tags so they stay consistent with the job detail page,
 // even if seoService.updateMetaTags runs later with generic fallbacks.
 const ogLocaleMap: Record<string, string> = { it: 'it_CH', en: 'en_US', de: 'de_CH', fr: 'fr_CH' };
 const setOg = (prop: string, val: string) => {
 let el = document.querySelector(`meta[property="${prop}"]`);
 if (!el) { el = document.createElement('meta'); el.setAttribute('property', prop); document.head.appendChild(el); }
 el.setAttribute('content', val);
 };
 setOg('og:title', fullTitle);
 setOg('og:description', descSnippet);
 setOg('og:url', canonicalHref);
 setOg('og:type', 'article');
 setOg('og:locale', ogLocaleMap[locale] || 'it_CH');
 setOg('og:site_name', 'Frontaliere Ticino');

 // Ensure the html lang attribute matches the active locale
 document.documentElement.lang = locale;
 return;
 }

 // Company page: canonical already set to self-referencing URL via canonicalSlugSource above
 if (companySlugFilter && initialJobSlug) {
 const ogUrl = document.querySelector('meta[property="og:url"]');
 if (ogUrl) ogUrl.setAttribute('content', canonicalHref);
 return;
 }

 // Location page: canonical already set to self-referencing URL via canonicalSlugSource above
 if (locationSlugFilter && initialJobSlug) {
 const ogUrl = document.querySelector('meta[property="og:url"]');
 if (ogUrl) ogUrl.setAttribute('content', canonicalHref);
 return;
 }

 const editorialLandingModel = editorialOfficialGazetteLanding || editorialJobTodayLanding || editorialLocationLanding || editorialLocationTypeLanding || editorialLocationSectorLanding || editorialSectorRegionLanding || editorialNursesHubLanding || editorialPartTimeLanding || editorialCareVariantLanding;
 if (editorialLandingModel) {
 const canonicalPath = buildPath({ activeTab: 'job-board', jobSlug: editorialLandingModel.slug }, locale);
 const editorialCanonicalHref = `${window.location.origin}${canonicalPath}`;
 canonical.setAttribute('href', editorialCanonicalHref);
 // Brand suffix is the first thing dropped when the (often place-bearing)
 // landing headline would push the title past the SERP cap.
 document.title = buildTitleWithBrand(editorialLandingModel.title);
 const metaDesc = document.querySelector('meta[name="description"]');
 if (metaDesc) {
 metaDesc.setAttribute('content', editorialLandingModel.description);
 }
 const ogUrl = document.querySelector('meta[property="og:url"]');
 if (ogUrl) ogUrl.setAttribute('content', editorialCanonicalHref);
 Analytics.trackSelectContent('editorial_landing_view', editorialLandingDescriptor?.kind ?? 'unknown');
 }
 }, [locale, selectedJob, expiredJob, initialJobSlug, jobs, companySlugFilter, locationSlugFilter, searchSlugFilter, editorialOfficialGazetteLanding, editorialJobTodayLanding, editorialLocationLanding, editorialLocationTypeLanding, editorialLocationSectorLanding, editorialSectorRegionLanding, editorialNursesHubLanding, editorialCareVariantLanding]);

 // Track job page views in Firestore (for newsletter popularity ranking).
 // Pass the whole job so trackJobView can write under the canonical IT slug
 // (slugByLocale.it) instead of the locale-flattened variant. Re-fires when
 // slugByLocale.it becomes available after the per-job detail file loads,
 // and the in-function debounce (keyed on job.id) prevents double counting.
 useEffect(() => {
 if (!selectedJob?.slug) return;
 trackJobView(selectedJob);
 // Per-ad publisher analytics (no-op unless this is a publisher-submitted ad).
 trackPublisherJobView(selectedJob as { publisherJobId?: string | null });
 // Personalization: track behavior for scoring (uses locale slug, fine here)
 if (enablePersonalization && selectedJob) {
 trackJobViewBehavior({
 slug: selectedJob.slug,
 category: selectedJob.category || 'other',
 company: selectedJob.company || '',
 location: selectedJob.addressLocality || selectedJob.location || '',
 });
 setBehaviorData(getBehaviorData());
 }
 }, [selectedJob?.slug, selectedJob?.slugByLocale?.it, enablePersonalization]);

 useEffect(() => {
 if (!authResolved || !authGateOpen || hasAccess) return;
 const focusedJob = pendingJob || selectedJob;
 if (focusedJob) {
 saveAuthJobContext({
 slug: focusedJob.slug || null,
 company: focusedJob.company || null,
 location: focusedJob.location || focusedJob.addressLocality || null,
 category: focusedJob.category || null,
 });
 }
 void promptOneTap();
 }, [authResolved, authGateOpen, hasAccess, pendingJob, selectedJob]);

 // Close auth gate modal on Escape key
 useEffect(() => {
 if (!authGateOpen) return;
 const handleKeyDown = (e: KeyboardEvent) => {
 if (e.key === 'Escape') {
 authUnlockCandidateRef.current = null;
 setAuthGateOpen(false);
 releaseSlot('job-auth-gate');
 setPendingJob(null);
 setAuthError(null);
 }
 };
 window.addEventListener('keydown', handleKeyDown);
 return () => window.removeEventListener('keydown', handleKeyDown);
 }, [authGateOpen]);

 useEffect(() => {
 if (!authResolved || !selectedJob || hasAccess) return;
 authUnlockCandidateRef.current = selectedJob.id;
 saveAuthJobContext({
 slug: selectedJob.slug || null,
 company: selectedJob.company || null,
 location: selectedJob.location || selectedJob.addressLocality || null,
 category: selectedJob.category || null,
 });
 void promptOneTap();
 Analytics.trackJobAuthFunnel('gate_view', buildJobTrackingContext(selectedJob));
 }, [authResolved, selectedJob, hasAccess]);

 useEffect(() => {
 // Wait for auth to resolve before rendering GIS buttons.
 // This ensures onAuthStateChanged listener is active, so when GIS
 // signs in via handleOneTapResponse → signInWithCredential, the
 // useAuth hook captures the state change and updates the UI.
 if (!authResolved) return;

 let cancelled = false;

 const mountGoogleButton = async (
 buttonContainer: HTMLDivElement | null,
 setReady: React.Dispatch<React.SetStateAction<boolean>>,
 active: boolean,
 ) => {
 if (!active || !buttonContainer) {
 setReady(false);
 return;
 }

 buttonContainer.innerHTML = '';
 try {
 // Use renderGoogleButton directly (same approach as profile page).
 await renderGoogleButton(buttonContainer, {
 theme: 'outline',
 size: 'large',
 text: 'signin_with',
 });
 if (cancelled) return;
 // Check if GIS rendered children (same readiness check as profile page)
 if (buttonContainer.children.length > 0) {
 setReady(true);
 } else {
 // GIS may need more time — check again after a short delay
 await new Promise(r => setTimeout(r, 500));
 if (cancelled) return;
 setReady(buttonContainer.children.length > 0);
 }
 } catch (error) {
 if (cancelled) return;
 setReady(false);
 reportCaughtError(error, 'jobBoard.renderGoogleButton');
 }
 };

 void mountGoogleButton(modalGoogleButtonRef.current, setModalGoogleButtonReady, authGateOpen && !hasAccess);
 void mountGoogleButton(inlineGoogleButtonRef.current, setInlineGoogleButtonReady, Boolean(selectedJob && !hasAccess));

 return () => {
 cancelled = true;
 };
 }, [authResolved, authGateOpen, hasAccess, locale, selectedJob]);

 useEffect(() => {
 const becameLoggedIn = !wasLoggedInRef.current && isLoggedIn;
 wasLoggedInRef.current = isLoggedIn;

 if (!authResolved || !isLoggedIn) return;
 if (!becameLoggedIn) return;

 const unlockedJob =
 pendingJob && authUnlockCandidateRef.current === pendingJob.id
 ? pendingJob
 : selectedJob && authUnlockCandidateRef.current === selectedJob.id
 ? selectedJob
 : null;
 if (!unlockedJob) return;

 authUnlockCandidateRef.current = null;

 const userEmail = getAuthEmail(authUser);
 const sourceSuffix = `:${unlockedJob.company}:${sanitizeJobTitle(unlockedJob.title).slice(0, 60)}`;
 const emailDomain = String(userEmail || '').split('@')[1] || 'unknown';

 autoNewsletterSubscribe(userEmail || undefined, `job_gate_google${sourceSuffix}`);
 // Leva B: offer the one-tap job alert immediately on this just-unlocked job.
 justAuthedJobIdRef.current = unlockedJob.id;
 setAuthNotice(null);
 setAuthError(null);
 setAuthGateOpen(false);
 releaseSlot('job-auth-gate');
 Analytics.trackJobAuthFunnel('auth_success', {
 method: 'google',
 emailDomain,
 ...buildJobTrackingContext(unlockedJob),
 });
 Analytics.trackNewsletter('subscribe', emailDomain);
 Analytics.trackSelectContent('job_board_open_detail', `${unlockedJob.company}_${unlockedJob.title}`);

 const nextSlug = deriveLocalizedJobSlug(unlockedJob, locale);
 setPendingJob(null);
 if (!selectedJob || selectedJob.id !== unlockedJob.id || initialJobSlug !== nextSlug) {
 onJobRouteChange?.(nextSlug, resolveJobCanton(unlockedJob));
 }
 }, [authResolved, authUser, initialJobSlug, isLoggedIn, locale, onJobRouteChange, pendingJob, selectedJob]);

 useEffect(() => {
 if (!authResolved || !hasAccess) return;
 const redirectSlug = readJobAuthRedirectSlug();
 if (!redirectSlug) return;

 clearJobAuthRedirectSlug();
 authUnlockCandidateRef.current = null;
 setAuthGateOpen(false);
 setPendingJob(null);
 setAuthError(null);
 releaseSlot('job-auth-gate');

 if (initialJobSlug === redirectSlug) return;
 onJobRouteChange?.(redirectSlug, getJobMetaForSlug(redirectSlug)?.canton);
 }, [authResolved, hasAccess, initialJobSlug, onJobRouteChange]);

 // When the inline auth gate is visible (job detail + not logged in),
 // register with the popup queue so achievement toasts are suppressed,
 // and scroll the auth gate into view for small viewports.
 const inlineAuthGateVisible = Boolean(selectedJob && authResolved && !hasAccess);
 useEffect(() => {
 if (!inlineAuthGateVisible) return;
 requestSlot('job-inline-auth-gate', POPUP_PRIORITY.INLINE_AUTH_GATE);
 // Scroll the auth gate into view after a short delay to let layout settle
 const raf = requestAnimationFrame(() => {
 document.getElementById('job-auth-gate')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
 });
 return () => {
 cancelAnimationFrame(raf);
 releaseSlot('job-inline-auth-gate');
 };
 }, [inlineAuthGateVisible]);

 const openDetail = (job: JobListing) => {
 if (!authResolved) return;
 // Always navigate to the detail page — the inline auth gate handles
 // unauthenticated users with a blurred preview + sign-in form,
 // giving more context than a modal popup and boosting conversion.
 savedListState.current = { page, scrollY: window.scrollY };
 onJobRouteChange?.(deriveLocalizedJobSlug(job, locale), resolveJobCanton(job));
 window.scrollTo({ top: 0, behavior: 'instant' });
 Analytics.trackSelectContent('job_board_open_detail', `${job.company}_${job.title}`);
 if (enablePersonalization && behaviorData) {
 const { score, topSignal } = computePersonalScore(job, behaviorData, userProfile ?? null, jobMatchProfile);
 if (score > 0) {
 Analytics.trackJobMatchClick(topSignal, score);
 }
 }
 };

 const renderJobCard = (job: JobListing) => (
 <JobCard
 key={buildListingDedupKey(job)}
 job={job}
 jobHref={buildJobPath(job)}
 salary={formatSalary(job)}
 logo={companyLogoUrl(job)}
 isNew={isNewJob(job)}
 postedLabel={daysSincePosted(job.postedDate)}
 locale={locale}
 t={t}
 onSelect={openDetail}
 saved={savedJobIds.has(job.id)}
 onToggleSave={handleToggleSaveFromList}
 />
 );

 // Device-split in-feed ad, reused across every SPA job-list surface (main
 // list + editorial-landing sections). Mobile vs desktop slot mirrors the
 // static `infeedAdListItemHtml`; cadence is the shared `shouldPlaceInfeedAd`.
 const renderInfeedAd = (keySuffix: string): React.ReactNode => {
 const cfg = isMobile ? AD_SLOTS.JOBLIST_INFEED_MOBILE : AD_SLOTS.JOBLIST_INFEED_DESKTOP;
 // Reserve from the registry, never a literal: this wrapper hard-coded 280 and
 // silently outlived the #4302 raise to 336, under-reserving every in-feed unit
 // in the list (up to JOBLIST_AD_MAX_PER_LIST per page) — issue #4677.
 return (
 <div
 key={`infeed-${isMobile ? 'm' : 'd'}-${keySuffix}-${adRefreshKey}`}
 style={{ ['--ad-mh' as string]: `${cfg.placeholderMinHeight}px` }}
 className="min-h-[var(--ad-mh)]"
 >
 <AdSenseBanner
 adSlot={cfg.slot}
 adFormat={cfg.format}
 fullWidthResponsive={cfg.fullWidthResponsive}
 className="my-3"
 />
 </div>
 );
 };

 // Interleave one in-feed ad after every Nth job card (shared `shouldPlaceInfeedAd`
 // cadence), never after the last card. Used by the editorial-landing sections;
 // the canonical main list inlines the same logic at its `displayJobs.map`.
 const renderJobListWithAds = (jobs: JobListing[], keyPrefix: string): React.ReactNode[] =>
 jobs.flatMap((job, i) => {
 const nodes: React.ReactNode[] = [renderJobCard(job)];
 if (i + 1 < jobs.length && shouldPlaceInfeedAd(i + 1)) {
 nodes.push(renderInfeedAd(`${keyPrefix}-${i}`));
 }
 return nodes;
 });

 const handleAuthAndOpen = async (provider: 'google' | 'facebook') => {
 const authFn = provider === 'google' ? onGoogleAuthRequired : onFacebookAuthRequired;
 if (!authFn) return;
 setAuthBusy(provider);
 setAuthError(null);
 const jobToTrack = pendingJob || selectedJob;
 const jobContext = jobToTrack ? buildJobTrackingContext(jobToTrack) : {};
 const redirectSlug = jobToTrack ? deriveLocalizedJobSlug(jobToTrack, locale) : null;
 try {
 // Persist the intended detail target before auth starts. On mobile redirect
 // flows, the browser may navigate away before post-await code runs.
 if (redirectSlug) {
 saveJobAuthRedirectSlug(redirectSlug);
 }
 const result = await authFn();
 if (!result) {
 const redirectProvider = (() => {
 try {
 return sessionStorage.getItem('auth_redirect_provider');
 } catch {
 return null;
 }
 })();
 if (redirectProvider === provider) {
 return;
 }
 clearJobAuthRedirectSlug();
 setAuthError(t('jobBoard.authCancelled'));
 Analytics.trackJobAuthFunnel('auth_fail', { method: provider, ...jobContext });
 return;
 }
 authUnlockCandidateRef.current = null;
 clearJobAuthRedirectSlug();
 const userEmail = result.email || result.user?.email;
 const sourceSuffix = jobToTrack ? `:${jobToTrack.company}:${sanitizeJobTitle(jobToTrack.title).slice(0, 60)}` : '';
 autoNewsletterSubscribe(userEmail, `job_gate_google${sourceSuffix}`);
 setAuthNotice(null);
 const emailDomain = String(userEmail || '').split('@')[1] || 'unknown';
 Analytics.trackJobAuthFunnel('auth_success', { method: provider, emailDomain, ...jobContext });
 Analytics.trackNewsletter('subscribe', emailDomain);
 setAuthGateOpen(false);
 releaseSlot('job-auth-gate');
 const jobToOpen = pendingJob || selectedJob;
 setPendingJob(null);
 if (jobToOpen) {
 // Leva B: offer the one-tap job alert immediately on this just-unlocked job.
 justAuthedJobIdRef.current = jobToOpen.id;
 onJobRouteChange?.(deriveLocalizedJobSlug(jobToOpen, locale), resolveJobCanton(jobToOpen));
 Analytics.trackSelectContent('job_board_open_detail', `${jobToOpen.company}_${jobToOpen.title}`);
 }
 } catch {
 setAuthError(t('jobBoard.authFailed'));
 Analytics.trackJobAuthFunnel('auth_fail', { method: provider, ...jobContext });
 } finally {
 setAuthBusy(null);
 }
 };

 const handleEmailAccess = async () => {
 const email = emailInput.trim();
 if (!email || !validateEmailStrict(email).valid) { setAuthError(t('newsletter.invalidEmail')); return; }
 setAuthBusy('email');
 setAuthError(null);
 const jobContext = pendingJob ? buildJobTrackingContext(pendingJob) : {};
 try {
 const sourceSuffix = pendingJob ? `:${pendingJob.company}:${sanitizeJobTitle(pendingJob.title).slice(0, 60)}` : '';
 await autoNewsletterSubscribe(email, `job_gate_email${sourceSuffix}`);
 localStorage.setItem(JOB_EMAIL_ACCESS_KEY, email.toLowerCase());
 setEmailAccessGranted(true);
 setAuthNotice({ kind: 'pending', email });
 const emailDomain = email.split('@')[1] || 'unknown';
 Analytics.trackJobAuthFunnel('auth_success', { method: 'email', emailDomain, ...jobContext });
 Analytics.trackNewsletter('subscribe', emailDomain);
 Analytics.trackSelectContent('job_board_email_access', emailDomain);
 authUnlockCandidateRef.current = null;
 setAuthGateOpen(false);
 releaseSlot('job-auth-gate');
 setEmailInput('');
 const jobToOpen = pendingJob;
 setPendingJob(null);
 if (jobToOpen) {
 onJobRouteChange?.(deriveLocalizedJobSlug(jobToOpen, locale), resolveJobCanton(jobToOpen));
 Analytics.trackSelectContent('job_board_open_detail', `${jobToOpen.company}_${jobToOpen.title}`);
 }
 } catch {
 setAuthError(t('jobBoard.authFailed'));
 Analytics.trackJobAuthFunnel('auth_fail', { method: 'email', ...jobContext });
 } finally {
 setAuthBusy(null);
 }
 };

 /** Inline email access from the gated detail page (no modal) */
 const handleInlineEmailAccess = async (job: JobListing) => {
 const email = emailInput.trim();
 if (!email || !validateEmailStrict(email).valid) { setAuthError(t('newsletter.invalidEmail')); return; }
 setAuthBusy('email');
 setAuthError(null);
 const jobContext = buildJobTrackingContext(job);
 try {
 await autoNewsletterSubscribe(email, `job_gate:${job.company}:${sanitizeJobTitle(job.title).slice(0, 60)}`);
 localStorage.setItem(JOB_EMAIL_ACCESS_KEY, email.toLowerCase());
 setEmailAccessGranted(true);
 setAuthNotice({ kind: 'pending', email });
 const emailDomain = email.split('@')[1] || 'unknown';
 Analytics.trackJobAuthFunnel('auth_success', { method: 'email', emailDomain, ...jobContext });
 Analytics.trackNewsletter('subscribe', emailDomain);
 authUnlockCandidateRef.current = null;
 setEmailInput('');
 // No need to route — the component will re-render with hasAccess=true
 Analytics.trackSelectContent('job_board_open_detail', `${job.company}_${job.title}`);
 } catch {
 setAuthError(t('jobBoard.authFailed'));
 Analytics.trackJobAuthFunnel('auth_fail', { method: 'email', ...jobContext });
 } finally {
 setAuthBusy(null);
 }
 };

 /** Build tracking context for a job to enrich analytics events */
 const buildJobTrackingContext = (job: JobListing) => {
 const title = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title);
 const category = normalizeJobCategory(job);
 const location = job.location || '';
 // Extract up to 5 short keywords from title + category
 const keywordParts = [title, category, location, job.company]
 .filter(Boolean)
 .join(' ')
 .toLowerCase()
 .split(/[\s,;|/·–—]+/)
 .filter((w) => w.length > 2 && w.length < 30);
 const keywords = [...new Set(keywordParts)].slice(0, 8).join(',');
 return {
 company: job.company,
 jobTitle: title,
 category,
 location,
 searchQuery: searchQuery.trim() || undefined,
 keywords,
 };
 };

 const autoNewsletterSubscribe = async (email?: string, source?: string) => {
 if (!email || localStorage.getItem('newsletter_subscribed') === 'true') return;
 try {
 const [{ getFirestore }, { getApp }] = await Promise.all([
 import('firebase/firestore'),
 import('@/services/firebase'),
 ]);
 const firestore = getFirestore(await getApp());
 if (!firestore) return;
 // Fifth sibling of the auto-subscribe guard (App.tsx, hooks/useUserState.ts,
 // services/authService.ts, PublisherPublishPage) and the same reasoning
 // (#5672). Two of this function's four callers are social sign-in unlocks
 // that promote (`isActive`/`status: 'confirmed'` below when the source is
 // Google/Facebook), which is the ring exactly: open an old email → the
 // never-expiring `ac` code signs you in → unlock a job → subscribed again.
 // The other two land `pending` and so are never promoted, but the upsert
 // still records a `subscribe_completed` event on an opted-out document, and
 // that event is the signal a genuine re-subscription is recognised by. The
 // localStorage flag above cannot cover either case: the unsubscribe handler
 // deletes it.
 //
 // Returning here also skips `markNewsletterSubscribedLocally()` below, which
 // is intended: that flag is what grants offerwall access, and granting a
 // subscriber perk to someone who is not a subscriber is the lie that made
 // this guard necessary. The job unlock itself is unaffected — every caller
 // grants it (JOB_EMAIL_ACCESS_KEY / setEmailAccessGranted) after the await,
 // independently of what happens in here.
 const { isNewsletterOptedOut } = await import('@/services/newsletterSubscribers');
 if (await isNewsletterOptedOut(firestore, email)) return;
 const normalizedSource = String(source || 'job_board_auth').toLowerCase();
 const isTrustedAuthSource = normalizedSource.includes('google') || normalizedSource.includes('facebook');
 const focusedJob = selectedJob || sortedJobs[0] || null;
 const jobContext = focusedJob
 ? {
 slug: focusedJob.slug || null,
 company: focusedJob.company || null,
 location: focusedJob.location || null,
 category: normalizeJobCategory(focusedJob.category, focusedJob.title) || null,
 searchQuery: searchQuery.trim() || null,
 }
 : {
 slug: null,
 company: null,
 location: null,
 category: null,
 searchQuery: searchQuery.trim() || null,
 };
 await upsertNewsletterSubscriber(firestore, {
 email,
 preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: true },
 source: source || 'job_board_auth',
 sourceChannel: isTrustedAuthSource
 ? normalizedSource.includes('facebook')
 ? 'auth_facebook'
 : 'auth_google'
 : 'job_gate',
 sourcePage: window.location.pathname,
 sourceCta: isTrustedAuthSource ? 'job_board_social_unlock' : 'job_board_email_unlock',
 sourceComponent: 'JobBoard',
 sourceRouteFamily: 'job-board',
 jobContext,
 locationInterest: jobContext.location,
 sectorInterest: jobContext.category,
 locale: navigator.language || 'it-IT',
 isActive: isTrustedAuthSource,
 status: isTrustedAuthSource ? 'confirmed' : 'pending',
 // Two different acts, ONE sentence (#5678, #5712, #5765). Each of the two
 // gate surfaces below renders a single notice, under its "continua con
 // email" button, and both entries named here carry that exact sentence —
 // they differ only in `act`, because typing an address is not the same
 // thing as signing in. Until #5765 this gate printed the sign-in notice
 // above the provider buttons AND the opt-in notice under the email form:
 // two statements on one screen, one of them stored. The social branch
 // still promotes straight to confirmed/active with no double opt-in.
 ...consentProof(
 isTrustedAuthSource ? 'communicationsSignIn' : 'communicationsSignInEmail',
 isTrustedAuthSource
 ? (normalizedSource.includes('facebook') ? 'facebook_oauth' : 'google_oauth')
 : 'email_submit',
 locale,
 ),
 });
 markNewsletterSubscribedLocally();
 } catch { /* non-critical */ }
 };

 const goToPage = (p: number) => {
 setPage(p);
 setAdRefreshKey((k) => k + 1);
 syncQueryParamsToUrl({ page: p > 1 ? String(p) : null });
 window.scrollTo({ top: 0, behavior: 'smooth' });
 };

 const renderPagination = () => {
 if (totalPages <= 1) return null;

 // Build visible page numbers with ellipsis.
 // Mobile: show 1 neighbor around current; Desktop: show 2 neighbors.
 const buildPageNumbers = (): (number | 'ellipsis')[] => {
 const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
 const delta = isMobile ? 1 : 2;
 const pages: (number | 'ellipsis')[] = [];
 const rangeStart = Math.max(2, currentPage - delta);
 const rangeEnd = Math.min(totalPages - 1, currentPage + delta);

 pages.push(1);
 if (rangeStart > 2) pages.push('ellipsis');
 for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i);
 if (rangeEnd < totalPages - 1) pages.push('ellipsis');
 if (totalPages > 1) pages.push(totalPages);
 return pages;
 };

 const pages = buildPageNumbers();
 const btnBase = 'inline-flex items-center justify-center rounded-lg border font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed';
 const btnSize = 'min-w-[44px] h-11 px-2 text-sm sm:min-w-[44px] sm:h-11 sm:px-3 sm:text-sm';
 const btnIdle = 'border-edge text-subtle bg-surface hover:bg-surface-raised';
 const btnActive = 'border-accent bg-accent text-on-accent hover:bg-accent-hover border-accent bg-accent hover:bg-accent-hover';

 return (
 <nav className="flex items-center gap-1 sm:gap-1.5" aria-label={t('jobBoard.pagination.label') || 'Pagination'}>
 {/* First page */}
 <button
 type="button"
 onClick={() => goToPage(1)}
 disabled={currentPage === 1}
 className={`${btnBase} ${btnSize} ${btnIdle}`}
 aria-label={t('jobBoard.pagination.first') || 'First page'}
 >
 <ChevronsLeft className="w-4 h-4" />
 </button>

 {/* Previous */}
 <button
 type="button"
 onClick={() => goToPage(currentPage - 1)}
 disabled={currentPage === 1}
 className={`${btnBase} ${btnSize} ${btnIdle}`}
 aria-label={t('jobBoard.pagination.prev')}
 >
 <ChevronLeft className="w-4 h-4" />
 </button>

 {/* Page numbers */}
 {pages.map((p, idx) =>
 p === 'ellipsis' ? (
 <span key={`ellipsis-${idx}`} className="px-1 text-muted select-none" aria-hidden>…</span>
 ) : (
 <button
 key={p}
 type="button"
 onClick={() => goToPage(p)}
 className={`${btnBase} ${btnSize} ${p === currentPage ? btnActive : btnIdle}`}
 aria-label={`${t('jobBoard.pagination.page') || 'Page'} ${p}`}
 aria-current={p === currentPage ? 'page' : undefined}
 >
 {p}
 </button>
 )
 )}

 {/* Next */}
 <button
 type="button"
 onClick={() => goToPage(currentPage + 1)}
 disabled={currentPage === totalPages}
 className={`${btnBase} ${btnSize} ${btnIdle}`}
 aria-label={t('jobBoard.pagination.next')}
 >
 <ChevronRight className="w-4 h-4" />
 </button>

 {/* Last page */}
 <button
 type="button"
 onClick={() => goToPage(totalPages)}
 disabled={currentPage === totalPages}
 className={`${btnBase} ${btnSize} ${btnIdle}`}
 aria-label={t('jobBoard.pagination.last') || 'Last page'}
 >
 <ChevronsRight className="w-4 h-4" />
 </button>
 </nav>
 );
 };

 const backToList = () => {
 Analytics.trackSelectContent('job_board_back_to_list', 'job-board');
 // Always use deterministic SPA navigation instead of history.back().
 // history.back() is unsafe for direct-entry pages (e.g. from Google) where
 // the previous history entry may be about:blank or an external page.
 onJobRouteChange?.(undefined);
 };

 const handleApply = (job: JobListing) => {
 Analytics.trackSelectContent('job_board_apply', `${job.company}_${job.title}`);
 Analytics.trackJobApply(canonicalCompanyRouteSlug(job.company, job.companyKey), Boolean(job.featured), job.slug || job.id);
 // In-house / forward-email publisher ads apply via the on-page
 // PublisherApplyForm (#candidatura), NOT an external URL. For these,
 // applyUrl/url point back at the ad's own /lavoro/<slug> page, so opening
 // job.url in a new tab just re-shows the listing ("returns to the ad"
 // bug). Scroll to the in-page form instead.
 const mode = (job as { applyMode?: string }).applyMode;
 if (mode === 'in_house' || mode === 'forward_email') {
 trackPublisherApplyClick(job as { publisherJobId?: string | null });
 document.getElementById('candidatura')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
 return;
 }
 // External publisher ads: count the apply click too (session-debounced, so it
 // never double-counts with the header logo/title links). No-op for crawled jobs.
 trackPublisherApplyClick(job as { publisherJobId?: string | null });
 if (job.url) {
 window.open(buildReferralUrl(job.url, job), '_blank', 'noopener,noreferrer');
 // Mutate the page in the same tick as the hand-off — the confirmation is the
 // user-visible receipt AND the DOM change that makes this click non-dead.
 setAppliedJobId(job.id);
 }
 };

 const handleShare = async (job: JobListing) => {
 const url = `${window.location.origin}${buildJobPath(job)}`;
 const title = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title);
 try {
 if (navigator.share) {
 await navigator.share({ title, text: `${title} — ${job.company}`, url });
 } else {
 await navigator.clipboard.writeText(url);
 }
 Analytics.trackSelectContent('job_board_share', `${job.company}_${title}`);
 } catch {
 // user cancelled share
 }
 };

 const navigateToRelatedSearch = useCallback((keyword: string) => {
 const searchSlug = buildSearchSlug(keyword, locale);
 applySearchQuery(keyword);
 // Keyword search hubs are Switzerland-wide (aggregate), mirroring the
 // related-search anchor hrefs (jobBoardCanton: JOB_BOARD_CANTON_AGGREGATE);
 // without it the SPA nav would collapse onto the legacy TI section.
 onJobRouteChange?.(searchSlug, JOB_BOARD_CANTON_AGGREGATE);
 }, [locale, onJobRouteChange]);

 // ── Salary estimate widgets (frontaliere vs CH resident) ───────────────
 // Net figures come from the SAME fiscal logic as the calculator — see
 // services/jobNetEstimate.ts (issue #4307). Never reimplement the
 // tax/contribution math here.
 const [salaryEstimates, setSalaryEstimates] = useState<JobNetEstimate | null>(null);
 useEffect(() => {
 if (!selectedJob) { setSalaryEstimates(null); return; }
 // EUR-denominated postings aren't a CHF net estimate — hide the widget
 // rather than mislabel a currency mismatch.
 if (selectedJob.currency === 'EUR') { setSalaryEstimates(null); return; }
 const minRaw = Number(selectedJob.salaryMin) || Number(selectedJob.baseSalary?.value?.minValue);
 const maxRaw = Number(selectedJob.salaryMax) || Number(selectedJob.baseSalary?.value?.maxValue);
 let cancelled = false;
 import('@/services/jobNetEstimate').then(({ estimateJobNetSalary }) => {
 if (cancelled) return;
 const estimate = estimateJobNetSalary(minRaw, maxRaw);
 setSalaryEstimates(estimate);
 if (estimate) Analytics.trackJobNetWidgetImpression(selectedJob.id);
 }).catch(() => setSalaryEstimates(null));
 return () => { cancelled = true; };
 }, [selectedJob]);

 const fmtNet = (v: number) => `CHF ${v.toLocaleString('de-CH')}`;

 // Deep-link into the calculator prefilled with this job's salary + canton
 // (issue #4307 scope item 2 — ?reddito=&cantone=, read back by the
 // reverse-bridge on the calculator side).
 const salaryCalcHref = salaryEstimates
 ? buildPath({ activeTab: 'calculator' }, locale) + `?reddito=${salaryEstimates.salaryMax || salaryEstimates.salaryMin}&cantone=${encodeURIComponent(selectedJob?.canton || '')}`
 : '';
 const goToCalc = (e: React.MouseEvent, variant: 'frontaliere' | 'resident' | 'cta') => {
 e.preventDefault();
 // SPA navigation: push route + apply query string, avoid full page reload / 404 flash
 const reddito = salaryEstimates?.salaryMax || salaryEstimates?.salaryMin;
 if (selectedJob) Analytics.trackJobNetWidgetClick(selectedJob.id, variant);
 nav.navigateTo('calculator');
 if (reddito) {
 const url = buildPath({ activeTab: 'calculator' }, locale) + `?reddito=${reddito}&cantone=${encodeURIComponent(selectedJob?.canton || '')}`;
 history.replaceState(history.state, '', url);
 }
 };

 const salaryEstimateWidget = salaryEstimates ? (
 <Callout status="warning" icon={<Calculator size={15} />} className="rounded-xl">
 <div className="text-sm font-bold text-heading mb-3">
 {t('jobBoard.salaryEstimate.cta')}
 </div>
 <div className="space-y-3">
 {/* Frontaliere (Permit G) */}
 <a
 href={salaryCalcHref}
 onClick={(e) => goToCalc(e, 'frontaliere')}
 className="block rounded-lg bg-warning-subtle border border-warning-border/50 p-3 hover:bg-warning-subtle transition-colors cursor-pointer"
 >
 <div className="text-xs font-semibold text-warning mb-1">
 {t('jobBoard.salaryEstimate.frontaliere')}
 </div>
 <div className="text-lg font-bold text-warning">
 {salaryEstimates.frontaliere.max
 ? t('jobBoard.salaryEstimate.monthly', { min: fmtNet(salaryEstimates.frontaliere.min), max: fmtNet(salaryEstimates.frontaliere.max) })
 : t('jobBoard.salaryEstimate.monthlySingle', { value: fmtNet(salaryEstimates.frontaliere.min) })}
 </div>
 </a>
 {/* CH Resident (Permit B) */}
 <a
 href={salaryCalcHref}
 onClick={(e) => goToCalc(e, 'resident')}
 className="block rounded-lg bg-success-subtle border border-success-border/50 p-3 hover:bg-success-subtle transition-colors cursor-pointer"
 >
 <div className="text-xs font-semibold text-success mb-1">
 {t('jobBoard.salaryEstimate.resident')}
 </div>
 <div className="text-lg font-bold text-success">
 {salaryEstimates.resident.max
 ? t('jobBoard.salaryEstimate.monthly', { min: fmtNet(salaryEstimates.resident.min), max: fmtNet(salaryEstimates.resident.max) })
 : t('jobBoard.salaryEstimate.monthlySingle', { value: fmtNet(salaryEstimates.resident.min) })}
 </div>
 </a>
 </div>
 <p className="mt-2 text-xs text-muted">{t('jobBoard.salaryEstimate.note')}</p>
 <a
 href={salaryCalcHref}
 onClick={(e) => goToCalc(e, 'cta')}
 className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 min-h-[44px] text-sm font-semibold bg-warning-strong hover:bg-warning-strong-hover text-on-accent rounded-lg transition-colors"
 >
 <Calculator size={14} />
 {t('jobBoard.salaryEstimate.cta')}
 </a>
 </Callout>
 ) : null;

 // ── Sector salary context (USTAT metadata) ──────────────────────────────
 const sectorContext = useMemo(() => {
 if (!selectedJob) return null;
 return getJobSalaryContext(selectedJob.category || '');
 }, [selectedJob]);

 const sectorContextWidget = sectorContext ? (
 <div className="rounded-xl border border-edge bg-surface-alt/50 p-3 text-xs">
 <div className="flex items-center gap-1.5 font-semibold text-body mb-2">
 <Briefcase size={13} className="text-link" />
 {t('jobBoard.sectorContext.title')}
 </div>
 <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-subtle">
 <span>{t('jobBoard.sectorContext.employees', { count: sectorContext.employeeCount.toLocaleString('de-CH'), ...cantonI18n })}</span>
 {sectorContext.frontialieriDiscount > 0 && (
 <span>{t('jobBoard.sectorContext.frontialieriGap', { pct: String(sectorContext.frontialieriDiscount) })}</span>
 )}
 {sectorContext.cclMinimumAnnual > 41600 && (
 <span>{t('jobBoard.sectorContext.cclMinimum', { amount: `CHF ${(sectorContext.cclMinimumAnnual / 1000).toFixed(1)}k` })}</span>
 )}
 {sectorContext.educationPremiumRatio > 1.3 && (
 <span>{t('jobBoard.sectorContext.educationPremium', { pct: String(Math.round((sectorContext.educationPremiumRatio - 1) * 100)) })}</span>
 )}
 </div>
 <p className="mt-1.5 text-xs text-muted">{t('jobBoard.sectorContext.source')}</p>
 </div>
 ) : null;

 // Post-apply receipt + peak-intent alert offer (issues #5040, #5039).
 //
 // The alert CTA here deliberately does NOT require an authenticated session.
 // The only surface that converts today (`job_detail_prompt`, 5 creations on
 // 410 impressions over 14d) is hard-gated on userId+email and logs a `no_auth`
 // skip for everyone else, so anonymous visitors — the bulk of organic search
 // traffic — are never offered an alert at the one moment their intent is
 // provably highest: they just applied. This routes them through the always-
 // mounted JobAlertForm, which owns auth + email capture, using the same
 // queued-request + backToList hand-off SavedJobsAlertNudge already uses from
 // the detail view.
 const appliedNoticeJsx = (appliedJobId && selectedJob && appliedJobId === selectedJob.id) ? (
 <div
 role="status"
 className="rounded-xl border border-success-border bg-success-subtle p-3 space-y-2"
 >
 <div className="flex items-start gap-2">
 <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" aria-hidden="true" />
 <div className="min-w-0">
 <p className="text-sm font-semibold font-display text-heading">
 {t('jobBoard.applied.title')}
 </p>
 <p className="mt-0.5 text-xs text-subtle">{t('jobBoard.applied.body')}</p>
 </div>
 </div>
 <div className="flex flex-wrap gap-2">
 <button
 type="button"
 onClick={() => {
 const category = (t(categoryTranslationKey(selectedJob)) || '').trim();
 Analytics.trackJobAlertCtaClick('job_detail_button', 'open', category);
 requestJobAlertOpen(category || undefined);
 backToList();
 }}
 className="inline-flex items-center gap-2 px-3 py-2 min-h-[44px] text-xs font-semibold font-display rounded-lg bg-accent-strong text-on-accent hover:bg-accent-strong-hover transition-colors"
 >
 <BellRing className="w-3.5 h-3.5" aria-hidden="true" />
 {t('jobBoard.applied.alertCta')}
 </button>
 <button
 type="button"
 onClick={() => handleApply(selectedJob)}
 className="inline-flex items-center gap-2 px-3 py-2 min-h-[44px] text-xs font-medium text-muted hover:text-strong transition-colors"
 >
 {t('jobBoard.applied.reopen')}
 </button>
 </div>
 </div>
 ) : null;

 // Job-detail alert prompt (fixed-position toast). Extracted to a variable so
 // it can be rendered in ALL JobBoard return branches — the component uses an
 // early-return chain, and the detail-view returns previously did not include
 // it, so the prompt effect fired on the detail view but had no render slot and
 // the toast never appeared. Rendered in the list + both detail returns below.
 const jobDetailPromptJsx = (jobDetailPromptVisible && jobDetailPromptCategory && userEmail && userId) ? (
 <Suspense fallback={null}>
 <JobDetailAlertPrompt
 category={jobDetailPromptCategory}
 userId={userId}
 email={userEmail}
 locale={locale}
 sourceJobSlug={selectedJob?.slug ?? null}
 sourceJobUrl={selectedJob?.url ?? null}
 sourceJobTitle={selectedJob?.title ?? null}
 cantonCode={selectedJob?.canton ?? null}
 onShown={() => Analytics.trackJobAlertCtaShown('job_detail_prompt', jobDetailPromptCategory)}
 onClose={() => {
 setJobDetailPromptVisible(false);
 setJobDetailPromptCategory(null);
 }}
 onAccepted={() => {
 const category = jobDetailPromptCategory;
 Analytics.trackJobAlertCtaClick('job_detail_prompt', 'accept', category);
 // Mirror inline-form behaviour: fire job_alert_created on successful
 // one-tap subscribe so Firestore writes and PostHog counts reconcile.
 Analytics.trackJobAlertCreated({
 keywords: category || '',
 location: selectedJob?.canton ?? '',
 frequency: 'weekly',
 surface: 'job_detail_prompt',
 });
 // Review PR #4338, bug G: keep the shared getUserAlerts cache correct —
 // this surface just created a new alert every other surface's cached
 // eligibility read needs to see.
 invalidateUserAlertsCache();
 import('@/services/jobDetailAlertGating').then(({ loadGatingState, saveGatingState, recordAccept, normalizeKeyword }) => {
 const next = recordAccept(loadGatingState(), new Date(), normalizeKeyword(category));
 saveGatingState(next);
 }).catch(() => {});
 }}
 onDismissed={() => {
 const category = jobDetailPromptCategory;
 Analytics.trackJobAlertCtaClick('job_detail_prompt', 'dismiss', category);
 import('@/services/jobDetailAlertGating').then(({ loadGatingState, saveGatingState, recordDismiss, normalizeKeyword }) => {
 const next = recordDismiss(loadGatingState(), new Date(), normalizeKeyword(category));
 saveGatingState(next);
 }).catch(() => {});
 }}
 onErrored={() => {
 Analytics.trackJobAlertCtaClick('job_detail_prompt', 'error', jobDetailPromptCategory);
 }}
 onManage={() => {
 // The manager (JobAlertForm) only mounts on the job-board LIST view, not
 // on this detail page — so leaving the detail first is required, then the
 // freshly-mounted form picks up the queued request (consumeJobAlertOpen)
 // even though it mounts lazily. Dispatching the DOM event here alone hit no
 // listener and went nowhere.
 requestJobAlertOpen();
 setJobDetailPromptVisible(false);
 setJobDetailPromptCategory(null);
 backToList();
 }}
 />
 </Suspense>
 ) : null;

 // Saved-jobs alert nudge toast (#4467).
 //
 // The `&& !jobDetailPromptVisible` that used to be here was the ONLY overlap
 // guard in the tree: one hardcoded pair out of the ten a family of five
 // bottom-anchored prompts produces, and it deleted the nudge rather than
 // deferring it. Both prompts now claim a popupQueue slot through
 // BottomPromptShell, which covers every pair — including the two rendered
 // from other subtrees, which no boolean here could have reached — and
 // PROMOTES the loser once the winner is dismissed instead of dropping it.
 const savedJobsNudgeJsx = savedNudge ? (
 <Suspense fallback={null}>
 <SavedJobsAlertNudge
 categoryLabel={savedNudge.categoryLabel}
 cantonCode={savedNudge.cantonCode}
 cantonLabel={savedNudge.cantonCode ? getCantonLabel(savedNudge.cantonCode, locale) : null}
 onShown={() => Analytics.trackEvent('nudge_shown', {
 nudge: 'saved_jobs_alert',
 saved_count: savedNudge.savedCount,
 nudge_category: savedNudge.category,
 nudge_canton: savedNudge.cantonCode || '(none)',
 })}
 userId={userId}
 email={userEmail}
 locale={locale}
 onClose={handleSavedNudgeClose}
 onAcceptTapped={handleSavedNudgeAcceptTapped}
 onAccepted={handleSavedNudgeAccepted}
 onAnonymousAccept={() => {
 // Hand off to the JobAlertForm (owns auth + email capture),
 // prefilling the derived keyword. Accept is terminal for the nudge;
 // the form flow has its own job_alert_created tracking. On the LIST
 // view the form is already mounted → the `openJobAlert` DOM event
 // expands + scrolls it. From DETAIL the form isn't mounted → same
 // queued-request + backToList dance as the prompt's onManage above.
 saveNudgeState(recordNudgeAccepted(loadNudgeState(), new Date()));
 if (isJobDetailView) {
 requestJobAlertOpen(savedNudge.categoryLabel);
 backToList();
 } else {
 window.dispatchEvent(new CustomEvent('openJobAlert', { detail: { keyword: savedNudge.categoryLabel } }));
 }
 }}
 onDismissed={handleSavedNudgeDismissed}
 />
 </Suspense>
 ) : null;

 // Save account-gating sign-in prompt (#4466 follow-up). Deliberately
 // separate from authGateModalJsx below — that one gates job-detail content
 // unlock (real login OR email-capture OR crawler bypass); saving requires a
 // real account only, no email fallback.
 const saveAuthPromptJsx = saveAuthPromptOpen ? (
 <Suspense fallback={null}>
 <SaveSignInPromptModal locale={locale} onDismiss={handleSaveAuthPromptDismiss} />
 </Suspense>
 ) : null;

 const authGateModalJsx = authGateOpen ? (
 <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) { authUnlockCandidateRef.current = null; setAuthGateOpen(false); releaseSlot('job-auth-gate'); setPendingJob(null); setAuthError(null); } }}>
 <div aria-hidden="true" className="absolute inset-0 bg-black/45 backdrop-blur-sm" />
 <div role="dialog" aria-modal="true" aria-label={t('jobBoard.gate.title') || 'Accedi per continuare'} className="relative w-full max-w-md rounded-stripe border border-edge bg-surface p-5 space-y-4">
 {/* Close X button */}
 <div className="flex items-start justify-between">
 <div className="flex items-center gap-3">
 <img src="/icons/icon-192x192.png" alt="Frontaliere Ticino" width={40} height={40} className="flex-shrink-0 rounded-stripe" loading="lazy" />
 <div>
 <h2 className="text-lg font-bold font-display text-heading">{t('jobBoard.gate.title')}</h2>
 <p className="text-xs font-medium text-accent">frontaliereticino.ch</p>
 <p className="text-sm text-subtle">{t('jobBoard.gate.subtitle')}</p>
 </div>
 </div>
 <button type="button" onClick={() => { authUnlockCandidateRef.current = null; setAuthGateOpen(false); releaseSlot('job-auth-gate'); setPendingJob(null); setAuthError(null); }} className="p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-stripe text-muted hover:text-subtle" aria-label={t('common.close')}>
 <X size={18} />
 </button>
 </div>

 {/* Pending job info */}
 {pendingJob && (
 <div className="flex items-center gap-3 p-3 rounded-stripe bg-surface-alt border border-edge">
 <Briefcase size={16} className="text-accent flex-shrink-0" />
 <div className="min-w-0">
 <p className="text-sm font-semibold text-heading line-clamp-2">{sanitizeJobTitle(pendingJob.titleByLocale?.[locale] ?? pendingJob.title)}</p>
 <p className="text-sm text-muted line-clamp-2">{pendingJob.company}{pendingJob.location ? ` — ${pendingJob.location}` : ''}</p>
 </div>
 </div>
 )}

 {/* Trust signals — above CTAs */}
 <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-subtle">
 <span className="inline-flex items-center gap-1"><CheckCircle2 size={12} className="text-success" />{t('jobBoard.gate.benefit1')}</span>
 <span className="inline-flex items-center gap-1"><CheckCircle2 size={12} className="text-success" />{t('jobBoard.gate.benefit2')}</span>
 <span className="inline-flex items-center gap-1"><CheckCircle2 size={12} className="text-success" />{t('jobBoard.gate.benefit3')}</span>
 <span className="inline-flex items-center gap-1"><Shield size={12} className="text-success" />{t('jobBoard.gate.privacyNote')}</span>
 </div>

 {/* Social proof */}
 {jobs.length > 0 && (
 <p className="text-xs font-medium text-accent">
 {jobs.length.toLocaleString()}+ {locale === 'it' ? 'annunci disponibili' : locale === 'de' ? 'verfügbare Stellenangebote' : locale === 'fr' ? 'offres disponibles' : 'listings available'}
 </p>
 )}

 <div className="space-y-3">
 <div className="space-y-2">
 <div ref={modalGoogleButtonRef} className="flex min-h-[44px] w-full items-center justify-center overflow-hidden rounded-stripe" />
 {!modalGoogleButtonReady && (
 <button
 type="button"
 onClick={() => void handleAuthAndOpen('google')}
 disabled={authBusy !== null}
 className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-surface border border-edge hover:bg-surface-raised disabled:opacity-60 text-strong text-sm font-semibold shadow-sm transition-colors"
 >
 {authBusy === 'google' ? <Loader2 className="w-4 h-4 animate-spin" /> : (
 <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
 <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
 <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
 <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
 <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
 </svg>
 )}
 {t('newsletter.popup.googleSignIn')}
 </button>
 )}
 </div>

 {/* LinkedIn Sign-In Button (conditional on Remote Config) */}
 {linkedInAvailable && (
 <button
 type="button"
 disabled={authBusy !== null}
 onClick={() => {
 const job = pendingJob || selectedJob;
 if (job) {
 const ctx = buildJobTrackingContext(job);
 Analytics.trackJobAuthFunnel('auth_method_click', { method: 'linkedin', ...ctx });
 setAuthBusy('linkedin');
 saveAuthJobContext({ slug: job.slug, company: job.company, location: job.location, category: job.category });
 const jobSlug = job.slugByLocale?.[locale] ?? job.slug;
 const section = getJobBoardSectionSlug(locale);
 const prefix = locale === 'it' ? '' : `/${locale}`;
 signInWithLinkedIn(`${prefix}/${section}/${jobSlug}/`.replace(/\/+/g, '/'))
 .catch(() => setAuthBusy(null));
 } else {
 setAuthBusy('linkedin');
 signInWithLinkedIn().catch(() => setAuthBusy(null));
 }
 }}
 className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-stripe bg-brand-linkedin hover:bg-brand-linkedin-hover disabled:opacity-60 text-on-accent text-sm font-semibold transition-colors"
 >
 {authBusy === 'linkedin' ? <Loader2 className="w-4 h-4 animate-spin" /> : (
 <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
 )}
 {locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}
 </button>
 )}

 {/* Divider */}
 <div className="flex items-center gap-3">
 <div className="flex-1 h-px bg-surface-raised" />
 <span className="text-sm text-muted">{t('jobBoard.authGateOrEmail')}</span>
 <div className="flex-1 h-px bg-surface-raised" />
 </div>

 {/* Email form */}
 <form
 onSubmit={(e) => { e.preventDefault(); void handleEmailAccess(); }}
 className="space-y-2"
 >
 <EmailInput
 value={emailInput}
 onChange={setEmailInput}
 placeholder={t('jobBoard.authGateEmailPlaceholder')}
 className="w-full px-3 py-2.5 rounded-stripe border border-edge bg-surface text-sm text-heading placeholder-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
 />
 <button
 type="submit"
 disabled={authBusy !== null || !emailInput.trim()}
 className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-sm font-semibold transition-colors"
 >
 {authBusy === 'email' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
 {t('jobBoard.authGateEmailCta')}
 </button>
 {/* The gate's ONE notice (#5765). It covers both ways through this gate —
 the provider buttons above and this button — which is why the sentence
 opens with "accedendo" and why both branches of the upsert store it. */}
 <ConsentNotice consentKey="communicationsSignIn" locale={locale} className="text-[11px] text-muted leading-relaxed block" />
 </form>
 </div>

 {authError && <p className="text-sm text-danger">{authError}</p>}
 </div>
 </div>
 ) : null;

 // Hero (badge + H1 + subtitle) for listing/search/location routes. Defined
 // BEFORE the jobsLoading gate so it can render DURING loading too — otherwise
 // this H1/subtitle (the LCP element) only paints after the ~1.9MB job index
 // downloads + the 5564-job parse/normalize finishes (#2350: lab LCP 4.5s,
 // render-delay 97%). Painting it on first mount (~2s) makes it the LCP; the
 // later loaded re-render is the same element/size so LCP isn't pushed back,
 // and the matching position keeps the hero shift-free (CLS).
 const listingHero = (
 <div className="text-center space-y-3">
 <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-accent-subtle text-accent rounded-full text-xs font-medium">
 <Briefcase className="w-4 h-4" />
 {t('jobBoard.badge')}
 </div>
 <h1 className="text-2xl sm:text-3xl font-bold font-display text-heading">
 {companyDisplayName
 ? t('jobBoard.companyPageTitle', { company: companyDisplayName, ...cantonI18n })
 : locationDisplayName
 ? t('jobBoard.locationPageTitle', { location: locationDisplayName, ...cantonI18n })
 : searchHeadingQuery
 ? t('jobBoard.searchPageTitle', { query: searchHeadingQuery })
 : t('jobBoard.title', cantonI18n)}
 </h1>
 <p className="text-sm sm:text-base text-subtle max-w-2xl mx-auto">{t('jobBoard.subtitle', cantonI18n)}</p>
 </div>
 );

 if (jobsLoading) {
 // Expired job pages with seeded data: render the expired view immediately
 // instead of a spinner. Google's WRS executes JS and would otherwise see
 // a blank loading state, making all 4k+ soft-landing pages useless for SEO.
 if (expiredJob && initialJobSlug && !companySlugFilter && !locationSlugFilter && !searchSlugFilter) {
 return (
 <JobExpiredView
 job={expiredJob}
 relatedJobs={[]}
 onBack={backToList}
 hasAccess={hasAccess}
 />
 );
 }
 // A build-seeded active job-detail (window.__JOB_SEED__) renders its real
 // content immediately — skip the loader and fall through to the
 // `if (selectedJob)` block below so the page paints on the first frame
 // without waiting for the full index. (CLS-safe: real layout, no late jump.)
 // Without this, the loader masks the seed until jobsLoading flips false.
 const seededActiveDetail = selectedJob && initialJobSlug
 && !companySlugFilter && !locationSlugFilter && !searchSlugFilter;
 if (!seededActiveDetail) {
 // Non-seeded job-detail URL (SPA navigation, or a page built before the
 // seed shipped): render the layout-matching SkeletonJobDetail instead of the
 // generic centered spinner, so first paint matches the eventual detail layout
 // (CLS) and we never expose a generic loading state before the index resolves.
 // Seeded expired/orphan pages are exempt — `seeded` window-data renders
 // synchronously above. (#1511)
 if (initialJobSlug && !companySlugFilter && !locationSlugFilter && !searchSlugFilter && !seeded) {
 return <SkeletonJobDetail />;
 }
 // Listing / search / location loading: paint the real hero (the LCP element,
 // #2350) on first mount, above a list skeleton, instead of waiting for the
 // full job-index fetch. Mirrors the loaded layout (hero → search → 10 cards)
 // so the hero reconciles in place and the footer stays below the fold (CLS).
 // Company-brand pages keep the generic skeleton — their loaded hero is the
 // richer EmployerBrandHub, not this text hero.
 if (!companySlugFilter) {
 return (
 <div className="space-y-6 min-h-[80vh]">
 {listingHero}
 <div className="h-14 rounded-2xl bg-surface-raised animate-pulse" />
 {/* Animated, accessible loader (#2968): rotating reassurance + shimmer
 cards sized to the real JobCard so results reconcile in place (CLS). */}
 <JobBoardResultsLoader cards={8} />
 </div>
 );
 }
 return (
 // Reserve realistic page height during the async job fetch. Search/filter
 // URLs (e.g. /cerca-lavoro-ticino/concorsi-…, ricerca-*) render this
 // JobBoard WITHOUT staticOverlay, so App.tsx display:none's the full-height
 // static SEO body on hydration. The previous centered spinner reserved only
 // 80vh: the footer sat just inside the viewport during the fetch, then got
 // pushed below the fold when the ~10-card list resolved → 0.064 CLS on
 // every landing (field p75 0.58 on /cerca-lavoro-ticino/). The skeleton
 // list approximates the final list height (header + search bar + 10×112px
 // cards, min-h-[80vh] floor inside SkeletonJobBoard) so the footer never
 // enters the viewport mid-load.
 <SkeletonJobBoard />
 );
 }
 }

 const authPendingNoticeJsx = authNotice?.kind === 'pending' ? (
 // Mobile-collapsed by design: the user is at the top of a job-detail page
 // and the auth-pending banner pushed the actual content below the fold on
 // small viewports (~3 short lines = ~140px of vertical real estate). The
 // <details> pattern keeps title + email visible (the essential signal —
 // "we sent you a link to this address") and tucks the description +
 // spam hint behind a 1-tap toggle on mobile. On `sm:` and up the banner
 // opens by default and stays open (open:hidden on the marker hides the
 // chevron once expanded). Native <details> needs no extra JS and remains
 // accessible to screen readers and keyboard users.
 <details
 className="group rounded-2xl border border-warning-border bg-warning-subtle px-4 py-3 text-left shadow-sm [&[open]]:py-4"
 open={typeof window !== 'undefined' ? window.matchMedia('(min-width: 640px)').matches : false}
 >
 <summary className="flex cursor-pointer list-none items-start gap-3 [&::-webkit-details-marker]:hidden">
 <div className="mt-0.5 rounded-full bg-warning-subtle p-2 text-warning">
 <Mail className="h-4 w-4" />
 </div>
 <div className="min-w-0 flex-1">
 <p className="text-sm font-bold text-warning">{t('newsletter.doubleOptIn.title')}</p>
 <p className="mt-1 truncate text-xs font-medium text-warning">{authNotice.email}</p>
 </div>
 <ChevronDown
 className="mt-1 h-4 w-4 shrink-0 text-warning transition-transform group-open:rotate-180 sm:hidden"
 aria-hidden="true"
 />
 </summary>
 <div className="mt-2 space-y-1 pl-9">
 <p className="text-sm text-warning">{t('newsletter.doubleOptIn.description')}</p>
 <p className="text-sm text-warning">{t('newsletter.doubleOptIn.spamHint')}</p>
 </div>
 </details>
 ) : null;

 if (editorialJobTodayLanding) {
 return (
 <JobBoardRailShell isDesktopLg={isDesktopLg}>
 <div className="space-y-6">
 <section className="rounded-3xl border border-info-border bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-6 sm:p-8">
 <p className="text-xs font-bold uppercase tracking-[0.18em] text-info">
 {editorialJobTodayLanding.updatedLabel} · {new Date().toLocaleDateString('it-CH')}
 </p>
 <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold font-display tracking-tight text-heading">
 {editorialJobTodayLanding.heading}
 </h1>
 <p className="mt-4 max-w-4xl text-sm sm:text-base leading-7 text-body">
 {editorialJobTodayLanding.description}
 </p>
 <p className="mt-3 max-w-4xl text-sm leading-7 text-subtle">
 {editorialJobTodayLanding.intro}
 </p>
 </section>

 <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm text-subtle">
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialJobTodayLanding.totalJobs}</span> {editorialJobTodayLanding.countsLabel}</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialJobTodayLanding.sections.last24Hours.jobs.length}</span> {editorialJobTodayLanding.sections.last24Hours.label}</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialJobTodayLanding.sections.last3Days.jobs.length}</span> {editorialJobTodayLanding.sections.last3Days.label}</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialJobTodayLanding.sections.partTime.jobs.length}</span> {editorialJobTodayLanding.sections.partTime.label}</span>
 </div>

 <section className="rounded-2xl border border-edge bg-surface p-4 sm:p-5">
 <div className="flex flex-wrap gap-2">
 {editorialJobTodayLanding.internalLinks.map((link) => (
 <a
 key={link.href}
 href={link.href}
 className="inline-flex items-center rounded-full bg-accent-subtle px-3 py-1.5 text-xs font-bold text-accent no-underline hover:underline"
 >
 {link.label}
 </a>
 ))}
 </div>
 </section>

 <section className="rounded-2xl border border-edge bg-surface p-5">
 <div className="flex items-center justify-between gap-4 mb-4">
 <h2 className="text-lg font-bold font-display text-heading">{editorialJobTodayLanding.sections.cityHubLabel}</h2>
 <a
 href={buildPath({ activeTab: 'job-board' }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.('');
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="text-sm font-bold text-accent no-underline hover:underline"
 >
 {editorialJobTodayLanding.openAllLabel}
 </a>
 </div>
 <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
 {editorialJobTodayLanding.sections.cities.map((city) => {
 const { canton: cityCanton, slug: citySlug } = hubLinkRoute(city.href);
 return (
 <a
 key={city.href}
 href={buildPath({ activeTab: 'job-board', ...(cityCanton ? { jobBoardCanton: cityCanton } : {}), jobSlug: citySlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(citySlug, cityCanton);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="flex items-center justify-between gap-3 rounded-2xl border border-edge px-4 py-3 no-underline hover:border-accent transition-colors"
 >
 <span className="font-semibold text-strong">{city.name}</span>
 <span className="text-sm font-bold text-accent">{city.count}</span>
 </a>
 );
 })}
 </div>
 </section>

 {editorialLandingSections.map((section) => (
 <section key={section.id} id={section.id} className="rounded-2xl border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading mb-4">{section.label}</h2>
 <div className="space-y-3">
 {renderJobListWithAds(section.jobs, section.id)}
 </div>
 </section>
 ))}
 {AD_SLOTS.JOBLIST_END_MULTIPLEX.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBLIST_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.JOBLIST_END_MULTIPLEX.format}
 className="mt-4"
 />
 )}
 {authGateModalJsx}
 </div>
 </JobBoardRailShell>
 );
 }

 if (editorialOfficialGazetteLanding) {
 return (
 <JobBoardRailShell isDesktopLg={isDesktopLg}>
 <div className="space-y-6">
 <section className="rounded-3xl border border-info-border bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-6 sm:p-8">
 <p className="text-xs font-bold uppercase tracking-[0.18em] text-info">
 {editorialOfficialGazetteLanding.updatedLabel} · {new Date().toLocaleDateString('it-CH')}
 </p>
 <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold font-display tracking-tight text-heading">
 {editorialOfficialGazetteLanding.heading}
 </h1>
 <p className="mt-4 max-w-4xl text-sm sm:text-base leading-7 text-body">
 {editorialOfficialGazetteLanding.description}
 </p>
 <p className="mt-3 max-w-4xl text-sm leading-7 text-subtle">
 {editorialOfficialGazetteLanding.intro}
 </p>
 </section>

 <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm text-subtle">
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialOfficialGazetteLanding.totalJobs}</span> {editorialOfficialGazetteLanding.countsLabel}</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialOfficialGazetteLanding.latestJobs.length}</span> {editorialOfficialGazetteLanding.latestLabel}</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5">{editorialOfficialGazetteLanding.officialSourceLabel} <a href={editorialOfficialGazetteLanding.officialSourceUrl} target="_blank" rel="nofollow noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-accent no-underline hover:underline">concorsi.ti.ch <ArrowUpRight className="w-3.5 h-3.5" /></a></span>
 </div>

 <section className="rounded-2xl border border-edge bg-surface p-4 sm:p-5">
 <div className="flex flex-wrap gap-2">
 {editorialOfficialGazetteLanding.internalLinks.map((link) => {
 const localPath = link.href.startsWith(PUBLIC_SITE_URL) ? link.href.replace(PUBLIC_SITE_URL, '') : '';
 const localParts = localPath.split('/').filter(Boolean);
 const isBoardRoot = localParts.length <= (locale === 'it' ? 1 : 2);
 const slug = !isBoardRoot && localParts.length > 0 ? localParts[localParts.length - 1] : '';
 const linkCanton = hubLinkRoute(link.href).canton;
 if (!localPath) {
 return (
 <a
 key={link.href}
 href={link.href}
 className="inline-flex items-center rounded-full bg-accent-subtle px-3 py-1.5 text-xs font-bold text-accent no-underline hover:underline"
 >
 {link.label}
 </a>
 );
 }
 return (
 <a
 key={link.href}
 href={slug ? buildPath({ activeTab: 'job-board', ...(linkCanton ? { jobBoardCanton: linkCanton } : {}), jobSlug: slug }, locale) : buildPath({ activeTab: 'job-board' }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(slug || '', linkCanton);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="inline-flex items-center rounded-full bg-accent-subtle px-3 py-1.5 text-xs font-bold text-accent no-underline hover:underline"
 >
 {link.label}
 </a>
 );
 })}
 </div>
 </section>

 <section className="grid gap-3 lg:grid-cols-3">
 {editorialOfficialGazetteLanding.explainerCards.map((card) => (
 <article key={card.title} className="rounded-2xl border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading">{card.title}</h2>
 <p className="mt-3 text-sm leading-7 text-subtle">{card.body}</p>
 </article>
 ))}
 </section>

 {editorialLandingSections.map((section) => (
 <section key={section.id} id={section.id} className="rounded-2xl border border-edge bg-surface p-5">
 <div className="flex items-center justify-between gap-4 mb-4">
 <h2 className="text-lg font-bold font-display text-heading">{section.label}</h2>
 <a
 href={buildPath({ activeTab: 'job-board' }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.('');
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="text-sm font-bold text-accent no-underline hover:underline"
 >
 {editorialOfficialGazetteLanding.openAllLabel}
 </a>
 </div>
 <div className="space-y-3">
 {renderJobListWithAds(section.jobs, section.id)}
 </div>
 </section>
 ))}

 <section className="rounded-2xl border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading mb-4">
 {locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'Frequently asked questions' : locale === 'de' ? 'Haufige Fragen' : 'Questions frequentes'}
 </h2>
 <div className="space-y-3">
 {editorialOfficialGazetteLanding.faq.map((entry) => (
 <details key={entry.question} className="rounded-2xl border border-edge px-4 py-3">
 <summary className="cursor-pointer text-sm font-bold text-heading">{entry.question}</summary>
 <p className="mt-3 text-sm leading-7 text-subtle">{entry.answer}</p>
 </details>
 ))}
 </div>
 </section>
 {AD_SLOTS.JOBLIST_END_MULTIPLEX.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBLIST_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.JOBLIST_END_MULTIPLEX.format}
 className="mt-4"
 />
 )}
 {authGateModalJsx}
 </div>
 </JobBoardRailShell>
 );
 }

 if (editorialNursesHubLanding) {
 return (
 <JobBoardRailShell isDesktopLg={isDesktopLg}>
 <div className="space-y-6">
 <section className="rounded-3xl border border-info-border bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-6 sm:p-8">
 <p className="text-xs font-bold uppercase tracking-[0.18em] text-info">
 {editorialNursesHubLanding.updatedLabel} · {new Date().toLocaleDateString('it-CH')}
 </p>
 <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold font-display tracking-tight text-heading">
 {editorialNursesHubLanding.heading}
 </h1>
 <p className="mt-4 max-w-4xl text-sm sm:text-base leading-7 text-body">
 {editorialNursesHubLanding.description}
 </p>
 <p className="mt-3 max-w-4xl text-sm leading-7 text-subtle">
 {editorialNursesHubLanding.intro}
 </p>
 </section>

 <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm text-subtle">
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialNursesHubLanding.totalJobs}</span> {editorialNursesHubLanding.countsLabel}</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialNursesHubLanding.latestJobs.length}</span> {editorialNursesHubLanding.latestLabel}</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialNursesHubLanding.variants.length}</span> {editorialNursesHubLanding.variantTitle}</span>
 </div>

 {editorialNursesHubLanding.variants.length > 0 && (
 <section className="rounded-2xl border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading mb-4">{editorialNursesHubLanding.variantTitle}</h2>
 <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
 {editorialNursesHubLanding.variants.map((link) => {
 const { canton: targetCanton, slug: targetSlug } = hubLinkRoute(link.href);
 return (
 <a
 key={link.href}
 href={buildPath({ activeTab: 'job-board', ...(targetCanton ? { jobBoardCanton: targetCanton } : {}), jobSlug: targetSlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(targetSlug, targetCanton);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="flex items-center justify-between gap-3 rounded-2xl border border-edge px-4 py-3 no-underline hover:border-accent transition-colors"
 >
 <span className="font-semibold text-strong">{link.label}</span>
 <span className="text-sm font-bold text-accent">{link.count}</span>
 </a>
 );
 })}
 </div>
 </section>
 )}

 <section className="grid gap-3 lg:grid-cols-3">
 {editorialNursesHubLanding.explainerCards.map((card) => (
 <article key={card.title} className="rounded-2xl border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading">{card.title}</h2>
 <p className="mt-3 text-sm leading-7 text-subtle">{card.body}</p>
 </article>
 ))}
 </section>

 {editorialLandingSections.map((section) => (
 <section key={section.id} id={section.id} className="rounded-2xl border border-edge bg-surface p-5">
 <div className="flex items-center justify-between gap-4 mb-4">
 <h2 className="text-lg font-bold font-display text-heading">{section.label}</h2>
 <a
 href={buildPath({ activeTab: 'job-board' }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.('');
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="text-sm font-bold text-accent no-underline hover:underline"
 >
 {editorialNursesHubLanding.openAllLabel}
 </a>
 </div>
 <div className="space-y-3">
 {renderJobListWithAds(section.jobs, section.id)}
 </div>
 </section>
 ))}

 <section className="rounded-2xl border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading mb-4">
 {locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'Frequently asked questions' : locale === 'de' ? 'Haufige Fragen' : 'Questions frequentes'}
 </h2>
 <div className="space-y-3">
 {editorialNursesHubLanding.faq.map((entry) => (
 <details key={entry.question} className="rounded-2xl border border-edge px-4 py-3">
 <summary className="cursor-pointer text-sm font-bold text-heading">{entry.question}</summary>
 <p className="mt-3 text-sm leading-7 text-subtle">{entry.answer}</p>
 </details>
 ))}
 </div>
 </section>
 {AD_SLOTS.JOBLIST_END_MULTIPLEX.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBLIST_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.JOBLIST_END_MULTIPLEX.format}
 className="mt-4"
 />
 )}
 {authGateModalJsx}
 </div>
 </JobBoardRailShell>
 );
 }

 if (editorialCareVariantLanding) {
 const { canton: parentCanton, slug: parentSlug } = hubLinkRoute(editorialCareVariantLanding.parentHubHref);
 return (
 <JobBoardRailShell isDesktopLg={isDesktopLg}>
 <div className="space-y-6">
 <section className="rounded-3xl border border-info-border bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-6 sm:p-8">
 <p className="text-xs font-bold uppercase tracking-[0.18em] text-info">
 {editorialCareVariantLanding.updatedLabel} · {new Date().toLocaleDateString('it-CH')}
 </p>
 <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold font-display tracking-tight text-heading">
 {editorialCareVariantLanding.heading}
 </h1>
 <p className="mt-4 max-w-4xl text-sm sm:text-base leading-7 text-body">
 {editorialCareVariantLanding.description}
 </p>
 <p className="mt-3 max-w-4xl text-sm leading-7 text-subtle">
 {editorialCareVariantLanding.intro}
 </p>
 <button
 type="button"
 onClick={() => {
 onJobRouteChange?.(parentSlug, parentCanton);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="mt-4 inline-flex items-center gap-2 rounded-full border border-accent-border px-4 py-2 min-h-[44px] text-sm font-bold text-accent"
 >
 <ArrowLeft className="w-4 h-4" />
 {/* BLOCK-B: Regionalize for national expansion — currently hardcodes Ticino/Tessin text */}
 {locale === 'it' ? 'Torna a infermieri in Ticino' : locale === 'en' ? 'Back to nurses in Ticino' : locale === 'de' ? 'Zuruck zu Pflege-Jobs im Tessin' : 'Retour a infirmiers au Tessin'}
 </button>
 </section>

 <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm text-subtle">
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialCareVariantLanding.totalJobs}</span> {editorialCareVariantLanding.countsLabel}</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialCareVariantLanding.latestJobs.length}</span> {editorialCareVariantLanding.latestLabel}</span>
 </div>

 {editorialCareVariantLanding.siblingLinks.length > 0 && (
 <section className="rounded-2xl border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading mb-4">
 {locale === 'it' ? 'Altri percorsi sanitari' : locale === 'en' ? 'Other care paths' : locale === 'de' ? 'Weitere Pflegepfade' : 'Autres parcours sante'}
 </h2>
 <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
 {editorialCareVariantLanding.siblingLinks.map((link) => {
 const { canton: targetCanton, slug: targetSlug } = hubLinkRoute(link.href);
 return (
 <a
 key={link.href}
 href={buildPath({ activeTab: 'job-board', ...(targetCanton ? { jobBoardCanton: targetCanton } : {}), jobSlug: targetSlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(targetSlug, targetCanton);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="flex items-center justify-between gap-3 rounded-2xl border border-edge px-4 py-3 no-underline hover:border-accent transition-colors"
 >
 <span className="font-semibold text-strong">{link.label}</span>
 <span className="text-sm font-bold text-accent">{link.count}</span>
 </a>
 );
 })}
 </div>
 </section>
 )}

 {editorialLandingSections.map((section) => (
 <section key={section.id} id={section.id} className="rounded-2xl border border-edge bg-surface p-5">
 <div className="flex items-center justify-between gap-4 mb-4">
 <h2 className="text-lg font-bold font-display text-heading">{section.label}</h2>
 <a
 href={buildPath({ activeTab: 'job-board' }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.('');
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="text-sm font-bold text-accent no-underline hover:underline"
 >
 {editorialCareVariantLanding.openAllLabel}
 </a>
 </div>
 <div className="space-y-3">
 {renderJobListWithAds(section.jobs, section.id)}
 </div>
 </section>
 ))}
 {AD_SLOTS.JOBLIST_END_MULTIPLEX.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBLIST_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.JOBLIST_END_MULTIPLEX.format}
 className="mt-4"
 />
 )}
 {authGateModalJsx}
 </div>
 </JobBoardRailShell>
 );
 }

 if (editorialLocationLanding) {
 return (
 <JobBoardRailShell isDesktopLg={isDesktopLg}>
 <div className="space-y-6">
 <section className="rounded-3xl border border-info-border bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-6 sm:p-8">
 <p className="text-xs font-bold uppercase tracking-[0.18em] text-info">
 {editorialLocationLanding.updatedLabel} · {new Date().toLocaleDateString('it-CH')}
 </p>
 <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold font-display tracking-tight text-heading">
 {editorialLocationLanding.heading}
 </h1>
 <p className="mt-4 max-w-4xl text-sm sm:text-base leading-7 text-body">
 {editorialLocationLanding.description}
 </p>
 <p className="mt-3 max-w-4xl text-sm leading-7 text-subtle">
 {editorialLocationLanding.intro}
 </p>
 </section>

 <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm text-subtle">
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialLocationLanding.totalJobs}</span> {editorialLocationLanding.countsLabel}</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialLocationLanding.latestJobs.length}</span> {editorialLocationLanding.latestLabel}</span>
 </div>

 {editorialLocationLanding.relatedTypeLinks.length > 0 && (
 <section className="rounded-2xl border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading mb-4">
 {locale === 'it' ? `Tipi di lavoro a ${editorialLocationLanding.location}` : locale === 'en' ? `Job types in ${editorialLocationLanding.location}` : locale === 'de' ? `Jobtypen in ${editorialLocationLanding.location}` : `Types d'emploi a ${editorialLocationLanding.location}`}
 </h2>
 <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
 {editorialLocationLanding.relatedTypeLinks.map((link) => {
 const { canton: targetCanton, slug: targetSlug } = hubLinkRoute(link.href);
 return (
 <a
 key={link.href}
 href={buildPath({ activeTab: 'job-board', ...(targetCanton ? { jobBoardCanton: targetCanton } : {}), jobSlug: targetSlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(targetSlug, targetCanton);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="flex items-center justify-between gap-3 rounded-2xl border border-edge px-4 py-3 no-underline hover:border-accent transition-colors"
 >
 <span className="font-semibold text-strong">{link.label}</span>
 <span className="text-sm font-bold text-accent">{link.count}</span>
 </a>
 );
 })}
 </div>
 </section>
 )}

 {editorialLocationLanding.relatedSectorLinks.length > 0 && (
 <section className="rounded-2xl border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading mb-4">
 {locale === 'it' ? `Settori a ${editorialLocationLanding.location}` : locale === 'en' ? `Sectors in ${editorialLocationLanding.location}` : locale === 'de' ? `Branchen in ${editorialLocationLanding.location}` : `Secteurs a ${editorialLocationLanding.location}`}
 </h2>
 <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
 {editorialLocationLanding.relatedSectorLinks.map((link) => {
 const { canton: targetCanton, slug: targetSlug } = hubLinkRoute(link.href);
 return (
 <a
 key={link.href}
 href={buildPath({ activeTab: 'job-board', ...(targetCanton ? { jobBoardCanton: targetCanton } : {}), jobSlug: targetSlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(targetSlug, targetCanton);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="flex items-center justify-between gap-3 rounded-2xl border border-edge px-4 py-3 no-underline hover:border-accent transition-colors"
 >
 <span className="font-semibold text-strong">{link.label}</span>
 <span className="text-sm font-bold text-accent">{link.count}</span>
 </a>
 );
 })}
 </div>
 </section>
 )}

 {editorialLandingSections.map((section) => (
 <section key={section.id} id={section.id} className="rounded-2xl border border-edge bg-surface p-5">
 <div className="flex items-center justify-between gap-4 mb-4">
 <h2 className="text-lg font-bold font-display text-heading">{section.label}</h2>
 <a
 href={buildPath({ activeTab: 'job-board' }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.('');
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="text-sm font-bold text-accent no-underline hover:underline"
 >
 {editorialLocationLanding.openAllLabel}
 </a>
 </div>
 <div className="space-y-3">
 {renderJobListWithAds(section.jobs, section.id)}
 </div>
 </section>
 ))}
 {AD_SLOTS.JOBLIST_END_MULTIPLEX.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBLIST_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.JOBLIST_END_MULTIPLEX.format}
 className="mt-4"
 />
 )}
 {authGateModalJsx}
 </div>
 </JobBoardRailShell>
 );
 }

 if (editorialLocationTypeLanding) {
 const { canton: parentCanton, slug: parentSlug } = hubLinkRoute(editorialLocationTypeLanding.parentLocationHref);
 return (
 <JobBoardRailShell isDesktopLg={isDesktopLg}>
 <div className="space-y-6">
 <section className="rounded-3xl border border-info-border bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-6 sm:p-8">
 <p className="text-xs font-bold uppercase tracking-[0.18em] text-info">
 {editorialLocationTypeLanding.updatedLabel} · {new Date().toLocaleDateString('it-CH')}
 </p>
 <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold font-display tracking-tight text-heading">
 {editorialLocationTypeLanding.heading}
 </h1>
 <p className="mt-4 max-w-4xl text-sm sm:text-base leading-7 text-body">
 {editorialLocationTypeLanding.description}
 </p>
 <p className="mt-3 max-w-4xl text-sm leading-7 text-subtle">
 {editorialLocationTypeLanding.intro}
 </p>
 <button
 type="button"
 onClick={() => {
 onJobRouteChange?.(parentSlug, parentCanton);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="mt-4 inline-flex items-center gap-2 rounded-full border border-accent-border px-4 py-2 min-h-[44px] text-sm font-bold text-accent"
 >
 <ArrowLeft className="w-4 h-4" />
 {locale === 'it' ? `Torna a lavoro a ${editorialLocationTypeLanding.location}` : locale === 'en' ? `Back to jobs in ${editorialLocationTypeLanding.location}` : locale === 'de' ? `Zuruck zu Jobs in ${editorialLocationTypeLanding.location}` : `Retour aux emplois a ${editorialLocationTypeLanding.location}`}
 </button>
 </section>

 <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm text-subtle">
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialLocationTypeLanding.totalJobs}</span> {editorialLocationTypeLanding.countsLabel}</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialLocationTypeLanding.latestJobs.length}</span> {editorialLocationTypeLanding.latestLabel}</span>
 </div>

 {editorialLocationTypeLanding.siblingTypeLinks.length > 0 && (
 <section className="rounded-2xl border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading mb-4">
 {locale === 'it' ? `Altri tipi di lavoro a ${editorialLocationTypeLanding.location}` : locale === 'en' ? `Other job types in ${editorialLocationTypeLanding.location}` : locale === 'de' ? `Weitere Jobtypen in ${editorialLocationTypeLanding.location}` : `Autres types d'emploi a ${editorialLocationTypeLanding.location}`}
 </h2>
 <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
 {editorialLocationTypeLanding.siblingTypeLinks.map((link) => {
 const { canton: targetCanton, slug: targetSlug } = hubLinkRoute(link.href);
 return (
 <a
 key={link.href}
 href={buildPath({ activeTab: 'job-board', ...(targetCanton ? { jobBoardCanton: targetCanton } : {}), jobSlug: targetSlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(targetSlug, targetCanton);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="flex items-center justify-between gap-3 rounded-2xl border border-edge px-4 py-3 no-underline hover:border-accent transition-colors"
 >
 <span className="font-semibold text-strong">{link.label}</span>
 <span className="text-sm font-bold text-accent">{link.count}</span>
 </a>
 );
 })}
 </div>
 </section>
 )}

 {editorialLandingSections.map((section) => (
 <section key={section.id} id={section.id} className="rounded-2xl border border-edge bg-surface p-5">
 <div className="flex items-center justify-between gap-4 mb-4">
 <h2 className="text-lg font-bold font-display text-heading">{section.label}</h2>
 <a
 href={buildPath({ activeTab: 'job-board' }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.('');
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="text-sm font-bold text-accent no-underline hover:underline"
 >
 {editorialLocationTypeLanding.openAllLabel}
 </a>
 </div>
 <div className="space-y-3">
 {renderJobListWithAds(section.jobs, section.id)}
 </div>
 </section>
 ))}
 {AD_SLOTS.JOBLIST_END_MULTIPLEX.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBLIST_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.JOBLIST_END_MULTIPLEX.format}
 className="mt-4"
 />
 )}
 {authGateModalJsx}
 </div>
 </JobBoardRailShell>
 );
 }

 if (editorialLocationSectorLanding) {
 const { canton: parentCanton, slug: parentSlug } = hubLinkRoute(editorialLocationSectorLanding.parentLocationHref);
 return (
 <JobBoardRailShell isDesktopLg={isDesktopLg}>
 <div className="space-y-6">
 <section className="rounded-3xl border border-info-border bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-6 sm:p-8">
 <p className="text-xs font-bold uppercase tracking-[0.18em] text-info">
 {editorialLocationSectorLanding.updatedLabel} · {new Date().toLocaleDateString('it-CH')}
 </p>
 <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold font-display tracking-tight text-heading">
 {editorialLocationSectorLanding.heading}
 </h1>
 <p className="mt-4 max-w-4xl text-sm sm:text-base leading-7 text-body">
 {editorialLocationSectorLanding.description}
 </p>
 <p className="mt-3 max-w-4xl text-sm leading-7 text-subtle">
 {editorialLocationSectorLanding.intro}
 </p>
 <button
 type="button"
 onClick={() => {
 onJobRouteChange?.(parentSlug, parentCanton);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="mt-4 inline-flex items-center gap-2 rounded-full border border-accent-border px-4 py-2 min-h-[44px] text-sm font-bold text-accent"
 >
 <ArrowLeft className="w-4 h-4" />
 {locale === 'it' ? `Torna a lavoro a ${editorialLocationSectorLanding.location}` : locale === 'en' ? `Back to jobs in ${editorialLocationSectorLanding.location}` : locale === 'de' ? `Zuruck zu Jobs in ${editorialLocationSectorLanding.location}` : `Retour aux emplois a ${editorialLocationSectorLanding.location}`}
 </button>
 </section>

 <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm text-subtle">
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialLocationSectorLanding.totalJobs}</span> {editorialLocationSectorLanding.countsLabel}</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialLocationSectorLanding.latestJobs.length}</span> {editorialLocationSectorLanding.latestLabel}</span>
 </div>

 {editorialLocationSectorLanding.siblingSectorLinks.length > 0 && (
 <section className="rounded-2xl border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading mb-4">
 {locale === 'it' ? `Altri settori a ${editorialLocationSectorLanding.location}` : locale === 'en' ? `Other sectors in ${editorialLocationSectorLanding.location}` : locale === 'de' ? `Weitere Branchen in ${editorialLocationSectorLanding.location}` : `Autres secteurs a ${editorialLocationSectorLanding.location}`}
 </h2>
 <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
 {editorialLocationSectorLanding.siblingSectorLinks.map((link) => {
 const { canton: targetCanton, slug: targetSlug } = hubLinkRoute(link.href);
 return (
 <a
 key={link.href}
 href={buildPath({ activeTab: 'job-board', ...(targetCanton ? { jobBoardCanton: targetCanton } : {}), jobSlug: targetSlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(targetSlug, targetCanton);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="flex items-center justify-between gap-3 rounded-2xl border border-edge px-4 py-3 no-underline hover:border-accent transition-colors"
 >
 <span className="font-semibold text-strong">{link.label}</span>
 <span className="text-sm font-bold text-accent">{link.count}</span>
 </a>
 );
 })}
 </div>
 </section>
 )}

 {editorialLandingSections.map((section) => (
 <section key={section.id} id={section.id} className="rounded-2xl border border-edge bg-surface p-5">
 <div className="flex items-center justify-between gap-4 mb-4">
 <h2 className="text-lg font-bold font-display text-heading">{section.label}</h2>
 <a
 href={buildPath({ activeTab: 'job-board' }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.('');
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="text-sm font-bold text-accent no-underline hover:underline"
 >
 {editorialLocationSectorLanding.openAllLabel}
 </a>
 </div>
 <div className="space-y-3">
 {renderJobListWithAds(section.jobs, section.id)}
 </div>
 </section>
 ))}
 {AD_SLOTS.JOBLIST_END_MULTIPLEX.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBLIST_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.JOBLIST_END_MULTIPLEX.format}
 className="mt-4"
 />
 )}
 {authGateModalJsx}
 </div>
 </JobBoardRailShell>
 );
 }

 if (editorialSectorRegionLanding) {
 return (
 <JobBoardRailShell isDesktopLg={isDesktopLg}>
 <div className="space-y-6">
 <section className="rounded-3xl border border-info-border bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-6 sm:p-8">
 <p className="text-xs font-bold uppercase tracking-[0.18em] text-info">
 {editorialSectorRegionLanding.updatedLabel} · {new Date().toLocaleDateString('it-CH')}
 </p>
 <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold font-display tracking-tight text-heading">
 {editorialSectorRegionLanding.heading}
 </h1>
 <p className="mt-4 max-w-4xl text-sm sm:text-base leading-7 text-body">
 {editorialSectorRegionLanding.description}
 </p>
 <p className="mt-3 max-w-4xl text-sm leading-7 text-subtle">
 {editorialSectorRegionLanding.intro}
 </p>
 <button
 type="button"
 onClick={() => {
 onJobRouteChange?.('');
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="mt-4 inline-flex items-center gap-2 rounded-full border border-accent-border px-4 py-2 min-h-[44px] text-sm font-bold text-accent"
 >
 <ArrowLeft className="w-4 h-4" />
 {editorialSectorRegionLanding.openAllLabel}
 </button>
 </section>

 <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm text-subtle">
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialSectorRegionLanding.totalJobs}</span> {editorialSectorRegionLanding.countsLabel}</span>
 <span className="hidden sm:inline text-edge" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-heading">{editorialSectorRegionLanding.latestJobs.length}</span> {editorialSectorRegionLanding.latestLabel}</span>
 </div>

 {editorialSectorRegionLanding.siblingSectorLinks.length > 0 && (
 <section className="rounded-2xl border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading mb-4">
 {/* BLOCK-B: Regionalize for national expansion — currently hardcodes Ticino/Tessin text */}
 {locale === 'it' ? 'Altri settori in Ticino' : locale === 'en' ? 'Other sectors in Ticino' : locale === 'de' ? 'Weitere Branchen im Tessin' : 'Autres secteurs au Tessin'}
 </h2>
 <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
 {editorialSectorRegionLanding.siblingSectorLinks.map((link) => {
 const { canton: targetCanton, slug: targetSlug } = hubLinkRoute(link.href);
 return (
 <a
 key={link.href}
 href={buildPath({ activeTab: 'job-board', ...(targetCanton ? { jobBoardCanton: targetCanton } : {}), jobSlug: targetSlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(targetSlug, targetCanton);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="flex items-center justify-between gap-3 rounded-2xl border border-edge px-4 py-3 no-underline hover:border-accent transition-colors"
 >
 <span className="font-semibold text-strong">{link.label}</span>
 <span className="text-sm font-bold text-accent">{link.count}</span>
 </a>
 );
 })}
 </div>
 </section>
 )}

 {editorialLandingSections.map((section) => (
 <section key={section.id} id={section.id} className="rounded-2xl border border-edge bg-surface p-5">
 <div className="flex items-center justify-between gap-4 mb-4">
 <h2 className="text-lg font-bold font-display text-heading">{section.label}</h2>
 <a
 href={buildPath({ activeTab: 'job-board' }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.('');
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }}
 className="text-sm font-bold text-accent no-underline hover:underline"
 >
 {editorialSectorRegionLanding.openAllLabel}
 </a>
 </div>
 <div className="space-y-3">
 {renderJobListWithAds(section.jobs, section.id)}
 </div>
 </section>
 ))}
 {AD_SLOTS.JOBLIST_END_MULTIPLEX.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBLIST_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.JOBLIST_END_MULTIPLEX.format}
 className="mt-4"
 />
 )}
 {authGateModalJsx}
 </div>
 </JobBoardRailShell>
 );
 }

 // Bridge pages (previousSlugs) now serve full content — selectedJob resolves
 // via bridgeTargetSlug above. No redirect or interstitial needed.

 if (initialJobSlug && !selectedJob && !companySlugFilter && !locationSlugFilter && !searchSlugFilter) {
 // Ensure expired/orphan job pages are indexable — remove any stale noindex
 // that may have been set by a previous navigation or SPA hydration race.
 const robotsMeta = document.querySelector('meta[name="robots"]');
 if (robotsMeta?.getAttribute('content')?.includes('noindex')) {
 robotsMeta.remove();
 }
 // Bridge-in-flight guard: show skeleton instead of flashing JobOrphanView
 // ("Questo annuncio non è più disponibile") during the resolution window.
 // Two cases:
 //   (a) Map loaded, slug is a real job → bridge fetch still in flight.
 //   (b) The slug's shard (or the full map) not yet loaded → can't confirm
 //       orphan status yet. This covers slugs whose prefix (recherche-,
 //       page-, …) made the router boot skip the eager shard fetch. Without
 //       this branch the guard was blind: getJobMetaForSlug returned
 //       undefined and JobOrphanView flashed before the bridge effect could
 //       resolve.
 // In both cases bridgeFetchAttempted being set (finally block) clears the
 // skeleton after the bridge effect has ensured the slug's shard.
 const bridgeTargetForRender = bridgeTargetSlug || initialJobSlug;
 const bridgeMeta = getJobMetaForSlug(bridgeTargetForRender);
 if ((bridgeMeta?.id || !isJobSlugReady(bridgeTargetForRender)) && bridgeFetchAttempted !== bridgeTargetForRender) {
 return <SkeletonJobDetail />;
 }
 // Expired: slug found in expired-jobs.json — show metadata + sign-in + related
 if (expiredJobLoading) return <SkeletonJobDetail />;
 if (expiredJob) {
 return (
 <JobExpiredView
 job={expiredJob}
 relatedJobs={relatedJobsForNotFound}
 onBack={backToList}
 hasAccess={hasAccess}
 totalActiveJobs={jobs.length}
 onNavigateToCompany={(slug) => { onJobRouteChange?.(slug); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
 onNavigateToLocation={(slug) => { onJobRouteChange?.(slug); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
 onNavigateToJob={(slug) => { onJobRouteChange?.(slug, getJobMetaForSlug(slug)?.canton); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
 />
 );
 }
 // Orphan: GSC slug / legacy URL with no data — show derived title + sign-in
 return (
 <JobOrphanView
 slug={initialJobSlug}
 onBack={backToList}
 hasAccess={hasAccess}
 totalActiveJobs={jobs.length}
 onNavigateToCompany={(slug) => { onJobRouteChange?.(slug); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
 onNavigateToLocation={(slug) => { onJobRouteChange?.(slug); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
 onNavigateToJob={(slug) => { onJobRouteChange?.(slug, getJobMetaForSlug(slug)?.canton); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
 />
 );
 }

 /**
  * CompanyAlert (#5012) — «Segui questa azienda» on the job detail, on BOTH
  * surfaces this component renders: the unlocked detail and the `!hasAccess`
  * gate.
  *
  * It used to exist only in the unlocked branch, so the CTA was invisible to
  * exactly the visitor phase 2's anonymous email-capture was built for.
  * Measured live 2026-08-06, logged out, three job pages: the chunk was
  * downloaded and rendered nothing, because `if (!hasAccess) return <gate/>`
  * returns before its call site. The component's own comment claimed the
  * opposite ("Nor is it gated on a session any more"), which is how it passed
  * review — the gating was in this file's control flow, 1200 lines above, not
  * in any `userId &&` test near the component.
  *
  * The wiring (session, analytics, cache invalidation) lives in
  * components/community/CompanyFollowCta.tsx because JobOrphanView and
  * JobExpiredView draw their own gates and need the same CTA — four call sites
  * is where a copied invocation starts drifting.
  */
 const companyFollowCta = (
   job: JobListing,
   surface: 'company_follow_button' | 'company_follow_gate',
 ) => (
   // Reserving fallback: this CTA renders in the job-detail header now, so the
   // lazy chunk landing must swap a same-sized block rather than insert one.
   <Suspense fallback={<CompanyFollowPlaceholder />}>
     <CompanyFollowCta
       company={String(job.company || '')}
       companyKey={job.companyKey ?? null}
       locale={locale}
       surface={surface}
       sourceJobSlug={job.slug ?? null}
       sourceJobUrl={job.url ?? null}
       sourceJobTitle={job.title ?? null}
       userId={userId}
       email={userEmail}
     />
   </Suspense>
 );

 if (selectedJob) {
 if (!authResolved || newsletterAutologinInFlight) {
 // Use a layout-matching skeleton instead of a tiny spinner to prevent CLS:
 // the spinner occupies ~80px but the full detail layout is 800-1200px,
 // causing a large measurable layout shift when auth resolves.
 // Also hold the skeleton while a newsletter autologin is exchanging so the
 // gate never flashes before the imminent sign-in lands.
 return <SkeletonJobDetail />;
 }
 if (!hasAccess) {
 const localizedTitle = sanitizeJobTitle(selectedJob.titleByLocale?.[locale] ?? selectedJob.title);
 const companyName = selectedJob.company;
 const jobLocation = selectedJob.location || '';
 const jobCategory = selectedJob.category || '';
 const gateSalary = formatSalary(selectedJob);
 const gateContract = t(contractTranslationKey(selectedJob));
 const gatePosted = daysSincePosted(selectedJob.postedDate);
 const gateIsNew = isNewJob(selectedJob);
 const logoUrl = cdnImageUrl(resolveCompanyLogoUrl(selectedJob));
 const previewCharLimit = 220;
 // Fixed-height teaser box with a STATIC height (svh, not dvh) so it never
 // shifts frame-to-frame — preserving the CLS guard below.
 const previewBoxClass =
 '[@media(max-height:540px)]:hidden h-[clamp(0px,calc(100svh_-_540px),80px)]';
 const descriptionPreview = String(
 selectedJob.descriptionByLocale?.[locale] ?? selectedJob.description ?? ''
 )
 .replace(/<br\s*\/?>/gi, '\n')
 .replace(/<\/(p|li|ul|ol|div|h[1-6]|blockquote)>/gi, '\n')
 .replace(/<[^>]+>/g, ' ')
 .replace(/[^\S\n]+/g, ' ')
 .replace(/\n[ \t]*/g, '\n')
 .replace(/\n{3,}/g, '\n\n')
 .trim()
 .slice(0, previewCharLimit);
 // True while the slim index gave us no description but the per-job detail
 // fetch hasn't settled yet (cache miss on first render, or in flight).
 // Switches the always-mounted teaser box from static bars to a pulsing
 // skeleton; the box itself never mounts/unmounts after first paint (its
 // height is fixed by the svh clamp), so neither the text arriving late
 // (~92px push, 0.054 CLS/view) nor a detail that settles WITHOUT a
 // description (reverse ~80px collapse) can shift the auth gate.
 const teaserPending = !descriptionPreview
 && (enrichmentLoading || (!resolvedJobDetail.has(selectedJob.id) && !jobDetailCache.has(selectedJob.id)));
 const gateCompanySlug = buildCompanySearchSlug(selectedJob.company, selectedJob.companyKey, locale);
 const gateCompanyHref = buildPath({ activeTab: 'job-board' as any, jobSlug: gateCompanySlug }, locale);
 const gateJobCanton = resolveJobCanton(selectedJob);
 // City link is ALWAYS canton-semantic: /cerca-lavoro-<canton>/<città>/ for
 // EVERY canton (incl. TI) — a city must never sit under a foreign section
 // (e.g. Zürich under /cerca-lavoro-ticino/ is semantically wrong). Known
 // municipality of the canton → canton city hub; otherwise the canton board
 // root (still the correct canton, never the legacy TI location filter).
 // Page richness for low-job cantons/cities is governed downstream by the
 // few-results expansion rules, not by the link target.
 const gateCitySlug = jobLocation && !isMultiLocation(jobLocation)
 ? normalizeCitySlug(selectedJob.addressLocality || jobLocation)
 : '';
 const gateCityHub = !!(gateCitySlug && isKnownCityHub(gateCitySlug, gateJobCanton));
 const gateLocationHref = !jobLocation
 ? ''
 : (gateCityHub
 ? buildPath({ activeTab: 'job-board' as any, jobBoardCanton: gateJobCanton, jobSlug: gateCitySlug }, locale)
 : buildPath({ activeTab: 'job-board' as any, jobBoardCanton: gateJobCanton }, locale));
 const openGateCompanyFilter = (e: React.MouseEvent<HTMLAnchorElement>) => {
 e.preventDefault();
 e.stopPropagation();
 e.nativeEvent.stopImmediatePropagation?.();
 Analytics.trackSelectContent('job_board_company_filter_open', selectedJob.company);
 // Full navigation to the static company hub — see openCompanyFilter note.
 window.location.assign(gateCompanyHref.split('?')[0]);
 };

 // Copy-attribution: replays show gated users copying the teaser lines and
 // pasting them into Google to find the listing — handing themselves to the
 // original source with none of our branding. Append our brand + the canonical
 // URL of THIS listing to whatever they selected, so the paste carries a real
 // backlink (rich editors/forums) and a search-box paste biases the result
 // back to our canonical. Tiny selections are left untouched; errors never
 // break the native copy.
 const handleGateCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
 try {
 const sel = typeof window !== 'undefined' ? window.getSelection() : null;
 const selectionText = sel?.toString() ?? '';
 if (!shouldAttributeCopy(selectionText, localizedTitle)) return;
 let selectionHtml = '';
 if (sel && sel.rangeCount > 0) {
 const holder = document.createElement('div');
 for (let i = 0; i < sel.rangeCount; i++) holder.appendChild(sel.getRangeAt(i).cloneContents());
 selectionHtml = holder.innerHTML;
 }
 const { text, html } = buildJobCopyAttribution({
 selectionText,
 selectionHtml,
 jobTitle: localizedTitle,
 company: companyName,
 url: `${PUBLIC_SITE_URL}${buildJobPath(selectedJob)}`,
 lead: t('jobBoard.copyAttribution.lead'),
 });
 e.clipboardData.setData('text/plain', text);
 e.clipboardData.setData('text/html', html);
 e.preventDefault();
 Analytics.trackSelectContent('job_gate_copy_attribution', `${companyName}_${localizedTitle}`);
 } catch {
 // leave the browser's native copy untouched on any failure
 }
 };

 return (
 <div className="space-y-5" onCopy={handleGateCopy}>
 <button
 onClick={backToList}
 className="inline-flex items-center gap-2 min-h-[44px] text-sm font-semibold text-accent hover:underline"
 >
 <ArrowLeft size={14} />
 {t('jobBoard.backToList')}
 </button>

 {authPendingNoticeJsx}

 {/* 3-column rail grid: left rail | gate body | right rail. Re-enables the
     full-height desktop side rails on the auth-gate view (matching the active
     job-detail + expired/orphan layouts), shrinking the central gate content
     on desktop (xl+) to host the half-page creatives. Rails widen 180px→300px
     at xlw (≥1400) and only serve there; below xl it's a single column.
     NOTE: overrides the FRO-2026-04-26 prune (rails earned €0.06–0.10 RPM on
     the gate) per explicit owner request. */}
 <div className={RAIL_GRID_CLASS_X} style={railStyle}>

 {/* ── Left Rail (desktop xl only) ── */}
 <aside className={RAIL_ASIDE_CLASS_X}>
 <Suspense fallback={null}><ArticleRailAdStack side="left" onEmptyResolved={onLeftEmptyResolved} /></Suspense>
 </aside>

 {/* ── Center gate content ── */}
 <div className="space-y-4">

 {/* Job header — always visible */}
 <div className="rounded-stripe border border-edge bg-surface p-4 sm:p-5">
 <div className="flex items-start gap-4">
 {logoUrl && (
 <img
 src={logoUrl}
 alt={companyName}
 width={48}
 height={48}
 className="w-12 h-12 rounded-lg object-contain bg-surface-alt flex-shrink-0"
 decoding="async"
 onError={handleCompanyLogoError}
 />
 )}
 <div className="flex-1 min-w-0">
 <h1 className="text-xl font-bold font-display text-heading leading-tight break-words [hyphens:auto]">{localizedTitle}</h1>
 <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1.5 text-sm leading-tight text-subtle">
 <a
 href={gateCompanyHref}
 onClickCapture={openGateCompanyFilter}
 className="inline-flex items-center gap-1 hover:text-accent hover:underline underline-offset-2 transition-colors"
 ><Building2 size={14} />{companyName}</a>
 {jobLocation && gateLocationHref && (
 <a
 href={gateLocationHref}
 onClick={(e) => {
 e.preventDefault();
 applySearchQuery('');
 // Soft-nav via onJobRouteChange keeps staticOverlay false so the canton
 // city hub / canton list renders in React without a blank-page flash.
 onJobRouteChange?.(gateCityHub ? gateCitySlug : '', gateJobCanton);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 Analytics.trackSelectContent('job_board_location_filter_open', jobLocation);
 }}
 className="inline-flex items-center gap-1 hover:text-accent hover:underline underline-offset-2 transition-colors"
 ><MapPin size={14} />{jobLocation}</a>
 )}
 {jobLocation && !gateLocationHref && <span className="inline-flex items-center gap-1"><MapPin size={14} />{jobLocation}</span>}
 {jobCategory && jobCategory !== 'other' && (
 <span className="inline-flex items-center gap-1"><Briefcase size={14} />{t(categoryTranslationKey(selectedJob))}</span>
 )}
 {gateSalary && <span className="inline-flex items-center gap-1 font-semibold text-success"><Euro size={14} />{gateSalary}</span>}
 <span className="inline-flex items-center gap-1"><Clock size={14} />{gateContract}</span>
 <span className={`inline-flex items-center gap-1${gateIsNew ? ' font-semibold text-accent' : ''}`}><Calendar size={14} />{gatePosted}</span>
 </div>
 </div>

 {/* Save toggle, same node and same corner as the unlocked header. It was
     missing from this branch entirely, so the ONE surface where the reader
     has no account — the only reader who cannot come back to the ad from a
     saved list — was also the only one with no way to keep it. Anonymous
     taps never write: handleToggleSave stashes the intent in
     services/pendingSaveJob.ts and opens the sign-in modal, which is the
     account-gating path #4466 already built, and the replay effect saves
     for real once sign-in completes (in this tab or a fresh one). */}
 <button
 type="button"
 onClick={() => handleToggleSave(selectedJob, 'detail_gate')}
 aria-pressed={savedJobIds.has(selectedJob.id)}
 aria-label={savedJobIds.has(selectedJob.id) ? t('jobBoard.save.saved') : t('jobBoard.save.cta')}
 className={`shrink-0 justify-center min-w-[44px] px-2.5 sm:px-3 py-2 min-h-[44px] rounded-full inline-flex items-center gap-1.5 text-xs font-semibold border transition-colors ${
 savedJobIds.has(selectedJob.id)
 ? 'bg-accent-subtle text-accent border-accent-border'
 : 'bg-surface/90 text-subtle border-edge hover:text-accent hover:border-accent-border'
 }`}
 >
 <Bookmark className={`w-3.5 h-3.5 ${savedJobIds.has(selectedJob.id) ? 'fill-current' : ''}`} aria-hidden="true" />
 <span className="hidden sm:inline">{savedJobIds.has(selectedJob.id) ? t('jobBoard.save.saved') : t('jobBoard.save.cta')}</span>
 </button>
 </div>
 {/* The employer's evergreen hub — the ONE destination a logged-out reader
     can reach from this gate without signing in, and the only link here
     that survives this ad expiring. Same component, same placement (under
     the title block) as JobExpiredView and JobOrphanView; it renders null
     unless the build proved a hub exists for this employer. */}
 <EmployerHubCta company={selectedJob.company} companyKey={selectedJob.companyKey} locale={locale as Locale} />
 {/* CompanyAlert (#5012) — the follow CTA, directly under the hub link it
     belongs with. It used to sit far below the auth gate, past the teaser and
     the sign-in block; on the surface where the reader is MOST likely to
     leave without an account, the one ask that does not need an account was
     the last thing on the page. Same component, same anonymous
     email-capture + double opt-in, moved to where the employer is named. */}
 {companyFollowCta(selectedJob, 'company_follow_gate')}
 {/* Readable description teaser — shows first ~200 chars to create information
 scent and an "open loop" that motivates signup. Fades out at the bottom.
 On very short viewports (landscape phones) we hide it entirely so the gate CTAs
 land above the fold.
 CLS guards: (a) svh, NOT dvh — dvh re-resolves every time the mobile URL bar
 collapses/expands, oscillating the box 0↔80px and shifting the gate and
 everything below it on every scroll direction change; svh is static.
 (b) The box is ALWAYS mounted at a FIXED clamp height (height, not
 maxHeight, so short text / skeleton / settled-empty all produce the exact
 same container height frame-to-frame). Contents only cross-fade between
 text, a pulsing skeleton (detail fetch pending) and static redacted bars
 (detail settled with no description — keeping the reserve, never
 collapsing). This kills both the ~92px gate push when the late teaser
 text arrived (0.054 CLS/view) and the reverse collapse for
 description-less jobs. */}
 <div className={`relative mt-3 w-full overflow-hidden rounded-stripe ${previewBoxClass}`}>
 {descriptionPreview ? (
 <p className="px-3 py-2 text-sm text-body leading-relaxed whitespace-pre-line sm:py-3">
 {descriptionPreview}...
 </p>
 ) : teaserPending ? (
 <div className="px-3 py-2 sm:py-3 space-y-2" aria-hidden="true">
 <SkeletonLine height="h-4" />
 <SkeletonLine height="h-4" />
 <SkeletonLine height="h-4" width="w-3/4" />
 </div>
 ) : (
 // Detail settled with no description: static redacted-style bars (no
 // pulse — nothing is loading) keep the reserved height instead of
 // collapsing the box, which would yank the gate up by the same ~80px
 // the late-teaser push used to move it down.
 <div className="px-3 py-2 sm:py-3 space-y-2 opacity-60" aria-hidden="true">
 <div className="bg-surface-raised rounded-lg w-full h-4" />
 <div className="bg-surface-raised rounded-lg w-full h-4" />
 <div className="bg-surface-raised rounded-lg w-3/4 h-4" />
 </div>
 )}
 <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent" />
 </div>

 {/* Auth gate — embedded inline for all viewports (no extra click needed) */}
 <div id="job-auth-gate" role="region" aria-label={t('jobBoard.gate.title')} className="relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-accent-border bg-accent-subtle p-4 sm:p-6">
 <h2 className="flex items-start gap-2 text-lg sm:text-xl font-bold font-display text-heading leading-tight">
 <Eye className="w-5 h-5 mt-0.5 text-accent flex-shrink-0" aria-hidden="true" />
 <span>{gateHeadline}</span>
 </h2>

 {/* Trust signals — 2 lines at text-sm. text-xs is reserved for metadata
 per the project's design context (.impeccable.md). */}
 <ul className="mt-3 space-y-1.5 text-sm text-subtle">
 <li className="flex items-center gap-2">
 <CheckCircle2 size={14} className="text-success flex-shrink-0" aria-hidden="true" />
 <span>{locale === 'it' ? 'Gratis · Per sempre' : locale === 'de' ? 'Kostenlos · Für immer' : locale === 'fr' ? 'Gratuit · Pour toujours' : 'Free · Forever'}</span>
 </li>
 <li className="flex items-center gap-2">
 <Shield size={14} className="text-success flex-shrink-0" aria-hidden="true" />
 <span>{t('jobBoard.gate.privacyNote')}</span>
 </li>
 </ul>

 {/* Social proof — keep one short line */}
 {jobs.length > 0 && (
 <p className="mt-3 text-xs font-medium text-accent">
 {jobs.length.toLocaleString()}+ {locale === 'it' ? 'annunci disponibili' : locale === 'de' ? 'verfügbare Stellenangebote' : locale === 'fr' ? 'offres disponibles' : 'listings available'}
 </p>
 )}

 <div className="mt-4 space-y-3">
 <div className="space-y-2">
 <div ref={inlineGoogleButtonRef} className="flex min-h-[44px] w-full items-center justify-center overflow-hidden rounded-stripe" />
 {!inlineGoogleButtonReady && (
 <button
 type="button"
 onClick={() => {
 const ctx = buildJobTrackingContext(selectedJob);
 Analytics.trackJobAuthFunnel('auth_method_click', { method: 'google', ...ctx });
 void handleAuthAndOpen('google');
 }}
 disabled={authBusy !== null}
 className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-surface border border-edge hover:bg-surface-raised disabled:opacity-60 text-strong text-sm font-semibold shadow-sm transition-colors"
 >
 {authBusy === 'google' ? <Loader2 className="w-4 h-4 animate-spin" /> : (
 <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
 <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
 <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
 <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
 <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
 </svg>
 )}
 {t('newsletter.popup.googleSignIn')}
 </button>
 )}
 </div>
 {linkedInAvailable && (
 <button
 type="button"
 disabled={authBusy !== null}
 onClick={() => {
 const job = selectedJob;
 if (job) {
 const ctx = buildJobTrackingContext(job);
 Analytics.trackJobAuthFunnel('auth_method_click', { method: 'linkedin', ...ctx });
 setAuthBusy('linkedin');
 saveAuthJobContext({ slug: job.slug, company: job.company, location: job.location, category: job.category });
 const jobSlug = job.slugByLocale?.[locale] ?? job.slug;
 const section = getJobBoardSectionSlug(locale);
 const prefix = locale === 'it' ? '' : `/${locale}`;
 signInWithLinkedIn(`${prefix}/${section}/${jobSlug}/`.replace(/\/+/g, '/'))
 .catch(() => setAuthBusy(null));
 } else {
 setAuthBusy('linkedin');
 signInWithLinkedIn().catch(() => setAuthBusy(null));
 }
 }}
 className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-stripe bg-brand-linkedin hover:bg-brand-linkedin-hover disabled:opacity-60 text-on-accent text-sm font-semibold transition-colors"
 >
 {authBusy === 'linkedin' ? <Loader2 className="w-4 h-4 animate-spin" /> : (
 <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
 )}
 {locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}
 </button>
 )}
 {/* Email — wrapped in <details open>: default expanded so we don't lose
 the email-preferring segment, but social-first users can collapse it
 to remove the form's vertical footprint from their decision flow. */}
 <details open className="group">
 <summary className="flex items-center gap-3 cursor-pointer list-none py-1 -my-1 [&::-webkit-details-marker]:hidden">
 <div className="flex-1 h-px bg-surface-raised/50" />
 <span className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-subtle transition-colors">
 {t('jobBoard.authGateOrEmail')}
 <ChevronDown size={14} className="transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
 </span>
 <div className="flex-1 h-px bg-surface-raised/50" />
 </summary>
 <form
 onSubmit={(e) => {
 e.preventDefault();
 const ctx = buildJobTrackingContext(selectedJob);
 Analytics.trackJobAuthFunnel('auth_method_click', { method: 'email', ...ctx });
 void handleInlineEmailAccess(selectedJob);
 }}
 className="mt-3 space-y-2"
 >
 <EmailInput
 value={emailInput}
 onChange={setEmailInput}
 placeholder={t('jobBoard.authGateEmailPlaceholder')}
 className="w-full px-3 py-2.5 rounded-stripe border border-edge bg-surface text-sm text-heading placeholder-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
 />
 <button
 type="submit"
 disabled={authBusy !== null || !emailInput.trim()}
 className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-sm font-semibold transition-colors"
 >
 {authBusy === 'email' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
 {t('jobBoard.gate.emailCta')}
 </button>
 </form>
 </details>
 {/* OUTSIDE the <details> on purpose (#5765). This is the gate's only
 notice and it covers the provider buttons too, so it may not disappear
 when somebody collapses the email form — which is exactly what would
 happen if it sat inside, and the social branch would then subscribe an
 address with nothing on screen. Placed right after the form, so with
 the panel open (the default) it still reads under the email button. */}
 <ConsentNotice consentKey="communicationsSignIn" locale={locale} className="text-[11px] text-muted leading-relaxed block" />
 </div>

 {authError && <p className="text-sm text-danger mt-2">{authError}</p>}
 </div>
 </div>

 {/* AdSense — below auth gate form */}
 {AD_SLOTS.JOBDETAIL_AUTH_GATE.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBDETAIL_AUTH_GATE.slot}
 adFormat={AD_SLOTS.JOBDETAIL_AUTH_GATE.format}
 fullWidthResponsive={AD_SLOTS.JOBDETAIL_AUTH_GATE.fullWidthResponsive}
 />
 )}
 </div>

 {/* ── Right Rail (desktop xl only) ── */}
 <aside className={RAIL_ASIDE_CLASS_X}>
 <Suspense fallback={null}><ArticleRailAdStack side="right" onEmptyResolved={onRightEmptyResolved} /></Suspense>
 </aside>

 </div>

 {/* AdSense — end multiplex below gate */}
 {AD_SLOTS.AUTHGATE_END_MULTIPLEX.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.AUTHGATE_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.AUTHGATE_END_MULTIPLEX.format}
 className="mt-2"
 />
 )}

 {/* Company banner — gate view */}
 <a
 href={gateCompanyHref}
 onClickCapture={openGateCompanyFilter}
 className="block rounded-xl border border-edge bg-surface-alt/50 p-4 hover:border-accent-border hover:bg-surface-raised/70 transition-colors"
 >
 <div className="flex items-start gap-3">
 <div className="w-10 h-10 rounded-lg bg-surface border border-edge flex items-center justify-center overflow-hidden shrink-0">
 {logoUrl ? (
 <img
 src={logoUrl}
 alt={`Logo ${companyName}`}
 className="w-7 h-7 object-contain"
 width={28}
 height={28}
 loading="lazy"
 onError={handleCompanyLogoError}
 />
 ) : (
 <Building2 className="w-4 h-4 text-muted" />
 )}
 </div>
 <div className="min-w-0">
 <h3 className="text-sm font-bold text-heading">{t('jobBoard.companyHeading')}</h3>
 <p className="text-sm text-subtle mt-1">
 {companyName} · {jobLocation} ({selectedJob.canton})
 </p>
 <p className="text-sm text-muted mt-2">
 Frontaliere Ticino ha scovato questa opportunità nel monitoraggio aziende.
 </p>
 </div>
 </div>
 </a>


 {/* Similar jobs — gate view (listing-style cards) */}
 {relatedJobs.length > 0 && (
 <section className="rounded-2xl border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading mb-4">{t('jobBoard.relatedTitle')}</h2>
 <div className="space-y-2">
 {relatedJobs.flatMap((job, relIdx) => {
 const jobHref = buildJobPath(job);
 const jobLogo = companyLogoUrl(job);
 const jobSalary = formatSalary(job);
 const card = (
 <article
 key={buildListingDedupKey(job)}
 className={`rounded-xl border p-3 sm:p-4 transition-colors min-h-[72px] ${
 job.featured
 ? 'border-warning-border bg-warning-subtle hover:border-warning'
 : 'border-edge bg-surface/50 hover:border-accent-border'
 }`}
 >
 <a
 href={jobHref}
 onClick={(e) => {
 e.preventDefault();
 if (selectedJob) {
 Analytics.trackJobMatchSimilarClick(
 selectedJob.slug || '',
 job.slug || '',
 describeSimilarJobMatchReason(selectedJob, job),
 relIdx,
 );
 }
 openDetail(job);
 }}
 className="block cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg"
 >
 <div className="flex items-start gap-3">
 <div className="w-10 h-10 sm:w-14 sm:h-14 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden border border-edge shrink-0">
 {jobLogo ? (
 <img src={jobLogo} alt={`Logo ${job.company}`} className="w-7 h-7 sm:w-10 sm:h-10 object-contain" width={40} height={40} loading="lazy" onError={handleCompanyLogoError} />
 ) : (
 <Building2 className="w-5 h-5 text-muted" />
 )}
 </div>
 <div className="min-w-0 flex-1">
 <h3 className="text-sm sm:text-base font-bold text-heading leading-tight">
 {sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title)}
 </h3>
 <p className="text-xs sm:text-sm text-subtle mt-0.5 line-clamp-2">
 {job.company} · {isMultiLocation(job.location) ? t('jobBoard.location.multiLocation') : formatJobLocation(job.location, job.canton)}
 </p>
 {jobSalary && (
 <span className="mt-1 inline-flex items-center gap-1 text-xs sm:text-sm font-semibold text-success">
 <Euro className="w-3.5 h-3.5" />
 {jobSalary}
 </span>
 )}
 </div>
 </div>
 <div className="mt-2 sm:mt-3 flex flex-wrap items-center gap-2 sm:gap-1.5 text-xs text-muted">
 <span className="inline-flex items-center gap-1">
 <MapPin className="w-3 h-3" />
 {isMultiLocation(job.location) ? t('jobBoard.location.multiLocation') : job.location}
 </span>
 <span className="px-1.5 py-0.5 rounded bg-surface-raised text-subtle">
 {t(contractTranslationKey(job))}
 </span>
 <span className="inline-flex items-center gap-1">
 <Clock className="w-3 h-3" />
 {daysSincePosted(job.postedDate)}
 </span>
 </div>
 </a>
 </article>
 );
 const nodes: React.ReactNode[] = [card];
 // One in-feed ad after every Nth related card (shared `shouldPlaceInfeedAd`
 // cadence), never after the last — same as the crawler-visible related grid
 // above. This `space-y-2` stack is the gated (`!hasAccess`) human surface;
 // `renderInfeedAd` already wraps the ad as a full-width block (no col-span).
 if (relIdx + 1 < relatedJobs.length && shouldPlaceInfeedAd(relIdx + 1)) {
 nodes.push(renderInfeedAd(`relgate-${relIdx}`));
 }
 return nodes;
 })}
 </div>
 </section>
 )}
 </div>
 );
 }

 const normalizeDescriptionForCanonicalParser = (raw?: string): string => String(raw || '')
 .replace(/\r/g, '\n')
 .replace(/<br\s*\/?>/gi, '\n')
 .replace(/<\/(p|li|h1|h2|h3|h4|div)>/gi, '\n')
 .replace(/<[^>]+>/g, ' ')
 .replace(/&nbsp;/gi, ' ')
 .replace(/([^#\n])\s*##+\s*/g, '$1\n## ')
 .replace(/(^|\n)\s*#\s+/g, '$1## ')
 .replace(/\s+(Profilo:|Condizioni per la partecipazione al concorso:|Condizioni per la partecipazione:|Per ulteriori informazioni\b|Contatto:|Interessat[oa]\?)/gi, '\n\n$1')
 .replace(/\s+[•·▪◦]\s+/g, '\n- ')
 .replace(/\s+-\s+(?=[A-ZÀ-ÖÙ-Ü])/g, '\n- ')
 .replace(/;\s+(?=[A-ZÀ-ÖÙ-Ü])/g, ';\n')
 .replace(/\n{3,}/g, '\n\n')
 .trim();
 const localizedDescription = selectedJob.descriptionByLocale?.[locale];
 const fallbackDescription = selectedJob.description;
 const descriptionCandidate = localizedDescription || fallbackDescription;
 const description = normalizeDescriptionForCanonicalParser(descriptionCandidate);
 const requirements = selectedJob.requirementsByLocale?.[locale] ?? selectedJob.requirements;
 const requirementList = sanitizeRequirementTokens(Array.isArray(requirements) ? requirements : []);
 const salary = formatSalary(selectedJob);
 const logo = companyLogoUrl(selectedJob);
 const canonicalCopy = getCanonicalCopy(locale);
 const canonicalContent = readCanonicalLocaleContent(selectedJob, locale, description, requirementList);
 const canonicalSummary = canonicalContent.summary.length > 0
 ? canonicalContent.summary
 : detailParagraphs.slice(0, 2);
 const canonicalRequirements = canonicalContent.requirements.length > 0
 ? canonicalContent.requirements
 : requirementList;
 const canonicalHighlights = cleanHighlightChips(
 canonicalContent.highlights.length > 0
 ? canonicalContent.highlights
 : cleanCanonicalItems([
 ...canonicalContent.responsibilities.slice(0, 3),
 ...canonicalRequirements.slice(0, 2),
 ...canonicalContent.benefits.slice(0, 2),
 ], 7),
 6
 );
 const canonicalExtraSections = canonicalContent.sections.filter((section) => {
 const id = String(section.id || '').toLowerCase();
 return !['responsibilities', 'requirements', 'benefits', 'process', 'overview', 'summary'].includes(id);
 });
 const canonicalContactSections = canonicalExtraSections.filter((section) => {
 const scope = `${String(section.id || '')} ${String(section.heading || '')}`.toLowerCase();
 return /contatt|contact|kontakt|coordina|referent/.test(scope);
 });
 const canonicalResidualSections = canonicalExtraSections.filter((section) => !canonicalContactSections.includes(section));
 const relatedSearches = buildRelatedSearches({
 job: selectedJob,
 locale,
 summary: canonicalSummary,
 requirements: canonicalRequirements,
 aiKeywords: canonicalContent.keywords,
 }).filter((term) => sortedJobs.some((job) => indexedQueryMatch(job, term)));
 // Dedup bullets globally across all timeline sections: when AI enrichment
 // populates the same item into multiple sections (S4 visual duplication
 // observed on the casale "Lavora con noi" page where the same filler line
 // appeared as responsibility, benefit AND process step), keep the first
 // occurrence and drop later duplicates. Match is whitespace/punctuation
 // insensitive.
 const timelineDedupKey = (s: string): string =>
 String(s || '')
 .toLowerCase()
 .replace(/[\p{P}\p{S}]+/gu, ' ')
 .replace(/\s+/g, ' ')
 .trim();
 const seenBullets = new Set<string>();
 const dedupBullets = (items: string[]): string[] => {
 const out: string[] = [];
 for (const item of items) {
 const key = timelineDedupKey(item);
 if (!key || seenBullets.has(key)) continue;
 seenBullets.add(key);
 out.push(item);
 }
 return out;
 };
 const dedupResponsibilities = dedupBullets(canonicalContent.responsibilities);
 const dedupRequirementsList = dedupBullets(canonicalRequirements);
 const dedupBenefits = dedupBullets(canonicalContent.benefits);
 const dedupProcess = dedupBullets(canonicalContent.process);
 const timelineSections = [
 ...(dedupResponsibilities.length > 0
 ? [{ id: 'responsibilities', heading: canonicalCopy.responsibilities, paragraphs: [], bullets: dedupResponsibilities }]
 : []),
 ...(dedupRequirementsList.length > 0
 ? [{ id: 'requirements', heading: canonicalCopy.requirements, paragraphs: [], bullets: dedupRequirementsList }]
 : []),
 ...(dedupBenefits.length > 0
 ? [{ id: 'benefits', heading: canonicalCopy.benefits, paragraphs: [], bullets: dedupBenefits }]
 : []),
 ...(dedupProcess.length > 0
 ? [{ id: 'process', heading: canonicalCopy.process, paragraphs: [], bullets: dedupProcess }]
 : []),
 ...canonicalContactSections,
 ...canonicalResidualSections,
 ];
 const hybridLayoutEnabled = false;
 const applyUrl = buildReferralUrl(selectedJob.applyUrl || selectedJob.url || '', selectedJob);
 const applyMode = (selectedJob as { applyMode?: string }).applyMode;
 const isInHouseApply = applyMode === 'in_house' || applyMode === 'forward_email';
 // Publisher / sponsored ad: a paid submission carries a `publisherJobId`. Used
 // to gate the per-job "Avvisami per questo annuncio" CTA (specificJobId alert).
 const isPublisherAd = Boolean((selectedJob as { publisherJobId?: string | null }).publisherJobId);
 const scrollToCandidatura = () => {
 document.getElementById('candidatura')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
 };
 const detailPageUrl = `${PUBLIC_SITE_URL}${buildJobPath(selectedJob)}`;
 const companySearchSlug = buildCompanySearchSlug(selectedJob.company, selectedJob.companyKey, locale);
 const companySearchHref = buildPath({ activeTab: 'job-board' as any, jobSlug: companySearchSlug }, locale);
 const detailJobCanton = resolveJobCanton(selectedJob);
 // Job-specific FAQ (build-plugins/shared/jobPostingFaq.ts) — the same
 // deterministic template + canonical schema builder that services/seoService.ts
 // uses for the runtime FAQPage JSON-LD on client-side navigation, so the
 // visible accordion here never desyncs from the structured data (or from the
 // SSG-prerendered static page for this same job). isRemote detection mirrors
 // the regex used elsewhere for the same purpose (jobsSeoPagesPlugin.ts,
 // services/seoService.ts).
 const faqJobInput: JobInput = {
 id: selectedJob.id,
 slug: selectedJob.slug,
 title: selectedJobTitle,
 description: detailDescription,
 company: selectedJob.company,
 companyKey: selectedJob.companyKey,
 companyDomain: selectedJob.companyDomain,
 addressLocality: selectedJob.addressLocality || selectedJob.location,
 addressRegion: detailJobCanton,
 addressCountry: selectedJob.addressCountry,
 postalCode: selectedJob.postalCode,
 streetAddress: selectedJob.streetAddress,
 postedDate: selectedJob.postedDate,
 crawledAt: selectedJob.crawledAt,
 contract: selectedJob.contract,
 salaryMin: selectedJob.salaryMin ?? selectedJob.baseSalary?.value?.minValue ?? null,
 salaryMax: selectedJob.salaryMax ?? selectedJob.baseSalary?.value?.maxValue ?? null,
 salaryCurrency: selectedJob.currency || selectedJob.baseSalary?.currency || selectedJob.baseSalary?.value?.currency,
 sector: selectedJob.sector,
 category: selectedJob.category,
 url: selectedJob.url,
 };
 const faqIsRemote = /remote|telelavor|smart[-\s]?working|home office|hybrid/i.test(
 `${selectedJobTitle} ${detailDescription} ${selectedJob.location || ''}`
 );
 const faqIsTicino = detailJobCanton === 'TI';
 const faqCantonDisplay = getCantonDisplayName(detailJobCanton, locale);
 const faqSchema = buildJobPostingSchema(faqJobInput, {
 locale,
 url: detailPageUrl,
 baseUrl: PUBLIC_SITE_URL,
 });
 const jobFaqPairs: JobFaqPair[] = buildJobPostingFaqPairs(faqSchema, {
 locale,
 jobUrl: String(selectedJob.applyUrl || selectedJob.url || detailPageUrl),
 cantonDisplay: faqCantonDisplay,
 isTicino: faqIsTicino,
 isRemote: faqIsRemote,
 });
 // City link is ALWAYS canton-semantic: /cerca-lavoro-<canton>/<città>/ for
 // EVERY canton (incl. TI) — never a foreign section (Zürich under
 // /cerca-lavoro-ticino/ is semantically wrong). Known municipality → canton
 // city hub; otherwise the canton board root. Content expansion for low-job
 // cantons/cities is governed downstream by the few-results rules.
 const detailCitySlug = !isMultiLocation(selectedJob.location)
 ? normalizeCitySlug(selectedJob.addressLocality || selectedJob.location || '')
 : '';
 const detailCityHub = !!(detailCitySlug && isKnownCityHub(detailCitySlug, detailJobCanton));
 const detailLocationHref = detailCityHub
 ? buildPath({ activeTab: 'job-board' as any, jobBoardCanton: detailJobCanton, jobSlug: detailCitySlug }, locale)
 : buildPath({ activeTab: 'job-board' as any, jobBoardCanton: detailJobCanton }, locale);
 const openCompanyFilter = (e: React.MouseEvent<HTMLAnchorElement>) => {
 e.preventDefault();
 e.stopPropagation();
 e.nativeEvent.stopImmediatePropagation?.();
 Analytics.trackSelectContent('job_board_company_filter_open', selectedJob.company);
 // Full navigation to the static company hub (HTTP 200) which lists the
 // company's jobs across ALL cantons. An SPA re-filter scopes to the current
 // canton shard and clobbers the static list with an empty result — the
 // /cerca-lavoro-ticino/azienda-X/ "0 results" bug for cross-canton employers
 // (e.g. PwC: 109 static jobs vs 0 in the TI shard). The viewed job is active,
 // so its company always has a current-build hub (companySearchHref uses the
 // canonical slug that mirrors the emitter).
 window.location.assign(companySearchHref.split('?')[0]);
 };
 const parserCoverage = (() => {
 const assigned =
 canonicalSummary.length +
 timelineSections.reduce((sum, section) => sum + section.paragraphs.length + section.bullets.length, 0);
 const original = Math.max(1, detailParagraphs.length + requirementList.length);
 return Math.min(100, Math.round((assigned / original) * 100));
 })();
 const isSubheadBullet = (value: string) => /^(requisiti necessari|requisiti auspicati|required|preferred)$/i.test(String(value || '').trim());
 const locationSnapshot = getJobLocationSnapshot({
 location: selectedJob.location,
 addressLocality: selectedJob.addressLocality,
 postalCode: selectedJob.postalCode,
 });
 const isContactSection = (section: { id?: string; heading?: string }) => {
 const scope = `${String(section.id || '')} ${String(section.heading || '')}`.toLowerCase();
 return /contatt|contact|kontakt|coordina|referent/.test(scope);
 };

 const renderHybridSection = (
 section: { heading: string; paragraphs: string[]; bullets: string[] },
 keyPrefix: string
 ) => (
 <section className="hybrid-ab-section">
 <h4>{section.heading}</h4>
 {section.paragraphs.length > 0 && section.paragraphs.map((line, idx) => (
 <p key={`${keyPrefix}-p-${idx}`}>{line}</p>
 ))}
 {section.bullets.length > 0 && (
 <ul>
 {section.bullets.map((item, idx) => (
 <li key={`${keyPrefix}-b-${idx}`} className={isSubheadBullet(item) ? 'subhead' : undefined}>{item}</li>
 ))}
 </ul>
 )}
 </section>
 );

 if (hybridLayoutEnabled) {
 return (
 <div className="space-y-6 hybrid-ab-wrap">
 <style>{`
 .hybrid-ab-wrap { max-width: 1120px; }
 .hybrid-ab-root { border: 1px solid #d8e4f4; background: #fff; border-radius: 20px; padding: 12px; overflow: hidden; }
 .hybrid-ab-hero { border: 1px solid #cae0ff; background: linear-gradient(130deg, rgba(229, 243, 255, 0.98), rgba(237, 252, 245, 0.98)); border-radius: 16px; padding: 14px; margin-bottom: 10px; }
 .hybrid-ab-title { font-size: 23px; line-height: 1.18; letter-spacing: -0.01em; font-family:"Outfit", sans-serif; color: #0f172a; margin: 0; }
 .hybrid-ab-sub { margin-top: 4px; font-size: 14px; color: #475569; }
 .hybrid-ab-meta { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 7px; }
 .hybrid-ab-meta span { border: 1px solid #cfe0f7; background: rgba(255, 255, 255, 0.75); border-radius: 999px; padding: 5px 8px; font-size: 11px; font-weight: 800; color: #385171; }
 .hybrid-ab-meta span.coverage { font-size: 12px; color: #1d4f90; border-color: #b9d4fa; background: #ebf5ff; }
 .hybrid-ab-section { border: 1px solid #dce6f5; border-radius: 14px; padding: 12px; margin-bottom: 9px; background: #fff; }
 .hybrid-ab-section h4 { margin: 0 0 8px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.02em; color: #2f435f; font-family:"Outfit", sans-serif; }
 .hybrid-ab-section p { margin: 0 0 8px 0; font-size: 14px; line-height: 1.58; color: #1f3149; }
 .hybrid-ab-section ul { margin: 0; padding-left: 18px; }
 .hybrid-ab-section li { margin-bottom: 7px; font-size: 14px; line-height: 1.52; color: #1f3149; }
 .hybrid-ab-section li.subhead { list-style: none; margin-left: -12px; margin-top: 4px; margin-bottom: 6px; font-weight: 800; color: #234b87; }
 .hybrid-ab-timeline { position: relative; margin-left: 6px; padding-left: 16px; border-left: 2px dashed #acc7ef; }
 .hybrid-ab-step { margin-bottom: 10px; position: relative; }
 .hybrid-ab-step::before { content:""; position: absolute; left: -22px; top: 8px; width: 9px; height: 9px; border-radius: 999px; background: #1769ff; }
 .hybrid-ab-cta { display: inline-flex; align-items: center; justify-content: center; margin-top: 2px; border-radius: 10px; text-decoration: none; background: linear-gradient(135deg, #1769ff, #0f8bff); color: #fff; font-size: 13px; font-weight: 800; padding: 10px 13px; border: none; cursor: pointer; }
 /* Dark mode overrides */
 .dark .hybrid-ab-root { border-color: #334155; background: #1e293b; }
 .dark .hybrid-ab-hero { border-color: #334155; background: linear-gradient(130deg, rgba(30, 41, 59, 0.98), rgba(20, 44, 52, 0.98)); }
 .dark .hybrid-ab-title { color: #f1f5f9; }
 .dark .hybrid-ab-sub { color: #94a3b8; }
 .dark .hybrid-ab-meta span { border-color: #475569; background: rgba(30, 41, 59, 0.75); color: #cbd5e1; }
 .dark .hybrid-ab-meta span.coverage { color: #93c5fd; border-color: #1e3a5f; background: #172554; }
 .dark .hybrid-ab-section { border-color: #334155; background: #1e293b; }
 .dark .hybrid-ab-section h4 { color: #cbd5e1; }
 .dark .hybrid-ab-section p { color: #e2e8f0; }
 .dark .hybrid-ab-section li { color: #e2e8f0; }
 .dark .hybrid-ab-section li.subhead { color: #93c5fd; }
 .dark .hybrid-ab-timeline { border-left-color: #475569; }
 .dark .hybrid-ab-step::before { background: #f59e0b; }
 .dark .hybrid-ab-cta { background: linear-gradient(135deg, #f59e0b, #d97706); }
 @media (max-width: 1120px) {
 .hybrid-ab-wrap { max-width: 100%; }
 }
 `}</style>
 <button
 onClick={backToList}
 className="inline-flex items-center gap-2 min-h-[44px] text-sm font-semibold text-accent hover:underline"
 >
 <ArrowLeft size={14} />
 {t('jobBoard.backToList')}
 </button>

 {authPendingNoticeJsx}

 <article className="hybrid-ab-root">
 <header className="hybrid-ab-hero">
 <h1 className="hybrid-ab-title">
 {selectedJobTitle}
 {selectedJob.featured && <Star className="inline-block w-4 h-4 ml-2 text-warning fill-warning" />}
 {selectedJob.featured && (
 <span className="ml-2 inline-flex items-center px-2 py-0.5 text-xs font-bold uppercase tracking-wide rounded-full bg-accent-subtle text-link align-middle">
 {t('jobBoard.sponsored')}
 </span>
 )}
 </h1>
 <p className="hybrid-ab-sub">{selectedJob.company} · {selectedJob.location} ({selectedJob.canton})</p>
 <div className="hybrid-ab-meta">
 <span>{`Categoria: ${t(categoryTranslationKey(selectedJob))}`}</span>
 <span>{`Contratto: ${t(contractTranslationKey(selectedJob))}`}</span>
 <span>{`Salario: ${salary || 'non indicato'}`}</span>
 <span className="coverage">{`Coverage parser: ${parserCoverage}%`}</span>
 </div>
 </header>

 {renderHybridSection({
 heading: canonicalCopy.summary,
 paragraphs: canonicalSummary.length > 0 ? canonicalSummary : detailParagraphs.slice(0, 2),
 bullets: [],
 }, 'overview')}

 {(selectedJob.descriptionMd && locale === 'it') ? (
 // Sponsored publisher ads with a markdown description render the
 // publisher-authored sections directly (same renderer as the static
 // /lavoro/ page and the editor preview — escape-first, injection-safe).
 // IT-only: the markdown source is publisher-written Italian; other
 // locales keep their translated plain-text sections.
 <div
 className="hybrid-ab-section"
 dangerouslySetInnerHTML={{ __html: renderPublisherMarkdown(selectedJob.descriptionMd) }}
 />
 ) : (
 <div className="hybrid-ab-timeline">
 {timelineSections.map((section, index) => (
 <div key={`${section.id}-${index}`} className="hybrid-ab-step">
 {renderHybridSection(
 {
 heading: section.heading,
 paragraphs: section.paragraphs,
 bullets: section.bullets,
 },
 `${section.id}-${index}`
 )}
 </div>
 ))}
 </div>
 )}

 {((selectedJob as { applyMode?: string }).applyMode === 'in_house'
 || (selectedJob as { applyMode?: string }).applyMode === 'forward_email') ? (
 <div id="candidatura">
 <PublisherApplyForm
 jobId={String((selectedJob as { publisherJobId?: string }).publisherJobId || '')}
 publisherUid={String((selectedJob as { publisherUid?: string }).publisherUid || '')}
 jobTitle={String(selectedJob.title || '')}
 jobSlug={String(selectedJob.slug || '')}
 />
 </div>
 ) : (
 <a
 className="hybrid-ab-cta"
 href={applyUrl}
 target="_blank"
 rel="nofollow noopener noreferrer"
 onClick={() => {
 Analytics.trackSelectContent('job_board_apply', `${selectedJob.company}_${selectedJob.title}`);
 Analytics.trackJobApply(canonicalCompanyRouteSlug(selectedJob.company, selectedJob.companyKey), Boolean(selectedJob.featured), selectedJob.slug || selectedJob.id);
 trackPublisherApplyClick(selectedJob as { publisherJobId?: string | null });
 }}
 >
 {t('jobBoard.apply')}
 </a>
 )}

 {!(selectedJob as unknown as { publisherJobId?: string }).publisherJobId && (
                  <a
                    href={buildPath({ activeTab: 'publish' }, locale) + '?claim=1'}
                    className="mt-3 inline-block text-xs font-medium text-muted hover:text-accent underline underline-offset-2"
                    onClick={() => {
                      const cj = selectedJob as unknown as Record<string, unknown>;
                      // Crawled listings carry no `employmentType` field — the value
                      // lives in `contract`. Derive the form's employmentType from it
                      // (same mapping the JobPosting structured data uses) so the claim
                      // pre-fill seeds it instead of leaving it at the FULL_TIME default.
                      const employmentType = CONTRACT_TO_EMPLOYMENT_TYPE[
                        normalizeJobContract(selectedJob.contract, selectedJob.title, selectedJob.description)
                      ];
                      // The publish form's salary inputs are CHF-only (submit hard-codes
                      // currency: 'CHF'). Only seed salary from CHF crawled listings — an
                      // EUR amount injected into a CHF field would be wrong, so leave it
                      // blank for EUR and let the employer fill it.
                      const salaryIsChf = selectedJob.currency !== 'EUR';
                      try {
                        sessionStorage.setItem('claimJobPrefill', JSON.stringify({
                          company: cj.company, title: cj.title, description: cj.description,
                          category: cj.category, sector: cj.sector, employmentType,
                          contractType: cj.contract, location: cj.location, canton: cj.canton,
                          applyUrl: cj.applyUrl || cj.url,
                          ...(salaryIsChf && cj.salaryMin != null ? { salaryMin: cj.salaryMin } : {}),
                          ...(salaryIsChf && cj.salaryMax != null ? { salaryMax: cj.salaryMax } : {}),
                        }));
                      } catch { /* storage blocked — publish page just won't prefill */ }
                      Analytics.trackSelectContent('job_board_claim_cta', `${selectedJob.company}_${selectedJob.title}`);
                    }}
                  >
                    {t('jobBoard.claimCta')}
                  </a>
                )}

                {salaryEstimateWidget && (
 <div className="mt-4">{salaryEstimateWidget}</div>
 )}
 {sectorContextWidget && (
 <div className="mt-3">{sectorContextWidget}</div>
 )}
 </article>
 {jobDetailPromptJsx}
 {savedJobsNudgeJsx}
 {saveAuthPromptJsx}
 </div>
 );
 }

 return (
 <div className="space-y-6">
 {/* Back link + top leaderboard share one row: the "back" link keeps its
     natural width on the left, the desktop banner fills the rest of the row
     to its right (the empty band beside the link). Banner is lg+ only; on
     mobile the row collapses to just the link. Auto Ads stay untouched —
     additional manual display unit. */}
 <div className="flex items-center gap-4">
 <button
 onClick={backToList}
 className="inline-flex items-center gap-2 min-h-[44px] text-sm font-semibold text-accent hover:underline shrink-0"
 >
 <ArrowLeft size={14} />
 {t('jobBoard.backToList')}
 </button>
 {isDesktopLg && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBDETAIL_TOP_BANNER.slot}
 adFormat={AD_SLOTS.JOBDETAIL_TOP_BANNER.format}
 fullWidthResponsive={AD_SLOTS.JOBDETAIL_TOP_BANNER.fullWidthResponsive}
 className="flex-1 min-w-0"
 />
 )}
 </div>

 {authPendingNoticeJsx}

 {/* 3-column rail grid: left rail | content | right rail. 180px rails at xl
     (1280–1399), widening to 300px at xlw (≥1400) to host the ArticleRailAd
     half-page creatives — same full-height side-rail layout as the article
     detail (BlogArticles) and expired-job views. Rail creatives only
     materialise at xlw; the narrow xl tier shows empty gutters. */}
 <div className={RAIL_GRID_CLASS_X} style={railStyle}>

 {/* ── Left Rail (desktop xl only) ── */}
 <aside className={RAIL_ASIDE_CLASS_X}>
 <Suspense fallback={null}><ArticleRailAdStack side="left" onEmptyResolved={onLeftEmptyResolved} /></Suspense>
 </aside>

 {/* ── Center content (existing 12-col job-detail grid) ── */}
 <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6">
 <article className="lg:col-span-8 lg:self-start space-y-4 sm:space-y-5">
 <header className="rounded-3xl border border-edge bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-4 sm:p-6">
 <div className="flex items-start gap-3 sm:gap-4">
 <a
 href={isInHouseApply ? '#candidatura' : applyUrl}
 target={isInHouseApply ? undefined : '_blank'}
 rel="nofollow noopener noreferrer"
 onClick={(e) => {
 if (isInHouseApply) { e.preventDefault(); scrollToCandidatura(); }
 Analytics.trackSelectContent('job_board_apply_header_logo', `${selectedJob.company}_${selectedJob.title}`);
 Analytics.trackJobApply(canonicalCompanyRouteSlug(selectedJob.company, selectedJob.companyKey), Boolean(selectedJob.featured), selectedJob.slug || selectedJob.id);
 trackPublisherApplyClick(selectedJob as { publisherJobId?: string | null });
 }}
 aria-label={`${t('jobBoard.apply')} ${selectedJob.company}`}
 className="w-14 h-14 sm:w-20 sm:h-20 rounded-xl bg-surface/90 flex items-center justify-center overflow-hidden border border-edge shrink-0 shadow-sm transition-transform hover:scale-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-info"
 >
 {logo ? (
 <img
 src={logo}
 alt={`Logo ${selectedJob.company}`}
 className="w-10 h-10 sm:w-14 sm:h-14 object-contain"
 width={56}
 height={56}
 decoding="async"
 onError={handleCompanyLogoError}
 />
 ) : (
 <Building2 className="w-9 h-9 text-muted" />
 )}
 </a>
 <div className="min-w-0 flex-1">
 <h1 className="text-xl sm:text-2xl md:text-3xl font-extrabold font-display text-heading leading-tight break-words [hyphens:auto]">
 <a
 href={isInHouseApply ? '#candidatura' : applyUrl}
 target={isInHouseApply ? undefined : '_blank'}
 rel="nofollow noopener noreferrer"
 onClick={(e) => {
 if (isInHouseApply) { e.preventDefault(); scrollToCandidatura(); }
 Analytics.trackSelectContent('job_board_apply_header_title', `${selectedJob.company}_${selectedJob.title}`);
 Analytics.trackJobApply(canonicalCompanyRouteSlug(selectedJob.company, selectedJob.companyKey), Boolean(selectedJob.featured), selectedJob.slug || selectedJob.id);
 trackPublisherApplyClick(selectedJob as { publisherJobId?: string | null });
 }}
 className="hover:underline decoration-2 underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
 >
 {selectedJobTitle}
 </a>
 {selectedJob.featured && <Star className="inline-block w-4 h-4 ml-2 text-warning fill-warning" />}
 </h1>
 <p className="mt-1 text-sm text-body break-words">
 <a
 href={companySearchHref}
 onClickCapture={openCompanyFilter}
 className="hover:text-accent hover:underline underline-offset-2 transition-colors"
 >{selectedJob.company}</a>
 {' · '}
 {detailLocationHref ? (
 <a
 href={detailLocationHref}
 onClick={(e) => {
 e.preventDefault();
 applySearchQuery('');
 // Soft-nav via onJobRouteChange keeps staticOverlay false so the canton
 // city hub / canton list renders in React without a blank-page flash.
 onJobRouteChange?.(detailCityHub ? detailCitySlug : '', detailJobCanton);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 Analytics.trackSelectContent('job_board_location_filter_open', selectedJob.location);
 }}
 className="hover:text-accent hover:underline underline-offset-2 transition-colors"
 >{selectedJob.location} ({selectedJob.canton})</a>
 ) : (
 <>{selectedJob.location} ({selectedJob.canton})</>
 )}
 </p>
 </div>
 {/* Save toggle (#4466). Moved out of the badge row and into the header
     corner, on the title's own row: in the chip strip it read as a seventh
     metadata pill among six non-interactive ones (category, contract,
     freshness, salary…), which is the worst place to put the only control
     in that strip. Still in flow and still rendered from first paint, so
     the zero-CLS property the chip was built for is unchanged — it is the
     same node in a different flex parent, not a `fixed`/`absolute` overlay
     that would have to be reserved for.
     Icon-only below `sm`, because `shrink-0` + a visible label claimed
     ~110px of a ~313px row at 390px and left the h1 a ~148px column: a
     single long word (`Collaborateur*trice`, ~240px at 24px) then
     overflowed `min-w-0 flex-1` and painted OVER this button. The label
     survives for assistive tech in `aria-label`, which is why it is set
     here and not left to the text node. */}
 <button
 type="button"
 onClick={() => handleToggleSave(selectedJob, 'detail')}
 aria-pressed={savedJobIds.has(selectedJob.id)}
 aria-label={savedJobIds.has(selectedJob.id) ? t('jobBoard.save.saved') : t('jobBoard.save.cta')}
 className={`shrink-0 justify-center min-w-[44px] px-2.5 sm:px-3 py-2 min-h-[44px] rounded-full inline-flex items-center gap-1.5 text-xs font-semibold border transition-colors ${
 savedJobIds.has(selectedJob.id)
 ? 'bg-accent-subtle text-accent border-accent-border'
 : 'bg-surface/90 text-subtle border-edge hover:text-accent hover:border-accent-border'
 }`}
 >
 <Bookmark className={`w-3.5 h-3.5 ${savedJobIds.has(selectedJob.id) ? 'fill-current' : ''}`} aria-hidden="true" />
 <span className="hidden sm:inline">{savedJobIds.has(selectedJob.id) ? t('jobBoard.save.saved') : t('jobBoard.save.cta')}</span>
 </button>
 </div>

 {/* Meta pills (category, contract, freshness, "new", salary) — moved up
     from the header's LAST child to the title's own block. They used to sit
     below EmployerHubCta + the follow CTA + its consent notice, so at 390px
     the salary — the one metadatum a reader scans for — landed roughly two
     blocks below the fold, while the gated header (`!hasAccess`) has always
     carried the same six values directly under the h1. Same values, same
     order, one position; the two branches now agree. */}
 <div className="mt-4 flex flex-wrap gap-2 text-xs">
 <span className="px-2 py-1 rounded-full bg-surface-raised text-body">
 {t(categoryTranslationKey(selectedJob))}
 </span>
 <span className="px-2 py-1 rounded-full bg-accent-subtle text-accent">
 {t(contractTranslationKey(selectedJob))}
 </span>
 <span className="px-2 py-1 rounded-full bg-success-subtle text-success">
 {daysSincePosted(selectedJob.postedDate)}
 </span>
 {isNewJob(selectedJob) && (
 <span className="px-2 py-1 rounded-full bg-success-subtle text-success inline-flex items-center gap-1">
 <Sparkles className="w-3 h-3" />
 {t('jobBoard.badge.new')}
 </span>
 )}
 {salary && (
 <span className="px-2 py-1 rounded-full bg-success-subtle text-success inline-flex items-center gap-1">
 <Euro className="w-3 h-3" />
 {salary}
 </span>
 )}
 </div>

 {/* The employer's evergreen hub. `jobsSeoPagesPlugin` already emits this
     link into the STATIC job page, so a crawler saw it and the reader lost
     it the moment React hydrated over the shell — this is the hydrated
     half of the same link, and it is the surface where reader intent is
     highest (the expired and orphan views have carried it for longer). */}
 <EmployerHubCta company={selectedJob.company} companyKey={selectedJob.companyKey} locale={locale as Locale} />

 {/* CompanyAlert (#5012): "Segui questa azienda", now in the employer block
     of the header instead of ~200 lines down the page, under the apply/share
     row. Two reasons it moved rather than being duplicated up here:
       · it is the same subscription the hub link's employer is about, so the
         two controls answer one question — "this company" — and reading them
         together is what makes the second one obvious;
       · CompanyFollowButton holds its follow/unfollow state locally and
         resolves it with its own `findCompanyAlert` call. A second instance
         on the same page would not just re-query: after one click the two
         would disagree, and clicking the stale one writes a SECOND alert
         document for the same employer, burning one of the visitor's few
         alert slots.
         One control, moved. */}
 {companyFollowCta(selectedJob, 'company_follow_button')}
 </header>

 <section className="section rounded-2xl border border-edge bg-surface p-4 sm:p-5 space-y-3">
 <h4 className="text-base font-bold text-heading">{canonicalCopy.summary}</h4>
 {enrichmentLoading && canonicalSummary.length === 0 && !detailDescription ? (
 <div className="space-y-2">
 <div className="animate-pulse bg-surface-raised rounded h-4 w-full" />
 <div className="animate-pulse bg-surface-raised rounded h-4 w-full" />
 <div className="animate-pulse bg-surface-raised rounded h-4 w-11/12" />
 <div className="animate-pulse bg-surface-raised rounded h-4 w-4/5" />
 </div>
 ) : canonicalContent.summary.length > 0 ? (
 <div className="space-y-2">
 {canonicalContent.summary.map((line, i) => (
 <p key={i} className="text-sm leading-relaxed text-body">{line}</p>
 ))}
 </div>
 ) : (
 <div className="space-y-2">
 {renderFormattedDescription(detailDescription)}
 </div>
 )}
 {canonicalHighlights.length > 0 && (
 <div className="pt-1">
 <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">{canonicalCopy.highlights}</h3>
 <div className="flex flex-wrap gap-2">
 {canonicalHighlights.map((item, i) => (
 <span
 key={i}
 className="text-xs px-2.5 py-1 rounded-full bg-info-subtle text-info border border-info-border"
 >
 {item}
 </span>
 ))}
 </div>
 </div>
 )}
 </section>

 {enrichmentLoading && timelineSections.length === 0 && !detailDescription ? (
 <>
 <section className="section rounded-2xl border border-edge bg-surface p-4 sm:p-5 space-y-2">
 <h4 className="text-base font-bold text-heading">{canonicalCopy.details}</h4>
 <div className="space-y-2">
 <div className="animate-pulse bg-surface-raised rounded h-4 w-full" />
 <div className="animate-pulse bg-surface-raised rounded h-4 w-full" />
 <div className="animate-pulse bg-surface-raised rounded h-4 w-5/6" />
 </div>
 </section>
 <section className="section rounded-2xl border border-edge bg-surface p-4 sm:p-5 space-y-2">
 <div className="animate-pulse bg-surface-raised rounded h-5 w-40" />
 <div className="space-y-1.5 pl-4">
 <div className="animate-pulse bg-surface-raised rounded h-4 w-3/4" />
 <div className="animate-pulse bg-surface-raised rounded h-4 w-2/3" />
 <div className="animate-pulse bg-surface-raised rounded h-4 w-4/5" />
 </div>
 </section>
 </>
 ) : timelineSections.length > 0 ? (
 <div className="timeline relative pl-6 space-y-3">
 <div className="absolute left-[9px] top-1 bottom-1 border-l-2 border-dashed border-accent-border" />
 {timelineSections.map((section, index) => (
 <div key={`${section.id}-${index}`} className="timeline-step relative">
 <span className="absolute -left-[23px] top-2 w-3 h-3 rounded-full bg-accent ring-2 ring-surface" />
 <section className="section rounded-2xl border border-edge bg-surface p-4 sm:p-5 space-y-2">
 <h4 className="text-base font-semibold text-heading mb-1">
 {section.heading}
 </h4>
 {section.paragraphs.length > 0 && section.paragraphs.map((line, i) => (
 <p key={i} className="text-sm leading-relaxed text-body">
 {isContactSection(section) ? renderContactRichText(line, selectedJob, locale, detailPageUrl) : line}
 </p>
 ))}
 {section.bullets.length > 0 && (
 <ul className="space-y-1.5 pl-4 list-disc marker:text-accent">
 {section.bullets.map((item, i) => (
 <li
 key={i}
 className={[
 'text-sm leading-relaxed text-body',
 isSubheadBullet(item) ? 'list-none -ml-3 font-bold text-accent' : '',
 ].join(' ').trim()}
 >
 {isContactSection(section) ? renderContactRichText(item, selectedJob, locale, detailPageUrl) : item}
 </li>
 ))}
 </ul>
 )}
 </section>
 </div>
 ))}
 </div>
 ) : (
 <section className="section rounded-2xl border border-edge bg-surface p-4 sm:p-5 space-y-2">
 <h4 className="text-base font-bold text-heading">{canonicalCopy.details}</h4>
 <div className="space-y-2">
 {renderFormattedDescription(detailDescription)}
 </div>
 </section>
 )}

 {/* S6 — Mobile-only action block below the description. CTA + money-signal
  *   after the prose so meaty job description leads above the fold per CLAUDE.md #15.
  *   Desktop keeps the sticky right rail so this block is hidden on lg+. */}
 <section
 aria-label={t('jobBoard.snapshotTitle')}
 className="lg:hidden rounded-2xl border border-edge bg-surface p-4 space-y-3"
 >
 <button
 onClick={() => handleApply(selectedJob)}
 className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 min-h-[48px] text-base font-semibold font-display bg-accent hover:bg-accent-hover text-on-accent rounded-lg transition-colors"
 >
 <ArrowUpRight className="w-4 h-4" />
 {t('jobBoard.apply')}
 </button>
 {appliedNoticeJsx}
 <dl className="grid grid-cols-3 gap-2 text-xs">
 <div className="rounded-lg bg-surface-alt p-2 text-center">
 <dt className="uppercase tracking-wide text-[10px] text-muted">{t('jobBoard.snapshot.location')}</dt>
 <dd className="font-semibold font-display text-strong mt-0.5 leading-tight truncate">
 {locationSnapshot?.locality || selectedJob.location}
 </dd>
 </div>
 <div className="rounded-lg bg-surface-alt p-2 text-center">
 <dt className="uppercase tracking-wide text-[10px] text-muted">{t('jobBoard.snapshot.contract')}</dt>
 <dd className="font-semibold font-display text-strong mt-0.5 leading-tight">
 {t(contractTranslationKey(selectedJob))}
 </dd>
 </div>
 <div className="rounded-lg bg-surface-alt p-2 text-center">
 <dt className="uppercase tracking-wide text-[10px] text-muted">{t('jobBoard.snapshot.published')}</dt>
 <dd className="font-semibold font-display text-strong mt-0.5 leading-tight">
 {daysSincePosted(selectedJob.postedDate)}
 </dd>
 </div>
 </dl>
 {salaryEstimateWidget}
 </section>

 {/* In-house / forward-email publisher ads: candidate applies via this
  *   on-page form (writes the `applications` doc → CF emails the publisher).
  *   The /lavoro/<slug>/candidatura/ deep-link (router + useEffect ~2668)
  *   and every apply CTA scroll here. Anchor offset clears the sticky nav. */}
 {isInHouseApply && (
 <div id="candidatura" className="scroll-mt-24">
 <PublisherApplyForm
 jobId={String((selectedJob as { publisherJobId?: string }).publisherJobId || '')}
 publisherUid={String((selectedJob as { publisherUid?: string }).publisherUid || '')}
 jobTitle={String(selectedJob.title || '')}
 jobSlug={String(selectedJob.slug || '')}
 />
 </div>
 )}

 {/* In-article ad — mobile/tablet only (desktop has sidebar ad) */}
 {!isDesktopLg && (
 <AdSenseBanner
 adSlot={AD_SLOTS.ARTICLE_INLINE_MOBILE.slot}
 adFormat={AD_SLOTS.ARTICLE_INLINE_MOBILE.format}
 adLayout={AD_SLOTS.ARTICLE_INLINE_MOBILE.layout}
 fullWidthResponsive={false}
 className="my-4"
 />
 )}

 <a
 href={companySearchHref}
 onClickCapture={openCompanyFilter}
 className="block rounded-xl border border-edge bg-surface-alt/50 p-4 hover:border-accent-border hover:bg-surface-raised/70 transition-colors"
 >
 <div className="flex items-start gap-3">
 <div className="w-10 h-10 rounded-lg bg-surface border border-edge flex items-center justify-center overflow-hidden shrink-0">
 {logo ? (
 <img
 src={logo}
 alt={`Logo ${selectedJob.company}`}
 className="w-7 h-7 object-contain"
 width={28}
 height={28}
 loading="lazy"
 onError={handleCompanyLogoError} /> ) : ( <Building2 className="w-4 h-4 text-muted" /> )} </div> <div className="min-w-0"> <h3 className="text-sm font-bold font-display text-heading">{t('jobBoard.companyHeading')}</h3> <p className="text-sm text-subtle mt-1"> {selectedJob.company} · {selectedJob.location} ({selectedJob.canton}) </p> <p className="text-sm text-muted mt-2"> {/* BLOCK-B: Regionalize for national expansion — currently hardcodes Ticino/Tessin text */} Frontaliere Ticino ha scovato questa opportunità nel monitoraggio aziende. </p> </div> </div> </a> <div className="flex flex-wrap gap-3 pt-1"> <button onClick={() => handleApply(selectedJob)} className="inline-flex items-center gap-2 px-4 py-2 min-h-[44px] text-sm font-semibold font-display bg-accent hover:bg-accent-hover text-on-accent rounded-lg transition-colors" > <ArrowUpRight className="w-4 h-4" /> {t('jobBoard.apply')} </button> <button type="button" onClick={() => void handleShare(selectedJob)} className="inline-flex items-center gap-2 px-4 py-2 min-h-[44px] text-sm font-semibold font-display border border-edge text-body text-strong rounded-lg hover:bg-surface-raised" > <ArrowUpRight className="w-4 h-4" /> {t('common.share')} </button> </div> {appliedNoticeJsx}
 {isPublisherAd && userId && userEmail && (
 <Suspense fallback={null}>
 <JobDetailJobAlertButton
 jobId={String(selectedJob.id || (selectedJob as { publisherJobId?: string }).publisherJobId || '')}
 userId={userId}
 email={userEmail}
 locale={locale}
 sourceJobSlug={selectedJob.slug ?? null}
 sourceJobUrl={selectedJob.url ?? null}
 sourceJobTitle={selectedJob.title ?? null}
 onSubscribed={() => {
 Analytics.trackJobAlertCtaClick('job_detail_button', 'success', selectedJob.title);
 Analytics.trackJobAlertCreated({ keywords: selectedJob.title || '', frequency: 'daily', surface: 'job_detail_button' });
 // Review PR #4338, bug G: keep the shared getUserAlerts cache correct —
 // this surface just created a new alert every other surface's cached
 // eligibility read needs to see.
 invalidateUserAlertsCache();
 }}
 onErrored={() => {
 Analytics.trackJobAlertCtaClick('job_detail_button', 'error', selectedJob.title);
 }}
 />
 </Suspense>
 )}

 {/* Job-specific FAQ accordion — visible counterpart of the FAQPage JSON-LD
 injected by services/seoService.ts (content-parity rule, CLAUDE.md §
 Static SEO Pages). Collapsed by default: prose FAQ sits below the
 action/data area per the mobile-first content-order rule. */}
 {jobFaqPairs.length > 0 && (
 <section className="rounded-2xl border border-edge bg-surface p-4 sm:p-5 space-y-3">
 <h2 className="text-base font-bold font-display text-heading">{t('jobBoard.faq.title')}</h2>
 <div className="space-y-3">
 {jobFaqPairs.map((entry) => (
 <details key={entry.q} className="rounded-2xl border border-edge px-4 py-3">
 <summary className="cursor-pointer text-sm font-bold text-heading">{entry.q}</summary>
 <p className="mt-3 text-sm leading-7 text-subtle">{entry.a}</p>
 </details>
 ))}
 </div>
 </section>
 )}
 </article> <aside className="hidden lg:block lg:col-span-4"> <div className="sticky top-20 space-y-4"> <Callout status="accent" icon={<Briefcase size={15} />} className="rounded-xl"> <div className="text-sm font-bold font-display text-heading"> {t('jobBoard.snapshotTitle')} </div> <div className="mt-3 space-y-2 text-xs text-subtle"> <div className="flex items-center justify-between gap-2"> <span>{t('jobBoard.snapshot.location')}</span> <div className="text-right"> <div className="font-semibold font-display text-strong"> {locationSnapshot?.locality || selectedJob.location} </div> {locationSnapshot?.postalCode && ( <div className="text-[11px] text-muted leading-tight mt-0.5"> {t('jobBoard.snapshot.postalCode')}: {locationSnapshot.postalCode} </div> )} </div> </div> <div className="flex items-center justify-between gap-2"> <span>{t('jobBoard.snapshot.contract')}</span> <span className="font-semibold font-display text-strong"> {t(contractTranslationKey(selectedJob))} </span> </div> <div className="flex items-center justify-between gap-2"> <span>{t('jobBoard.snapshot.published')}</span> <span className="font-semibold font-display text-strong">{daysSincePosted(selectedJob.postedDate)}</span> </div> {locationSnapshot?.crossings && locationSnapshot.crossings.length > 0 && ( <div className="pt-2 border-t border-edge/60"> <div className="mb-1.5 text-xs font-semibold font-display uppercase tracking-wide text-muted"> {t('jobBoard.snapshot.borderCrossings')} </div> <div className="space-y-1"> {locationSnapshot.crossings.map((crossing) => ( <a key={crossing.id} href={buildPath({ activeTab: 'guida', guidaSubTab: 'border', borderCrossing: crossing.id, }, locale)} className="flex items-center justify-between gap-2 rounded-lg px-2 py-2.5 min-h-[44px] lg:min-h-0 lg:py-1.5 bg-surface-alt hover:bg-surface-raised/50 text-body transition-colors" > <span className="font-medium font-display leading-tight">{crossing.name}</span> <ArrowUpRight className="w-3 h-3 text-muted" /> </a> ))} </div> </div> )} </div> </Callout> {canonicalContent.process.length > 0 && timelineSections.length === 0 && ( <Callout status="info" icon={<Calendar size={15} />} className="rounded-xl"> <div className="text-sm font-bold font-display text-heading"> {canonicalCopy.process} </div> <ul className="mt-2 space-y-1.5 pl-4 list-disc marker:text-info "> {canonicalContent.process.map((item, i) => ( <li key={i} className="text-sm leading-relaxed text-subtle">{item}</li> ))} </ul> </Callout> )} <Callout status="success" icon={<Users size={15} />} className="rounded-xl"> <div className="text-sm font-bold font-display text-heading"> {t('jobBoard.adviceTitle')} </div> <p className="mt-2 text-sm leading-relaxed text-subtle"> {t('jobBoard.adviceDescription')} </p> <button onClick={() => handleApply(selectedJob)} className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 min-h-[44px] text-sm font-semibold font-display bg-success-strong hover:bg-success-strong-hover text-on-accent rounded-lg" > {t('jobBoard.adviceCta')} </button> </Callout> {relatedSearches.length > 0 && ( <Callout status="accent" icon={<Search size={15} />} className="rounded-xl"> <div className="text-sm font-bold font-display text-heading"> {canonicalCopy.keywords} </div> <div className="mt-2 flex flex-wrap gap-2"> {relatedSearches.map((keyword, i) => { const searchHref = buildPath({ activeTab: 'job-board' as any, jobBoardCanton: JOB_BOARD_CANTON_AGGREGATE, jobSlug: buildSearchSlug(keyword, locale) }, locale); return ( <a key={i} href={searchHref} onClick={(e) => { e.preventDefault(); navigateToRelatedSearch(keyword); }} className="text-xs px-2.5 py-1.5 min-h-[44px] inline-flex items-center rounded-full bg-accent-subtle text-accent border border-accent-border" > {keyword} </a> ); })} </div> </Callout> )} {salaryEstimateWidget} {sectorContextWidget} <Suspense fallback={null}><PartnerRecommendations context="jobs" maxCards={1} /></Suspense> {isDesktopLg && ( <AdSenseBanner adSlot={AD_SLOTS.JOBDETAIL_SIDEBAR.slot} adFormat={AD_SLOTS.JOBDETAIL_SIDEBAR.format} fullWidthResponsive className="mt-2" /> )}<Callout status="accent" icon={<Mail size={15} />} className="rounded-xl"> <div className="text-sm font-bold font-display text-heading"> {t('jobBoard.publishTitle')} </div> <p className="mt-2 text-sm leading-relaxed text-subtle"> {t('jobBoard.publishDescription', cantonI18n)} </p> <button onClick={onPostJob} className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 min-h-[44px] text-sm font-semibold font-display border border-accent-border text-accent rounded-lg hover:bg-accent-subtle" > {t('jobBoard.publishCta')} </button> </Callout> </div> </aside> </div> {/* ── Right Rail (desktop xl only) ── */} <aside className={RAIL_ASIDE_CLASS_X}> <Suspense fallback={null}><ArticleRailAdStack side="right" onEmptyResolved={onRightEmptyResolved} /></Suspense> </aside> </div> {/* AdSense — job detail end multiplex */} <AdSenseBanner adSlot={AD_SLOTS.JOBDETAIL_END_MULTIPLEX.slot} adFormat={AD_SLOTS.JOBDETAIL_END_MULTIPLEX.format} className="mt-6 mb-4" /> {relatedJobs.length > 0 && ( <section className="rounded-2xl border border-edge bg-surface p-5"> <h2 className="text-lg font-bold font-display text-heading mb-4">{t('jobBoard.relatedTitle')}</h2> <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3"> {relatedJobs.flatMap((job, relIdx) => { const jobLogo = companyLogoUrl(job); const card = ( <button key={buildListingDedupKey(job)} onClick={() => { if (selectedJob) { Analytics.trackJobMatchSimilarClick(selectedJob.slug || '', job.slug || '', describeSimilarJobMatchReason(selectedJob, job), relIdx); } openDetail(job); }} className="text-left rounded-xl border border-edge p-3 hover:border-accent-border hover:bg-surface-raised/40 transition-colors" > <div className="flex items-start gap-3"> <div className="w-12 h-12 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden border border-edge shrink-0"> {jobLogo ? ( <img src={jobLogo} alt={`Logo ${job.company}`} className="w-8 h-8 object-contain" width={32} height={32} loading="lazy" onError={handleCompanyLogoError} />
 ) : (
 <Building2 className="w-5 h-5 text-muted" />
 )}
 </div>
 <div className="min-w-0">
 <div className="text-sm font-bold text-heading line-clamp-2">
 {sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title)}
 </div>
 <div className="text-sm text-subtle mt-0.5">
 {job.company} · {isMultiLocation(job.location) ? t('jobBoard.location.multiLocation') : job.location}
 </div>
 </div>
 </div>
 </button>
 );
 const nodes: React.ReactNode[] = [card];
 // One in-feed ad after every Nth related card (shared `shouldPlaceInfeedAd`
 // cadence, same as the main list); `col-span-full` so it spans the grid row.
 if (relIdx + 1 < relatedJobs.length && shouldPlaceInfeedAd(relIdx + 1)) {
 nodes.push(
 <div key={`rel-infeed-${job.id}`} className="col-span-full">
 {renderInfeedAd(`related-${relIdx}`)}
 </div>
 );
 }
 return nodes;
 })}
 </div>
 </section>
 )}

 {/* AdSense — between related jobs and articles */}
 {AD_SLOTS.JOBDETAIL_BETWEEN_SECTIONS && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBDETAIL_BETWEEN_SECTIONS.slot}
 adFormat={AD_SLOTS.JOBDETAIL_BETWEEN_SECTIONS.format}
 className="my-4"
 />
 )}

 {relatedArticles.length > 0 && (
 <section className="rounded-2xl border border-edge bg-surface p-5">
 <div className="flex items-center justify-between mb-4">
 <h2 className="text-lg font-bold font-display text-heading flex items-center gap-2">
 <BookOpen className="w-5 h-5 text-success" />
 {t('jobBoard.relatedArticlesTitle')}
 </h2>
 <a
 href={buildPath({ activeTab: 'blog' })}
 onClick={(e) => { e.preventDefault(); nav.navigateTo('blog'); }}
 className="text-xs font-semibold text-success hover:underline"
 >
 {t('blog.relatedArticles')}
 </a>
 </div>
 <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
 {relatedArticles.map((article) => (
 <a
 key={article.id}
 href={buildPath({ activeTab: 'blog', blogArticle: article.id })}
 onClick={(e) => { e.preventDefault(); nav.navigateTo('blog', article.id); }}
 className="text-left rounded-xl border border-success-border p-3 bg-success-subtle/60 hover:bg-success-subtle transition-colors"
 >
 <div className="flex items-start gap-3">
 <div className="w-12 h-12 rounded-lg overflow-hidden shrink-0">
 <img
 src={article.image}
 alt={t(`blog.article.${article.id}.title`)}
 width={48}
 height={48}
 className="w-12 h-12 object-cover"
 loading="lazy"
 />
 </div>
 <div className="min-w-0">
 <div className="text-sm font-bold text-heading line-clamp-2">
 {t(`blog.article.${article.id}.title`)}
 </div>
 <div className="text-sm text-subtle mt-0.5">
 {t(`blog.article.${article.id}.excerpt`).slice(0, 80)}…
 </div>
 </div>
 </div>
 </a>
 ))}
 </div>
 </section>
 )}

 {/* Internal link to job listing — SEO anchor for head-term"lavoro ticino" */}
 <nav className="text-center py-4">
 <a
 href={buildPath({ activeTab: 'job-board' }, locale)}
 onClick={(e) => { e.preventDefault(); backToList(); }}
 className="inline-flex items-center gap-2 min-h-[44px] text-sm font-semibold text-accent hover:underline"
 >
 <Briefcase className="w-4 h-4" />
 {t('jobBoard.allJobsCta', cantonI18n)}
 </a>
 </nav>
 {jobDetailPromptJsx}
 {savedJobsNudgeJsx}
 {saveAuthPromptJsx}
 </div>
 );
 }

 return (
 <JobBoardRailShell isDesktopLg={isDesktopLg}>
 <div className="space-y-6">
 {searchSlugFilter && (
 <div className="rounded-xl border border-accent-border bg-accent-subtle p-3 text-sm text-accent flex items-center justify-between gap-3">
 <span className="font-semibold">
 {t('jobBoard.filter.activeSearch', { query: searchSlugFilter })}
 </span>
 <button
 onClick={() => onJobRouteChange?.(undefined)}
 className="px-2 py-1 rounded-md border border-accent-border hover:bg-accent-subtle text-xs font-bold"
 >
 {t('jobBoard.filter.remove')}
 </button>
 </div>
 )}
 {companySlugFilter && (
 <div className="rounded-xl border border-accent-border bg-accent-subtle/60 p-3 text-sm text-accent flex items-center justify-between gap-3">
 <span className="font-semibold">
 {t('jobBoard.filter.activeCompany')}
 </span>
 <button
 onClick={() => onJobRouteChange?.(undefined)}
 className="px-2 py-1 rounded-md border border-accent-border hover:bg-accent-subtle text-xs font-bold"
 >
 {t('jobBoard.filter.remove')}
 </button>
 </div>
 )}
 {locationSlugFilter && (
 <div className="rounded-xl border border-accent-border bg-accent-subtle/60 p-3 text-sm text-accent flex items-center justify-between gap-3">
 <span className="font-semibold inline-flex items-center gap-1.5">
 <MapPin size={14} />
 {locationDisplayName || locationSlugFilter}
 </span>
 <button
 onClick={() => onJobRouteChange?.(undefined)}
 className="px-2 py-1 rounded-md border border-accent-border hover:bg-accent-subtle text-xs font-bold"
 >
 {t('jobBoard.filter.remove')}
 </button>
 </div>
 )}
 {employerBrand && companySlugFilter ? (
 <EmployerBrandHub
 brand={employerBrand}
 locale={locale}
 jobs={employerBrandJobs as any}
 buildJobHref={(job) => {
 const path = buildJobPath(job as any);
 return path.startsWith('http') ? path : `${window.location.origin}${path}`;
 }}
 canonicalUrl={typeof window !== 'undefined' ? window.location.href : ''}
 emitStructuredData={false}
 />
 ) : (
 listingHero
 )}

 {/* ─── Search & Filters ─── */}
 <div className="space-y-3">
 {/* Hero search bar */}
 <div className="relative group">
 <div className="absolute inset-0 bg-gradient-to-r from-info-strong/20 via-success-strong/20 to-info-strong/20 rounded-2xl blur-xl opacity-0 group-focus-within:opacity-100 transition-opacity duration-300" />
 <div className="relative flex items-center bg-surface rounded-2xl border-2 border-edge group-focus-within:border-accent shadow-sm group-focus-within:shadow-lg group-focus-within:shadow-accent/10 transition-[color,background-color,border-color,box-shadow] duration-200">
 <Search className="ml-4 w-5 h-5 text-muted group-focus-within:text-accent transition-colors shrink-0" />
 <input
 ref={searchInputRef}
 type="text"
 placeholder={t('jobBoard.searchPlaceholder')}
 defaultValue={searchQuery}
 onChange={(e) => {
 const next = e.target.value;
 if (searchDebounceTimerRef.current) clearTimeout(searchDebounceTimerRef.current);
 searchDebounceTimerRef.current = setTimeout(() => setSearchQuery(next), 200);
 }}
 className="flex-1 px-3 py-3.5 sm:py-4 text-base sm:text-lg bg-transparent text-heading placeholder:text-muted focus:outline-none"
 aria-label={t('jobBoard.searchPlaceholder')}
 />
 {searchQuery && (
 <button
 type="button"
 onClick={() => applySearchQuery('')}
 className="p-2 mr-1 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-muted hover:text-body hover:bg-surface-raised transition-colors"
 aria-label="Clear search"
 >
 <X className="w-4 h-4" />
 </button>
 )}
 {/* Keyboard shortcut hint — desktop only */}
 {!searchQuery && (
 <kbd className="hidden sm:inline-flex items-center gap-0.5 mr-4 px-2 py-1 text-xs font-medium text-muted bg-surface-raised rounded-md border border-edge select-none">
 ⌘K
 </kbd>
 )}
 </div>
 </div>

 {/* Autocomplete suggestions — min-h prevents CLS when suggestions appear */}
 <div className={autocompleteSuggestions.length > 0 ? 'min-h-[32px]' : ''}>
 {autocompleteSuggestions.length > 0 && (
 <div className="flex flex-wrap items-center gap-1.5">
 <span className="text-sm text-muted flex-shrink-0">{t('search.autocomplete') || 'Suggerimenti:'}</span>
 {autocompleteSuggestions.map((s) => (
 <button
 key={s}
 type="button"
 onClick={() => applySearchQuery(s)}
 className="px-2.5 py-1 rounded-full text-xs bg-accent-subtle text-accent border border-accent-border hover:bg-accent-subtle transition-colors"
 >
 {s}
 </button>
 ))}
 </div>
 )}
 </div>

 {/* Unified quick-filter chips — two scrollable rows */}
 <div className="space-y-2" role="group" aria-label={t('jobBoard.quickFilters.label')}>
 {/* Row 1: Time & Location */}
 <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
 {([
 { id: 'today', icon: Clock, label: t('jobBoard.quickFilters.today'), active: selectedDateRange === '24h', action: () => setSelectedDateRange(selectedDateRange === '24h' ? 'all' : '24h') },
 { id: '3days', icon: Clock, label: t('jobBoard.quickFilters.3days'), active: selectedDateRange === '3d', action: () => setSelectedDateRange(selectedDateRange === '3d' ? 'all' : '3d') },
 { id: '7days', icon: Clock, label: t('jobBoard.quickFilters.7days'), active: selectedDateRange === '7d', action: () => setSelectedDateRange(selectedDateRange === '7d' ? 'all' : '7d') },
 { id: 'lugano', icon: MapPin, label: 'Lugano', active: selectedLocation === 'lugano', action: () => setSelectedLocation(selectedLocation === 'lugano' ? 'all' : 'lugano') },
 { id: 'mendrisio', icon: MapPin, label: 'Mendrisio', active: selectedLocation === 'mendrisio', action: () => setSelectedLocation(selectedLocation === 'mendrisio' ? 'all' : 'mendrisio') },
 { id: 'bellinzona', icon: MapPin, label: 'Bellinzona', active: selectedLocation === 'bellinzona', action: () => setSelectedLocation(selectedLocation === 'bellinzona' ? 'all' : 'bellinzona') },
 { id: 'locarno', icon: MapPin, label: 'Locarno', active: selectedLocation === 'locarno', action: () => setSelectedLocation(selectedLocation === 'locarno' ? 'all' : 'locarno') },
 { id: 'chiasso', icon: MapPin, label: 'Chiasso', active: selectedLocation === 'chiasso', action: () => setSelectedLocation(selectedLocation === 'chiasso' ? 'all' : 'chiasso') },
 ] as const).map(chip => (
 <button
 key={chip.id}
 type="button"
 onClick={chip.action}
 className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 min-h-11 text-xs font-medium rounded-full border transition-[color,background-color,border-color,box-shadow] ${
 chip.active
 ? 'bg-accent-strong border-accent text-on-accent shadow-sm shadow-accent/20'
 : 'bg-surface border-edge text-subtle hover:bg-surface-raised hover:border-accent'
 }`}
 aria-pressed={chip.active}
 >
 <chip.icon className="w-3 h-3" />
 {chip.label}
 </button>
 ))}
 </div>
 {/* Row 2: Roles & Categories */}
 <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
 {([
 { id: 'nurse', icon: Briefcase, label: t('jobBoard.quickFilters.nurse'), active: searchQuery.toLowerCase() === t('jobBoard.quickFilters.nurse').toLowerCase(), action: () => { const term = t('jobBoard.quickFilters.nurse').toLowerCase(); applySearchQuery(searchQuery.toLowerCase() === term ? '' : term); } },
 { id: 'engineer', icon: Briefcase, label: t('jobBoard.quickFilters.engineer'), active: searchQuery.toLowerCase() === t('jobBoard.quickFilters.engineer').toLowerCase(), action: () => { const term = t('jobBoard.quickFilters.engineer').toLowerCase(); applySearchQuery(searchQuery.toLowerCase() === term ? '' : term); } },
 { id: 'driver', icon: Briefcase, label: t('jobBoard.quickFilters.driver'), active: searchQuery.toLowerCase() === t('jobBoard.quickFilters.driver').toLowerCase(), action: () => { const term = t('jobBoard.quickFilters.driver').toLowerCase(); applySearchQuery(searchQuery.toLowerCase() === term ? '' : term); } },
 { id: 'health', icon: Tag, label: t('jobBoard.quickFilters.health'), active: selectedCategory === 'health', action: () => setSelectedCategory(selectedCategory === 'health' ? 'all' : 'health') },
 { id: 'parttime', icon: Tag, label: 'Part-time', active: selectedContract === 'part-time', action: () => setSelectedContract(selectedContract === 'part-time' ? 'all' : 'part-time') },
 { id: 'apprentice', icon: Tag, label: t('jobBoard.quickFilters.apprenticeship'), active: selectedContract === 'internship', action: () => setSelectedContract(selectedContract === 'internship' ? 'all' : 'internship') },
 ] as const).map(chip => (
 <button
 key={chip.id}
 type="button"
 onClick={chip.action}
 className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 min-h-11 text-xs font-medium rounded-full border transition-[color,background-color,border-color,box-shadow] ${
 chip.active
 ? 'bg-accent-strong border-accent text-on-accent shadow-sm shadow-accent/20'
 : 'bg-surface border-edge text-subtle hover:bg-surface-raised hover:border-accent'
 }`}
 aria-pressed={chip.active}
 >
 <chip.icon className="w-3 h-3" />
 {chip.label}
 </button>
 ))}
 </div>
 </div>

 {/* Issue #4298: one-tap alert CTA driven by the board's own active filters */}
 {boardFilterAlertVisible && userId && userEmail && (
 <Suspense fallback={null}>
 <JobBoardFilterAlertCta
 userId={userId}
 email={userEmail}
 locale={locale}
 onImpression={() => trackJobAlertCtaShownOnce('job_board_filters', boardFilterAlertKeywordLabel)}
 keywordLabel={boardFilterAlertKeywordLabel}
 cantonCode={boardFilterAlertCantonCode}
 onSubscribed={() => {
 Analytics.trackJobAlertCtaClick('job_board_filters', 'success', boardFilterAlertKeywordLabel);
 Analytics.trackJobAlertCreated({
 keywords: boardFilterAlertKeywordLabel,
 location: boardFilterAlertCantonCode || '',
 frequency: 'weekly',
 surface: 'job_board_filters',
 });
 // Review PR #4338, bug G: keep the shared getUserAlerts cache correct.
 invalidateUserAlertsCache();
 // Bug F: delay hiding the CTA so JobBoardFilterAlertCta's own
 // "Alert attivato ✓" success state (setStatus('success'), same render
 // batch as this callback) has time to actually paint before the parent
 // unmounts it via boardFilterAlertVisible flipping false.
 if (boardFilterAlertHideTimerRef.current !== null) window.clearTimeout(boardFilterAlertHideTimerRef.current);
 boardFilterAlertHideTimerRef.current = window.setTimeout(() => {
 boardFilterAlertHideTimerRef.current = null;
 setBoardFilterAlertEligible(false);
 }, 2500);
 }}
 onErrored={() => {
 Analytics.trackJobAlertCtaClick('job_board_filters', 'error', boardFilterAlertKeywordLabel);
 }}
 />
 </Suspense>
 )}

 {/* Popular internal-search chips — real mined terms, issue #4301.
 Self-contained component + single mount point (renders null below its
 own minimum-terms threshold). id is the scroll target for the
 0-results "get an alert" CTA below (lands next to the always-mounted
 JobAlertForm just under it). */}
 <div id="jobboard-search-utilities">
 <PopularSearchChips onSelect={applySearchQuery} activeTerm={searchQuery} />
 </div>

 {/* FRO-332/353: Job Alert form (behind feature flag) */}
 {enableJobAlerts && (
 <Suspense fallback={<div className="h-[100px] rounded-xl bg-surface-raised animate-pulse" />}>
 <JobAlertForm
 authUser={authUser}
 onRequireAuth={onRequireAuth}
 initialKeyword={searchQuery}
 initialCantonCode={boardFilterAlertCantonCode}
 />
 </Suspense>
 )}

 {/* Filter toggle bar — wraps so the saved-jobs pill (#4466) never forces
 horizontal overflow on narrow mobile widths. */}
 <div className="flex flex-wrap items-center gap-2">
 <button
 type="button"
 onClick={() => setFiltersExpanded(!filtersExpanded)}
 className={`inline-flex items-center gap-2 px-3.5 py-2 min-h-[44px] text-sm font-medium rounded-xl border transition-colors ${
 filtersExpanded || activeFilterCount > 0
 ? 'bg-accent-subtle border-accent-border text-accent'
 : 'bg-surface border-edge text-subtle hover:bg-surface-raised'
 }`}
 aria-expanded={filtersExpanded}
 aria-label={t('jobBoard.filter.toggle') || 'Toggle filters'}
 >
 <SlidersHorizontal className="w-4 h-4" />
 {t('jobBoard.filter.filters') || 'Filtri'}
 {activeFilterCount > 0 && (
 <span className="inline-flex items-center justify-center w-5 h-5 text-xs font-bold rounded-full bg-accent-strong text-on-accent">
 {activeFilterCount}
 </span>
 )}
 </button>

 {/* Quick"New only" pill — always visible */}
 <button
 type="button"
 onClick={() => setShowNewOnly(!showNewOnly)}
 className={`inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] text-sm font-medium rounded-xl border transition-[color,background-color,border-color,box-shadow] ${
 showNewOnly
 ? 'bg-accent-strong border-accent text-on-accent hover:bg-accent-strong-hover shadow-sm shadow-accent/20'
 : 'bg-surface border-edge text-subtle hover:bg-surface-raised'
 }`}
 aria-label={t('jobBoard.filter.newOnly')}
 aria-pressed={showNewOnly}
 >
 <Sparkles className="w-3.5 h-3.5" />
 {t('jobBoard.filter.newOnly')}
 </button>

 {/* Saved-jobs view toggle (#4466) — same mechanics as the new-only pill,
 with a persistent total-saved counter badge. */}
 <button
 type="button"
 onClick={() => {
 const next = !showSavedOnly;
 if (next && !authUser?.uid) {
 savePendingSaveJobIntent({ kind: 'show_saved_only' });
      requestSlot('save-auth-prompt', POPUP_PRIORITY.AUTH_GATE);
 setSaveAuthPromptOpen(true);
 Analytics.trackEvent('save_signin_prompt_shown', { surface: 'saved_filter_pill' });
 return;
 }
 setShowSavedOnly(next);
 if (next) {
 Analytics.trackEvent('saved_list_viewed', { saved_count: savedJobs.length });
 }
 }}
 className={`inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] text-sm font-medium rounded-xl border transition-[color,background-color,border-color,box-shadow] ${
 showSavedOnly
 ? 'bg-accent-strong border-accent text-on-accent hover:bg-accent-strong-hover shadow-sm shadow-accent/20'
 : 'bg-surface border-edge text-subtle hover:bg-surface-raised'
 }`}
 aria-label={t('jobBoard.filter.saved')}
 aria-pressed={showSavedOnly}
 >
 <Bookmark className={`w-3.5 h-3.5 ${savedJobs.length > 0 && !showSavedOnly ? 'fill-current text-accent' : ''}`} />
 {t('jobBoard.filter.saved')}
 {savedJobs.length > 0 && (
 <span className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-xs font-bold ${
 showSavedOnly ? 'bg-surface text-accent' : 'bg-accent-subtle text-accent'
 }`}>
 {savedJobs.length}
 </span>
 )}
 </button>

 {/* Reset all filters */}
 {activeFilterCount > 0 && (
 <button
 type="button"
 onClick={resetAllFilters}
 className="ml-auto inline-flex items-center gap-1 px-3 py-2 min-h-[44px] text-xs font-semibold text-danger hover:text-danger hover:bg-danger-subtle rounded-lg transition-colors"
 aria-label={t('jobBoard.filter.resetAll') || 'Reset all filters'}
 >
 <X className="w-3.5 h-3.5" />
 {t('jobBoard.filter.resetAll') || 'Reset'}
 </button>
 )}
 </div>

 {/* Expandable filter panel — uses max-h transition to prevent CLS */}
 <div className={`transition-[max-height,opacity] duration-200 ease-out overflow-hidden ${filtersExpanded ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'}`}>
 <div className="bg-surface/50 p-3 sm:p-4 rounded-xl border border-edge">
 <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
 <div className="relative">
 <select
 value={selectedLocation}
 onChange={(e) => setSelectedLocation(e.target.value)}
 className={`w-full appearance-none pl-3 pr-8 py-2.5 min-h-[44px] text-sm rounded-xl border transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-transparent truncate ${
 selectedLocation !== 'all'
 ? 'border-accent-border bg-accent-subtle text-accent'
 : 'border-edge bg-surface text-heading'
 }`}
 aria-label={t('jobBoard.filter.location')}
 >
 <option value="all">{t('jobBoard.filter.allLocations')}</option>
 {uniqueLocalities.map((loc) => (
 <option key={loc.value} value={loc.value}>
 {loc.label}
 </option>
 ))}
 </select>
 <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
 </div>

 <div className="relative">
 <select
 value={selectedSector}
 onChange={(e) => setSelectedSector(e.target.value)}
 className={`w-full appearance-none pl-3 pr-8 py-2.5 min-h-[44px] text-sm rounded-xl border transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-transparent truncate ${
 selectedSector !== 'all'
 ? 'border-accent-border bg-accent-subtle text-accent'
 : 'border-edge bg-surface text-heading'
 }`}
 aria-label={t('jobBoard.filter.sector')}
 >
 <option value="all">{t('jobBoard.filter.allSectors')}</option>
 {uniqueSectors.map((sec) => (
 <option key={sec} value={sec.toLowerCase()}>
 {sec}
 </option>
 ))}
 </select>
 <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
 </div>

 <div className="relative">
 <select
 value={selectedCategory}
 onChange={(e) => setSelectedCategory(e.target.value as JobCategory | 'all')}
 className={`w-full appearance-none pl-3 pr-8 py-2.5 min-h-[44px] text-sm rounded-xl border transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-transparent ${
 selectedCategory !== 'all'
 ? 'border-accent-border bg-accent-subtle text-accent'
 : 'border-edge bg-surface text-heading'
 }`}
 aria-label={t('jobBoard.filter.category')}
 >
 {categories.map((c) => (
 <option key={c.value} value={c.value}>
 {t(c.labelKey)}
 </option>
 ))}
 </select>
 <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
 </div>

 <div className="relative">
 <select
 value={selectedContract}
 onChange={(e) => setSelectedContract(e.target.value as ContractType | 'all')}
 className={`w-full appearance-none pl-3 pr-8 py-2.5 min-h-[44px] text-sm rounded-xl border transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-transparent ${
 selectedContract !== 'all'
 ? 'border-accent-border bg-accent-subtle text-accent'
 : 'border-edge bg-surface text-heading'
 }`}
 aria-label={t('jobBoard.filter.contract')}
 >
 {contracts.map((c) => (
 <option key={c.value} value={c.value}>
 {t(c.labelKey)}
 </option>
 ))}
 </select>
 <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
 </div>

 <div className="relative">
 <select
 value={selectedCompany}
 onChange={(e) => setSelectedCompany(e.target.value)}
 className={`w-full appearance-none pl-3 pr-8 py-2.5 min-h-[44px] text-sm rounded-xl border transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-transparent truncate ${
 selectedCompany !== 'all'
 ? 'border-accent-border bg-accent-subtle text-accent'
 : 'border-edge bg-surface text-heading'
 }`}
 aria-label={t('jobBoard.filter.company')}
 >
 <option value="all">{t('jobBoard.filter.allCompanies')}</option>
 {uniqueCompanies.map((c) => (
 <option key={c} value={c.toLowerCase()}>
 {c}
 </option>
 ))}
 </select>
 <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
 </div>

 <div className="relative">
 <select
 value={selectedDateRange}
 onChange={(e) => setSelectedDateRange(e.target.value as DateRange)}
 className={`w-full appearance-none pl-3 pr-8 py-2.5 min-h-[44px] text-sm rounded-xl border transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-transparent ${
 selectedDateRange !== 'all'
 ? 'border-accent-border bg-accent-subtle text-accent'
 : 'border-edge bg-surface text-heading'
 }`}
 aria-label={t('jobBoard.filter.dateRange')}
 >
 {dateRanges.map((d) => (
 <option key={d.value} value={d.value}>
 {t(d.labelKey)}
 </option>
 ))}
 </select>
 <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
 </div>
 </div>
 </div>
 </div>

 {/* Related search suggestions — overflow-hidden transition prevents CLS */}
 <div className={`transition-[max-height,opacity] duration-200 overflow-hidden ${searchQuery.trim() && relatedSearchSuggestions.length > 0 ? 'max-h-[200px] opacity-100' : 'max-h-0 opacity-0'}`}>
 {searchQuery.trim() && relatedSearchSuggestions.length > 0 && (
 <div className="rounded-xl border border-accent-border bg-accent-subtle/50 bg-accent-subtle p-3">
 <div className="flex items-center gap-2 mb-2">
 <Search className="w-4 h-4 text-accent" />
 <p className="text-xs font-semibold uppercase tracking-wide text-accent">Ricerche correlate</p>
 </div>
 <div className="flex flex-wrap gap-2">
 {relatedSearchSuggestions.map((term, i) => {
 const href = buildPath({ activeTab: 'job-board' as any, jobBoardCanton: JOB_BOARD_CANTON_AGGREGATE, jobSlug: buildSearchSlug(term, locale) }, locale);
 return (
 <a
 key={`${term}-${i}`}
 href={href}
 onClick={(e) => {
 e.preventDefault();
 navigateToRelatedSearch(term);
 }}
 className="text-xs px-2.5 py-1.5 min-h-[44px] inline-flex items-center rounded-full bg-surface/40 text-accent border border-accent-border hover:bg-accent-subtle transition-colors"
 >
 {term}
 </a>
 );
 })}
 </div>
 </div>
 )}
 </div>
 </div>

 {/* ── Personalization: NewJobsCounter + Personalizzato pill + TrendingSection ── */}
 {enablePersonalization && (
 <div className="space-y-3">
 {!newJobsDismissed && newJobsInfo.total > 0 && (
 <NewJobsCounter
 newJobsCount={newJobsInfo.total}
 matchingCount={newJobsInfo.matching}
 onDismiss={() => setNewJobsDismissed(true)}
 />
 )}
 {isPersonalizationActive && (
 <div
 role="status"
 className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent-subtle border border-accent-border text-xs font-medium text-accent transition-opacity duration-300 ease-in motion-reduce:transition-none"
 >
 <UserCheck className="w-3.5 h-3.5" />
 Personalizzato per te
 </div>
 )}
 {jobMatchAlertVisible && userId && userEmail && (
 <Suspense fallback={null}>
 <JobMatchAlertCta
 userId={userId}
 email={userEmail}
 locale={locale}
 onImpression={() => trackJobAlertCtaShownOnce('job_match_pill', jobMatchAlertCategoryLabel)}
 categoryLabel={jobMatchAlertCategoryLabel}
 cantonCode={jobMatchAlertCantonCode}
 onSubscribed={() => {
 Analytics.trackJobAlertCtaClick('job_match_pill', 'success', jobMatchAlertCategoryLabel);
 Analytics.trackJobAlertCreated({
 keywords: jobMatchAlertCategoryLabel,
 location: jobMatchAlertCantonCode || '',
 frequency: 'weekly',
 surface: 'job_match_pill',
 });
 Analytics.trackJobMatchAlertSignup(jobMatchAlertCategoryLabel, jobMatchAlertCantonCode);
 // Review PR #4338, bug G: keep the shared getUserAlerts cache correct.
 invalidateUserAlertsCache();
 // Bug F sibling (review PR #4338): JobMatchAlertCta has the identical
 // idle/submitting/success/error state machine as JobBoardFilterAlertCta —
 // delay hiding it so its own "Alert attivato ✓" success state has time
 // to actually paint before the parent unmounts it via
 // jobMatchAlertVisible flipping false.
 if (jobMatchAlertHideTimerRef.current !== null) window.clearTimeout(jobMatchAlertHideTimerRef.current);
 jobMatchAlertHideTimerRef.current = window.setTimeout(() => {
 jobMatchAlertHideTimerRef.current = null;
 setJobMatchAlertEligible(false);
 }, 2500);
 }}
 onErrored={() => {
 Analytics.trackJobAlertCtaClick('job_match_pill', 'error', jobMatchAlertCategoryLabel);
 }}
 />
 </Suspense>
 )}
 {trendingJobs.length >= 3 && (
 <TrendingSection
 trendingJobs={trendingJobs.map((j) => ({
 ...j,
 logoUrl: companyLogoUrl(j),
 href: j.slug ? buildPath({ activeTab: 'job-board' as any, jobSlug: j.slug }, locale) : undefined,
 }))}
 popularity={deferredPopularity}
 heading={t('jobBoard.trending.heading')}
 ariaLabel={t('jobBoard.trending.aria')}
 onJobClick={(slug) => {
 Analytics.trackSelectContent('trending_section_click', slug);
 const job = jobs.find((j) => j.slug === slug);
 if (job) openDetail(job);
 }}
 />
 )}
 </div>
 )}

 <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 sm:gap-3 min-h-[28px]">
 <p className="text-xs sm:text-sm text-muted" aria-live="polite">
 {resultsResolving
 ? t('jobBoard.loadingResults')
 : isMobile && filteredJobs.length > 0
 ? t('jobBoard.showingNJobs', { count: String(displayJobs.length), total: String(filteredJobs.length) })
 : t('jobBoard.resultsCount', { count: String(filteredJobs.length) })}
 </p>
 {!isMobile && renderPagination()}
 </div>

 {salaryRangeFilter.min !== null && (
 <div className="flex items-center gap-2 text-xs text-muted -mt-1 mb-1">
 <span>
 {t('jobBoard.salaryRangeFilter.active', {
 min: salaryRangeFilter.min.toLocaleString('de-CH'),
 max: (salaryRangeFilter.max ?? salaryRangeFilter.min).toLocaleString('de-CH'),
 })}
 </span>
 <button type="button" onClick={clearSalaryRangeFilter} className="underline hover:text-link">
 {t('jobBoard.salaryRangeFilter.clear')}
 </button>
 </div>
 )}

 <div className="space-y-3 min-h-[600px]">
 {/* While the authoritative results are still resolving (provisional
 first-page count or in-flight fallback pools), hide the count banners
 and provisional cards — the skeleton below stands in their place. */}
 {!resultsResolving && (
 <>
 {isUsingSearchFallback && (
 <div
 role="status"
 aria-live="polite"
 className="rounded-xl border border-warning-border bg-warning-subtle px-4 py-3 text-sm text-body"
 >
 <div className="flex items-start gap-2">
 <Search className="w-4 h-4 mt-0.5 shrink-0 text-warning-strong" />
 <div>
 <p className="font-semibold font-display text-strong">
 {t('jobBoard.searchFallback.title', { query: deferredSearchQuery.trim() })}
 </p>
 <p className="text-xs text-subtle mt-1">
 {t('jobBoard.searchFallback.hint')}
 </p>
 </div>
 </div>
 </div>
 )}
 {isCrossCantonFallback && (
 <div
 role="status"
 aria-live="polite"
 className="rounded-xl border border-info-border bg-info-subtle px-4 py-3 text-sm text-body"
 >
 <div className="flex items-start gap-2">
 <Search className="w-4 h-4 mt-0.5 shrink-0 text-info-strong" />
 <div>
 <p className="font-semibold font-display text-strong">
 {t('jobBoard.crossCantonFallback.title', { query: deferredSearchQuery.trim(), count: String(filteredJobs.length), ...cantonI18n })}
 </p>
 <p className="text-xs text-subtle mt-1">
 {t('jobBoard.crossCantonFallback.hint')}
 </p>
 </div>
 </div>
 </div>
 )}
 {isBroadenedSearch && (
 <div
 role="status"
 aria-live="polite"
 className="rounded-xl border border-info-border bg-info-subtle px-4 py-3 text-sm text-body"
 >
 <div className="flex items-start gap-2">
 <Search className="w-4 h-4 mt-0.5 shrink-0 text-info-strong" />
 <div>
 <p className="font-semibold font-display text-strong">
 {t('jobBoard.broadenedSearch.title', { query: deferredSearchQuery.trim(), count: String(filteredJobs.length), ...cantonI18n })}
 </p>
 <p className="text-xs text-subtle mt-1">
 {t('jobBoard.broadenedSearch.hint')}
 </p>
 </div>
 </div>
 </div>
 )}
 {isCrossLocaleFallback && (
 <div
 role="status"
 aria-live="polite"
 className="rounded-xl border border-info-border bg-info-subtle px-4 py-3 text-sm text-body"
 >
 <div className="flex items-start gap-2">
 <Search className="w-4 h-4 mt-0.5 shrink-0 text-info-strong" />
 <div>
 <p className="font-semibold font-display text-strong">
 {t('jobBoard.crossLocaleFallback.title', { query: deferredSearchQuery.trim(), count: String(filteredJobs.length) })}
 </p>
 <p className="text-xs text-subtle mt-1">
 {t('jobBoard.crossLocaleFallback.hint')}
 </p>
 </div>
 </div>
 </div>
 )}
 {isBroadenedCompanyScope && (
 <div
 role="status"
 aria-live="polite"
 className="rounded-xl border border-info-border bg-info-subtle px-4 py-3 text-sm text-body"
 >
 <div className="flex items-start gap-2">
 <Briefcase className="w-4 h-4 mt-0.5 shrink-0 text-info-strong" />
 <div>
 <p className="font-semibold font-display text-strong">
 {t('jobBoard.companyBroaden.title', { company: companyDisplayName ?? '', count: String(filteredJobs.length), ...cantonI18n })}
 </p>
 <p className="text-xs text-subtle mt-1">
 {t('jobBoard.companyBroaden.hint')}
 </p>
 </div>
 </div>
 </div>
 )}
 {displayJobs.map((job, idx) => {
 const pos = idx + 1;
 // One in-feed ad after every Nth card (shared `shouldPlaceInfeedAd`
 // cadence: 3, 6, 9, …), never after the last loaded card.
 const showAd = shouldPlaceInfeedAd(pos) && pos < displayJobs.length;
 return (
 <React.Fragment key={job.id || job.slug || idx}>
 {renderJobCard(job)}
 {showAd && renderInfeedAd(`main-${idx}`)}
 </React.Fragment>
 );
 })}
 </>
 )}

 {/* Animated loader while results resolve (empty-while-fetching OR a
 provisional first-page count) — rotating reassurance + shimmer cards
 sized to the loaded layout so the count + cards reconcile in place (no
 CLS) and the user never sees a bare "0 risultati" mid-fetch (#2968). */}
 {resultsResolving && (
 <JobBoardResultsLoader cards={6} />
 )}

 {filteredJobs.length === 0 && !resultsResolving && showSavedOnly && (
 <div className="text-center py-12 text-muted">
 <Bookmark className="w-10 h-10 mx-auto mb-3 opacity-30" />
 <p className="font-medium">{t('jobBoard.saved.emptyTitle')}</p>
 <p className="text-sm mt-1">{t('jobBoard.saved.emptyHint')}</p>
 </div>
 )}

 {filteredJobs.length === 0 && !resultsResolving && !showSavedOnly && (
 <div className="text-center py-12 text-muted">
 <Briefcase className="w-10 h-10 mx-auto mb-3 opacity-30" />
 <p className="font-medium">{t('jobBoard.noResults')}</p>
 <p className="text-sm mt-1">{t('jobBoard.noResultsHint')}</p>

 {/* Smart 0-results: fuzzy "did you mean" suggestions (issue #4301) */}
 {zeroResultSuggestions.length > 0 && (
 <div className="mt-4">
 <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
 {t('jobBoard.zeroResults.suggestionsLabel')}
 </p>
 <div className="flex flex-wrap justify-center gap-2">
 {zeroResultSuggestions.map((term) => (
 <button
 key={term}
 type="button"
 onClick={() => applySearchQuery(term)}
 className="px-3 py-1.5 min-h-11 rounded-full text-xs font-medium bg-accent-subtle text-accent border border-accent-border hover:bg-accent-subtle transition-colors"
 >
 {term}
 </button>
 ))}
 </div>
 </div>
 )}

 {/* 0-results job-alert CTA: points at the already-mounted JobAlertForm
 above (id="jobboard-search-utilities" anchor), already prefilled via
 its initialKeyword={searchQuery} prop — no second form instance. */}
 {enableJobAlerts && deferredSearchQuery.trim() && (
 <button
 type="button"
 onClick={() => document.getElementById('jobboard-search-utilities')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
 className="mt-5 inline-flex items-center gap-1.5 px-4 py-2.5 min-h-11 rounded-xl text-sm font-semibold bg-accent-strong text-on-accent hover:opacity-90 transition-opacity"
 >
 {t('jobBoard.zeroResults.alertCta', { query: deferredSearchQuery.trim() })}
 </button>
 )}
 </div>
 )}
 </div>

 {/* Mobile: infinite scroll sentinel. min-h matches the spinner row's real
 height (py-6 + h-5 = 68px) so the container doesn't shrink by 20px when
 hasMoreMobileJobs flips false at end-of-list (in-viewport layout shift). */}
 <div className="min-h-[68px] sm:hidden">
 {hasMoreMobileJobs && (
 <div ref={jobSentinelRef} className="flex justify-center items-center py-6">
 <div className="h-5 w-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
 <span className="ml-2 text-sm text-muted">{t('jobBoard.loadMore')}…</span>
 </div>
 )}
 </div>

 <div className="flex flex-wrap items-center justify-center sm:justify-end gap-3">
 {!isMobile && renderPagination()}
 </div>

 {/* AdSense — end-of-list multiplex */}
 {filteredJobs.length > 0 && (
 <React.Fragment key={`endlist-${adRefreshKey}`}>
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBLIST_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.JOBLIST_END_MULTIPLEX.format}
 className="mt-6 mb-4"
 />
 </React.Fragment>
 )}

 {enableJobAlerts && filteredJobs.length >= 3 && (
 <Suspense fallback={<div className="mt-6 rounded-2xl border border-edge bg-surface-raised animate-pulse min-h-[280px]" aria-hidden="true" />}>
 <JobAlertEndCard keyword={deferredSearchQuery.trim()} />
 </Suspense>
 )}

 {enableJobAlerts && (
 <Suspense fallback={null}>
 <JobAlertStickyBanner />
 </Suspense>
 )}

 {jobDetailPromptJsx}
 {savedJobsNudgeJsx}
 {saveAuthPromptJsx}

 {authGateModalJsx}

 {/* Layer 2D — Internal linking: Strumenti correlati sidebar block. */}
 <aside
 aria-label={t('seoLinks.jobBoard.title')}
 data-testid="jobboard-seo-sidebar"
 className="rounded-2xl border border-edge bg-surface p-4"
 >
 <h3 className="text-sm font-bold text-heading mb-2">{t('seoLinks.jobBoard.title')}</h3>
 <ul className={`grid grid-cols-1 gap-2 list-none p-0 m-0 ${[!killSwitches.jobMarket, !killSwitches.weeklyEmployers, !killSwitches.healthPremiums, true].filter(Boolean).length > 1 ? 'sm:grid-cols-2' : ''}`}>
 {!killSwitches.jobMarket && (
 <li>
 <a
 href={buildJobMarketHubPath(locale)}
 className="inline-flex items-center gap-2 text-xs text-subtle hover:text-accent transition-colors no-underline py-1"
 >
 <TrendingUp className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
 {t('seoLinks.jobBoard.jobMarket')}
 </a>
 </li>
 )}
 {!killSwitches.weeklyEmployers && (
 <li>
 <a
 href={buildCurrentWeekPath(locale, 'ticino')}
 className="inline-flex items-center gap-2 text-xs text-subtle hover:text-accent transition-colors no-underline py-1"
 >
 <Building2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
 {t('seoLinks.jobBoard.employers')}
 </a>
 </li>
 )}
 {!killSwitches.healthPremiums && (
 <li>
 <a
 href={buildHealthPremiumsCantonPath(locale, 'ticino')}
 className="inline-flex items-center gap-2 text-xs text-subtle hover:text-success transition-colors no-underline py-1"
 >
 <Heart className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
 {t('seoLinks.jobBoard.healthPremiums')}
 </a>
 </li>
 )}
 <li>
 <a
 href={locale === 'it' ? '/' : `/${locale}/`}
 className="inline-flex items-center gap-2 text-xs text-subtle hover:text-accent transition-colors no-underline py-1"
 >
 <Calculator className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
 {t('seoLinks.jobBoard.salary')}
 </a>
 </li>
 </ul>
 </aside>

 <div className="bg-gradient-to-br from-info-subtle to-accent-subtle rounded-2xl p-6 border border-info-border">
 <div className="flex flex-col md:flex-row items-center gap-4 text-center md:text-left">
 <div className="flex-shrink-0 p-3 bg-info-subtle rounded-xl">
 <Building2 className="w-8 h-8 text-info" />
 </div>
 <div className="flex-1">
 <h3 className="font-bold font-display text-heading text-lg">{t('jobBoard.cta.title', cantonI18n)}</h3>
 <p className="text-sm text-subtle mt-1">{t('jobBoard.cta.description')}</p>
 </div>
 <button
 onClick={() => {
 Analytics.trackSelectContent('job_board_cta', 'company_post_job');
 onPostJob?.();
 }}
 className="inline-flex items-center gap-2 px-5 py-2.5 bg-info-strong hover:bg-info-strong-hover text-on-accent font-semibold rounded-xl transition-colors text-sm whitespace-nowrap cursor-pointer"
 >
 <Mail className="w-4 h-4" />
 {t('jobBoard.cta.button')}
 </button>
 </div>
 </div>
 </div>
 </JobBoardRailShell>
 );
};

export default React.memo(JobBoard);
