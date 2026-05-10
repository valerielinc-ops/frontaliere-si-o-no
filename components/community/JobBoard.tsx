/**
 * JobBoard — Ticino job board for cross-border workers
 *
 * - Listing: latest crawled jobs, 10 per page + pagination.
 * - Detail: dedicated SEO-friendly page per job (slug route), with sidebar widgets and related jobs.
 */

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
const JobAlertForm = lazyRetry(() => import('@/components/community/JobAlertForm'));
const JobAlertStickyBanner = lazyRetry(() => import('@/components/community/JobAlertStickyBanner'));
const JobAlertEndCard = lazyRetry(() => import('@/components/community/JobAlertEndCard'));
const JobAlertPostAuthPrompt = lazyRetry(() => import('@/components/community/JobAlertPostAuthPrompt'));
const JobDetailAlertPrompt = lazyRetry(() => import('@/components/community/JobDetailAlertPrompt'));
import { reportCaughtError } from '@/services/errorReporter';
import { trackJobView } from '@/services/jobViewsService';
import {
 fetchAggregatedJobs,
 fetchAllJobs,
 fetchJobsForCanton,
 getDefaultCantonForVisit,
 AGGREGATE_CANTON_CODE,
 type Job as RawJob,
} from '@/services/jobsService';
import { normalizeSearchText, buildStemmedHaystack, stemSearchToken } from '@/services/textUtils';
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
} from '@/services/personalizationScoring';
import NewJobsCounter from '@/components/community/NewJobsCounter';
import TrendingSection from '@/components/community/TrendingSection';
import EmployerBrandHub from '@/components/jobs/EmployerBrandHub';
import { getEmployerBrandBySlug } from '@/services/employerBrands';
import popularityData from '@/data/job-popularity.json';
import type { SimulationResult } from '@/types';
import { DEFAULT_INPUTS } from '@/constants';
import {
 ArrowLeft,
 ArrowUpRight,
 BookOpen,
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
import { buildPath, registerJobSlugMap } from '@/services/router';
import { useNavigation } from '@/services/NavigationContext';
import AdSenseBanner from '@/components/shared/AdSenseBanner';
import Callout from '@/components/shared/Callout';
import { SkeletonJobDetail } from '@/components/shared/Skeletons';
import { useExpiredJob, hasSeededExpiredData, seededJobMatchesSlug } from '@/hooks/useExpiredJob';
import { useKillSwitches } from '@/hooks/useKillSwitches';
import JobExpiredView from '@/components/community/JobExpiredView';
import JobOrphanView from '@/components/community/JobOrphanView';
import { AD_SLOTS } from '@/services/adsenseSlots';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { eagerAuth, getAuthEmail, promptOneTap, renderGoogleButton, isLinkedInSignInAvailable, signInWithLinkedIn, saveAuthJobContext } from '@/services/authService';
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
} from '@/services/relatedSearchClusters';
export { buildSearchSlug } from '@/services/relatedSearchClusters';
import { handleCompanyLogoError } from '@/services/logoService';
import { deriveJobPostalCode, getJobLocationSnapshot } from '@/services/jobLocationSnapshot';
import { getJobSalaryContext } from '@/data/salaryData';
import {
 upsertNewsletterSubscriber,
 markNewsletterSubscribedLocally,
} from '@/services/newsletterSubscribers';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import { requestSlot, releaseSlot, POPUP_PRIORITY } from '@/services/popupQueue';
import type { Article } from '@/data/blog-articles-data';
// Layer 2D — Internal linking: cross-feature SEO page builders (sidebar "Strumenti correlati").
import { buildCurrentWeekPath } from '@/build-plugins/weeklyEmployersData';
import { buildHubPath as buildJobMarketHubPath } from '@/build-plugins/jobMarketSnapshotData';
import { buildHealthPremiumsCantonPath } from '@/build-plugins/healthPremiumsData';
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
const JOB_AUTH_REDIRECT_SLUG_KEY = 'frontaliere_job_auth_redirect_slug';

/** Module-level cache for per-job detail data (fetched on-demand when detail view opens). */
const jobDetailCache = new Map<string, Promise<Partial<JobListing>>>();

/**
 * Fetch a single job's detail data (~15KB) instead of the full locale file (~11MB).
 * Per-job detail files are generated at build time by localeJobsSplitPlugin. (FRO-detail-split)
 */
function fetchJobDetail(jobId: string): Promise<Partial<JobListing>> {
 if (!jobDetailCache.has(jobId)) {
 const promise = fetch(`/data/job-detail/${jobId}.json`)
 .then((res) => { if (!res.ok) throw new Error(`${res.status}`); return res.json(); })
 .then((data: unknown) => (data && typeof data === 'object' ? data : {}) as Partial<JobListing>)
 .catch(() => ({} as Partial<JobListing>));
 jobDetailCache.set(jobId, promise);
 }
 return jobDetailCache.get(jobId)!;
}

const ARTICLE_STOP_WORDS = new Set(['2025', '2026', '2027', 'del', 'dei', 'per', 'con', 'sul', 'fra', 'tra', 'una', 'non', 'che', 'come', 'cosa', 'dal', 'the', 'and', 'for', 'with', 'von', 'und', 'les', 'des', 'pour', 'dans']);

function slugTopicWordsJob(id: string): Set<string> {
 return new Set(id.split('-').filter(w => w.length > 2 && !ARTICLE_STOP_WORDS.has(w)));
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
 onJobRouteChange?: (slug?: string) => void;
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
 });
 if (explicitLogo) return explicitLogo;

 const host = resolveCompanyWebsiteHost({
 company: job.company,
 companyKey: job.companyKey,
 companyDomain: job.companyDomain,
 url: job.url,
 });
 if (!host) return null;
 return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
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
 const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
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

 // Tokenize by splitting on spaces while preserving the space
 const words = text.split(/(?<=\s)/);

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

/** Parse crawled markdown-like job description into structured JSX blocks. */
export function renderFormattedDescription(raw: string): React.ReactNode {
 const text = String(raw || '').trim();
 if (!text) return null;

 // Pre-process: inject line breaks for descriptions that lack them
 const normalized = normalizeDescriptionBreaks(text);

 // Split into lines, preserving structure
 const lines = normalized.split(/\n/).map(l => l.trim());
 const blocks: React.ReactNode[] = [];
 let bulletBuffer: string[] = [];
 let keyIdx = 0;

 const flushBullets = () => {
 if (bulletBuffer.length === 0) return;
 blocks.push(
 <ul key={`ul-${keyIdx++}`} className="space-y-1.5 pl-4 list-disc marker:text-accent">
 {bulletBuffer.map((b, i) => (
 <li key={i} className="text-sm leading-relaxed text-body">{b}</li>
 ))}
 </ul>
 );
 bulletBuffer = [];
 };

 for (const line of lines) {
 if (!line) {
 // blank line — flush bullets, skip
 flushBullets();
 continue;
 }

 // Bare ## marker with no content (e.g. "##" or "## ") — skip silently
 if (/^#{1,3}\s*$/.test(line)) {
 flushBullets();
 continue;
 }

 // ## Section header
 const headerMatch = line.match(/^#{1,3}\s+(.+)/);
 if (headerMatch) {
 flushBullets();
 const headingFull = headerMatch[1].replace(/:$/, '').trim();

 // A) Heading contains inline dash-bullets (" - CapitalWord" × 3+) → heading + list
 const dashHits = [...headingFull.matchAll(/ - [A-ZÀ-ÖÙ-Ü]/g)];
 if (dashHits.length >= 3 && (dashHits[0].index ?? 0) > 5) {
 const splitAt = dashHits[0].index!;
 const title = headingFull.substring(0, splitAt).trim();
 const items = headingFull.substring(splitAt)
 .split(/ - /)
 .map(s => s.trim())
 .filter(s => s.length > 0);
 blocks.push(
 <h3 key={`h-${keyIdx++}`} className="text-sm font-bold text-heading border-l-3 border-accent pl-3 mt-4 mb-1 first:mt-0">
 {title}
 </h3>
 );
 if (items.length > 0) {
 blocks.push(
 <ul key={`ul-${keyIdx++}`} className="space-y-1.5 pl-4 list-disc marker:text-accent">
 {items.map((item, i) => (
 <li key={i} className="text-sm leading-relaxed text-body">{item}</li>
 ))}
 </ul>
 );
 }
 continue;
 }

 // A-bis) Italian infinitive pattern: lowercase items after dash (" - lowercase")
 const dashHitsLc = [...headingFull.matchAll(/ - [a-zà-öù-ü]/g)];
 if (dashHitsLc.length >= 3 && (dashHitsLc[0].index ?? 0) > 5) {
 const splitAt = dashHitsLc[0].index!;
 const title = headingFull.substring(0, splitAt).trim();
 const items = headingFull.substring(splitAt)
   .split(/ - /)
   .map(s => s.trim())
   .filter(s => s.length > 0);
 blocks.push(
   <h3 key={`h-${keyIdx++}`} className="text-sm font-bold text-heading border-l-3 border-accent pl-3 mt-4 mb-1 first:mt-0">
     {title}
   </h3>
 );
 if (items.length > 0) {
   blocks.push(
     <ul key={`ul-${keyIdx++}`} className="space-y-1.5 pl-4 list-disc marker:text-accent">
       {items.map((item, i) => (
         <li key={i} className="text-sm leading-relaxed text-body">{item}</li>
       ))}
     </ul>
   );
 }
 continue;
 }

 // B) Oversized heading (>150 chars) → split at first sentence boundary → heading + paragraph
 if (headingFull.length > 150) {
 const splitMatch = headingFull.match(/^(.{10,150}?(?:\d+%|[.!?]))\s+([A-ZÀ-ÖÙ-Ü][\s\S]*)/);
 if (splitMatch) {
 blocks.push(
 <h3 key={`h-${keyIdx++}`} className="text-sm font-bold text-heading border-l-3 border-accent pl-3 mt-4 mb-1 first:mt-0">
 {splitMatch[1]}
 </h3>
 );
 blocks.push(
 <p key={`p-${keyIdx++}`} className="text-sm leading-relaxed text-body">{splitMatch[2]}</p>
 );
 continue;
 }
 }

 // Normal heading
 blocks.push(
 <h3 key={`h-${keyIdx++}`} className="text-sm font-bold text-heading border-l-3 border-accent pl-3 mt-4 mb-1 first:mt-0">
 {headingFull}
 </h3>
 );
 continue;
 }

 // Bullet: starts with - or • or * (optionally followed by space)
 const bulletMatch = line.match(/^[-•*]\s+(.+)/);
 if (bulletMatch) {
 bulletBuffer.push(bulletMatch[1]);
 continue;
 }

 // Section-like label ending with : (e.g."Compiti:""Requisiti:")
 if (/^[A-ZÀ-ÖÙ-Ü][^.!?]{2,60}:$/.test(line) && !line.includes(' - ')) {
 flushBullets();
 const heading = line.replace(/:$/, '').trim();
 blocks.push(
 <h3 key={`h-${keyIdx++}`} className="text-sm font-bold text-heading border-l-3 border-accent pl-3 mt-4 mb-1 first:mt-0">
 {heading}
 </h3>
 );
 continue;
 }

 // Regular paragraph
 flushBullets();
 blocks.push(
 <p key={`p-${keyIdx++}`} className="text-sm leading-relaxed text-body">{line}</p>
 );
 }

 flushBullets();

 // Fallback: if we got no blocks (e.g. text had no newlines), split via normalizeParagraphs
 if (blocks.length === 0) {
 return normalizeParagraphs(text).map((p, i) => (
 <p key={i} className="text-sm leading-relaxed text-body">{p}</p>
 ));
 }

 return blocks;
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

type CanonicalLocaleContent = {
 summary: string[];
 sections: Array<{
 id: string;
 heading: string;
 paragraphs: string[];
 bullets: string[];
 }>;
 responsibilities: string[];
 requirements: string[];
 benefits: string[];
 process: string[];
 highlights: string[];
 keywords: string[];
 readingMinutes: number;
};

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

type FallbackSectionId =
 | 'overview'
 | 'responsibilities'
 | 'requirements'
 | 'benefits'
 | 'application'
 | 'contacts'
 | 'company'
 | 'details'
 | 'notes';

const FALLBACK_SECTION_ORDER: FallbackSectionId[] = [
 'overview',
 'responsibilities',
 'requirements',
 'benefits',
 'application',
 'contacts',
 'company',
 'details',
 'notes',
];

const FALLBACK_HEADING_MAP: Array<{ id: FallbackSectionId; title: string; keys: string[] }> = [
 { id: 'overview', title: 'Panoramica', keys: ['descrizione', 'panoramica', 'overview', 'about the role', 'introduzione'] },
 { id: 'responsibilities', title: 'Mansioni principali', keys: ['mansioni', 'compiti', 'responsabilita', 'tasks', 'responsibilities', 'attivita'] },
 { id: 'requirements', title: 'Competenze richieste', keys: ['requisiti', 'competenze richieste', 'profilo', 'your profile', 'qualifications', 'istruzione ed esperienza precedente', 'lingue'] },
 { id: 'benefits', title: 'Cosa offre l\'azienda', keys: ['cosa ti offriamo', 'offriamo', 'benefit', 'benefits', 'vantaggi'] },
 { id: 'application', title: 'Come candidarsi', keys: ['come candidarsi', 'candidatura', 'application process', 'apply'] },
 { id: 'contacts', title: 'Contatti', keys: ['contatto', 'contatti', 'kontakt', 'contact', 'informazioni aggiuntive', 'informazioni'] },
 { id: 'company', title: 'Azienda e contesto', keys: ['chi siamo', 'azienda', 'hospital', 'ospedale', 'organization', 'organizzazione'] },
 { id: 'details', title: 'Dettagli ulteriori', keys: ['dettagli', 'details', 'altro'] },
 { id: 'notes', title: 'Note e contenuto originale', keys: ['note', 'contenuto originale', 'testo originale', 'estratti originali', 'raw'] },
];

const FALLBACK_INLINE_HEADING_KEYS = [
 'le tue mansioni',
 'mansioni',
 'compiti',
 'responsabilita',
 'responsabilità',
 'attivita chiave',
 'attività chiave',
 'requisiti necessari',
 'requisiti auspicati',
 'requisiti',
 'competenze richieste',
 'profilo',
 'cosa porti con te',
 'cosa ti offriamo',
 'benefits',
 'come candidarsi',
 'candidatura',
 'contatti',
 'contatto',
 'lingue',
 'sede',
 'settori medici',
 'istruzione ed esperienza precedente',
 'manutenzione preventiva e aggiornamenti',
 'informazioni aggiuntive',
 'chi siamo',
 'about us',
];

const FALLBACK_INLINE_FIELD_KEYS = [
 'sede',
 'settori medici',
 'attivita chiave',
 'attività chiave',
 'assistenza sul campo e assistenza clienti',
 'manutenzione preventiva e aggiornamenti',
 'istruzione ed esperienza precedente',
 'lingue',
];

const FALLBACK_INLINE_FIELD_SPLIT_LABELS = [
 'Sede',
 'Settori medici',
 'Attività chiave',
 'Assistenza sul campo e assistenza clienti',
 'Manutenzione preventiva e aggiornamenti',
 'Istruzione ed esperienza precedente',
 'Lingue',
 'Tedesco',
 'Inglese',
 'Francese',
];

// Pre-compiled RegExps for description normalization (Vercel rule 7.10)
const INLINE_HEADING_REGEXPS = [...FALLBACK_INLINE_HEADING_KEYS]
 .sort((a, b) => b.length - a.length)
 .map((key) => {
 const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 return new RegExp(`(^|[\\n\\.;:!?]\\s+|\\s{2,})(?=${escaped}\\b)`, 'gi');
 });

const INLINE_FIELD_LABEL_REGEXPS = [...FALLBACK_INLINE_FIELD_KEYS]
 .sort((a, b) => b.length - a.length)
 .map((key) => {
 const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 return new RegExp(`\\s+(?=${escaped}(?:\\s*:|\\b))`, 'gi');
 });

const INLINE_FIELD_SPLIT_REGEXP = new RegExp(
 `\\s+(?=(?:${FALLBACK_INLINE_FIELD_SPLIT_LABELS.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:\\s*:|\\b))`,
 'g',
);

const HEADING_PREFIX_REGEXP_CACHE = new Map<string, RegExp[]>();
function getHeadingPrefixRegexps(group: { id: string; keys: string[] }): RegExp[] {
 let cached = HEADING_PREFIX_REGEXP_CACHE.get(group.id);
 if (!cached) {
 cached = [...group.keys]
 .sort((a, b) => b.length - a.length)
 .map((key) => {
 const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 return new RegExp(`^\\s*#*\\s*${escaped}\\s*[:\\-]?\\s*`, 'i');
 });
 HEADING_PREFIX_REGEXP_CACHE.set(group.id, cached);
 }
 return cached;
}

function fallbackSplitInlineFieldItems(text: string): string[] {
 const inlineFieldSplitRegex = INLINE_FIELD_SPLIT_REGEXP;
 const candidate = fallbackCleanSpaces(text);
 const parts = candidate
 .split(inlineFieldSplitRegex)
 .map((x) => fallbackCleanSpaces(x))
 .filter(Boolean);
 return parts.length >= 2 ? parts : [candidate];
}

const FALLBACK_SECTION_HINTS: Record<FallbackSectionId, string[]> = {
 overview: ['descrizione', 'panoramica', 'overview', 'ruolo', 'posizione', 'introduzione', 'profilo del ruolo'],
 responsibilities: ['mansioni', 'compiti', 'responsabilita', 'attivita', 'tasks', 'responsibilities', 'impari', 'svolgi', 'contribuisci', 'prendi'],
 requirements: ['requisiti', 'requisiti necessari', 'requisiti auspicati', 'competenze', 'profilo', 'qualifiche', 'diploma', 'esperienza', 'conoscenza'],
 benefits: ['cosa ti offriamo', 'offriamo', 'benefit', 'vantaggi', 'vacanze', 'sconti', 'ambiente di lavoro', 'opportunita'],
 application: ['come candidarsi', 'candidatura', 'interessato', 'invia', 'application', 'apply', 'selezione', 'colloquio', 'entro e non oltre'],
 contacts: ['contatti', 'contatto', 'email', 'e-mail', 'telefono', 'tel', 'scrivere', 'chiama', '091', '+41', '0041'],
 company: ['chi siamo', 'azienda', 'ospedale', 'hospital', 'organizzazione', 'organization', 'collaboratori', 'contesto'],
 details: ['dettagli', 'details', 'ulteriori informazioni', 'note aggiuntive'],
 notes: ['contenuto originale', 'testo originale', 'estratti originali', 'appendice', 'raw'],
};

const FALLBACK_NOISE_BLOCK_PATTERNS = [
 /##\s*(Vedi dettagli|View details|See details)[\s\S]*$/i,
 /##\s*(Annunci correlati|Related jobs|Offres d'emploi similaires)[\s\S]*$/i,
 /##\s*(Mappa|Map|Carte)[\s\S]*$/i,
];

const FALLBACK_NOISE_LINE_PATTERNS = [
 /^powered by\b/i,
 /^var\s+careerjet_apply_data\b/i,
 /^\(function\s*\(d,\s*s,\s*id\)/i,
 /^postuler\b/i,
 /^connexion\b/i,
 /^share this job\b/i,
 /^condividi questo annuncio\b/i,
 /^tell a friend\b/i,
];

const FALLBACK_FRAGMENT_START_RE = /^(di|del|della|dello|dei|degli|delle|con|per|e|oppure|o|che|da|a|al|alla|alle|agli|sul|sulla|sulle|nel|nella|nelle|d')\b/i;

const FALLBACK_PASS3_ROUTE_RULES: Array<{ id: FallbackSectionId; re: RegExp }> = [
 { id: 'application', re: /\b(candidatur|inoltrat|invia|apply|application|entro le ore|scadenz|selezion)\b/i },
 { id: 'contacts', re: /\b(tel\.?|telefono|email|e-mail|contatt|ulteriori informazioni|responsabile)\b/i },
 { id: 'company', re: /\b(repubblica e cantone|ente|organizzazione|collaboratori|ospedale|strutture|chi siamo)\b/i },
 { id: 'requirements', re: /\b(requisit|diploma|titolo|esperienz|conoscenza|attitudine|profilo)\b/i },
 { id: 'benefits', re: /\b(cosa ti offriamo|offriamo|vacanze|sconti|benefit|ambiente di lavoro|opportunita)\b/i },
 { id: 'responsibilities', re: /\b(mansion|compit|responsabilit|attivit|consulenza|gestire|svolgere)\b/i },
];

function fallbackDecodeHtml(input: string): string {
 return String(input || '')
 .replace(/&nbsp;/gi, ' ')
 .replace(/&raquo;|»/gi, ' ')
 .replace(/&amp;/gi, '&')
 .replace(/&quot;/gi, '"')
 .replace(/&#39;|&apos;/gi, '\'')
 .replace(/&lt;/gi, '<')
 .replace(/&gt;/gi, '>');
}

function fallbackDecodeLooseEntities(input: string): string {
 return String(input || '').replace(/&(sol|comma|ndash|newline|colo|times);/gi, (_m, ent) => {
 const map: Record<string, string> = {
 sol: '/',
 comma: ',',
 ndash: ' - ',
 newline: '\n',
 colo: ':',
 times: 'x',
 };
 return map[String(ent || '').toLowerCase()] || ' ';
 });
}

function fallbackCleanSpaces(value: string): string {
 return String(value || '').replace(/\s+/g, ' ').trim();
}

function fallbackNormalizeIdSource(value: string): string {
 return fallbackDecodeHtml(value || '')
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9 ]/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();
}

function fallbackUniq(items: string[], max = 999): string[] {
 const out: string[] = [];
 const seen = new Set<string>();
 for (const raw of items) {
 const clean = fallbackCleanSpaces(raw);
 if (!clean) continue;
 const key = clean.toLowerCase();
 if (seen.has(key)) continue;
 seen.add(key);
 out.push(clean);
 if (out.length >= max) break;
 }
 return out;
}

function fallbackDetectHeading(value: string): FallbackSectionId | null {
 const source = fallbackNormalizeIdSource(value.replace(/^#+\s*/, '').replace(/:$/, ''));
 for (const group of FALLBACK_HEADING_MAP) {
 for (const key of group.keys) {
 const normalized = fallbackNormalizeIdSource(key);
 if (!normalized) continue;
 if (source === normalized || source.startsWith(`${normalized} `) || source.startsWith(`${normalized}:`)) {
 return group.id;
 }
 }
 }
 return null;
}

function fallbackRemoveHeadingPrefix(line: string, sectionId: FallbackSectionId): string {
 const group = FALLBACK_HEADING_MAP.find((g) => g.id === sectionId);
 if (!group) return line;
 let out = line;
 for (const rx of getHeadingPrefixRegexps(group)) {
 out = out.replace(rx, '');
 }
 return out.replace(/^#+\s*/, '').trim();
}

function fallbackSplitByInlineHeadings(text: string): string {
 let out = String(text || '');
 for (const rx of INLINE_HEADING_REGEXPS) {
 out = out.replace(rx, '$1\n');
 }
 return out;
}

function fallbackSplitByInlineFieldLabels(text: string): string {
 let out = String(text || '');
 for (const rx of INLINE_FIELD_LABEL_REGEXPS) {
 out = out.replace(rx, '\n');
 }
 return out;
}

function fallbackIsUiNoiseChunk(line: string): boolean {
 const raw = fallbackCleanSpaces(line);
 if (!raw) return true;
 if (FALLBACK_NOISE_LINE_PATTERNS.some((rx) => rx.test(raw))) return true;
 if (/(@context|careerjet|indeed-apply|apply_button|bootstrap\.js)/i.test(raw)) return true;
 if (/^https?:\/\/\S+$/.test(raw) && /(careerjetApply|indeed)/i.test(raw)) return true;
 if (/^##\s*(offres d'emploi similaires|annunci correlati|related jobs|mappa|map|carte)/i.test(raw)) return true;
 return false;
}

function fallbackNormalizeRaw(raw: string): string {
 let text = fallbackDecodeLooseEntities(fallbackDecodeHtml(raw || ''));
 text = text
 .replace(/&(?:amp;)?newline;?/gi, '\n')
 .replace(/\\n/g, '\n')
 .replace(/<br\s*\/?>/gi, '\n')
 .replace(/<\/(p|li|h1|h2|h3|h4|div)>/gi, '\n')
 .replace(/<[^>]+>/g, ' ')
 .replace(/&[a-z]{2,20};?/gi, ' ')
 .replace(/\u00a0/g, ' ')
 .replace(/\r/g, '\n')
 .replace(/[ \t]+/g, ' ')
 .replace(/([^#\n])\s*##+\s*/g, '$1\n## ')
 .replace(/(^|\n)\s*#\s+/g, '$1## ')
 .replace(/\s+[•·▪◦]\s+/g, '\n- ')
 .replace(/\s+-\s+(?=[A-ZÀ-ÖÙ-Ü])/g, '\n- ')
 .replace(/;\s+(?=[A-ZÀ-ÖÙ-Ü])/g, ';\n')
 .trim();
 for (const rx of FALLBACK_NOISE_BLOCK_PATTERNS) {
 text = text.replace(rx, '');
 }
 text = fallbackSplitByInlineHeadings(text);
 text = fallbackSplitByInlineFieldLabels(text);
 text = text.replace(/\n{3,}/g, '\n\n');
 return text;
}

function fallbackSplitAtomicChunks(normalized: string): string[] {
 const chunks: string[] = [];
 const lines = String(normalized || '').split(/\n+/);
 for (const rawLine of lines) {
 const line = fallbackCleanSpaces(rawLine);
 if (!line || fallbackIsUiNoiseChunk(line)) continue;
 const sentenceChunks = line.split(/(?<=[.!?;])\s+(?=[A-ZÀ-ÖÙ-Ü])/g);
 for (const piece of sentenceChunks) {
 const atom = fallbackCleanSpaces(piece);
 if (!atom || fallbackIsUiNoiseChunk(atom)) continue;
 // Detect enumeration lists: 3+ ' - ' separators → split even on lowercase items
 // (handles Italian infinitive lists from public-administration job postings)
 const inlineDashParts = atom.split(/ - (?=[a-zA-ZÀ-ÖÙ-Üà-öù-ü])/);
 if (inlineDashParts.length >= 3) {
 const cleanedParts = inlineDashParts.map((x) => fallbackCleanSpaces(x)).filter(Boolean);
 const longParts = cleanedParts.filter((x) => x.length > 8);
 if (longParts.length >= 3) {
 // Emit ALL parts (including short heading words like "Compiti")
 // so downstream heading detection can categorize the section.
 for (const part of cleanedParts) {
 if (!fallbackIsUiNoiseChunk(part)) chunks.push(part);
 }
 continue;
 }
 }
 const splitByBullets = atom
 .split(/\s*(?:^|\s)(?:-\s+|•\s+|▪\s+|\*\s+)(?=[A-Z0-9À-ÖÙ-Ü])/g)
 .map((x) => fallbackCleanSpaces(x))
 .filter(Boolean);
 const splitByInfinitives = (splitByBullets.length > 0 ? splitByBullets : [atom]).flatMap((value) => {
 const candidate = fallbackCleanSpaces(value);
 if (candidate.length < 160) return [candidate];
 const parts = candidate
 .split(/\s+(?=(?:[A-ZÀ-ÖÙ-Ü][a-zà-öù-ü]{4,}(?:are|ere|ire)\b))/g)
 .map((x) => fallbackCleanSpaces(x))
 .filter(Boolean);
 return parts.length >= 2 ? parts : [candidate];
 });
 const splitByFieldLabels = splitByInfinitives.flatMap((value) => {
 return fallbackSplitInlineFieldItems(value);
 });
 for (const item of splitByFieldLabels) {
 if (!item || fallbackIsUiNoiseChunk(item)) continue;
 chunks.push(item);
 }
 }
 }
 return chunks;
}

function fallbackExtractContacts(fullText: string): { emails: string[]; phones: string[] } {
 const source = fallbackDecodeHtml(fullText || '');
 const emails = fallbackUniq(source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [], 8);
 const phones = fallbackUniq(source.match(/(?:\+41|0041|0)\s?\d{2}\s?\d{3}\s?\d{2}\s?\d{2}/g) || [], 8);
 return { emails, phones };
}

function fallbackNormalizeRequirementLine(line: string): string {
 let out = fallbackCleanSpaces(line)
 .replace(/^['"`]+|['"`]+$/g, '')
 .replace(/^#+\s*/, '')
 .replace(/^[-–—•*]+\s*/, '')
 .replace(/^[\],.;:!?)\s]+/, '')
 .replace(/&(?:amp;)?newline;?/gi, ' ')
 .replace(/&[a-z]{2,20};?/gi, ' ');
 if (/^i\s*\(/i.test(out)) out = out.replace(/^i\s*/i, '');
 out = out.replace(/\s*\.\.\.\s*$/g, '');
 return out.replace(/\s+/g, ' ').trim();
}

function fallbackIsGarbageChunk(line: string): boolean {
 const base = fallbackCleanSpaces(String(line || '').replace(/^[-–—•*]+/, ''));
 const normalized = fallbackNormalizeIdSource(base);
 if (!normalized) return true;
 if (/^(chiave|chiavi|key|keys|none|n d|n a|nd|na|colo)$/.test(normalized)) return true;
 if (/^\?+$/.test(base) || /^(null|undefined|nan)$/i.test(base)) return true;
 if (/^\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{2}\/\d{4}$/.test(base)) return true;
 if (fallbackIsUiNoiseChunk(base)) return true;
 return normalized.length <= 1;
}

function fallbackScoreSectionHints(text: string, sectionId: FallbackSectionId): number {
 const normalized = fallbackNormalizeIdSource(text);
 const hints = FALLBACK_SECTION_HINTS[sectionId] || [];
 let score = 0;
 for (const hint of hints) {
 const token = fallbackNormalizeIdSource(hint);
 if (!token) continue;
 if (normalized.includes(token)) score += token.length >= 10 ? 2 : 1;
 }
 return score;
}

function fallbackGuessSectionByContent(text: string, fallback: FallbackSectionId = 'overview'): { id: FallbackSectionId; score: number } {
 const raw = String(text || '');
 if (!raw.trim()) return { id: fallback, score: 0 };
 if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(raw) || /(?:\+41|0041|0)\s?\d{2}\s?\d{3}\s?\d{2}\s?\d{2}/.test(raw)) {
 return { id: 'contacts', score: 99 };
 }
 const direct = fallbackDetectHeading(raw);
 if (direct) return { id: direct, score: 90 };
 let best: { id: FallbackSectionId; score: number } = { id: fallback, score: 0 };
 for (const id of FALLBACK_SECTION_ORDER) {
 const score = fallbackScoreSectionHints(raw, id);
 if (score > best.score) best = { id, score };
 }
 return best;
}

function fallbackRepairSectionItems(items: string[], sectionId: FallbackSectionId, overflow: string[]): string[] {
 const out: string[] = [];
 for (const raw of items || []) {
 for (const splitRaw of fallbackSplitInlineFieldItems(raw)) {
 let item = fallbackNormalizeRequirementLine(splitRaw);
 if (!item) continue;
 if (fallbackIsGarbageChunk(item)) {
 overflow.push(item);
 continue;
 }
 if (/^di\s+/i.test(item) && out.length > 0) {
 const prev = out[out.length - 1];
 if (/(requisiti|criteri|condizioni|ordine|profilo|idoneita|eleggibilita)$/i.test(prev) || prev.length <= 45) {
 out[out.length - 1] = `${prev} ${item}`.replace(/\s+/g, ' ').trim();
 continue;
 }
 }
 if (item.length <= 14 && out.length > 0 && /^(requirements|application|details)$/.test(sectionId)) {
 const prev = out[out.length - 1];
 if (prev.length <= 120 && !/[.!?]$/.test(prev)) {
 out[out.length - 1] = `${prev} ${item}`.replace(/\s+/g, ' ').trim();
 continue;
 }
 }
 if (FALLBACK_FRAGMENT_START_RE.test(item) && out.length > 0 && item.length <= 72) {
 out[out.length - 1] = `${out[out.length - 1]} ${item}`.replace(/\s+/g, ' ').trim();
 continue;
 }
 if (/^[a-zà-öù-ü][^.!?]{1,90}$/i.test(item) && out.length > 0 && item.length <= 42) {
 out[out.length - 1] = `${out[out.length - 1]} ${item}`.replace(/\s+/g, ' ').trim();
 continue;
 }
 out.push(item);
 }
 }
 return fallbackUniq(out, 150);
}

function fallbackNormalizeRequirementSubheading(line: string): string {
 const item = fallbackCleanSpaces(String(line || ''));
 if (!item) return item;
 if (/^requisiti necessari\b/i.test(item)) return 'Requisiti necessari';
 if (/^requisiti auspicati\b/i.test(item)) return 'Requisiti auspicati';
 if (/^requisiti preferenziali\b/i.test(item)) return 'Requisiti preferenziali';
 if (/^required\b/i.test(item)) return 'Required';
 if (/^preferred\b/i.test(item)) return 'Preferred';
 return item;
}

function fallbackExplodeDenseItem(item: string, sectionId: FallbackSectionId): string[] {
 const clean = fallbackCleanSpaces(item);
 if (!clean || clean.length < 210) return [clean];
 const canExplode = /^(overview|details|company|requirements|responsibilities)$/.test(sectionId);
 if (!canExplode) return [clean];
 const bySemi = clean.split(/;\s+(?=[A-ZÀ-ÖÙ-Üa-zà-öù-ü])/g).map((x) => fallbackCleanSpaces(x)).filter(Boolean);
 if (bySemi.length >= 3) return bySemi;
 const bySent = clean.split(/(?<=[.!?])\s+(?=[A-ZÀ-ÖÙ-Ü])/g).map((x) => fallbackCleanSpaces(x)).filter(Boolean);
 if (bySent.length >= 3) return bySent;
 return [clean];
}

function fallbackRouteByPass3Rules(item: string, currentId: FallbackSectionId): FallbackSectionId {
 const line = String(item || '');
 const guessed = fallbackGuessSectionByContent(line, currentId);
 let best: { id: FallbackSectionId; score: number } = { id: currentId, score: guessed.id === currentId ? guessed.score : 0 };
 for (const rule of FALLBACK_PASS3_ROUTE_RULES) {
 if (rule.re.test(line)) {
 const base = 6 + fallbackScoreSectionHints(line, rule.id);
 if (base > best.score) best = { id: rule.id, score: base };
 }
 }
 if (guessed.id !== currentId && guessed.score >= 4 && guessed.score > best.score) best = guessed;
 return best.id;
}

function fallbackThirdPassAiStyle(sectionMap: Record<FallbackSectionId, string[]>, normalizedRaw: string): { sections: Record<FallbackSectionId, string[]>; moved: number; split: number; reconciled: number } {
 const out = {} as Record<FallbackSectionId, string[]>;
 for (const id of FALLBACK_SECTION_ORDER) out[id] = [];
 let moved = 0;
 let split = 0;

 for (const id of FALLBACK_SECTION_ORDER) {
 const sourceItems = sectionMap[id] || [];
 for (const raw of sourceItems) {
 const item = fallbackNormalizeRequirementSubheading(fallbackNormalizeRequirementLine(raw));
 if (!item || fallbackIsGarbageChunk(item)) continue;
 const exploded = fallbackExplodeDenseItem(item, id);
 if (exploded.length > 1) split += exploded.length - 1;
 for (const part of exploded) {
 let clean = fallbackNormalizeRequirementSubheading(fallbackNormalizeRequirementLine(part));
 if (!clean || fallbackIsGarbageChunk(clean)) continue;
 clean = clean
 .replace(/^#\s*/g, '')
 .replace(/^(?:compiti|mansioni principali)\s*:\s*/i, '')
 .replace(/^(?:come candidarsi|contatti)\s*:\s*/i, '');
 if (!clean) continue;
 const target = fallbackRouteByPass3Rules(clean, id);
 if (target !== id) moved += 1;
 out[target].push(clean);
 }
 }
 }

 const represented = new Set<string>();
 for (const id of FALLBACK_SECTION_ORDER) {
 for (const item of out[id]) {
 const key = fallbackNormalizeIdSource(item);
 if (key.length >= 14) represented.add(key);
 }
 }

 let reconciled = 0;
 const rawChunks = fallbackSplitAtomicChunks(normalizedRaw || '');
 for (const raw of rawChunks) {
 const clean = fallbackNormalizeRequirementSubheading(fallbackNormalizeRequirementLine(raw));
 if (!clean || fallbackIsGarbageChunk(clean)) continue;
 const key = fallbackNormalizeIdSource(clean);
 if (key.length < 18) continue;
 if (!represented.has(key)) {
 out.details.push(clean);
 represented.add(key);
 reconciled += 1;
 }
 }

 for (const id of FALLBACK_SECTION_ORDER) {
 out[id] = fallbackRepairSectionItems(out[id], id, out.details);
 if (id === 'requirements') out[id] = out[id].map(fallbackNormalizeRequirementSubheading);
 out[id] = fallbackUniq(out[id], 260);
 }
 return { sections: out, moved, split, reconciled };
}

function fallbackBuildResidualNotes(normalizedRaw: string, sectionMap: Record<FallbackSectionId, string[]>): string[] {
 const represented = new Set<string>();
 for (const id of FALLBACK_SECTION_ORDER) {
 if (id === 'notes') continue;
 for (const item of sectionMap[id] || []) {
 const key = fallbackNormalizeIdSource(item);
 if (key.length >= 10) represented.add(key);
 }
 }
 const leftovers: string[] = [];
 const rawChunks = fallbackSplitAtomicChunks(normalizedRaw || '');
 for (const raw of rawChunks) {
 const clean = fallbackNormalizeRequirementSubheading(fallbackNormalizeRequirementLine(raw));
 if (!clean || fallbackIsUiNoiseChunk(clean)) continue;
 const key = fallbackNormalizeIdSource(clean);
 if (key.length < 10) continue;
 if (!represented.has(key)) {
 leftovers.push(clean);
 represented.add(key);
 }
 }
 return fallbackUniq(leftovers, 400);
}

function canonicalizeFallbackRaw(description: string, requirements: string[]): {
 sections: Record<FallbackSectionId, string[]>;
 metrics: { coverage: number };
} {
 const normalized = fallbackNormalizeRaw(description || '');
 const chunks = fallbackSplitAtomicChunks(normalized);
 const sections = {} as Record<FallbackSectionId, string[]>;
 for (const id of FALLBACK_SECTION_ORDER) sections[id] = [];
 const overflow: string[] = [];
 let current: FallbackSectionId = 'overview';
 const originalCount = chunks.length;
 let assignedCount = 0;

 for (const rawChunk of chunks) {
 let chunk = fallbackCleanSpaces(rawChunk);
 if (!chunk) continue;
 const headingIdFromChunk = fallbackDetectHeading(chunk);
 if (headingIdFromChunk) {
 current = headingIdFromChunk;
 const body = fallbackNormalizeRequirementLine(fallbackRemoveHeadingPrefix(chunk, headingIdFromChunk));
 if (body) {
 sections[current].push(body);
 assignedCount += 1;
 }
 continue;
 }
 if (/^[A-ZÀ-ÖÙ-Ü][^.!?]{2,65}:$/.test(chunk)) {
 const direct = fallbackDetectHeading(chunk.replace(/:$/, ''));
 if (direct) {
 current = direct;
 continue;
 }
 }
 chunk = fallbackNormalizeRequirementLine(chunk);
 if (!chunk) continue;
 if (fallbackIsGarbageChunk(chunk)) {
 overflow.push(chunk);
 continue;
 }
 const guessed = fallbackGuessSectionByContent(chunk, current);
 if (guessed.score >= 2) current = guessed.id;
 sections[current].push(chunk);
 assignedCount += 1;
 }

 const reqLines = requirements
 .map((x) => fallbackNormalizeRequirementLine(x))
 .filter(Boolean);
 sections.requirements = fallbackUniq([...sections.requirements, ...reqLines], 120);

 for (const id of FALLBACK_SECTION_ORDER) {
 sections[id] = fallbackRepairSectionItems(
 sections[id].map((x) => fallbackNormalizeRequirementLine(x)).filter(Boolean),
 id,
 overflow
 );
 }

 const movedMap = {} as Record<FallbackSectionId, string[]>;
 for (const id of FALLBACK_SECTION_ORDER) movedMap[id] = [];
 for (const id of FALLBACK_SECTION_ORDER) {
 for (const item of sections[id]) {
 const guessed = fallbackGuessSectionByContent(item, id);
 const moveThreshold = guessed.id === 'contacts' ? 6 : 3;
 if (guessed.id !== id && guessed.score >= moveThreshold) movedMap[guessed.id].push(item);
 else movedMap[id].push(item);
 }
 }
 for (const id of FALLBACK_SECTION_ORDER) sections[id] = fallbackUniq(movedMap[id], 200);

 const cleanedOverflow = fallbackUniq(
 overflow.map((x) => fallbackNormalizeRequirementLine(x)).filter((x) => x && !fallbackIsGarbageChunk(x)),
 80
 );
 if (cleanedOverflow.length > 0) {
 sections.details = fallbackUniq([...sections.details, ...cleanedOverflow], 200);
 }

 const pass3 = fallbackThirdPassAiStyle(sections, normalized);
 for (const id of FALLBACK_SECTION_ORDER) sections[id] = fallbackUniq(pass3.sections[id] || [], 260);

 const contacts = fallbackExtractContacts(`${normalized}\n${requirements.join('\n')}`);
 if (contacts.phones.length > 0) {
 for (const phone of contacts.phones) {
 if (!sections.contacts.some((x) => x.includes(phone))) sections.contacts.push(`Telefono: ${phone}`);
 }
 }
 if (contacts.emails.length > 0) {
 for (const email of contacts.emails) {
 if (!sections.contacts.some((x) => x.includes(email))) sections.contacts.push(`Email: ${email}`);
 }
 }

 const residualNotes = fallbackBuildResidualNotes(normalized, sections);
 if (residualNotes.length > 0) {
 sections.notes = fallbackUniq([...(sections.notes || []), ...residualNotes], 400);
 }

 const coverage = originalCount > 0 ? Math.min(100, Math.round((assignedCount / originalCount) * 100)) : 100;
 return { sections, metrics: { coverage } };
}

function localizedExtraSectionHeading(id: FallbackSectionId, locale: Locale): string {
 const map: Record<'it' | 'en' | 'de' | 'fr', Partial<Record<FallbackSectionId, string>>> = {
 it: {
 contacts: 'Contatti',
 company: 'Azienda e contesto',
 details: 'Dettagli ulteriori',
 notes: 'Note e contenuto originale',
 },
 en: {
 contacts: 'Contacts',
 company: 'Company and context',
 details: 'Additional details',
 notes: 'Notes and original content',
 },
 de: {
 contacts: 'Kontakte',
 company: 'Unternehmen und Kontext',
 details: 'Weitere Details',
 notes: 'Notizen und Originalinhalt',
 },
 fr: {
 contacts: 'Contacts',
 company: 'Entreprise et contexte',
 details: 'Détails supplémentaires',
 notes: 'Notes et contenu original',
 },
 };
 const key = (locale in map ? locale : 'it') as 'it' | 'en' | 'de' | 'fr';
 return map[key][id] || FALLBACK_HEADING_MAP.find((h) => h.id === id)?.title || 'Dettagli';
}

export function buildFallbackCanonicalContent(description: string, requirements: string[], locale: Locale): CanonicalLocaleContent {
 const parsed = canonicalizeFallbackRaw(description, requirements);
 const summary = cleanCanonicalItems(parsed.sections.overview, 3);
 const responsibilities = cleanCanonicalItems(parsed.sections.responsibilities, 12);
 const parsedRequirements = cleanCanonicalItems(parsed.sections.requirements, 12);
 const mergedRequirements = parsedRequirements.length > 0
 ? parsedRequirements
 : cleanCanonicalItems(requirements, 12);
 const benefits = cleanCanonicalItems(parsed.sections.benefits, 10);
 const process = cleanCanonicalItems(parsed.sections.application, 8);
 const sections: CanonicalLocaleContent['sections'] = [];
 for (const id of (['contacts', 'company', 'details', 'notes'] as const)) {
 const items = cleanCanonicalItems(parsed.sections[id], id === 'notes' ? 24 : 12);
 if (items.length === 0) continue;
 sections.push({
 id,
 heading: localizedExtraSectionHeading(id, locale),
 paragraphs: [],
 bullets: items,
 });
 }
 const compact = String(description || '').replace(/\s+/g, ' ').trim();
 const wordCount = compact ? compact.split(/\s+/).length : 0;
 const highlights = cleanCanonicalItems([
 ...summary.slice(0, 2),
 ...responsibilities.slice(0, 2),
 ...mergedRequirements.slice(0, 2),
 ...benefits.slice(0, 2),
 ], 8);
 return {
 summary,
 sections,
 responsibilities,
 requirements: mergedRequirements,
 benefits,
 process,
 highlights,
 keywords: [],
 readingMinutes: Math.max(1, Math.round(Math.max(1, wordCount) / 180)),
 };
}

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

function normalizeCompanyKey(value: string): string {
 return String(value || '')
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9]+/g, ' ')
 .trim();
}

function slugifyCompany(value: string): string {
 return normalizeCompanyKey(value).replace(/\s+/g, '-').trim();
}

function canonicalCompanyRouteSlug(company: string, companyKey?: string): string {
 const keyNorm = normalizeCompanyKey(String(companyKey || ''));
 const companyNorm = normalizeCompanyKey(String(company || ''));
 if (keyNorm.includes('lidl') || companyNorm.includes('lidl')) return 'lidl';
 return slugifyCompany(company);
}

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
 // Check legacy slug aliases (renamed active jobs) — both flat and locale-aware
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

function buildListingDedupKey(job: JobListing): string {
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

function dedupeJobsForListing(jobs: JobListing[]): JobListing[] {
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

function queryMatchesJob(job: JobListing, query: string, locale: Locale): boolean {
 const queryTokens = normalizeSearchText(query).split(' ').filter(Boolean);
 if (queryTokens.length === 0) return true;
 const description = job.descriptionByLocale?.[locale] ?? job.description;
 const localizedTitle = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title);
 const haystack = normalizeSearchText(`${localizedTitle} ${job.company} ${job.location} ${description}`);
 return queryTokens.every((token) => haystack.includes(token));
}

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
}
const JobCard = React.memo(({ job, jobHref, salary, logo, isNew, postedLabel, locale, t, onSelect }: JobCardProps) => (
 <article
 key={job.id}
 className={`rounded-xl border p-3 sm:p-4 transition-colors min-h-[72px] ${
 job.featured
 ? 'border-warning-border bg-warning-subtle hover:border-warning'
 : 'border-edge bg-surface/50 hover:border-accent-border'
 }`}
 >
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
 <div className="min-w-0 flex-1">
 <h2 className="text-sm sm:text-base font-bold font-display text-heading leading-tight">
 {sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title)}
 {job.featured && <Star className="inline-block w-3.5 h-3.5 ml-1.5 text-warning fill-warning" />}
 {isNew && (
 <span className="ml-1.5 sm:ml-2 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide rounded-full bg-success-subtle text-success">
 <Sparkles className="w-2.5 h-2.5" />
 {t('jobBoard.badge.new')}
 </span>
 )}
 </h2>
 <p className="text-xs sm:text-sm text-subtle mt-0.5 line-clamp-2">
 {job.company} · {isMultiLocation(job.location) ? t('jobBoard.location.multiLocation') : `${job.location} (${job.canton})`}
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
}) => {
 const { t } = useTranslation();
 const [locale] = useLocale();
 const nav = useNavigation();
 const pageSize = 10;
 // Runtime kill-switches for the "Strumenti correlati" sidebar cross-links.
 // Toggle via Firebase Remote Config — each `<li>` respects its own flag.
 const killSwitches = useKillSwitches();

 const [jobs, setJobs] = useState<JobListing[]>([]);
 const [jobsLoading, setJobsLoading] = useState(true);
 const [enrichmentLoading, setEnrichmentLoading] = useState(false);
 // FRO-353: Feature flag for Job Alerts (controlled via Firebase Remote Config)
 const [enableJobAlerts, setEnableJobAlerts] = useState(false);
 useEffect(() => {
 import('@/services/firebase').then(({ getConfigValue }) =>
 getConfigValue('ENABLE_JOB_ALERTS').then((v) => setEnableJobAlerts(v === 'true'))
 ).catch(() => {});
 }, []);
 // Post-auth prompt: when the user goes from unauthenticated → authenticated
 // and they were actively searching, invite them to also create an alert.
 // Session-scoped dismissal to avoid nagging.
 const [postAuthPromptVisible, setPostAuthPromptVisible] = useState(false);
 // Job-detail alert prompt: gentle 1-tap subscription when a logged-in user
 // opens a single job detail. Independent from postAuthPromptVisible.
 const [jobDetailPromptVisible, setJobDetailPromptVisible] = useState(false);
 const [jobDetailPromptCategory, setJobDetailPromptCategory] = useState<string | null>(null);
 const prevAuthUserRef = useRef<typeof authUser>(authUser);
 useEffect(() => {
 isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {});
 }, []);
 const [searchQuery, setSearchQuery] = useState(() => parseSearchSlugFilter(initialJobSlug) || readSearchQueryFromUrl());
 const deferredSearchQuery = useDeferredValue(searchQuery);
 useEffect(() => {
 const prev = prevAuthUserRef.current;
 prevAuthUserRef.current = authUser;
 if (prev || !authUser || !enableJobAlerts) return;
 if (sessionStorage.getItem('jobAlertPostAuthPromptDismissed') === '1') return;
 const q = (searchQuery || '').trim();
 if (q.length < 2) return;
 setPostAuthPromptVisible(true);
 }, [authUser, enableJobAlerts, searchQuery]);
 const [selectedCategory, setSelectedCategory] = useState<JobCategory | 'all'>('all');
 const [selectedContract, setSelectedContract] = useState<ContractType | 'all'>('all');
 const [selectedCompany, setSelectedCompany] = useState<string>('all');
 const [selectedDateRange, setSelectedDateRange] = useState<DateRange>('all');
 const [selectedLocation, setSelectedLocation] = useState<string>('all');
 const [selectedSector, setSelectedSector] = useState<string>('all');
 const [showNewOnly, setShowNewOnly] = useState(false);
 const [filtersExpanded, setFiltersExpanded] = useState(false);
 const searchInputRef = useRef<HTMLInputElement>(null);
 const [linkedInAvailable, setLinkedInAvailable] = useState(false);
 const modalGoogleButtonRef = useRef<HTMLDivElement | null>(null);
 const inlineGoogleButtonRef = useRef<HTMLDivElement | null>(null);
 const authUnlockCandidateRef = useRef<string | null>(null);
 const wasLoggedInRef = useRef(isLoggedIn);

 // ── Personalization: behavior data + derived state ──
 const [behaviorData, setBehaviorData] = useState<BehaviorData | null>(null);
 const [newJobsDismissed, setNewJobsDismissed] = useState(false);
 const popularity = popularityData as Record<string, number>;

 // Load behavior data on mount and update last visit
 useEffect(() => {
 if (!enablePersonalization) return;
 const data = getBehaviorData();
 setBehaviorData(data);
 updateLastVisit();
 }, [enablePersonalization]);

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
 const newJobsInfo = useMemo(() => {
 if (!enablePersonalization || !behaviorData) return { total: 0, matching: 0 };
 const lastVisit = getLastVisitTimestamp();
 return computeNewJobsCount(jobs, lastVisit, behaviorData, userProfile ?? null);
 }, [enablePersonalization, behaviorData, jobs, userProfile]);

 // Trending jobs for user's location
 const userLocation = userProfile?.municipality ?? null;
 const trendingJobs = useMemo(() => {
 if (!enablePersonalization) return [];
 return getTrendingByLocation(jobs, popularity, userLocation);
 }, [enablePersonalization, jobs, popularity, userLocation]);

 // Whether personalization is actively changing sort order (any job scored > 0)
 const isPersonalizationActive = useMemo(() => {
 if (!enablePersonalization || !behaviorData) return false;
 return jobs.some((j) => computePersonalScore(j, behaviorData, userProfile ?? null).score > 0);
 }, [enablePersonalization, behaviorData, jobs, userProfile]);

 // Analytics: track personalization state
 useEffect(() => {
 if (!enablePersonalization || !behaviorData) return;
 if (isPersonalizationActive) {
 Analytics.trackSelectContent('personalization_active', 'job_board');
 } else if (behaviorData.viewedJobs.length === 0 && behaviorData.searches.length === 0) {
 Analytics.trackSelectContent('personalization_cold_start', 'job_board');
 }
 }, [enablePersonalization, isPersonalizationActive, behaviorData]);

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
 setSearchQuery(initialFilterParams.query);
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
 return count;
 }, [searchQuery, selectedCategory, selectedContract, selectedCompany, selectedDateRange, selectedLocation, selectedSector, showNewOnly]);

 const resetAllFilters = useCallback(() => {
 setSearchQuery('');
 setSelectedCategory('all');
 setSelectedContract('all');
 setSelectedCompany('all');
 setSelectedDateRange('all');
 setSelectedLocation('all');
 setSelectedSector('all');
 setShowNewOnly(false);
 }, []);
 const [page, setPage] = useState(() => readPageFromUrl());
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
 const isCrawlerVisitor = useMemo(
 () =>
 /bot|crawler|spider|crawling|googlebot|bingbot|yandexbot|duckduckbot|baiduspider|semrushbot|ahrefsbot|applebot|slurp|facebookexternalhit|linkedinbot|twitterbot|whatsapp/i.test(
 navigator.userAgent || ''
 ),
 []
 );
 const authResolved = !authLoading;
 const hasAccess = isLoggedIn || emailAccessGranted || isCrawlerVisitor;
 const companySlugFilter = useMemo(() => {
  const filter = parseCompanySlugFilter(initialJobSlug, jobs);
  if (!filter) return null;
  // If the build plugin seeded expired data specifically for this slug, the URL is
  // an expired job page — not a company filter page. This catches expired jobs whose
  // company name starts with "azienda-" etc. The slug-specific match prevents stale
  // window globals from a previous SPA navigation triggering a false positive.
  if (initialJobSlug && seededJobMatchesSlug(initialJobSlug)) return null;
  return filter;
 }, [initialJobSlug, jobs]);
 const locationSlugFilter = useMemo(() => parseLocationSlugFilter(initialJobSlug), [initialJobSlug]);
 const searchSlugFilter = useMemo(() => parseSearchSlugFilter(initialJobSlug), [initialJobSlug]);

 // Bridge detection: the plugin writes window.__BRIDGE_TARGET_SLUG__ in the static HTML for old URLs
 const bridgeTargetSlug = useMemo(
 () => (typeof window !== 'undefined' ? ((window as any).__BRIDGE_TARGET_SLUG__ as string | undefined) : undefined),
 [],
 );

 useEffect(() => {
 const syncFromUrl = () => {
 const next = parseSearchSlugFilter(initialJobSlug) || readSearchQueryFromUrl();
 setSearchQuery((prev) => (prev === next ? prev : next));
 setPage(readPageFromUrl());
 setAdRefreshKey((k) => k + 1);
 };
 window.addEventListener('popstate', syncFromUrl);
 return () => window.removeEventListener('popstate', syncFromUrl);
 }, [initialJobSlug]);

 useEffect(() => {
 const next = searchSlugFilter || readSearchQueryFromUrl();
 setSearchQuery((prev) => (prev === next ? prev : next));
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

 /** Top-N cantons fetched when no canton intent is detected (req #4). */
 const TOP_AGGREGATE_CANTONS: ReadonlyArray<string> = [
 'TI', 'GR', 'VS', 'ZH', 'BE', 'BS', 'GE', 'VD',
 ];

 /** Legacy slim-index → locale → monolithic fallback (FRO-386). */
 const loadLegacyLocaleJobs = async (): Promise<JobListing[]> => {
 const slimIndexUrl = `/data/jobs-${locale}-index.json`;
 const localeUrl = `/data/jobs-${locale}.json`;
 try {
 const res = await fetch(slimIndexUrl);
 if (res.ok) return (await res.json()) as JobListing[];
 throw new Error(`slim index ${res.status}`);
 } catch {
 try {
 const res = await fetch(localeUrl);
 if (res.ok) return (await res.json()) as JobListing[];
 throw new Error(`locale jobs ${res.status}`);
 } catch {
 // Final fallback — monolithic, deprecated path.
 const all = (await fetchAllJobs()) as unknown as JobListing[];
 return Array.isArray(all) ? all : [];
 }
 }
 };

 const finalize = (raw: ReadonlyArray<JobListing>): void => {
 if (cancelled) return;
 const normalized = raw.map((job) => normalizeIncomingJob(job));
 const deduped = dedupeJobsForListing(normalized);
 setJobs(deduped);
 registerJobSlugMap(deduped);
 setJobsLoading(false);
 };

 const run = async (): Promise<void> => {
 try {
 const defaultCanton = getDefaultCantonForVisit();
 const shardJobs: RawJob[] =
 defaultCanton === AGGREGATE_CANTON_CODE
 ? await fetchAggregatedJobs(TOP_AGGREGATE_CANTONS, { deduplicate: true })
 : await fetchJobsForCanton(defaultCanton);

 // Shards not yet deployed (every shard 404'd / empty) → legacy loader.
 if (shardJobs.length === 0) {
 const legacy = await loadLegacyLocaleJobs();
 finalize(Array.isArray(legacy) ? legacy : []);
 return;
 }

 finalize(shardJobs as unknown as JobListing[]);
 } catch (err: unknown) {
 // Service-level failure → try legacy path before giving up.
 console.warn('Failed to load jobs from shards:', err);
 reportCaughtError(err, 'jobBoard.loadJobs.shards');
 try {
 const legacy = await loadLegacyLocaleJobs();
 finalize(Array.isArray(legacy) ? legacy : []);
 } catch (legacyErr: unknown) {
 console.warn('Legacy locale-jobs fallback also failed:', legacyErr);
 reportCaughtError(legacyErr, 'jobBoard.loadJobs.legacy');
 if (!cancelled) setJobsLoading(false);
 }
 }
 };

 void run();
 return () => {
 cancelled = true;
 };
 }, [locale]);

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
 const counts = new Map<string, number>();
 for (const job of jobs) {
 const loc = (job.addressLocality || '').trim();
 if (loc && loc.length > 2) {
 const key = loc.toLowerCase();
 counts.set(key, (counts.get(key) || 0) + 1);
 }
 }
 // Sort by frequency descending so the most common cities appear first
 return Array.from(counts.entries())
 .sort((a, b) => b[1] - a[1])
 .map(([key]) => {
 // Find original casing from any job
 const job = jobs.find(j => (j.addressLocality || '').toLowerCase() === key);
 return job?.addressLocality || key;
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

 const selectedJob = useMemo(() => {
 if (companySlugFilter || locationSlugFilter || searchSlugFilter || editorialLandingDescriptor) return null;
 if (!initialJobSlug) return null;
 // When navigating via a previousSlug (bridge), use the current slug for job lookup
 const lookupSlug = bridgeTargetSlug || initialJobSlug;
 return jobs.find((j) => matchesRouteSlug(j, lookupSlug)) || null;
 }, [jobs, initialJobSlug, bridgeTargetSlug, companySlugFilter, locationSlugFilter, searchSlugFilter, editorialLandingDescriptor]);

 // FRO-detail-split: Lazily enrich slim job with per-job detail data (~15KB)
 // instead of fetching the full locale file (~11MB). Merges detail fields into
 // the jobs state so selectedJob recomputes with complete data automatically.
 const selectedJobId = selectedJob?.id ?? null;
 useEffect(() => {
 if (!selectedJobId) return;
 setEnrichmentLoading(true);
 fetchJobDetail(selectedJobId).then((detail) => {
 if (Object.keys(detail).length === 0) return;
 setJobs((prev) => prev.map((j) => (j.id === selectedJobId ? { ...j, ...detail } : j)));
 }).catch(() => {
 // Silently ignore — slim data already shown, detail enrichment is best-effort
 }).finally(() => {
 setEnrichmentLoading(false);
 });
 }, [selectedJobId]);

 // Job-detail alert prompt — gating + 4 s reveal timer.
 // Trigger: single-job-detail view, logged-in user with email, feature flag on,
 // localStorage gating allows it, AND no existing alert covers this category.
 const isJobDetailView = selectedJob !== null;
 const userEmail = authUser?.email || null;
 const userId = authUser?.uid || null;
 useEffect(() => {
 if (!isJobDetailView || !selectedJob) return;
 if (!enableJobAlerts || !userId || !userEmail) return;
 const categoryKey = categoryTranslationKey(selectedJob);
 const localizedCategory = (t(categoryKey) || '').trim();
 if (!localizedCategory) return;

 let cancelled = false;
 let timerId: number | null = null;

 (async () => {
 const [{ loadGatingState, markShownThisSession, shouldShowPrompt }, { getUserAlerts, findMatchingAlertForCategory, normalizeKeyword }] = await Promise.all([
 import('@/services/jobDetailAlertGating'),
 import('@/services/jobAlertService'),
 ]);
 if (cancelled) return;

 const state = loadGatingState();
 const normalized = normalizeKeyword(localizedCategory);
 if (!shouldShowPrompt(state, new Date(), normalized)) return;

 let existing: Awaited<ReturnType<typeof getUserAlerts>>;
 try {
 existing = await getUserAlerts(userId);
 } catch {
 // Fail closed — never badger users on a degraded network.
 return;
 }
 if (cancelled) return;
 if (findMatchingAlertForCategory(existing, localizedCategory)) return;

 timerId = window.setTimeout(() => {
 if (cancelled) return;
 markShownThisSession();
 setJobDetailPromptCategory(localizedCategory);
 setJobDetailPromptVisible(true);
 Analytics.trackJobAlertCtaClick('job_detail_prompt', 'shown', localizedCategory);
 }, 4000);
 })();

 return () => {
 cancelled = true;
 if (timerId !== null) window.clearTimeout(timerId);
 };
 }, [isJobDetailView, selectedJob, enableJobAlerts, userId, userEmail, t]);

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

 const shouldPersonalize = enablePersonalization && behaviorData;

 const withMeta = swissJobs.map(j => ({
 job: j,
 rank: cantonRank(j),
 day: dayTs(j.crawledAt || j.postedDate),
 qs: j.qualityScore ?? 0,
 personal: shouldPersonalize
 ? computePersonalScore(j, behaviorData, userProfile ?? null)
 : { score: 0, topSignal: '' },
 }));
 withMeta.sort((a, b) =>
 (b.personal.score - a.personal.score)
 || (a.rank - b.rank)
 || (b.day - a.day)
 || (b.qs - a.qs)
 );
 return withMeta.map(({ job }) => job);
 }, [jobs, enablePersonalization, behaviorData, userProfile]);

 // Pre-built search index: caches normalised haystack per job so
 // queryMatchesJob doesn't recompute expensive string normalisation on every keystroke.
 const [searchIndex, setSearchIndex] = useState<Map<JobListing, string>>(() => new Map());

 useEffect(() => {
 const map = new Map<JobListing, string>();
 let i = 0;
 const CHUNK_SIZE = 50;

 function processChunk() {
 const end = Math.min(i + CHUNK_SIZE, sortedJobs.length);
 for (; i < end; i++) {
 const job = sortedJobs[i];
 const description = job.descriptionByLocale?.[locale] ?? job.description;
 const localizedTitle = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title);
 // Stemmed + space-padded haystack so query matching tolerates Italian
 // plural/feminine variants (pulizie ↔ pulizia, infermieri ↔ infermiera)
 // while still requiring word-boundary alignment (cas ≠ cassa).
 map.set(job, buildStemmedHaystack(`${localizedTitle} ${job.company} ${job.location} ${job.contract} ${job.category} ${job.sector || ''} ${description}`));
 }
 if (i < sortedJobs.length) {
 requestAnimationFrame(processChunk);
 } else {
 setSearchIndex(map);
 }
 }

 if (sortedJobs.length > 0) {
 requestAnimationFrame(processChunk);
 }

 return () => { i = sortedJobs.length; };
 }, [sortedJobs, locale]);

 // Fast query match using pre-built index — avoids re-normalising haystacks.
 const indexedQueryMatch = useCallback(
 (job: JobListing, query: string): boolean => {
 const queryTokens = normalizeSearchText(query).split(' ').filter(Boolean).map(stemSearchToken);
 if (queryTokens.length === 0) return true;
 const haystack = searchIndex.get(job) ?? '';
 // Each stemmed query token must match a whole haystack word
 // (haystack is wrapped in spaces, words are stemmed → ' infermier uffic ').
 // Trailing space prevents false positives: 'cas' must not match 'cassa'.
 return queryTokens.every((token) => haystack.includes(` ${token} `));
 },
 [searchIndex],
 );

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
 if (selectedCategory !== 'all' && job.category !== selectedCategory) return false;
 if (selectedContract !== 'all' && job.contract !== selectedContract) return false;
 if (selectedCompany !== 'all' && job.company.toLowerCase() !== selectedCompany) return false;
 if (selectedLocation !== 'all' && (job.addressLocality || '').toLowerCase() !== selectedLocation) return false;
 if (selectedSector !== 'all' && (job.sector || '').toLowerCase() !== selectedSector) return false;
 if (cutoff > 0) {
 const jobDate = new Date(job.crawledAt || job.postedDate).getTime();
 if (jobDate < cutoff) return false;
 }
 if (showNewOnly) {
 const jobTs = new Date(job.crawledAt || job.postedDate).getTime();
 if (now - jobTs >= 72 * 60 * 60 * 1000) return false;
 }
 return true;
 }, [companySlugFilter, locationSlugFilter, selectedCategory, selectedContract, selectedCompany, selectedLocation, selectedSector, showNewOnly]);

 // strictFilteredJobs: AND-match on every search token (current behavior).
 // The OR-fallback layer below kicks in when this is empty for a
 // multi-token query — typical for slug-driven URLs like
 // /cerca-lavoro-ticino/ricerca-koch-davos/ where no job has BOTH "koch"
 // and "davos" but many have one of the two.
 const strictFilteredJobs = useMemo(() => {
 const now = Date.now();
 const dateRangeMs: Record<DateRange, number> = {
 all: 0,
 '24h': 24 * 60 * 60 * 1000,
 '3d': 3 * 24 * 60 * 60 * 1000,
 '7d': 7 * 24 * 60 * 60 * 1000,
 '30d': 30 * 24 * 60 * 60 * 1000,
 '90d': 90 * 24 * 60 * 60 * 1000,
 };
 const cutoff = selectedDateRange === 'all' ? 0 : now - dateRangeMs[selectedDateRange];
 const query = deferredSearchQuery.trim();
 return sortedJobs.filter((job) => {
 if (!passingNonSearchFilters(job, now, cutoff)) return false;
 if (query) return indexedQueryMatch(job, query);
 return true;
 });
 }, [sortedJobs, selectedDateRange, deferredSearchQuery, indexedQueryMatch, passingNonSearchFilters]);

 // filteredJobs: strict-AND result, OR a partial-match fallback ranked by
 // how many tokens hit. Mirrors the build plugin's two-phase matching at
 // build/relatedSearchClustersPlugin.ts so users landing on a slug URL
 // see the SAME job set the static cluster page would show. Capped at
 // MAX_FALLBACK to keep the UI responsive even for high-frequency tokens.
 const MAX_FALLBACK_RESULTS = 30;
 const filteredJobs = useMemo(() => {
 const query = deferredSearchQuery.trim();
 if (!query || strictFilteredJobs.length > 0) return strictFilteredJobs;

 const queryTokens = normalizeSearchText(query).split(' ').filter(Boolean).map(stemSearchToken);
 if (queryTokens.length < 2) return strictFilteredJobs; // single token: AND === OR, nothing to add

 const now = Date.now();
 const dateRangeMs: Record<DateRange, number> = {
 all: 0, '24h': 24 * 60 * 60 * 1000, '3d': 3 * 24 * 60 * 60 * 1000,
 '7d': 7 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000, '90d': 90 * 24 * 60 * 60 * 1000,
 };
 const cutoff = selectedDateRange === 'all' ? 0 : now - dateRangeMs[selectedDateRange];

 const scored: { job: JobListing; score: number }[] = [];
 for (const job of sortedJobs) {
 if (!passingNonSearchFilters(job, now, cutoff)) continue;
 const haystack = searchIndex.get(job) ?? '';
 let score = 0;
 for (const t of queryTokens) {
 if (haystack.includes(` ${t} `)) score++;
 }
 if (score > 0) scored.push({ job, score });
 }
 scored.sort((a, b) => b.score - a.score);
 return scored.slice(0, MAX_FALLBACK_RESULTS).map((x) => x.job);
 }, [strictFilteredJobs, sortedJobs, deferredSearchQuery, searchIndex, selectedDateRange, passingNonSearchFilters]);

 // True when the result set is the OR-fallback (strict yielded zero but
 // we found partial matches). Used by the UI to render an explanatory
 // banner so users know why these jobs appear despite the query.
 const isUsingSearchFallback = useMemo(() => {
 return Boolean(deferredSearchQuery.trim()) && strictFilteredJobs.length === 0 && filteredJobs.length > 0;
 }, [deferredSearchQuery, strictFilteredJobs.length, filteredJobs.length]);

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
 }, [deferredSearchQuery, selectedCategory, selectedContract, selectedCompany, selectedDateRange, showNewOnly]);

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

 const relatedJobs = useMemo(() => {
 if (!selectedJob) return [];
 const withScore = sortedJobs
 .filter((j) => j.id !== selectedJob.id && j.slug)
 .map((j) => {
 let score = 0;
 if (j.category === selectedJob.category) score += 3;
 if (j.location === selectedJob.location) score += 2;
 if (j.company === selectedJob.company) score += 1;
 const freshness = new Date(j.crawledAt || j.postedDate).getTime();
 return { job: j, score, freshness };
 });
 return withScore
 .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.freshness - a.freshness))
 .slice(0, 6)
 .map((x) => x.job);
 }, [selectedJob, sortedJobs]);

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

 // Load blog meta translations + articles data for cross-linking (only when job selected)
 const [blogMetaReady, setBlogMetaReady] = useState(false);
 const [blogArticles, setBlogArticles] = useState<Article[]>([]);
 useEffect(() => {
 if (!selectedJob) return;
 Promise.all([
 loadBlogMeta(),
 import('@/data/blog-articles-data').then(m => m.ARTICLES),
 ]).then(([, data]) => {
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

 const CONTRACT_MAP: Record<string, string> = {
 'full-time': 'FULL_TIME',
 'part-time': 'PART_TIME',
 temporary: 'TEMPORARY',
 internship: 'INTERN',
 contract: 'CONTRACTOR',
 permanent: 'FULL_TIME',
 };

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
 return posted.toISOString();
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
 const logo = companyLogoUrl(job) || 'https://frontaliereticino.ch/icons/icon-512x512.png';
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
 employmentType: CONTRACT_MAP[normalizeJobContract(job.contract, localizedTitle, description)] || 'OTHER',
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
 applicantLocationRequirements: {
 '@type': 'Country',
 name: 'CH',
 },
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

 if (selectedJob || initialJobSlug) {
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
 ? `${companyDisplayName} — ${t('jobBoard.title')}`
 : selectedSector !== 'all'
 ? `${selectedSector} — ${t('jobBoard.title')}`
 : selectedLocation !== 'all'
 ? `${selectedLocation} — ${t('jobBoard.title')}`
 : t('jobBoard.title');

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
 }, [filteredJobs, locale, selectedJob, initialJobSlug, selectedSector, selectedLocation, companyDisplayName, t]);

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
 return buildPath({ activeTab: 'job-board' as any, ...(localizedSlug ? { jobSlug: localizedSlug } : {}) }, locale);
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
 const suffix = ' | Frontaliere Ticino';
 const sep = ' — ';
 const company = selectedJob.company;
 const candidate = `${localizedTitle}${sep}${company}${suffix}`;
 document.title = candidate.length <= 60 ? candidate : `${localizedTitle}${sep}${company}`.slice(0, 60);
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
 // Build title with cascading truncation to fit ~60 char SERP limit
 const suffix = ' | Frontaliere Ticino';
 const sep = ' — ';
 const company = selectedJob.company;
 let fullTitle: string;
 const candidate1 = `${localizedTitle}${sep}${company}${suffix}`;
 if (candidate1.length <= 60) {
 fullTitle = candidate1;
 } else {
 const candidate2 = `${localizedTitle}${sep}${company}`;
 if (candidate2.length <= 60) {
 fullTitle = candidate2;
 } else {
 // Truncate job title at word boundary to fit with company name
 const maxTitleLen = 60 - sep.length - company.length;
 if (maxTitleLen > 20) {
 const cut = localizedTitle.lastIndexOf(' ', maxTitleLen - 1);
 const truncated = cut > 15 ? localizedTitle.slice(0, cut) + '…' : localizedTitle.slice(0, maxTitleLen - 1) + '…';
 fullTitle = `${truncated}${sep}${company}`;
 } else {
 fullTitle = localizedTitle.length <= 60 ? localizedTitle : localizedTitle.slice(0, 57) + '…';
 }
 }
 }
 const descSnippet = String(localizedDescription || '').slice(0, 160);
 document.title = fullTitle;
 const metaDesc = document.querySelector('meta[name="description"]');
 if (metaDesc) {
 metaDesc.setAttribute('content', descSnippet);
 }

 // Set all OG tags so they stay consistent with the job detail page,
 // even if seoService.updateMetaTags runs later with generic fallbacks.
 const ogLocaleMap: Record<string, string> = { it: 'it_IT', en: 'en_US', de: 'de_CH', fr: 'fr_CH' };
 const setOg = (prop: string, val: string) => {
 let el = document.querySelector(`meta[property="${prop}"]`);
 if (!el) { el = document.createElement('meta'); el.setAttribute('property', prop); document.head.appendChild(el); }
 el.setAttribute('content', val);
 };
 setOg('og:title', fullTitle);
 setOg('og:description', descSnippet);
 setOg('og:url', canonicalHref);
 setOg('og:type', 'article');
 setOg('og:locale', ogLocaleMap[locale] || 'it_IT');
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
 document.title = `${editorialLandingModel.title} | Frontaliere Ticino`;
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
 void promptOneTap();
 }, [authResolved, authGateOpen, hasAccess]);

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
 onJobRouteChange?.(nextSlug);
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
 onJobRouteChange?.(redirectSlug);
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
 onJobRouteChange?.(deriveLocalizedJobSlug(job, locale));
 window.scrollTo({ top: 0, behavior: 'instant' });
 Analytics.trackSelectContent('job_board_open_detail', `${job.company}_${job.title}`);
 };

 const renderJobCard = (job: JobListing) => (
 <JobCard
 key={job.id}
 job={job}
 jobHref={buildJobPath(job)}
 salary={formatSalary(job)}
 logo={companyLogoUrl(job)}
 isNew={isNewJob(job)}
 postedLabel={daysSincePosted(job.postedDate)}
 locale={locale}
 t={t}
 onSelect={openDetail}
 />
 );

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
 onJobRouteChange?.(deriveLocalizedJobSlug(jobToOpen, locale));
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
 onJobRouteChange?.(deriveLocalizedJobSlug(jobToOpen, locale));
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
 if (job.url) window.open(buildReferralUrl(job.url, job), '_blank', 'noopener,noreferrer');
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
 setSearchQuery(keyword);
 onJobRouteChange?.(searchSlug);
 }, [locale, onJobRouteChange]);

 // ── Salary estimate widgets (frontaliere vs CH resident) ───────────────
 const [salaryEstimates, setSalaryEstimates] = useState<{
 salaryMin: number; salaryMax: number | null;
 frontaliere: { min: number; max: number | null };
 resident: { min: number; max: number | null };
 } | null>(null);
 useEffect(() => {
 if (!selectedJob) { setSalaryEstimates(null); return; }
 const minRaw = Number(selectedJob.salaryMin) || Number(selectedJob.baseSalary?.value?.minValue);
 const maxRaw = Number(selectedJob.salaryMax) || Number(selectedJob.baseSalary?.value?.maxValue);
 if (!minRaw || !Number.isFinite(minRaw)) { setSalaryEstimates(null); return; }
 const salaryMin = minRaw;
 const salaryMax = (maxRaw && Number.isFinite(maxRaw) && maxRaw > minRaw) ? maxRaw : null;
 let cancelled = false;
 import('@/services/calculationService').then(({ calculateSimulation }) => {
 if (cancelled) return;
 const run = (annual: number): SimulationResult | null => {
 try { return calculateSimulation({ ...DEFAULT_INPUTS, annualIncomeCHF: annual }); }
 catch { return null; }
 };
 const resMin = run(salaryMin);
 const resMax = salaryMax ? run(salaryMax) : null;
 if (!resMin) { setSalaryEstimates(null); return; }
 setSalaryEstimates({
 salaryMin, salaryMax,
 frontaliere: { min: Math.round(resMin.itResident.netIncomeMonthly), max: resMax ? Math.round(resMax.itResident.netIncomeMonthly) : null },
 resident: { min: Math.round(resMin.chResident.netIncomeMonthly), max: resMax ? Math.round(resMax.chResident.netIncomeMonthly) : null },
 });
 }).catch(() => setSalaryEstimates(null));
 return () => { cancelled = true; };
 }, [selectedJob]);

 const fmtNet = (v: number) => `CHF ${v.toLocaleString('de-CH')}`;

 const salaryCalcHref = salaryEstimates
 ? buildPath({ activeTab: 'calculator' }, locale) + `?reddito=${salaryEstimates.salaryMax || salaryEstimates.salaryMin}`
 : '';
 const goToCalc = (e: React.MouseEvent) => {
 e.preventDefault();
 // SPA navigation: push route + apply query string, avoid full page reload / 404 flash
 const reddito = salaryEstimates?.salaryMax || salaryEstimates?.salaryMin;
 nav.navigateTo('calculator');
 if (reddito) {
 const url = buildPath({ activeTab: 'calculator' }, locale) + `?reddito=${reddito}`;
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
 onClick={goToCalc}
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
 onClick={goToCalc}
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
 onClick={goToCalc}
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
 <span>{t('jobBoard.sectorContext.employees', { count: sectorContext.employeeCount.toLocaleString('de-CH'), ...getCantonI18nParams() })}</span>
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
 </form>
 </div>

 {authError && <p className="text-sm text-danger">{authError}</p>}
 </div>
 </div>
 ) : null;

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
 return (
 <div className="flex items-center justify-center py-20">
 <Loader2 className="w-9 h-9 text-accent animate-spin" />
 </div>
 );
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
 const citySlug = city.href.split('/').filter(Boolean).pop() || '';
 return (
 <a
 key={city.href}
 href={buildPath({ activeTab: 'job-board', jobSlug: citySlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(citySlug);
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
 {section.jobs.map((job) => renderJobCard(job))}
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
 );
 }

 if (editorialOfficialGazetteLanding) {
 return (
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
 href={slug ? buildPath({ activeTab: 'job-board', jobSlug: slug }, locale) : buildPath({ activeTab: 'job-board' }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(slug || '');
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
 {section.jobs.map((job) => renderJobCard(job))}
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
 );
 }

 if (editorialNursesHubLanding) {
 return (
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
 const targetSlug = link.href.split('/').filter(Boolean).pop() || '';
 return (
 <a
 key={link.href}
 href={buildPath({ activeTab: 'job-board', jobSlug: targetSlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(targetSlug);
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
 {section.jobs.map((job) => renderJobCard(job))}
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
 );
 }

 if (editorialCareVariantLanding) {
 const parentSlug = editorialCareVariantLanding.parentHubHref.split('/').filter(Boolean).pop() || '';
 return (
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
 onJobRouteChange?.(parentSlug);
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
 const targetSlug = link.href.split('/').filter(Boolean).pop() || '';
 return (
 <a
 key={link.href}
 href={buildPath({ activeTab: 'job-board', jobSlug: targetSlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(targetSlug);
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
 {section.jobs.map((job) => renderJobCard(job))}
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
 );
 }

 if (editorialLocationLanding) {
 return (
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
 const targetSlug = link.href.split('/').filter(Boolean).pop() || '';
 return (
 <a
 key={link.href}
 href={buildPath({ activeTab: 'job-board', jobSlug: targetSlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(targetSlug);
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
 const targetSlug = link.href.split('/').filter(Boolean).pop() || '';
 return (
 <a
 key={link.href}
 href={buildPath({ activeTab: 'job-board', jobSlug: targetSlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(targetSlug);
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
 {section.jobs.map((job) => renderJobCard(job))}
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
 );
 }

 if (editorialLocationTypeLanding) {
 const parentSlug = editorialLocationTypeLanding.parentLocationHref.split('/').filter(Boolean).pop() || '';
 return (
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
 onJobRouteChange?.(parentSlug);
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
 const targetSlug = link.href.split('/').filter(Boolean).pop() || '';
 return (
 <a
 key={link.href}
 href={buildPath({ activeTab: 'job-board', jobSlug: targetSlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(targetSlug);
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
 {section.jobs.map((job) => renderJobCard(job))}
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
 );
 }

 if (editorialLocationSectorLanding) {
 const parentSlug = editorialLocationSectorLanding.parentLocationHref.split('/').filter(Boolean).pop() || '';
 return (
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
 onJobRouteChange?.(parentSlug);
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
 const targetSlug = link.href.split('/').filter(Boolean).pop() || '';
 return (
 <a
 key={link.href}
 href={buildPath({ activeTab: 'job-board', jobSlug: targetSlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(targetSlug);
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
 {section.jobs.map((job) => renderJobCard(job))}
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
 );
 }

 if (editorialSectorRegionLanding) {
 return (
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
 const targetSlug = link.href.split('/').filter(Boolean).pop() || '';
 return (
 <a
 key={link.href}
 href={buildPath({ activeTab: 'job-board', jobSlug: targetSlug }, locale)}
 onClick={(e) => {
 e.preventDefault();
 onJobRouteChange?.(targetSlug);
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
 {section.jobs.map((job) => renderJobCard(job))}
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
 onNavigateToJob={(slug) => { onJobRouteChange?.(slug); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
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
 onNavigateToJob={(slug) => { onJobRouteChange?.(slug); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
 />
 );
 }

 if (selectedJob) {
 if (!authResolved) {
 // Use a layout-matching skeleton instead of a tiny spinner to prevent CLS:
 // the spinner occupies ~80px but the full detail layout is 800-1200px,
 // causing a large measurable layout shift when auth resolves.
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
 const logoUrl = resolveCompanyLogoUrl(selectedJob);
 const descriptionPreview = String(
 selectedJob.descriptionByLocale?.[locale] ?? selectedJob.description ?? ''
 ).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
 const gateCompanySlug = buildCompanySearchSlug(selectedJob.company, selectedJob.companyKey, locale);
 const gateCompanyHref = buildPath({ activeTab: 'job-board' as any, jobSlug: gateCompanySlug }, locale);
 const gateLocationSlug = jobLocation ? buildLocationSearchSlug(selectedJob.addressLocality || jobLocation, locale) : '';
 const gateLocationHref = gateLocationSlug ? buildPath({ activeTab: 'job-board' as any, jobSlug: gateLocationSlug }, locale) : '';

 return (
 <div className="space-y-5">
 <button
 onClick={backToList}
 className="inline-flex items-center gap-2 min-h-[44px] text-sm font-semibold text-accent hover:underline"
 >
 <ArrowLeft size={14} />
 {t('jobBoard.backToList')}
 </button>

 {authPendingNoticeJsx}

 {/* Single-column gate body — desktop rails earned €0.06–0.10 RPM (FRO-2026-04-26 prune). */}
 <div className="space-y-4">

 {/* Job header — always visible */}
 <div className="rounded-stripe border border-edge bg-surface p-5">
 <div className="flex items-start gap-4">
 {logoUrl && (
 <img
 src={logoUrl}
 alt={companyName}
 width={48}
 height={48}
 className="w-12 h-12 rounded-lg object-contain bg-surface-alt flex-shrink-0"
 loading="lazy"
 onError={handleCompanyLogoError}
 />
 )}
 <div className="flex-1 min-w-0">
 <h1 className="text-xl font-bold font-display text-heading leading-tight">{localizedTitle}</h1>
 <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-sm text-subtle">
 <a
 href={gateCompanyHref}
 onClick={(e) => {
 e.preventDefault();
 setSearchQuery('');
 window.history.pushState({ route: { activeTab: 'job-board', jobSlug: gateCompanySlug } }, '', gateCompanyHref.split('?')[0]);
 window.dispatchEvent(new PopStateEvent('popstate'));
 window.scrollTo({ top: 0, behavior: 'smooth' });
 Analytics.trackSelectContent('job_board_company_filter_open', selectedJob.company);
 }}
 className="inline-flex items-center gap-1 hover:text-accent hover:underline underline-offset-2 transition-colors"
 ><Building2 size={14} />{companyName}</a>
 {jobLocation && gateLocationHref && (
 <a
 href={gateLocationHref}
 onClick={(e) => {
 e.preventDefault();
 setSearchQuery('');
 window.history.pushState({ route: { activeTab: 'job-board', jobSlug: gateLocationSlug } }, '', gateLocationHref.split('?')[0]);
 window.dispatchEvent(new PopStateEvent('popstate'));
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
 </div>
 {/* Readable description teaser — shows first ~200 chars to create information
 scent and an "open loop" that motivates signup. Fades out at the bottom. */}
 {descriptionPreview && (
 <div className="relative mt-3 w-full overflow-hidden rounded-stripe" style={{ maxHeight: 'clamp(0px, calc(100dvh - 540px), 80px)' }}>
 <p className="px-3 py-2 text-sm text-body leading-relaxed sm:py-3">
 {descriptionPreview}...
 </p>
 <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent" />
 </div>
 )}

 {/* Auth gate — embedded inline for all viewports (no extra click needed) */}
 <div id="job-auth-gate" role="region" aria-label={t('jobBoard.gate.title')} className="relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-accent-border bg-accent-subtle p-5 sm:p-6">
 <div className="flex items-center gap-3 mb-3">
 <div className="flex-shrink-0 p-2 bg-accent-subtle rounded-stripe">
 <Eye className="w-5 h-5 text-accent" />
 </div>
 <div>
 <h2 className="text-lg font-bold font-display text-heading">{t('jobBoard.gate.title')}</h2>
 <p className="text-sm text-subtle">{t('jobBoard.gate.subtitle')}</p>
 </div>
 </div>

 {/* Trust signals — above CTAs for mobile visibility */}
 <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-subtle">
 <span className="inline-flex items-center gap-1"><CheckCircle2 size={12} className="text-success" />{t('jobBoard.gate.benefit1')}</span>
 <span className="inline-flex items-center gap-1"><CheckCircle2 size={12} className="text-success" />{t('jobBoard.gate.benefit2')}</span>
 <span className="inline-flex items-center gap-1"><CheckCircle2 size={12} className="text-success" />{t('jobBoard.gate.benefit3')}</span>
 <span className="inline-flex items-center gap-1"><Shield size={12} className="text-success" />{t('jobBoard.gate.privacyNote')}</span>
 </div>

 {/* Social proof */}
 {jobs.length > 0 && (
 <p className="mb-3 text-xs font-medium text-accent">
 {jobs.length.toLocaleString()}+ {locale === 'it' ? 'annunci disponibili' : locale === 'de' ? 'verfügbare Stellenangebote' : locale === 'fr' ? 'offres disponibles' : 'listings available'}
 </p>
 )}

 <div className="space-y-3">
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
 <div className="flex items-center gap-3">
 <div className="flex-1 h-px bg-surface-raised/50" />
 <span className="text-sm text-muted">{t('jobBoard.authGateOrEmail')}</span>
 <div className="flex-1 h-px bg-surface-raised/50" />
 </div>
 <form
 onSubmit={(e) => {
 e.preventDefault();
 const ctx = buildJobTrackingContext(selectedJob);
 Analytics.trackJobAuthFunnel('auth_method_click', { method: 'email', ...ctx });
 void handleInlineEmailAccess(selectedJob);
 }}
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
 {t('jobBoard.gate.emailCta')}
 </button>
 </form>
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
 onClick={(e) => {
 e.preventDefault();
 setSearchQuery('');
 const canonicalCompanyPath = gateCompanyHref.split('?')[0];
 const currentPathWithSearch = `${window.location.pathname}${window.location.search}`;
 if (currentPathWithSearch !== canonicalCompanyPath) {
 window.history.pushState(
 { route: { activeTab: 'job-board', jobSlug: gateCompanySlug } },
 '',
 canonicalCompanyPath
 );
 window.dispatchEvent(new PopStateEvent('popstate'));
 }
 window.scrollTo({ top: 0, behavior: 'smooth' });
 Analytics.trackSelectContent('job_board_company_filter_open', selectedJob.company);
 }}
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
 {relatedJobs.map((job) => {
 const jobHref = buildJobPath(job);
 const jobLogo = companyLogoUrl(job);
 const jobSalary = formatSalary(job);
 return (
 <article
 key={job.id}
 className={`rounded-xl border p-3 sm:p-4 transition-colors min-h-[72px] ${
 job.featured
 ? 'border-warning-border bg-warning-subtle hover:border-warning'
 : 'border-edge bg-surface/50 hover:border-accent-border'
 }`}
 >
 <a
 href={jobHref}
 onClick={(e) => { e.preventDefault(); openDetail(job); }}
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
 {job.company} · {isMultiLocation(job.location) ? t('jobBoard.location.multiLocation') : `${job.location} (${job.canton})`}
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
 const timelineSections = [
 ...(canonicalContent.responsibilities.length > 0
 ? [{ id: 'responsibilities', heading: canonicalCopy.responsibilities, paragraphs: [], bullets: canonicalContent.responsibilities }]
 : []),
 ...(canonicalRequirements.length > 0
 ? [{ id: 'requirements', heading: canonicalCopy.requirements, paragraphs: [], bullets: canonicalRequirements }]
 : []),
 ...(canonicalContent.benefits.length > 0
 ? [{ id: 'benefits', heading: canonicalCopy.benefits, paragraphs: [], bullets: canonicalContent.benefits }]
 : []),
 ...(canonicalContent.process.length > 0
 ? [{ id: 'process', heading: canonicalCopy.process, paragraphs: [], bullets: canonicalContent.process }]
 : []),
 ...canonicalContactSections,
 ...canonicalResidualSections,
 ];
 const hybridLayoutEnabled = false;
 const applyUrl = buildReferralUrl(selectedJob.applyUrl || selectedJob.url || '', selectedJob);
 const detailPageUrl = `${PUBLIC_SITE_URL}${buildJobPath(selectedJob)}`;
 const companySearchSlug = buildCompanySearchSlug(selectedJob.company, selectedJob.companyKey, locale);
 const companySearchHref = buildPath({ activeTab: 'job-board' as any, jobSlug: companySearchSlug }, locale);
 const detailLocationSlug = buildLocationSearchSlug(selectedJob.addressLocality || selectedJob.location || '', locale);
 const detailLocationHref = detailLocationSlug ? buildPath({ activeTab: 'job-board' as any, jobSlug: detailLocationSlug }, locale) : '';
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

 <a
 className="hybrid-ab-cta"
 href={applyUrl}
 target="_blank"
 rel="nofollow noopener noreferrer"
 onClick={() => Analytics.trackSelectContent('job_board_apply', `${selectedJob.company}_${selectedJob.title}`)}
 >
 {t('jobBoard.apply')}
 </a>

 {salaryEstimateWidget && (
 <div className="mt-4">{salaryEstimateWidget}</div>
 )}
 {sectorContextWidget && (
 <div className="mt-3">{sectorContextWidget}</div>
 )}
 </article>
 </div>
 );
 }

 return (
 <div className="space-y-6">
 <button
 onClick={backToList}
 className="inline-flex items-center gap-2 min-h-[44px] text-sm font-semibold text-accent hover:underline"
 >
 <ArrowLeft size={14} />
 {t('jobBoard.backToList')}
 </button>

 {authPendingNoticeJsx}

 <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6">
 <article className="lg:col-span-8 space-y-4 sm:space-y-5">
 <header className="rounded-3xl border border-edge bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-4 sm:p-6">
 <div className="flex items-start gap-3 sm:gap-4">
 <a
 href={applyUrl}
 target="_blank"
 rel="nofollow noopener noreferrer"
 onClick={() => Analytics.trackSelectContent('job_board_apply_header_logo', `${selectedJob.company}_${selectedJob.title}`)}
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
 loading="lazy"
 onError={handleCompanyLogoError}
 />
 ) : (
 <Building2 className="w-9 h-9 text-muted" />
 )}
 </a>
 <div className="min-w-0">
 <h1 className="text-2xl md:text-3xl font-extrabold font-display text-heading leading-tight">
 <a
 href={applyUrl}
 target="_blank"
 rel="nofollow noopener noreferrer"
 onClick={() => Analytics.trackSelectContent('job_board_apply_header_title', `${selectedJob.company}_${selectedJob.title}`)}
 className="hover:underline decoration-2 underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
 >
 {selectedJobTitle}
 </a>
 {selectedJob.featured && <Star className="inline-block w-4 h-4 ml-2 text-warning fill-warning" />}
 </h1>
 <p className="mt-1 text-sm text-body">
 <a
 href={companySearchHref}
 onClick={(e) => {
 e.preventDefault();
 setSearchQuery('');
 window.history.pushState({ route: { activeTab: 'job-board', jobSlug: companySearchSlug } }, '', companySearchHref.split('?')[0]);
 window.dispatchEvent(new PopStateEvent('popstate'));
 window.scrollTo({ top: 0, behavior: 'smooth' });
 Analytics.trackSelectContent('job_board_company_filter_open', selectedJob.company);
 }}
 className="hover:text-accent hover:underline underline-offset-2 transition-colors"
 >{selectedJob.company}</a>
 {' · '}
 {detailLocationHref ? (
 <a
 href={detailLocationHref}
 onClick={(e) => {
 e.preventDefault();
 setSearchQuery('');
 window.history.pushState({ route: { activeTab: 'job-board', jobSlug: detailLocationSlug } }, '', detailLocationHref.split('?')[0]);
 window.dispatchEvent(new PopStateEvent('popstate'));
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
 </div>

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
 <h4 className="text-sm font-bold text-heading border-l-4 border-accent pl-3">
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
 onClick={(e) => {
 e.preventDefault();
 setSearchQuery('');
 const canonicalCompanyPath = companySearchHref.split('?')[0];
 const currentPathWithSearch = `${window.location.pathname}${window.location.search}`;
 if (currentPathWithSearch !== canonicalCompanyPath) {
 window.history.pushState(
 { route: { activeTab: 'job-board', jobSlug: companySearchSlug } },
 '',
 canonicalCompanyPath
 );
 window.dispatchEvent(new PopStateEvent('popstate'));
 }
 window.scrollTo({ top: 0, behavior: 'smooth' });
 Analytics.trackSelectContent('job_board_company_filter_open', selectedJob.company);
 }}
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
 onError={handleCompanyLogoError} /> ) : ( <Building2 className="w-4 h-4 text-muted" /> )} </div> <div className="min-w-0"> <h3 className="text-sm font-bold font-display text-heading">{t('jobBoard.companyHeading')}</h3> <p className="text-sm text-subtle mt-1"> {selectedJob.company} · {selectedJob.location} ({selectedJob.canton}) </p> <p className="text-sm text-muted mt-2"> {/* BLOCK-B: Regionalize for national expansion — currently hardcodes Ticino/Tessin text */} Frontaliere Ticino ha scovato questa opportunità nel monitoraggio aziende. </p> </div> </div> </a> <div className="flex flex-wrap gap-3 pt-1"> <button onClick={() => handleApply(selectedJob)} className="inline-flex items-center gap-2 px-4 py-2 min-h-[44px] text-sm font-semibold font-display bg-accent hover:bg-accent-hover text-on-accent rounded-lg transition-colors" > <ArrowUpRight className="w-4 h-4" /> {t('jobBoard.apply')} </button> <button type="button" onClick={() => void handleShare(selectedJob)} className="inline-flex items-center gap-2 px-4 py-2 min-h-[44px] text-sm font-semibold font-display border border-edge text-body text-strong rounded-lg hover:bg-surface-raised" > <ArrowUpRight className="w-4 h-4" /> {t('common.share')} </button> </div> </article> <aside className="lg:col-span-4"> <div className="sticky top-20 space-y-4"> <Callout status="accent" icon={<Briefcase size={15} />} className="rounded-xl"> <div className="text-sm font-bold font-display text-heading"> {t('jobBoard.snapshotTitle')} </div> <div className="mt-3 space-y-2 text-xs text-subtle"> <div className="flex items-center justify-between gap-2"> <span>{t('jobBoard.snapshot.location')}</span> <div className="text-right"> <div className="font-semibold font-display text-strong"> {locationSnapshot?.locality || selectedJob.location} </div> {locationSnapshot?.postalCode && ( <div className="text-[11px] text-muted leading-tight mt-0.5"> {t('jobBoard.snapshot.postalCode')}: {locationSnapshot.postalCode} </div> )} </div> </div> <div className="flex items-center justify-between gap-2"> <span>{t('jobBoard.snapshot.contract')}</span> <span className="font-semibold font-display text-strong"> {t(contractTranslationKey(selectedJob))} </span> </div> <div className="flex items-center justify-between gap-2"> <span>{t('jobBoard.snapshot.published')}</span> <span className="font-semibold font-display text-strong">{daysSincePosted(selectedJob.postedDate)}</span> </div> {locationSnapshot?.crossings && locationSnapshot.crossings.length > 0 && ( <div className="pt-2 border-t border-edge/60"> <div className="mb-1.5 text-xs font-semibold font-display uppercase tracking-wide text-muted"> {t('jobBoard.snapshot.borderCrossings')} </div> <div className="space-y-1"> {locationSnapshot.crossings.map((crossing) => ( <a key={crossing.id} href={buildPath({ activeTab: 'guida', guidaSubTab: 'border', borderCrossing: crossing.id, }, locale)} className="flex items-center justify-between gap-2 rounded-lg px-2 py-2.5 min-h-[44px] lg:min-h-0 lg:py-1.5 bg-surface-alt hover:bg-surface-raised/50 text-body transition-colors" > <span className="font-medium font-display leading-tight">{crossing.name}</span> <ArrowUpRight className="w-3 h-3 text-muted" /> </a> ))} </div> </div> )} </div> </Callout> {canonicalContent.process.length > 0 && timelineSections.length === 0 && ( <Callout status="info" icon={<Calendar size={15} />} className="rounded-xl"> <div className="text-sm font-bold font-display text-heading"> {canonicalCopy.process} </div> <ul className="mt-2 space-y-1.5 pl-4 list-disc marker:text-info "> {canonicalContent.process.map((item, i) => ( <li key={i} className="text-sm leading-relaxed text-subtle">{item}</li> ))} </ul> </Callout> )} <Callout status="success" icon={<Users size={15} />} className="rounded-xl"> <div className="text-sm font-bold font-display text-heading"> {t('jobBoard.adviceTitle')} </div> <p className="mt-2 text-sm leading-relaxed text-subtle"> {t('jobBoard.adviceDescription')} </p> <button onClick={() => handleApply(selectedJob)} className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 min-h-[44px] text-sm font-semibold font-display bg-success-strong hover:bg-success-strong-hover text-on-accent rounded-lg" > {t('jobBoard.adviceCta')} </button> </Callout> {relatedSearches.length > 0 && ( <Callout status="accent" icon={<Search size={15} />} className="rounded-xl"> <div className="text-sm font-bold font-display text-heading"> {canonicalCopy.keywords} </div> <div className="mt-2 flex flex-wrap gap-2"> {relatedSearches.map((keyword, i) => { const searchHref = buildPath({ activeTab: 'job-board' as any, jobSlug: buildSearchSlug(keyword, locale) }, locale); return ( <a key={i} href={searchHref} onClick={(e) => { e.preventDefault(); navigateToRelatedSearch(keyword); }} className="text-xs px-2.5 py-1.5 min-h-[44px] inline-flex items-center rounded-full bg-accent-subtle text-accent border border-accent-border" > {keyword} </a> ); })} </div> </Callout> )} {salaryEstimateWidget} {sectorContextWidget} {isDesktopLg && ( <AdSenseBanner adSlot={AD_SLOTS.JOBDETAIL_SIDEBAR.slot} adFormat={AD_SLOTS.JOBDETAIL_SIDEBAR.format} fullWidthResponsive className="mt-2" /> )}<Callout status="accent" icon={<Mail size={15} />} className="rounded-xl"> <div className="text-sm font-bold font-display text-heading"> {t('jobBoard.publishTitle')} </div> <p className="mt-2 text-sm leading-relaxed text-subtle"> {t('jobBoard.publishDescription', getCantonI18nParams())} </p> <button onClick={onPostJob} className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 min-h-[44px] text-sm font-semibold font-display border border-accent-border text-accent rounded-lg hover:bg-accent-subtle" > {t('jobBoard.publishCta')} </button> </Callout> </div> </aside> </div> {/* AdSense — job detail end multiplex */} <AdSenseBanner adSlot={AD_SLOTS.JOBDETAIL_END_MULTIPLEX.slot} adFormat={AD_SLOTS.JOBDETAIL_END_MULTIPLEX.format} className="mt-6 mb-4" /> {relatedJobs.length > 0 && ( <section className="rounded-2xl border border-edge bg-surface p-5"> <h2 className="text-lg font-bold font-display text-heading mb-4">{t('jobBoard.relatedTitle')}</h2> <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3"> {relatedJobs.map((job) => { const jobLogo = companyLogoUrl(job); return ( <button key={job.id} onClick={() => openDetail(job)} className="text-left rounded-xl border border-edge p-3 hover:border-accent-border hover:bg-surface-raised/40 transition-colors" > <div className="flex items-start gap-3"> <div className="w-12 h-12 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden border border-edge shrink-0"> {jobLogo ? ( <img src={jobLogo} alt={`Logo ${job.company}`} className="w-8 h-8 object-contain" width={32} height={32} loading="lazy" onError={handleCompanyLogoError} />
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
 {t('jobBoard.allJobsCta', getCantonI18nParams())}
 </a>
 </nav>
 </div>
 );
 }

 return (
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
 />
 ) : (
 <div className="text-center space-y-3">
 <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-accent-subtle text-accent rounded-full text-xs font-medium">
 <Briefcase className="w-4 h-4" />
 {t('jobBoard.badge')}
 </div>
 <h1 className="text-2xl sm:text-3xl font-bold font-display text-heading">
 {companyDisplayName
 ? t('jobBoard.companyPageTitle', { company: companyDisplayName, ...getCantonI18nParams() })
 : locationDisplayName
 ? t('jobBoard.locationPageTitle', { location: locationDisplayName, ...getCantonI18nParams() })
 : t('jobBoard.title', getCantonI18nParams())}
 </h1>
 <p className="text-sm sm:text-base text-subtle max-w-2xl mx-auto">{t('jobBoard.subtitle', getCantonI18nParams())}</p>
 </div>
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
 value={searchQuery}
 onChange={(e) => setSearchQuery(e.target.value)}
 className="flex-1 px-3 py-3.5 sm:py-4 text-base sm:text-lg bg-transparent text-heading placeholder:text-muted focus:outline-none"
 aria-label={t('jobBoard.searchPlaceholder')}
 />
 {searchQuery && (
 <button
 type="button"
 onClick={() => setSearchQuery('')}
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
 onClick={() => setSearchQuery(s)}
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
 className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-[color,background-color,border-color,box-shadow] ${
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
 { id: 'infermiere', icon: Briefcase, label: 'Infermiere', active: searchQuery.toLowerCase() === 'infermiere', action: () => setSearchQuery(searchQuery.toLowerCase() === 'infermiere' ? '' : 'infermiere') },
 { id: 'ingegnere', icon: Briefcase, label: 'Ingegnere', active: searchQuery.toLowerCase() === 'ingegnere', action: () => setSearchQuery(searchQuery.toLowerCase() === 'ingegnere' ? '' : 'ingegnere') },
 { id: 'autista', icon: Briefcase, label: 'Autista', active: searchQuery.toLowerCase() === 'autista', action: () => setSearchQuery(searchQuery.toLowerCase() === 'autista' ? '' : 'autista') },
 { id: 'health', icon: Tag, label: t('jobBoard.quickFilters.health'), active: selectedCategory === 'health', action: () => setSelectedCategory(selectedCategory === 'health' ? 'all' : 'health') },
 { id: 'parttime', icon: Tag, label: 'Part-time', active: selectedContract === 'part-time', action: () => setSelectedContract(selectedContract === 'part-time' ? 'all' : 'part-time') },
 { id: 'apprentice', icon: Tag, label: t('jobBoard.quickFilters.apprenticeship'), active: selectedContract === 'internship', action: () => setSelectedContract(selectedContract === 'internship' ? 'all' : 'internship') },
 ] as const).map(chip => (
 <button
 key={chip.id}
 type="button"
 onClick={chip.action}
 className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-[color,background-color,border-color,box-shadow] ${
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

 {/* FRO-332/353: Job Alert form (behind feature flag) */}
 {enableJobAlerts && (
 <Suspense fallback={<div className="h-[100px] rounded-xl bg-surface-raised animate-pulse" />}>
 <JobAlertForm
 authUser={authUser}
 onRequireAuth={onRequireAuth}
 initialKeyword={searchQuery}
 />
 </Suspense>
 )}

 {/* Filter toggle bar */}
 <div className="flex items-center gap-2">
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
 <option key={loc} value={loc.toLowerCase()}>
 {loc}
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
 const href = buildPath({ activeTab: 'job-board' as any, jobSlug: buildSearchSlug(term, locale) }, locale);
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
 {trendingJobs.length >= 3 && (
 <TrendingSection
 trendingJobs={trendingJobs.map((j) => ({
 ...j,
 logoUrl: companyLogoUrl(j),
 href: j.slug ? buildPath({ activeTab: 'job-board' as any, jobSlug: j.slug }, locale) : undefined,
 }))}
 popularity={popularity}
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
 <p className="text-xs sm:text-sm text-muted">
 {isMobile && filteredJobs.length > 0
 ? t('jobBoard.showingNJobs', { count: String(displayJobs.length), total: String(filteredJobs.length) })
 : t('jobBoard.resultsCount', { count: String(filteredJobs.length) })}
 </p>
 {!isMobile && renderPagination()}
 </div>

 <div className="space-y-3 min-h-[600px]">
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
 {displayJobs.map((job, idx) => {
 const pos = idx + 1;
 const AD_INTERVAL = 8;
 const FIRST_AD_AFTER = 3;
 const showAd = pos === FIRST_AD_AFTER || (pos > FIRST_AD_AFTER && (pos - FIRST_AD_AFTER) % AD_INTERVAL === 0);
 return (
 <React.Fragment key={job.id || job.slug || idx}>
 {renderJobCard(job)}
 {showAd && isMobile && (
 <div key={`infeed-m-${idx}-${adRefreshKey}`} style={{ minHeight: '280px' }}>
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBLIST_INFEED_MOBILE.slot}
 adFormat={AD_SLOTS.JOBLIST_INFEED_MOBILE.format}
 adLayoutKey={AD_SLOTS.JOBLIST_INFEED_MOBILE.layoutKey}
 fullWidthResponsive={false}
 className="my-3"
 />
 </div>
 )}
 {showAd && !isMobile && (
 <div key={`infeed-d-${idx}-${adRefreshKey}`} style={{ minHeight: '110px' }}>
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBLIST_INFEED_DESKTOP.slot}
 adFormat={AD_SLOTS.JOBLIST_INFEED_DESKTOP.format}
 adLayoutKey={AD_SLOTS.JOBLIST_INFEED_DESKTOP.layoutKey}
 fullWidthResponsive={false}
 className="my-3"
 />
 </div>
 )}
 </React.Fragment>
 );
 })}

 {filteredJobs.length === 0 && (
 <div className="text-center py-12 text-muted">
 <Briefcase className="w-10 h-10 mx-auto mb-3 opacity-30" />
 <p className="font-medium">{t('jobBoard.noResults')}</p>
 <p className="text-sm mt-1">{t('jobBoard.noResultsHint')}</p>
 </div>
 )}
 </div>

 {/* Mobile: infinite scroll sentinel */}
 <div className="min-h-[48px] sm:hidden">
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
 <Suspense fallback={null}>
 <JobAlertEndCard keyword={deferredSearchQuery.trim()} />
 </Suspense>
 )}

 {enableJobAlerts && (
 <Suspense fallback={null}>
 <JobAlertStickyBanner />
 </Suspense>
 )}

 {postAuthPromptVisible && (
 <Suspense fallback={null}>
 <JobAlertPostAuthPrompt
 keyword={searchQuery.trim()}
 onAccept={() => {
 Analytics.trackJobAlertCtaClick('post_auth_prompt', 'open', searchQuery.trim());
 sessionStorage.setItem('jobAlertPostAuthPromptDismissed', '1');
 setPostAuthPromptVisible(false);
 window.dispatchEvent(new CustomEvent('openJobAlert'));
 }}
 onDismiss={() => {
 Analytics.trackJobAlertCtaClick('post_auth_prompt', 'dismiss', searchQuery.trim());
 sessionStorage.setItem('jobAlertPostAuthPromptDismissed', '1');
 setPostAuthPromptVisible(false);
 }}
 />
 </Suspense>
 )}

 {jobDetailPromptVisible && jobDetailPromptCategory && userEmail && userId && (
 <Suspense fallback={null}>
 <JobDetailAlertPrompt
 category={jobDetailPromptCategory}
 userId={userId}
 email={userEmail}
 locale={locale}
 onClose={() => {
 setJobDetailPromptVisible(false);
 setJobDetailPromptCategory(null);
 }}
 onAccepted={() => {
 const category = jobDetailPromptCategory;
 Analytics.trackJobAlertCtaClick('job_detail_prompt', 'accept', category);
 Analytics.trackJobAlertCtaClick('job_detail_prompt', 'success', category);
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
 window.dispatchEvent(new CustomEvent('openJobAlert'));
 }}
 />
 </Suspense>
 )}

 {authGateModalJsx}

 {/* Layer 2D — Internal linking: Strumenti correlati sidebar block. */}
 <aside
 aria-label={t('seoLinks.jobBoard.title')}
 data-testid="jobboard-seo-sidebar"
 className="rounded-2xl border border-edge bg-surface p-4"
 >
 <h3 className="text-sm font-bold text-heading mb-2">{t('seoLinks.jobBoard.title')}</h3>
 <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 list-none p-0 m-0">
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
 <h3 className="font-bold font-display text-heading text-lg">{t('jobBoard.cta.title', getCantonI18nParams())}</h3>
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
 );
};

export default React.memo(JobBoard);
