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
  ALL_CANTON_PROFESSION_IDS,
  PROFESSION_IDS,
  type AnyProfessionId,
  type CantonOnlyProfessionId,
  type ProfessionId,
  type ProfessionLocale,
} from './professionLandingsData';
import { resolveJobCanton } from './shared/cantonSection';
import { realSalaryMedianChf } from './shared/realSalaryMedian';
import { firstParsableMs, firstParsableDateStr } from './shared/firstParsableDate';
import { TI_LEGACY_CITY_HUB_KEYS, jobMatchesCity, type CityHubKey } from './cityJobsHub';

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
  companyDomain?: string;
  contract?: string;
  category?: string;
  sector?: string;
  addressLocality?: string;
  canton?: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  /** Salary provenance persisted by scripts/re-enrich-jobs.mjs —
   * 'reported' | 'existing' | 'estimated'. Absent on records not yet
   * re-enriched. */
  salarySource?: string;
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
  readonly companyKey: string | null;
  readonly companyDomain: string | null;
  readonly city: string;
  readonly addressLocality: string | null;
  readonly canton: string | null;
  readonly contract: string | null;
  readonly salaryMin: number | null;
  readonly salaryMax: number | null;
  readonly postedDate: string;
  readonly daysAgo: number;
  readonly slug: string;
  readonly slugByLocale: Partial<Record<ProfessionLocale, string>>;
  readonly employmentType: string | null;
  readonly url: string | null;
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
  psicologo: {
    title: /\b(psicolog|psycholog|psychothérap|psychotherap)/i,
  },
  fisioterapista: {
    title: /\b(fisioterap|physiotherap|physiothérap)/i,
  },
  logopedista: {
    title: /\b(logoped|logopäd|orthophonist|speech therap)/i,
  },
  farmacista: {
    title: /\b(farmacist|apotheker|pharmacien|pharmacist|pharma-?assistent)/i,
  },
  ostetrica: {
    title: /\b(ostetric|hebamme|sage-?femme|midwife)/i,
  },
  'assistente-dentale': {
    title: /\b(dentalassistent|dentalhygien|assistente dentale|igienista dentale|assistante dentaire|dental assistant|dental hygienist|prophylaxeassistent)/i,
  },
  'tecnico-radiologia': {
    title: /(radiologiefach|fachperson mtr|tecnico di radiologia|technicien en radiologie|radiographer|\bmtra\b)/i,
    // Reject physician titles (Radiologe / medico radiologo are MDs, not TRM).
    exclude: /\b(arzt|ärztin|medico|facharzt|oberarzt)\b/i,
  },
  oss: {
    title: /(\boss\b|operat(ore|rice) socio|fachfrau gesundheit|fachmann gesundheit|\bfage\b|assistant en soins|aide-?soignant)/i,
  },
  'ottico-optometrista': {
    title: /\b(ottic[oa]\b|optometrist|optiker|opticien)/i,
    // "ottico/ottica" is a common bare adjective in physics/tech titles
    // (fibra ottica, sensore ottico, ottica adattiva) — reject those so the
    // landing only features eyewear-profession ads.
    exclude: /(ottica adattiva|fibra ottic|sensore ottic|microscopio ottic|lettore ottic|cavo ottic|disco ottic|amplificatore ottic|ricercator|postdoc|dottorato|fisica|physics|laser)/i,
  },
  contabile: {
    title: /\b(contabil|buchhalt|comptab|accountant|accounting)/i,
  },
  'assistente-sociale': {
    title: /\b(assistente sociale|sozialarbeit|sozialp[äa]dagog|assistant social|social worker)/i,
  },
  macellaio: {
    title: /\b(macella|metzger|fleischfach|boucher\b|butcher)/i,
  },
  saldatore: {
    title: /\b(saldator|schweisser|schweißer|soudeur|welder)/i,
  },
  architetto: {
    title: /\b(architetto|architekt(:in|\/-?in)?|architecte)\b/i,
    // The crawler dataset is dominated by IT/solution architects — reject any
    // title with a tech qualifier so featured cards only show building architects.
    exclude: /(software|solution|cloud|system|enterprise|data|\bit\b|\bict\b|security|\bai\b|infrastructure|network|platform|application|technical|test|\bsap\b|\biam\b|\berp\b|domain|business|pega|\bot\b|tagetik|informatique|logiciel)/i,
  },
};

/**
 * Matchers for the 5 canton-only professions (#3657). Kept separate from
 * PROFESSION_MATCHERS (which backs the TI-only aggregateProfessionJobs used by
 * the Ticino-bespoke landing system) so these ids never leak into that
 * loop — they only ever run inside aggregateProfessionJobsByCanton below.
 */
const CANTON_ONLY_MATCHERS: Record<CantonOnlyProfessionId, ProfessionMatcher> = {
  dietista: {
    title: /\b(dietist|dietolog|nutrizionist|nutritionist|di[ée]t[ée]ticien|dieteticien|ern[äa]hrungsberat|di[äa]tassistent)/i,
  },
  meccanico: {
    title: /(meccanic|m[ée]canicien|mechaniker|mechanic)/i,
    // Reject "mechanical engineer" / "ingegnere meccanico" style titles — those
    // are engineering roles, not the trade-mechanic profession this page targets.
    exclude: /\b(ingegner|engineer|ingenieur|ingénieur)\b/i,
  },
  automazione: {
    title: /(automatiker|automaticien|tecnico (?:di |in )?automazione|technicien en automatisation|automation technician|automatisierungstechniker)/i,
    // Reject software/IT/RPA "automation" roles — this profession targets the
    // industrial trade (Automatiker EFZ), not process/test automation software jobs.
    exclude: /\b(software|informatic|\bit\b|rpa|test automation|devops|cloud)\b/i,
  },
  montatore: {
    title: /(montator|montatric|montagg|monteur|monteuse)/i,
    // Reject compounds already covered by a different profession: electrician
    // ("Elektromonteur" / "monteur électricien") and French "monteur vidéo"
    // (video editor) — not the generic fitter/assembler role this page targets.
    exclude: /(elektromonteur|monteur[\s-]?[ée]lectricien|[ée]lectricien|elettricist|elektriker|vid[ée]o)/i,
  },
  'addetto-pulizie': {
    title: /(addett[oa]\s+(?:alle\s+)?pulizi|pulizi[ae]|cleaner|cleaning operative|reinigungskraft|raumpfleg|geb[äa]udereinig|agent de nettoyage|agent d'entretien|agent de propret[ée])/i,
  },
};

/** Matchers for every profession the per-canton family covers (24 + 5). */
const ALL_PROFESSION_MATCHERS: Record<AnyProfessionId, ProfessionMatcher> = {
  ...PROFESSION_MATCHERS,
  ...CANTON_ONLY_MATCHERS,
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

function toFeatured(job: JobRecord, now: number): FeaturedJob | null {
  if (!job.id || !job.title || !job.slug) return null;
  // First PARSEABLE date, not first truthy: a malformed postedDate must not
  // shadow a valid firstSeenAt and render "Pubblicata 9999 giorni fa".
  const postedDate = firstParsableDateStr(job.postedDate, job.firstSeenAt);
  const ts = firstParsableMs(job.postedDate, job.firstSeenAt);
  const daysAgo = ts ? Math.max(0, Math.round((now - ts) / DAY_MS)) : 9999;
  return {
    id: job.id,
    title: job.title,
    titleByLocale: job.titleByLocale ?? {},
    company: job.company ?? '',
    companyKey: job.companyKey ?? null,
    companyDomain: job.companyDomain ?? null,
    city: job.addressLocality ?? '',
    addressLocality: job.addressLocality ?? null,
    canton: job.canton ?? null,
    contract: job.employmentType ?? job.contract ?? null,
    salaryMin: typeof job.salaryMin === 'number' ? job.salaryMin : null,
    salaryMax: typeof job.salaryMax === 'number' ? job.salaryMax : null,
    postedDate,
    daysAgo,
    slug: job.slug,
    slugByLocale: job.slugByLocale ?? {},
    employmentType: job.employmentType ?? null,
    url: job.url ?? null,
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
    const ts = firstParsableMs(job.postedDate, job.firstSeenAt);
    if (ts && ts >= last30) fresh30++;
  }

  const medianSalary = realSalaryMedianChf(matches);

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
    const aTs = firstParsableMs(a.postedDate, a.firstSeenAt);
    const bTs = firstParsableMs(b.postedDate, b.firstSeenAt);
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
 *
 * Filters to canton=TI before aggregation. The profession landings
 * (`/lavoro-ticino-{profession}/`) are editorially Ticino-themed: section
 * titles say "Chi assume in Ticino" / "Principali datori di lavoro in
 * Ticino" / "Il mestiere in Ticino", and the employer-chip URLs all point
 * at `/cerca-lavoro-ticino/?q=<employer>`. Before this filter, the cathedral
 * dataset expansion (2026-05-10) caused non-TI employers (Luzerner Psychiatrie,
 * Psychiatrie Baselland, Stiftung Bachtelen, …) to surface in the TI section
 * and link to a TI search that returned zero results — visible 2026-05-20 on
 * /lavoro-ticino-educatore/. Filtering at the load boundary keeps content and
 * link target consistent without rewriting every downstream call site.
 */
export function aggregateProfessionJobs(
  rootDir: string,
  now: number = Date.now(),
): Record<ProfessionId, ProfessionJobsSnapshot> {
  if (_snapshotCache && _cacheRootDir === rootDir) return _snapshotCache;

  const allJobs = loadJobs(rootDir);
  const jobs = allJobs.filter((job) => resolveJobCanton(job as { canton?: string; location?: string }) === 'TI');
  const out = {} as Record<ProfessionId, ProfessionJobsSnapshot>;
  for (const id of PROFESSION_IDS) {
    out[id] = buildSnapshotForProfession(jobs, PROFESSION_MATCHERS[id], now);
  }
  _snapshotCache = out;
  _cacheRootDir = rootDir;
  return out;
}

// ── Per-canton aggregation (profession × canton landings) ────────────────────

/** Half-canton URL-group collapse: AI/AR -> APPENZELLO, BL/BS -> BASILEA. */
const CANTON_URL_GROUP: Record<string, string> = { AI: 'APPENZELLO', AR: 'APPENZELLO', BL: 'BASILEA', BS: 'BASILEA' };

function jobCantonUrlKey(job: JobRecord): string {
  const code = resolveJobCanton(job as { canton?: string; location?: string });
  if (!code) return '';
  return CANTON_URL_GROUP[code] ?? code;
}

let _cantonSnapshotCache: Record<string, Record<AnyProfessionId, ProfessionJobsSnapshot>> | null = null;
let _cantonCacheRootDir: string | null = null;

/**
 * Aggregate jobs.json into per-(canton, profession) snapshots — the data source
 * for the per-canton profession landings. Unlike aggregateProfessionJobs (which
 * pins to TI and only the 24 Ticino-bespoke professions), this groups every
 * active job by its canton (half-cantons collapse to the URL group) and builds
 * a profession snapshot per canton — for the full ALL_CANTON_PROFESSION_IDS set
 * (24 + the 5 canton-only professions, #3657) — from the REAL jobs in that
 * canton: topEmployers, median salary and live counts are all corpus-derived,
 * so each canton page shows genuine local employers.
 *
 * Returns `Record<cantonUrlKey, Record<AnyProfessionId, snapshot>>`. Cached per rootDir.
 */
export function aggregateProfessionJobsByCanton(
  rootDir: string,
  now: number = Date.now(),
): Record<string, Record<AnyProfessionId, ProfessionJobsSnapshot>> {
  if (_cantonSnapshotCache && _cantonCacheRootDir === rootDir) return _cantonSnapshotCache;

  const allJobs = loadJobs(rootDir);
  const byCanton = new Map<string, JobRecord[]>();
  for (const job of allJobs) {
    const key = jobCantonUrlKey(job);
    if (!key) continue;
    const list = byCanton.get(key);
    if (list) list.push(job);
    else byCanton.set(key, [job]);
  }

  const out: Record<string, Record<AnyProfessionId, ProfessionJobsSnapshot>> = {};
  for (const [cantonKey, jobs] of byCanton.entries()) {
    const perProfession = {} as Record<AnyProfessionId, ProfessionJobsSnapshot>;
    for (const id of ALL_CANTON_PROFESSION_IDS) {
      perProfession[id] = buildSnapshotForProfession(jobs, ALL_PROFESSION_MATCHERS[id], now);
    }
    out[cantonKey] = perProfession;
  }

  _cantonSnapshotCache = out;
  _cantonCacheRootDir = rootDir;
  return out;
}

// ── Per-TI-city aggregation (profession × city landings, issue #4301) ──────

let _citySnapshotCache: Record<CityHubKey, Record<ProfessionId, ProfessionJobsSnapshot>> | null = null;
let _cityCacheRootDir: string | null = null;

/**
 * Per-(TI city, profession) snapshot — the same PROFESSION_IDS set
 * aggregateProfessionJobs uses (canton-only ids from #3657 are non-TI
 * professions, out of scope for a TI-city page), filtered to jobs matching
 * BOTH canton=TI (resolveJobCanton) AND the given city
 * (cityJobsHub.jobMatchesCity — same location-substring match the city hub
 * page itself uses, so a city's live count here agrees with its hub).
 *
 * Returns `Record<CityHubKey, Record<ProfessionId, snapshot>>`. Cached per rootDir.
 */
export function aggregateProfessionJobsByCity(
  rootDir: string,
  now: number = Date.now(),
): Record<CityHubKey, Record<ProfessionId, ProfessionJobsSnapshot>> {
  if (_citySnapshotCache && _cityCacheRootDir === rootDir) return _citySnapshotCache;

  const allJobs = loadJobs(rootDir);
  const tiJobs = allJobs.filter((job) => resolveJobCanton(job as { canton?: string; location?: string }) === 'TI');

  const out = {} as Record<CityHubKey, Record<ProfessionId, ProfessionJobsSnapshot>>;
  for (const cityKey of TI_LEGACY_CITY_HUB_KEYS) {
    const cityJobs = tiJobs.filter((job) => jobMatchesCity(job, cityKey));
    const perProfession = {} as Record<ProfessionId, ProfessionJobsSnapshot>;
    for (const id of PROFESSION_IDS) {
      perProfession[id] = buildSnapshotForProfession(cityJobs, PROFESSION_MATCHERS[id], now);
    }
    out[cityKey] = perProfession;
  }

  _citySnapshotCache = out;
  _cityCacheRootDir = rootDir;
  return out;
}

/** Test/CI helper — clear the module-level cache. */
export function _resetProfessionJobsAggregateCache(): void {
  _snapshotCache = null;
  _cacheRootDir = null;
  _cantonSnapshotCache = null;
  _cantonCacheRootDir = null;
  _citySnapshotCache = null;
  _cityCacheRootDir = null;
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

/** Test-only export — exposes the internal projector for unit tests. */
export { toFeatured as toFeaturedForTest };
