/**
 * Build-time aggregator for the profession landings (AE-3 template B).
 *
 * Reads data/jobs.json once per build, derives per-profession metrics that
 * feed the new template B header (3 stat tiles + 3 featured jobs + employer
 * grid). PROFESSION_FACTS in professionLandingsData.ts stays as the frozen
 * authority for typicalSalaryRange / CCL / recognition — those are stable
 * editorial facts, not snapshot-driven.
 *
 * Matching strategy
 * -----------------
 * jobs.json `category` is a multilingual mess (`finance`, `Tecnica`,
 * `Gesundheitswesen`, `health`, `Infermieristica`, …) so we do NOT rely on
 * it alone. Each profession defines a multilingual title regex AND a set of
 * accepted category substrings (lowercased). A job matches a profession when
 * either signal fires; the title regex is the primary path.
 *
 * Output cached at the module level so multiple plugins (or repeated calls
 * during a single build) don't re-parse the 31 MB file.
 *
 * No write side effects: this module is read-only by design.
 */

import * as fs from 'node:fs';
import * as np from 'node:path';
import {
  PROFESSION_IDS,
  type ProfessionId,
  type ProfessionLocale,
} from './professionLandingsData';

// ── Types ────────────────────────────────────────────────────────────────────

/** Subset of jobs.json record fields we actually need. */
interface JobRecord {
  id?: string;
  slug?: string;
  slugByLocale?: Partial<Record<ProfessionLocale, string>>;
  title?: string;
  titleByLocale?: Partial<Record<ProfessionLocale, string>>;
  company?: string;
  companyKey?: string;
  category?: string;
  sector?: string;
  addressLocality?: string;
  canton?: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string;
  postedDate?: string;
  firstSeenAt?: string;
  featured?: boolean;
  employmentType?: string;
  url?: string;
  applyUrl?: string;
}

export interface FeaturedJob {
  readonly id: string;
  readonly title: string;
  readonly titleByLocale: Partial<Record<ProfessionLocale, string>>;
  readonly company: string;
  readonly city: string;
  readonly salaryMin: number | null;
  readonly salaryMax: number | null;
  readonly postedDate: string;
  readonly daysAgo: number;
  readonly slug: string;
  readonly slugByLocale: Partial<Record<ProfessionLocale, string>>;
  readonly employmentType: string | null;
}

export interface ProfessionJobsSnapshot {
  /** Live count of matching jobs in the dataset (all-time, no age filter). */
  readonly liveCount: number;
  /**
   * Count of matches with `postedDate` in the last 30 days — the "freshness"
   * signal that powers the third stat tile. Honest where Q-over-Q would lie
   * (the crawlers drop stale postings so a true trend is unobservable).
   */
  readonly fresh30Count: number;
  /** Median annual gross CHF salary computed from baseSalary midpoints. */
  readonly medianSalaryChf: number | null;
  /** Top 3 freshest featured (else freshest) jobs that match this profession. */
  readonly featured: readonly FeaturedJob[];
  /** Top 6 employers by job count for this profession. */
  readonly topEmployers: ReadonlyArray<{ name: string; count: number }>;
}

// ── Matchers ─────────────────────────────────────────────────────────────────

interface ProfessionMatcher {
  /** Multilingual title regex — matches any tokenised role variant. */
  readonly title: RegExp;
  /**
   * Optional negative regex — when it matches, the job is rejected even if
   * `title` would have matched. Lets us strip cross-category false positives
   * like "Chef de Rang" sneaking into cuoco (it's a waiter title in DE/FR).
   */
  readonly exclude?: RegExp;
}

/**
 * Heuristic matchers — multi-locale (IT/EN/DE/FR) word stems. Title-only:
 * jobs.json `category` is too coarse and multilingual to use safely (a single
 * `gesundheitswesen` category catches psychologists, OSS, doctors AND nurses).
 * False positives compound on featured-jobs cards which a user sees and
 * judges immediately — so the bar for inclusion has to be the title itself.
 */
const PROFESSION_MATCHERS: Record<ProfessionId, ProfessionMatcher> = {
  infermiere: {
    title: /\b(infermier|krankenpfleg|krankenschwester|pflegefach|pflegehelfer|registered nurse|infirmier|infirmière|fachperson gesundheit)/i,
    // Reject the generic "nurse" assistant titles that aren't RN-grade roles.
    exclude: /\b(assistenzpsycholog|psychotherap|sozialarbeit|tieräpfleg)/i,
  },
  operaio: {
    title: /\b(operai|produktionsmitarbeit|production worker|tornitor|fresator|saldator|magazzinier|aiuto-?reparto|lagerist|lagermitarbeit|aiuto-?cucina|hilfsarbeiter)\b/i,
  },
  impiegato: {
    title: /\b(impiegat|sachbearbeiter|kaufm[äa]nn|kauffrau|kfm-?angestellte|administrative assistant|administrative officer|amministrativ|back-?office clerk|front-?office clerk|customer service representative|sekret[äa]r|segretari)\b/i,
  },
  ingegnere: {
    title: /\b(ingegner|ingenieur|ingénieur|engineer|engineering specialist)\b/i,
  },
  educatore: {
    title: /\b(educator|educatore|educatrice|erzieher|éducateur|educateur|sozialp[äa]dagog|fachperson betreuung|operatore socio-?educativ|asilo nido|nido d'?infanzia)/i,
  },
  autista: {
    title: /\b(autist|chauffeur|conducente|camionist|berufsfahrer|lkw-?fahrer|truck driver|delivery driver)\b/i,
  },
  muratore: {
    title: /\b(murator|maurer|mason|maçon|macon|carpentier|carpentiere|bauarbeiter|construction worker|capomastr|casserator)/i,
  },
  cuoco: {
    title: /\b(cuoc|cuisinier|koch|cook|chef de partie|chef de cuisine|sous chef|küchenchef|capo cuoc|pizzaiol)\b/i,
    // "Chef de rang" / "Chef de Réception" are hospitality service titles, not kitchen.
    exclude: /\b(chef de rang|chef de réception|chef d'équipe|chef de service|chef sommelier)\b/i,
  },
  cameriere: {
    title: /\b(camerier|kellner|waiter|waitress|serveur|serveuse|chef de rang|commis de salle|barista|barkeeper)\b/i,
  },
  elettricista: {
    title: /\b(elettricist|elektriker|electrician|électricien|electricien|elektromonteur|elektroinstallat)/i,
  },
};

// ── Cache + load ─────────────────────────────────────────────────────────────

let _snapshotCache: Record<ProfessionId, ProfessionJobsSnapshot> | null = null;
let _cacheRootDir: string | null = null;

const DAY_MS = 86_400_000;

function loadJobs(rootDir: string): readonly JobRecord[] {
  const jobsPath = np.join(rootDir, 'data', 'jobs.json');
  if (!fs.existsSync(jobsPath)) return [];
  try {
    const raw = fs.readFileSync(jobsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as JobRecord[];
    return [];
  } catch (err) {
    console.warn('[profession-aggregate] failed to read jobs.json:', err);
    return [];
  }
}

function jobMatchesProfession(job: JobRecord, m: ProfessionMatcher): boolean {
  const haystacks: string[] = [];
  if (job.title) haystacks.push(job.title);
  if (job.titleByLocale) {
    for (const v of Object.values(job.titleByLocale)) {
      if (v) haystacks.push(v);
    }
  }
  let titleHit = false;
  for (const h of haystacks) {
    if (m.title.test(h)) {
      titleHit = true;
      break;
    }
  }
  if (!titleHit) return false;
  if (m.exclude) {
    for (const h of haystacks) {
      if (m.exclude.test(h)) return false;
    }
  }
  return true;
}

function median(values: readonly number[]): number | null {
  const sorted = [...values].filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function jobMidpoint(job: JobRecord): number | null {
  const min = typeof job.salaryMin === 'number' ? job.salaryMin : null;
  const max = typeof job.salaryMax === 'number' ? job.salaryMax : null;
  if (min && max) return Math.round((min + max) / 2);
  if (min) return min;
  if (max) return max;
  return null;
}

function toFeatured(job: JobRecord, now: number): FeaturedJob | null {
  if (!job.id || !job.title || !job.slug) return null;
  const postedDate = job.postedDate || job.firstSeenAt || '';
  const ts = postedDate ? Date.parse(postedDate) : NaN;
  const daysAgo = Number.isFinite(ts) ? Math.max(0, Math.round((now - ts) / DAY_MS)) : 9999;
  return {
    id: job.id,
    title: job.title,
    titleByLocale: job.titleByLocale ?? {},
    company: job.company ?? '',
    city: job.addressLocality ?? '',
    salaryMin: typeof job.salaryMin === 'number' ? job.salaryMin : null,
    salaryMax: typeof job.salaryMax === 'number' ? job.salaryMax : null,
    postedDate,
    daysAgo,
    slug: job.slug,
    slugByLocale: job.slugByLocale ?? {},
    employmentType: job.employmentType ?? null,
  };
}

function buildSnapshotForProfession(
  jobs: readonly JobRecord[],
  matcher: ProfessionMatcher,
  now: number,
): ProfessionJobsSnapshot {
  const matches: JobRecord[] = [];
  for (const job of jobs) {
    if (jobMatchesProfession(job, matcher)) matches.push(job);
  }

  // Freshness: count matches posted in the last 30 days. Honest where a
  // quarter-over-quarter delta would lie — the crawlers drop stale postings
  // so the prior period is always near-empty.
  const last30 = now - 30 * DAY_MS;
  let fresh30 = 0;
  for (const job of matches) {
    const ts = job.postedDate ? Date.parse(job.postedDate) : NaN;
    if (Number.isFinite(ts) && ts >= last30) fresh30++;
  }

  const salaryValues: number[] = [];
  for (const job of matches) {
    const mid = jobMidpoint(job);
    if (mid) salaryValues.push(mid);
  }
  const medianSalary = median(salaryValues);

  const employerCounts = new Map<string, number>();
  for (const job of matches) {
    const name = (job.company ?? '').trim();
    if (!name) continue;
    employerCounts.set(name, (employerCounts.get(name) ?? 0) + 1);
  }
  const topEmployers = [...employerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({ name, count }));

  // Featured: top 3 — prefer `featured: true`, then freshest postedDate.
  // Sort raw matches first so we can read the `featured` flag without losing it.
  const sortedMatches = [...matches].sort((a, b) => {
    const aFeat = a.featured ? 1 : 0;
    const bFeat = b.featured ? 1 : 0;
    if (aFeat !== bFeat) return bFeat - aFeat;
    const aTs = a.postedDate ? Date.parse(a.postedDate) : 0;
    const bTs = b.postedDate ? Date.parse(b.postedDate) : 0;
    return bTs - aTs;
  });
  const featured: FeaturedJob[] = [];
  for (const job of sortedMatches) {
    if (featured.length >= 3) break;
    const f = toFeatured(job, now);
    if (f) featured.push(f);
  }

  return {
    liveCount: matches.length,
    fresh30Count: fresh30,
    medianSalaryChf: medianSalary,
    featured,
    topEmployers,
  };
}

/**
 * Aggregate jobs.json into per-profession snapshots. Cached per `rootDir`.
 * Pass `now` to override the clock (used by tests); defaults to Date.now().
 */
export function aggregateProfessionJobs(
  rootDir: string,
  now: number = Date.now(),
): Record<ProfessionId, ProfessionJobsSnapshot> {
  if (_snapshotCache && _cacheRootDir === rootDir) return _snapshotCache;

  const jobs = loadJobs(rootDir);
  const out = {} as Record<ProfessionId, ProfessionJobsSnapshot>;
  for (const id of PROFESSION_IDS) {
    out[id] = buildSnapshotForProfession(jobs, PROFESSION_MATCHERS[id], now);
  }
  _snapshotCache = out;
  _cacheRootDir = rootDir;
  return out;
}

/** Test/CI helper — clear the module-level cache. */
export function _resetProfessionJobsAggregateCache(): void {
  _snapshotCache = null;
  _cacheRootDir = null;
}

// ── Job-board URL builder ────────────────────────────────────────────────────

const JOB_BOARD_BASE_PATH: Record<ProfessionLocale, string> = {
  it: '/cerca-lavoro-ticino',
  en: '/en/find-jobs-ticino',
  de: '/de/jobs-im-tessin',
  fr: '/fr/trouver-emploi-tessin',
};

/**
 * Build the canonical detail-page URL for a featured job in the target locale.
 * Falls back to the IT slug when the locale-specific one is missing.
 */
export function buildFeaturedJobUrl(job: FeaturedJob, locale: ProfessionLocale): string {
  const slug = job.slugByLocale[locale] ?? job.slug;
  return `${JOB_BOARD_BASE_PATH[locale]}/${slug}/`;
}

/** Job-board hub URL for the given locale (used by the "view all" CTA). */
export function buildJobBoardUrl(locale: ProfessionLocale): string {
  return `${JOB_BOARD_BASE_PATH[locale]}/`;
}
