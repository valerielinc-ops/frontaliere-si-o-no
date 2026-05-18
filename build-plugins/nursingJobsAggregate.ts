/**
 * Build-time aggregator for the nursing/healthcare landings (template B).
 *
 * Mirrors `professionJobsAggregate.ts` but with healthcare-tuned title
 * matchers. Each of the 3 nursing IDs (`nurses`, `oss`, `healthcare-ticino`)
 * defines a multilingual title regex (with optional exclusion); jobs whose
 * title (in any locale variant) matches are kept. Category strings in
 * jobs.json are multilingual mess (`gesundheitswesen`, `health`,
 * `Infermieristica`, …) and rope in psychologists / vet-assistants too,
 * so we deliberately match on title only — the bar for a featured-job card
 * shown to a real user is "the title actually describes the role".
 *
 * Output cached at the module level so multiple plugins (or repeated calls
 * during a single build) don't re-parse the 31 MB file. No write side
 * effects — read-only by design.
 */

import * as fs from 'node:fs';
import * as np from 'node:path';
import {
  NURSING_LANDING_IDS,
  type NursingLandingId,
  type NursingLocale,
} from './nursingLandingsData';
import type { ProfessionJobsSnapshot, FeaturedJob } from './professionJobsAggregate';

// Re-export the snapshot/featured types so the plugin imports a single
// canonical shape — different alias keeps grep-ability without forking the
// schema.
export type NursingJobsSnapshot = ProfessionJobsSnapshot;
export type NursingFeaturedJob = FeaturedJob;

// ── Types ────────────────────────────────────────────────────────────────────

/** Subset of jobs.json record fields we actually need. */
interface JobRecord {
  id?: string;
  slug?: string;
  slugByLocale?: Partial<Record<NursingLocale, string>>;
  title?: string;
  titleByLocale?: Partial<Record<NursingLocale, string>>;
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

// ── Matchers ─────────────────────────────────────────────────────────────────

interface NursingMatcher {
  /** Multilingual title regex — matches any tokenised healthcare role variant. */
  readonly title: RegExp;
  /**
   * Optional negative regex — rejects cross-domain false positives even when
   * `title` matched (e.g. "Assistenzpsychologe" sneaking past `pflegehilfe`).
   */
  readonly exclude?: RegExp;
}

/**
 * Heuristic matchers — multi-locale (IT/EN/DE/FR) word stems. Title-only by
 * design (see file header). `healthcare-ticino` is the largest umbrella —
 * nurses + OSS + doctors + therapists + radiology + lab.
 */
const NURSING_MATCHERS: Record<NursingLandingId, NursingMatcher> = {
  nurses: {
    title: /\b(infermier|nurse|krankenpfleg|krankenschwester|pflegefach|registered nurse|fachperson gesundheit|infirmier|infirmière)/i,
    // Strip psychology assistants, animal carers and other non-RN roles that
    // share the "pfleg" / "nurse" stem in some locales.
    exclude: /\b(assistenzpsycholog|psychotherap|tierpfleg|tieräpfleg|tierarztpfleger|pet care)/i,
  },
  oss: {
    title: /\b(operatore socio-?sanitari|\boss\b|fachperson betreuung|fage|fa-?ge|assistant.{0,5}cur|assistant.{0,5}sant|assc|pflegehelfer|aide-?soignant|nursing assistant|healthcare assistant|care helper|hilfspflege)/i,
  },
  'healthcare-ticino': {
    title: /\b(infermier|nurse|krankenpfleg|krankenschwester|pflegefach|registered nurse|fachperson gesundheit|infirmier|infirmière|operatore socio-?sanitari|\boss\b|fachperson betreuung|fage|fa-?ge|assistant.{0,5}cur|assistant.{0,5}sant|assc|pflegehelfer|aide-?soignant|nursing assistant|healthcare assistant|doctor|medic|terapista|physiotherap|fisioterapist|ergoterapist|logopedist|caregiver|tecnico sanitario|laboratorio analisi|radiolog|ostetric|levatric|sage-?femme|hebamme|midwife|pharmacist|farmacist|apotheker|psicolog|psychologist|psycholog)/i,
    exclude: /\b(tierpfleg|tieräpfleg|tierarztpfleger|tierarzt|vet\b|veterinari)/i,
  },
};

// ── Cache + load ─────────────────────────────────────────────────────────────

let _snapshotCache: Record<NursingLandingId, NursingJobsSnapshot> | null = null;
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
    console.warn('[nursing-aggregate] failed to read jobs.json:', err);
    return [];
  }
}

function jobMatches(job: JobRecord, m: NursingMatcher): boolean {
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

function toFeatured(job: JobRecord, now: number): NursingFeaturedJob | null {
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

function buildSnapshotForId(
  jobs: readonly JobRecord[],
  matcher: NursingMatcher,
  now: number,
): NursingJobsSnapshot {
  const matches: JobRecord[] = [];
  for (const job of jobs) {
    if (jobMatches(job, matcher)) matches.push(job);
  }

  // Freshness: count matches posted in the last 30 days.
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
  const sortedMatches = [...matches].sort((a, b) => {
    const aFeat = a.featured ? 1 : 0;
    const bFeat = b.featured ? 1 : 0;
    if (aFeat !== bFeat) return bFeat - aFeat;
    const aTs = a.postedDate ? Date.parse(a.postedDate) : 0;
    const bTs = b.postedDate ? Date.parse(b.postedDate) : 0;
    return bTs - aTs;
  });
  const featured: NursingFeaturedJob[] = [];
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
 * Aggregate jobs.json into per-nursing-id snapshots. Cached per `rootDir`.
 * Pass `now` to override the clock (used by tests); defaults to Date.now().
 */
export function aggregateNursingJobs(
  rootDir: string,
  now: number = Date.now(),
): Record<NursingLandingId, NursingJobsSnapshot> {
  if (_snapshotCache && _cacheRootDir === rootDir) return _snapshotCache;

  const jobs = loadJobs(rootDir);
  const out = {} as Record<NursingLandingId, NursingJobsSnapshot>;
  for (const id of NURSING_LANDING_IDS) {
    out[id] = buildSnapshotForId(jobs, NURSING_MATCHERS[id], now);
  }
  _snapshotCache = out;
  _cacheRootDir = rootDir;
  return out;
}

/** Test/CI helper — clear the module-level cache. */
export function _resetNursingJobsAggregateCache(): void {
  _snapshotCache = null;
  _cacheRootDir = null;
}

// ── Job-board URL builder ────────────────────────────────────────────────────

const JOB_BOARD_BASE_PATH: Record<NursingLocale, string> = {
  it: '/cerca-lavoro-ticino',
  en: '/en/find-jobs-ticino',
  de: '/de/jobs-im-tessin',
  fr: '/fr/trouver-emploi-tessin',
};

/**
 * Build the canonical detail-page URL for a featured job in the target locale.
 * Falls back to the IT slug when the locale-specific one is missing.
 */
export function buildFeaturedJobUrl(job: NursingFeaturedJob, locale: NursingLocale): string {
  // `slugByLocale` is keyed on the same 'it'|'en'|'de'|'fr' string union as
  // NursingLocale; the index access is safe even though the declared key type
  // comes from ProfessionLocale (identical string union).
  const slug = job.slugByLocale[locale as keyof typeof job.slugByLocale] ?? job.slug;
  return `${JOB_BOARD_BASE_PATH[locale]}/${slug}/`;
}

/** Job-board hub URL for the given locale (used by the "view all" CTA). */
export function buildJobBoardUrl(locale: NursingLocale): string {
  return `${JOB_BOARD_BASE_PATH[locale]}/`;
}
