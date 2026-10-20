import {
  buildSectorHubPath,
  isSectorHubJobActive,
  jobMatchesSector,
  SECTOR_HUB_DISPLAY,
  SECTOR_HUB_KEYS,
  SECTOR_HUB_SLUG,
  type SectorHubKey,
} from '../../build-plugins/jobSectorLanding';
import { isKnownExistingCategorySlug } from '../../build-plugins/shared/autoSectorHubPaths';
import { resolveJobCanton, SECTION_LEGACY_TI } from '../../build-plugins/shared/cantonSection';
import { isListingInventoryJob, normalizeListingIdentity } from '../../services/jobBoardInventory';
import { jobQueuedAtMs, jobTrafficScore } from './job-traffic-priority.mjs';
import { isFixtureJob } from './fixture-data-filter.mjs';
import {
  type SectorHubPublication,
  type SectorHubPublicationRegistry,
} from '../../data/sector-hub-publications';

export const HUB_DISCOVERY_WINDOW_DAYS = 28;
export const MIN_TRACKED_JOBS = 3;
export const MIN_PROMISING_JOBS = 8;
export const MIN_REVIEW_JOBS = 15;
export const MIN_REVIEW_EMPLOYERS = 4;
export const MIN_REVIEW_WEEKS = 3;
export const CANDIDATE_RETENTION_WEEKS = 12;
export const MAX_CANDIDATES = 250;
const SCORING = Object.freeze({
  weights: Object.freeze({ inventory: 0.25, employers: 0.15, adViews: 0.2, ga4Sessions: 0.1, seoDemand: 0.3 }),
  scales: Object.freeze({ jobs: 20, employers: 5, adViewsPerDay: 3, ga4Sessions28d: 20, gscClicks: 10, gscPageImpressionsPerUnit: 100, gscQueryImpressions: 1000 }),
});

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CATEGORY_FIELDS = ['sector', 'category'] as const;
// Exact publisher categories map to the IT umbrella; generic "tech" is kept
// out of the title matcher because the source label also covers unrelated jobs.
const CURATED_SOURCE_LABEL_ALIASES: Partial<Record<SectorHubKey, readonly string[]>> = {
  informatica: [
    'tech',
    'technology',
    'information technology',
    'informatica',
    'informatik',
    'informatique',
    'tecnologia & it',
    'technology & it',
  ],
};

const GENERIC_LABELS = new Set([
  'altro', 'altri', 'altre', 'other', 'others', 'miscellaneous', 'general',
  'generico', 'generica', 'various', 'diverse', 'diversi', 'servizi', 'services',
  'service', 'job', 'jobs', 'lavoro', 'lavori', 'offerte', 'offerta', 'emploi',
  'emplois', 'stellen', 'position', 'positions', 'healthcare', 'health',
  'gesundheitswesen', 'branche', 'sector', 'sectors', 'settore', 'settori',
  'category', 'categorie', 'categoria', 'categories', 'kategorie',
]);

const QUERY_STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'work', 'jobs', 'job', 'offerte', 'offerta',
  'lavoro', 'lavori', 'cerca', 'cercare', 'cerco', 'emploi', 'emplois', 'offres',
  'stellen', 'stelle', 'arbeit', 'arbeiten', 'gesucht', 'ticino', 'tessin', 'ticino',
  'svizzera', 'svizzero', 'schweiz', 'suisse', 'switzerland', 'canton', 'cantone',
  'career', 'careers', 'recruitment', 'recruiting', 'vacancy', 'vacancies',
]);

const JOB_INTENT_RE = /\b(job|jobs|lavor|offert|occup|impieg|emploi|carri[eè]r|stellen|arbeitsplatz|arbeitsstelle|gesucht|recruit|vacan|posto|posti|assunzion|impiego)\w*/i;

const AUTO_LABELS_BY_SLUG: Readonly<Record<string, SectorHubPublication['labelByLocale']>> = {
  finance: { it: 'Finanza', en: 'Finance', de: 'Finanzen', fr: 'Finance' },
  admin: { it: 'Amministrazione', en: 'Administration', de: 'Verwaltung', fr: 'Administration' },
  'public-admin': { it: 'Amministrazione pubblica', en: 'Public administration', de: 'Öffentliche Verwaltung', fr: 'Administration publique' },
  accounting: { it: 'Contabilità', en: 'Accounting', de: 'Buchhaltung', fr: 'Comptabilité' },
  'human-resources': { it: 'Risorse umane', en: 'Human resources', de: 'Personalwesen', fr: 'Ressources humaines' },
  sales: { it: 'Vendite', en: 'Sales', de: 'Vertrieb', fr: 'Ventes' },
  marketing: { it: 'Marketing', en: 'Marketing', de: 'Marketing', fr: 'Marketing' },
  logistics: { it: 'Logistica', en: 'Logistics', de: 'Logistik', fr: 'Logistique' },
  engineering: { it: 'Ingegneria', en: 'Engineering', de: 'Ingenieurwesen', fr: 'Ingénierie' },
  healthcare: { it: 'Sanità', en: 'Healthcare', de: 'Gesundheitswesen', fr: 'Santé' },
  hospitality: { it: 'Ospitalità e ristorazione', en: 'Hospitality', de: 'Gastgewerbe', fr: 'Hôtellerie-restauration' },
  education: { it: 'Istruzione', en: 'Education', de: 'Bildung', fr: 'Éducation' },
  construction: { it: 'Edilizia', en: 'Construction', de: 'Bauwesen', fr: 'Construction' },
  manufacturing: { it: 'Industria manifatturiera', en: 'Manufacturing', de: 'Fertigung', fr: 'Industrie manufacturière' },
  'customer-service': { it: 'Servizio clienti', en: 'Customer service', de: 'Kundenservice', fr: 'Service client' },
  legal: { it: 'Servizi legali', en: 'Legal services', de: 'Rechtswesen', fr: 'Services juridiques' },
};

const AUTO_PUBLISH_FAST_TRACK = Object.freeze({
  minActiveJobs: 20,
  minDistinctEmployers: 5,
  minJobsWithViews: 12,
  minStrongTrafficSignals: 2,
  strongSignalThresholds: Object.freeze({ viewsPerLiveDay: 10, ga4Sessions28d: 100, gscJobPageImpressions28d: 1500 }),
});

export interface DiscoveryJob {
  id?: string;
  slug?: string;
  slugByLocale?: Partial<Record<(typeof LOCALES)[number], string>>;
  title?: string;
  titleByLocale?: Partial<Record<(typeof LOCALES)[number], string>>;
  description?: string;
  descriptionByLocale?: Partial<Record<(typeof LOCALES)[number], string>>;
  category?: string;
  sector?: string;
  company?: string;
  companyKey?: string;
  companyDomain?: string;
  canton?: string;
  location?: string;
  addressLocality?: string;
  sourceLang?: (typeof LOCALES)[number];
  expired?: boolean;
  needsRetranslation?: boolean | Partial<Record<(typeof LOCALES)[number], boolean>>;
  firstSeenAt?: string;
  postedDate?: string;
  datePosted?: string;
  crawledAt?: string;
}

export interface TrafficSnapshot {
  generatedAt: string;
  window: { startDate: string; endDate: string };
  gsc: {
    queries: Record<string, { imp?: number; clicks?: number; topLandingPage?: string }>;
    pages: Record<string, number>;
    error?: string;
  };
  ga4: {
    pages: Record<string, { sessions?: number; pageviews?: number }>;
    coverage?: { complete?: boolean; returnedRows?: number; reportedRows?: number | null };
    error?: string;
  };
}
export type PreviousSectorHubCandidate = {
  suggestedSlug?: string;
  observedWeeks?: string[];
  firstSeenAt?: string;
  lastSeenAt?: string;
  slugConflict?: boolean;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizePhrase(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function slugify(value: string): string {
  return normalizePhrase(value).replace(/\s+/g, '-').slice(0, 64).replace(/-+$/g, '');
}

function validCategoryLabel(raw: unknown, job: DiscoveryJob): string | null {
  const label = text(raw).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ');
  const normalized = normalizePhrase(label);
  if (label.length < 3 || label.length > 80 || normalized.length < 3) return null;
  if (GENERIC_LABELS.has(normalized)) return null;
  if (/@|https?:|www\.|\b\d{4,}\b/i.test(label)) return null;
  if ([job.company, job.companyKey, job.companyDomain].some((name) => normalizePhrase(text(name)) === normalized)) return null;
  if (/\b(?:sa|srl|gmbh|ag|ltd|inc|llc)\b/i.test(label)) return null;
  return label;
}

function isCuratedLabel(label: string): boolean {
  const normalized = normalizePhrase(label);
  for (const sector of SECTOR_HUB_KEYS) {
    const aliases = [
      sector,
      SECTOR_HUB_DISPLAY.it[sector],
      ...LOCALES.map((locale) => SECTOR_HUB_SLUG[locale][sector]),
      ...(CURATED_SOURCE_LABEL_ALIASES[sector] || []),
    ];
    if (aliases.some((alias) => normalizePhrase(alias) === normalized)) return true;
    if (jobMatchesSector({ title: label, category: label, sector: label }, sector, 'it')) return true;
  }
  return false;
}

function employerIdentity(job: DiscoveryJob): string {
  return normalizePhrase(text(job.companyKey) || text(job.companyDomain) || text(job.company));
}

function jobIdentity(job: DiscoveryJob, index: number): string {
  return text(job.id) || text(job.slug) || `${text(job.companyKey)}:${text(job.title)}:${index}`;
}

function isoWeekKey(value: Date): string {
  const date = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const firstMonday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  firstMonday.setUTCDate(firstMonday.getUTCDate() - ((firstMonday.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((date.getTime() - firstMonday.getTime()) / WEEK_MS);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isoWeekStart(weekKey: string): number | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4.getTime());
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
  return monday.getTime();
}

function consecutiveWeekCount(weeks: readonly string[]): number {
  const ordered = [...new Set(weeks)].sort().reverse();
  if (!ordered.length) return 0;
  let count = 1;
  let previousStart = isoWeekStart(ordered[0]);
  if (previousStart == null) return 0;
  for (const week of ordered.slice(1)) {
    const start = isoWeekStart(week);
    if (start == null || previousStart - start !== WEEK_MS) break;
    count += 1;
    previousStart = start;
  }
  return count;
}

function normalizePath(value: string): string {
  const path = String(value || '').split(/[?#]/, 1)[0];
  return path.startsWith('/') ? (path.endsWith('/') ? path : `${path}/`) : `/${path}${path.endsWith('/') ? '' : '/'}`;
}

function jobDetailSlug(pathValue: string): string | null {
  const parts = normalizePath(pathValue).split('/').filter(Boolean);
  let locale: (typeof LOCALES)[number] = 'it';
  if (LOCALES.includes(parts[0] as (typeof LOCALES)[number])) locale = parts.shift() as (typeof LOCALES)[number];
  if (parts.length !== 2) return null;
  const section = parts[0];
  const isJobSection = section === SECTION_LEGACY_TI[locale]
    || /^(?:cerca-lavoro-|find-jobs-|jobs-(?:im|in)-|trouver-emploi-)/i.test(section);
  return isJobSection ? parts[1] : null;
}

function pathStatsForJobs(
  jobs: readonly { job: DiscoveryJob; id: string }[],
  pages: Record<string, { sessions?: number; pageviews?: number }> | Record<string, number>,
): Map<string, { sessions: number; pageviews: number; impressions: number }> {
  const ownersBySlug = new Map<string, string[]>();
  jobs.forEach(({ job, id }) => {
    for (const slug of new Set([text(job.slug), ...Object.values(job.slugByLocale || {}).map(text)].filter(Boolean))) {
      const owners = ownersBySlug.get(slug) || [];
      owners.push(id);
      ownersBySlug.set(slug, owners);
    }
  });

  const out = new Map<string, { sessions: number; pageviews: number; impressions: number }>();
  for (const [path, rawStats] of Object.entries(pages)) {
    const slug = jobDetailSlug(path);
    if (!slug) continue;
    const owners = ownersBySlug.get(slug);
    if (!owners || owners.length !== 1) continue;
    const id = owners[0];
    const current = out.get(id) || { sessions: 0, pageviews: 0, impressions: 0 };
    if (typeof rawStats === 'number') current.impressions += finiteNonNegative(rawStats);
    else {
      current.sessions += finiteNonNegative(rawStats.sessions);
      current.pageviews += finiteNonNegative(rawStats.pageviews);
    }
    out.set(id, current);
  }
  return out;
}

function queryTokens(value: string): string[] {
  return normalizePhrase(value).split(' ').filter((token) => token.length >= 3 && !QUERY_STOP_WORDS.has(token));
}

function relatedQueryMetrics(label: string, queries: TrafficSnapshot['gsc']['queries']): { impressions: number; clicks: number } {
  const tokens = queryTokens(label);
  if (!tokens.length) return { impressions: 0, clicks: 0 };
  const requiredMatches = tokens.length >= 3 ? 2 : 1;
  let impressions = 0;
  let clicks = 0;
  for (const [query, metrics] of Object.entries(queries)) {
    const matched = new Set(queryTokens(query).filter((token) => tokens.includes(token)));
    if (matched.size < requiredMatches) continue;
    const landingIsJobPage = Boolean(metrics.topLandingPage && jobDetailSlug(metrics.topLandingPage));
    if (!landingIsJobPage && !JOB_INTENT_RE.test(query)) continue;
    impressions += finiteNonNegative(metrics.imp);
    clicks += finiteNonNegative(metrics.clicks);
  }
  return { impressions, clicks };
}

function scoreCandidate(metrics: {
  activeJobCount: number;
  employerCount: number;
  viewsPerLiveDay: number;
  ga4Sessions28d: number;
  gscJobPageImpressions28d: number;
  gscQueryImpressions28d: number;
  gscQueryClicks28d: number;
}, popularityFresh: boolean): number {
  const inventory = Math.min(metrics.activeJobCount / SCORING.scales.jobs, 1);
  const employers = Math.min(metrics.employerCount / SCORING.scales.employers, 1);
  const views = popularityFresh ? Math.min(Math.log1p(metrics.viewsPerLiveDay) / Math.log1p(SCORING.scales.adViewsPerDay), 1) : 0;
  const ga4 = Math.min(Math.log1p(metrics.ga4Sessions28d) / Math.log1p(SCORING.scales.ga4Sessions28d), 1);
  const seo = Math.max(
    Math.min(Math.log1p(metrics.gscQueryClicks28d + metrics.gscJobPageImpressions28d / SCORING.scales.gscPageImpressionsPerUnit) / Math.log1p(SCORING.scales.gscClicks), 1),
    Math.min(metrics.gscQueryImpressions28d / SCORING.scales.gscQueryImpressions, 1) * 0.7,
  );
  const weights = SCORING.weights;
  return Math.round((weights.inventory * inventory + weights.employers * employers + weights.adViews * views + weights.ga4Sessions * ga4 + weights.seoDemand * seo) * 1000) / 1000;
}

function sourceCoverageStatus(error?: string): 'complete' | 'partial' | 'unavailable' {
  if (!error) return 'complete';
  return /no service-account|no GA4_PROPERTY_ID|no service-account token/i.test(error) ? 'unavailable' : 'partial';
}

function hubTraffic(
  key: SectorHubKey,
  traffic: TrafficSnapshot,
): { ga4Sessions28d: number; ga4Pageviews28d: number; gscPageImpressions28d: number } {
  let ga4Sessions28d = 0;
  let ga4Pageviews28d = 0;
  let gscPageImpressions28d = 0;
  for (const locale of LOCALES) {
    const path = buildSectorHubPath(locale, key);
    const ga4 = traffic.ga4.pages[normalizePath(path)];
    if (ga4) {
      ga4Sessions28d += finiteNonNegative(ga4.sessions);
      ga4Pageviews28d += finiteNonNegative(ga4.pageviews);
    }
    gscPageImpressions28d += finiteNonNegative(traffic.gsc.pages[normalizePath(path)]);
  }
  return { ga4Sessions28d, ga4Pageviews28d, gscPageImpressions28d };
}

export function buildSectorHubDiscoveryReport({
  jobs,
  popularity,
  popularityScannedAt,
  traffic,
  previous = {},
  now = new Date(),
}: {
  jobs: readonly DiscoveryJob[];
  popularity: Record<string, number>;
  popularityScannedAt?: string | null;
  traffic: TrafficSnapshot;
  previous?: { candidates?: PreviousSectorHubCandidate[] };
  now?: Date;
}) {
  const generatedAt = now.toISOString();
  const currentWeek = isoWeekKey(now);
  const popularityScanMs = Date.parse(popularityScannedAt || '');
  const popularityFresh = Number.isFinite(popularityScanMs) && now.getTime() - popularityScanMs <= 7 * DAY_MS;
  const liveJobs: Array<{ job: DiscoveryJob; id: string; views: number; viewsPerLiveDay: number }> = [];
  const seenJobIds = new Set<string>();
  let activeJobsOutsideCuratedHubs = 0;
  let unclassifiedActiveJobs = 0;
  const hubAcc = new Map(SECTOR_HUB_KEYS.map((key) => [key, {
    activeJobs: new Set<string>(), employers: new Set<string>(), jobsWithViews: 0,
    jobViews: 0, viewsPerLiveDay: 0,
  }]));
  const candidateAcc = new Map<string, {
    slug: string;
    jobs: Map<string, { job: DiscoveryJob; id: string; views: number; viewsPerLiveDay: number }>;
    labels: Map<string, number>;
    fields: Set<string>;
  }>();
  // jobsSeoPagesPlugin emits a static category route only when its exact
  // production listing pool contains at least three records for that key.
  // Keep the route choice in the weekly registry so routing, the index, and
  // generated HTML all agree about whether that page really exists.
  const existingCategoryJobCounts = new Map<string, number>();
  const existingCategoryJobIds = new Map<string, Map<string, number>>();
  jobs.forEach((job, index) => {
    if (isFixtureJob(job) || !isListingInventoryJob(job)
      || !isSectorHubJobActive(job, 'it') || resolveJobCanton(job) !== 'TI') return;
    const listing = normalizeListingIdentity(job);
    const id = jobIdentity(listing, index);
    const categorySlug = String(listing.category || '').toLowerCase();
    if (isKnownExistingCategorySlug(categorySlug)) {
      existingCategoryJobCounts.set(categorySlug, (existingCategoryJobCounts.get(categorySlug) || 0) + 1);
      const ids = existingCategoryJobIds.get(categorySlug) || new Map<string, number>();
      ids.set(id, (ids.get(id) || 0) + 1);
      existingCategoryJobIds.set(categorySlug, ids);
    }
    if (seenJobIds.has(id)) return;
    seenJobIds.add(id);
    const views = jobTrafficScore(listing, popularity);
    const queuedAt = jobQueuedAtMs(listing);
    const ageDays = Number.isFinite(queuedAt) && queuedAt <= now.getTime()
      ? Math.max(1, (now.getTime() - queuedAt) / DAY_MS)
      : 30;
    const viewsPerLiveDay = views / ageDays;
    liveJobs.push({ job: listing, id, views, viewsPerLiveDay });

    const matchedHubs: SectorHubKey[] = [];
    for (const key of SECTOR_HUB_KEYS) {
      if (jobMatchesSector(job, key, 'it')) matchedHubs.push(key);
    }
    for (const key of matchedHubs) {
      const acc = hubAcc.get(key)!;
      acc.activeJobs.add(id);
      const employer = employerIdentity(job);
      if (employer) acc.employers.add(employer);
      acc.jobViews += views;
      acc.viewsPerLiveDay += viewsPerLiveDay;
      if (views > 0) acc.jobsWithViews += 1;
    }
    if (matchedHubs.length) return;

    activeJobsOutsideCuratedHubs += 1;
    const candidateLabels = new Map<string, { label: string; fields: Set<string> }>();
    for (const field of CATEGORY_FIELDS) {
      const label = validCategoryLabel(job[field], job);
      if (!label || isCuratedLabel(label)) continue;
      const slug = slugify(label);
      if (!slug) continue;
      const current = candidateLabels.get(slug) || { label, fields: new Set<string>() };
      current.fields.add(field);
      candidateLabels.set(slug, current);
    }
    if (!candidateLabels.size) {
      unclassifiedActiveJobs += 1;
      return;
    }
    for (const [slug, info] of candidateLabels) {
      const acc = candidateAcc.get(slug) || { slug, jobs: new Map(), labels: new Map(), fields: new Set<string>() };
      acc.jobs.set(id, { job, id, views, viewsPerLiveDay });
      acc.labels.set(info.label, (acc.labels.get(info.label) || 0) + 1);
      for (const field of info.fields) acc.fields.add(field);
      candidateAcc.set(slug, acc);
    }
  });

  // The two evidence maps share a path parser but not a value shape; keep
  // them separate so GA4 and GSC counts remain independent.
  const jobRecords = liveJobs.map(({ job, id }) => ({ job, id }));
  const ga4ByJob = pathStatsForJobs(jobRecords, traffic.ga4.pages);
  const gscByJob = pathStatsForJobs(jobRecords, traffic.gsc.pages);

  const existingHubPerformance = SECTOR_HUB_KEYS.map((key) => {
    const acc = hubAcc.get(key)!;
    const pathMetrics = hubTraffic(key, traffic);
    return {
      key,
      label: SECTOR_HUB_DISPLAY.it[key],
      activeJobCount: acc.activeJobs.size,
      employerCount: acc.employers.size,
      activeJobsWithViews: acc.jobsWithViews,
      activeJobViews: Math.round(acc.jobViews),
      viewsPerLiveDay: Math.round(acc.viewsPerLiveDay * 100) / 100,
      ...pathMetrics,
    };
  });

  const previousBySlug = new Map<string, PreviousSectorHubCandidate>();
  for (const candidate of previous.candidates || []) {
    const slug = text(candidate.suggestedSlug);
    if (slug) previousBySlug.set(slug, candidate);
  }
  const currentSlugs = new Set<string>();
  const candidateRows = [];
  for (const [slug, acc] of candidateAcc) {
    const entries = [...acc.labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const label = entries[0]?.[0] || slug.replace(/-/g, ' ');
    const jobEntries = [...acc.jobs.values()];
    const employers = new Set(jobEntries.map(({ job }) => employerIdentity(job)).filter(Boolean));
    const activeJobCount = jobEntries.length;
    const staticCategoryIds = existingCategoryJobIds.get(slug);
    const existingCategoryInventoryMatches = Boolean(staticCategoryIds)
      && existingCategoryJobCounts.get(slug) === jobEntries.length
      && staticCategoryIds?.size === jobEntries.length
      && [...(staticCategoryIds || [])].every(([id, count]) => count === 1 && acc.jobs.has(id));
    if (activeJobCount < MIN_TRACKED_JOBS) continue;
    currentSlugs.add(slug);
    let activeJobViews = 0;
    let viewsPerLiveDay = 0;
    let activeJobsWithViews = 0;
    let ga4Sessions28d = 0;
    let ga4Pageviews28d = 0;
    let gscJobPageImpressions28d = 0;
    for (const { id, views, viewsPerLiveDay: perDay } of jobEntries) {
      activeJobViews += views;
      viewsPerLiveDay += perDay;
      if (views > 0) activeJobsWithViews += 1;
      const ga4 = ga4ByJob.get(id);
      const gsc = gscByJob.get(id);
      if (ga4) {
        ga4Sessions28d += ga4.sessions;
        ga4Pageviews28d += ga4.pageviews;
      }
      if (gsc) gscJobPageImpressions28d += gsc.impressions;
    }
    const queryMetrics = relatedQueryMetrics(label, traffic.gsc.queries);
    const old = previousBySlug.get(slug);
    const observedWeeks = [...new Set([...(old?.observedWeeks || []), currentWeek])].sort().slice(-CANDIDATE_RETENTION_WEEKS);
    const candidateAgeWeeks = consecutiveWeekCount(observedWeeks);
    const trafficEvidence = (popularityFresh && viewsPerLiveDay >= 0.25)
      || ga4Sessions28d >= 10
      || gscJobPageImpressions28d >= 50
      || queryMetrics.clicks >= 2
      || queryMetrics.impressions >= 100;
    const score = scoreCandidate({
      activeJobCount,
      employerCount: employers.size,
      viewsPerLiveDay,
      ga4Sessions28d,
      gscJobPageImpressions28d,
      gscQueryImpressions28d: queryMetrics.impressions,
      gscQueryClicks28d: queryMetrics.clicks,
    }, popularityFresh);
    const slugConflicts = Object.entries(SECTOR_HUB_SLUG).some(([, slugs]) =>
      Object.values(slugs).some((knownSlug) => knownSlug === slug))
      || (SECTOR_HUB_KEYS as readonly string[]).includes(slug);
    const reviewEligible = !slugConflicts
      && activeJobCount >= MIN_REVIEW_JOBS
      && employers.size >= MIN_REVIEW_EMPLOYERS
      && trafficEvidence
      && candidateAgeWeeks >= MIN_REVIEW_WEEKS;
    candidateRows.push({
      label,
      suggestedSlug: slug,
      sourceFields: [...acc.fields].sort(),
      existingCategoryJobCount: existingCategoryJobCounts.get(slug) || 0,
      existingCategoryInventoryMatches,
      alternateLabels: entries.slice(1, 6).map(([name]) => name),
      activeJobCount,
      employerCount: employers.size,
      activeJobsWithViews,
      activeJobViews: Math.round(activeJobViews),
      viewsPerLiveDay: Math.round(viewsPerLiveDay * 100) / 100,
      ga4Sessions28d: Math.round(ga4Sessions28d),
      ga4Pageviews28d: Math.round(ga4Pageviews28d),
      gscJobPageImpressions28d: Math.round(gscJobPageImpressions28d),
      gscQueryImpressions28d: Math.round(queryMetrics.impressions),
      gscQueryClicks28d: Math.round(queryMetrics.clicks),
      score,
      consecutiveWeeks: candidateAgeWeeks,
      observedWeeks,
      firstSeenAt: old?.firstSeenAt || generatedAt,
      lastSeenAt: generatedAt,
      status: reviewEligible ? 'eligible-for-review'
        : activeJobCount >= MIN_PROMISING_JOBS && employers.size >= 3 && trafficEvidence ? 'promising' : 'watch',
      requiresCuratedTaxonomy: true,
      slugConflict: slugConflicts,
    });
  }

  for (const old of previous.candidates || []) {
    const slug = text(old.suggestedSlug);
    if (!slug || currentSlugs.has(slug) || !old.lastSeenAt) continue;
    const lastSeen = Date.parse(old.lastSeenAt);
    if (!Number.isFinite(lastSeen) || now.getTime() - lastSeen > CANDIDATE_RETENTION_WEEKS * WEEK_MS) continue;
    candidateRows.push({
      ...old,
      activeJobCount: 0,
      employerCount: 0,
      activeJobsWithViews: 0,
      activeJobViews: 0,
      viewsPerLiveDay: 0,
      ga4Sessions28d: 0,
      ga4Pageviews28d: 0,
      gscJobPageImpressions28d: 0,
      gscQueryImpressions28d: 0,
      gscQueryClicks28d: 0,
      score: 0,
      status: 'dormant',
      requiresCuratedTaxonomy: true,
      slugConflict: Boolean(old.slugConflict),
    });
  }

  candidateRows.sort((a, b) => Number(b.status === 'eligible-for-review') - Number(a.status === 'eligible-for-review')
    || b.score - a.score
    || b.activeJobCount - a.activeJobCount
    || a.suggestedSlug.localeCompare(b.suggestedSlug));

  const gscStatus = sourceCoverageStatus(traffic.gsc.error);
  const ga4Error = traffic.ga4.error
    || (traffic.ga4.coverage?.complete === false ? 'GA4 coverage is incomplete or restricted' : undefined);
  const ga4Status = sourceCoverageStatus(ga4Error);
  const gscPasses = traffic.gsc.error || '';
  return {
    schemaVersion: 1,
    generatedAt,
    week: currentWeek,
    window: traffic.window,
    publicationMode: 'automatic-quality-gated',
    promotionRules: {
      minActiveJobs: MIN_REVIEW_JOBS,
      minDistinctEmployers: MIN_REVIEW_EMPLOYERS,
      minConsecutiveWeeks: MIN_REVIEW_WEEKS,
      requiresTrafficEvidence: true,
      trafficEvidenceRule: 'Sustained promotion needs one traffic threshold; fast-track promotion needs two of the three strong, complete traffic signals plus minimum inventory and employer counts.',
      trafficSources: ['active-ad views', 'GA4 job-page sessions', 'GSC impressions and clicks'],
      automaticFastTrack: AUTO_PUBLISH_FAST_TRACK,
      fastTrackSourceRule: 'Count only fresh popularity exports, complete GA4 page data and GSC page impressions marked complete.',
      automaticSustainedTrack: 'eligible-for-review status for 3 consecutive weeks with the normal inventory, employer and traffic gates',
      staticCategoryRouteRule: 'Reuse a static category URL only when the candidate and validated category-page job ID inventories match exactly without duplicates; otherwise emit a dynamic sector route.',
      localizedLabelRule: 'Only locales with an explicit localized label are emitted, linked and indexed.',
    },
    scoring: SCORING,
    sourceCoverage: {
      jobs: {
        status: 'complete',
        datasetRecords: jobs.length,
        activeTicinoJobs: liveJobs.length,
        activeJobsOutsideCuratedHubs,
        unclassifiedActiveJobs,
      },
      popularity: {
        status: popularityFresh ? 'complete' : 'stale-or-unavailable',
        scannedAt: popularityScannedAt || null,
        entries: Object.keys(popularity).length,
        timeBasis: 'cumulative views on currently active ads; per-day rate uses first-seen/posting dates and falls back to 30 days when unknown',
      },
      ga4: {
        status: ga4Status,
        returnedPages: Object.keys(traffic.ga4.pages).length,
        minSessionsPerPage: 1,
        coverage: traffic.ga4.coverage || null,
        error: ga4Error || null,
      },
      gsc: {
        status: gscStatus,
        returnedQueries: Object.keys(traffic.gsc.queries).length,
        returnedPages: Object.keys(traffic.gsc.pages).length,
        queryAggregationComplete: !gscPasses.includes('pass1 (query):'),
        queryLandingPagesComplete: !gscPasses.includes('pass2 (query+page):'),
        pageImpressionsComplete: !gscPasses.includes('pass3 (page):'),
        error: traffic.gsc.error || null,
      },
    },
    existingHubPerformance,
    candidates: candidateRows.slice(0, MAX_CANDIDATES),
    notes: [
      'Candidates are grouped only from active Ticino ads whose title/category does not match any of the '
        + SECTOR_HUB_KEYS.length + ' curated hubs.',
      'The popularity export is cumulative; only views attached to active ads are counted and the score uses views per live day from the best available posting date.',
      'Eligible candidates require 15 active ads, 4 distinct employers, traffic evidence and 3 consecutive weekly observations.',
      'Automatic publication accepts every candidate that passes either the sustained three-week gate or the fast-track inventory and multi-source traffic gate; there is no one-hub promotion slot.',
      'Generated pages use localized templates, exact publisher category fields, live inventory floors, canonical/hreflang and noindex retirement bridges.',
      'Static category URLs are reused only when the candidate inventory exactly matches the validated category-page inventory; otherwise the candidate gets a dynamic sector URL.',
      'A missing or partial GA4/GSC source is reported as such; its absent rows are not interpreted as measured zero demand.',
    ],
  };
}

type AutomaticHubCandidate = {
  label: string;
  suggestedSlug: string;
  sourceFields: string[];
  existingCategoryJobCount?: number;
  existingCategoryInventoryMatches?: boolean;
  alternateLabels: string[];
  activeJobCount: number;
  employerCount: number;
  activeJobsWithViews: number;
  viewsPerLiveDay: number;
  ga4Sessions28d: number;
  gscJobPageImpressions28d: number;
  consecutiveWeeks: number;
  status: string;
  slugConflict: boolean;
};

function qualifiesForAutomaticPublication(
  candidate: AutomaticHubCandidate,
  sources: { popularityFresh: boolean; ga4Complete: boolean; gscPageImpressionsComplete: boolean },
): boolean {
  if (candidate.slugConflict || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.suggestedSlug)) return false;
  const fastThresholds = AUTO_PUBLISH_FAST_TRACK.strongSignalThresholds;
  const strongSignals = [
    sources.popularityFresh
      && candidate.activeJobsWithViews >= AUTO_PUBLISH_FAST_TRACK.minJobsWithViews
      && candidate.viewsPerLiveDay >= fastThresholds.viewsPerLiveDay,
    sources.ga4Complete && candidate.ga4Sessions28d >= fastThresholds.ga4Sessions28d,
    sources.gscPageImpressionsComplete
      && candidate.gscJobPageImpressions28d >= fastThresholds.gscJobPageImpressions28d,
  ].filter(Boolean).length;
  const fastTrack = candidate.activeJobCount >= AUTO_PUBLISH_FAST_TRACK.minActiveJobs
    && candidate.employerCount >= AUTO_PUBLISH_FAST_TRACK.minDistinctEmployers
    && strongSignals >= AUTO_PUBLISH_FAST_TRACK.minStrongTrafficSignals;
  const sustainedTrack = candidate.status === 'eligible-for-review'
    && candidate.activeJobCount >= MIN_REVIEW_JOBS
    && candidate.employerCount >= MIN_REVIEW_EMPLOYERS
    && candidate.consecutiveWeeks >= MIN_REVIEW_WEEKS;
  return fastTrack || sustainedTrack;
}

function labelsForCandidate(candidate: AutomaticHubCandidate): SectorHubPublication['labelByLocale'] {
  // Unknown labels remain in the promotion registry, but only explicitly
  // translated locales may be emitted or indexed. Repeating a source label
  // across every language would create misleading localized SEO pages.
  return AUTO_LABELS_BY_SLUG[candidate.suggestedSlug] || {};
}

function samePublicationState(
  left: readonly SectorHubPublication[],
  right: readonly SectorHubPublication[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Promote all quality-qualified candidates into the compact public registry.
 * The weekly lifecycle has hysteresis: a missing gate moves an active hub to
 * cooling-off, a second consecutive miss retires it, and a recovered hub is
 * reactivated. The registry changes only when its published state changes,
 * so weekly evidence refreshes do not dispatch a needless site deployment.
 */
export function buildAutomaticSectorHubPublicationRegistry({
  report,
  previous,
}: {
  report: {
    generatedAt: string;
    week: string;
    candidates: readonly AutomaticHubCandidate[];
    sourceCoverage?: {
      popularity?: { status?: string };
      ga4?: { status?: string };
      gsc?: { pageImpressionsComplete?: boolean };
    };
  };
  previous?: SectorHubPublicationRegistry | null;
}): SectorHubPublicationRegistry {
  const previousHubs = previous?.schemaVersion === 1 && Array.isArray(previous.hubs)
    ? previous.hubs
    : [];
  const sources = {
    popularityFresh: report.sourceCoverage?.popularity?.status === 'complete',
    ga4Complete: report.sourceCoverage?.ga4?.status === 'complete',
    gscPageImpressionsComplete: report.sourceCoverage?.gsc?.pageImpressionsComplete === true,
  };
  const hasReliableTrafficEvidence = sources.popularityFresh || sources.ga4Complete || sources.gscPageImpressionsComplete;
  const previousBySlug = new Map(previousHubs.map((hub) => [hub.slug, hub]));
  const qualifying = report.candidates
    .filter((candidate) => qualifiesForAutomaticPublication(candidate, sources))
    .sort((a, b) => b.activeJobCount - a.activeJobCount || a.suggestedSlug.localeCompare(b.suggestedSlug));
  const qualifyingSlugs = new Set(qualifying.map((candidate) => candidate.suggestedSlug));
  const currentBySlug = new Map(report.candidates.map((candidate) => [candidate.suggestedSlug, candidate]));
  const hubs: SectorHubPublication[] = [];

  for (const candidate of qualifying) {
    const old = previousBySlug.get(candidate.suggestedSlug);
    const matchLabels = [...new Set([candidate.label, ...candidate.alternateLabels]
      .map((label) => label.trim()).filter(Boolean))];
    const sourceFields = candidate.sourceFields.filter((field): field is 'category' | 'sector' =>
      field === 'category' || field === 'sector');
    const routeKind = candidate.existingCategoryJobCount === undefined
      ? old?.routeKind || 'dynamic'
      : candidate.existingCategoryInventoryMatches === true
        && candidate.existingCategoryJobCount >= 3
        && isKnownExistingCategorySlug(candidate.suggestedSlug)
        ? 'static-category'
        : 'dynamic';
    hubs.push({
      slug: candidate.suggestedSlug,
      routeKind,
      label: candidate.label,
      labelByLocale: labelsForCandidate(candidate),
      sourceFields: sourceFields.length ? sourceFields : old?.sourceFields || ['category'],
      matchLabels: matchLabels.length ? matchLabels : old?.matchLabels || [candidate.label],
      firstPublishedAt: old?.firstPublishedAt || report.generatedAt,
      status: 'active',
    });
  }

  for (const old of previousHubs) {
    if (qualifyingSlugs.has(old.slug)) continue;
    // The report is capped. An absent slug may have fallen below MAX_CANDIDATES
    // rather than lost its live inventory, so only an observed miss advances
    // the retirement lifecycle.
    const current = currentBySlug.get(old.slug);
    if (!current && report.candidates.length >= MAX_CANDIDATES) {
      hubs.push(old);
      continue;
    }
    // A stale/unavailable traffic source is not zero demand. When the live
    // category is still present, wait for one measured source before advancing
    // an otherwise active publication toward retirement.
    if (current && !hasReliableTrafficEvidence && current.activeJobCount >= MIN_REVIEW_JOBS) {
      hubs.push(old);
      continue;
    }
    const status = old.status === 'active' ? 'cooling-off'
      : old.status === 'cooling-off' ? 'retired'
      : 'retired';
    hubs.push(status === old.status ? old : { ...old, status });
  }

  hubs.sort((a, b) => a.slug.localeCompare(b.slug));
  const unchanged = previous?.schemaVersion === 1 && previous.sourceWeek
    && samePublicationState(previous.hubs, hubs);
  if (unchanged) return previous;
  return {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    sourceWeek: report.week,
    hubs,
  };
}
