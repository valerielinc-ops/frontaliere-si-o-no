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
import { jobMatchesCity, type CityHubKey } from './cityJobsHub';
import { PROFESSION_CITY_DEFS } from './professionCityData';

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
  location?: string;
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
 *
 * ## Stem vs whole word: why a trailing `\b` is not free (#5204, #5205)
 *
 * These alternations mix two kinds of alternative and they need *different*
 * right-hand boundaries:
 *
 * - **stems** (`autist`, `operai`, `impiegat`, `camerier`, `cuoc`, `saldator`)
 *   are prefixes by construction — the inflection is supposed to follow.
 *   A trailing `\b` after the group makes them match nothing at all:
 *   `/\b(autist)\b/` cannot match "Autista", because `t`→`a` is not a word
 *   boundary. Wrapping the whole group in `\b(...)\b` therefore silently
 *   deletes every stem in it.
 * - **whole words** (`engineer`, `cook`, `mason`, `truck driver`) need the
 *   trailing `\b` kept: without it `engineer` swallows "Engineering
 *   Manager" (a field, not the role) and `cook` swallows "Cookie
 *   consent manager".
 *
 * That is why the sibling matchers below that carry no trailing `\b` at all
 * (muratore, psicologo, farmacista, ostetrica, …) never had the bug: their
 * alternations are stem-only. Keep the two kinds separated when editing, and
 * see `tests/profession-matcher-boundaries.test.ts`, which pins both
 * directions with real corpus titles.
 *
 * Second boundary rule: a **leading** `\b` blocks German compounds. `\boptiker`
 * cannot match "Augenoptiker", `\bschweisser` cannot match
 * "Aluminiumschweisser" — in DE the role noun is routinely the tail of a
 * compound, so stems that legitimately appear compounded carry no leading `\b`.
 *
 * Third: Italian job titles are written gender-inclusive with a slash
 * ("Operatore/trice socio sanitario/a", "Tecnico/a di radiologia"), which
 * breaks any literal multi-word phrase. Phrases that must survive it spell the
 * optional `/suffix` out.
 */
const PROFESSION_MATCHERS: Record<ProfessionId, ProfessionMatcher> = {
  infermiere: {
    title: /\b(infermier|krankenpfleg|krankenschwester|pflegefach|pflegehelfer|registered nurse|infirmier|infirmière|fachperson gesundheit)/i,
    // Reject the generic "nurse" assistant titles that aren't RN-grade roles.
    exclude: /\b(assistenzpsycholog|psychotherap|sozialarbeit|tieräpfleg)/i,
  },
  operaio: {
    // Stem-only alternation — the trailing `\b` used to void every entry
    // ("Operaio/a", "Produktionsmitarbeiter:in", "Tornitore" all missed).
    title: /\b(operai|produktionsmitarbeit|production worker|tornitor|fresator|saldator|magazzinier|aiuto-?reparto|lagerist|lagermitarbeit|aiuto-?cucina|hilfsarbeiter)/i,
  },
  impiegato: {
    // Stem-only alternation — see operaio.
    title: /\b(impiegat|sachbearbeiter|kaufm[äa]nn|kauffrau|kfm-?angestellte|administrative assistant|administrative officer|amministrativ|back-?office clerk|front-?office clerk|customer service representative|sekret[äa]r|segretari)/i,
  },
  ingegnere: {
    // The clearest case of the two boundaries pulling opposite ways. The
    // English `engineer` MUST keep its trailing `\b` — without it every
    // "… Engineering Manager" (the field, not the role) lands here. The
    // Italian/French stems must NOT have it, and did: `ingegner\b` matched
    // no Italian title at all, so the entire IT side of this profession was
    // riding on the English alternative. `[eia]\b` admits
    // ingegnere/ingegneri/ingegnera while keeping out "ingegneria" (the
    // discipline); `(?!bau)` keeps out "Ingenieurbau" draughtsman roles.
    title: /\b(?:(ingegner[eia]\b|ing[ée]nieur(?!bau)|ingenieur(?!bau))|(engineer|engineering specialist)\b)/i,
  },
  educatore: {
    title: /\b(educator|educatore|educatrice|erzieher|éducateur|educateur|sozialp[äa]dagog|fachperson betreuung|operatore socio-?educativ|asilo nido|nido d'?infanzia)/i,
  },
  autista: {
    // Stem-only alternation — the trailing `\b` voided `autist` against the
    // only forms that actually occur ("Autista", "Autisti", "Chauffeure").
    title: /\b(autist|chauffeur|conducente|camionist|berufsfahrer|lkw-?fahrer|truck driver|delivery driver)/i,
  },
  muratore: {
    title: /\b(murator|maurer|mason|maçon|macon|carpentier|carpentiere|bauarbeiter|construction worker|capomastr|casserator)/i,
  },
  cuoco: {
    // Split boundary: `cook` and `koch` MUST stay whole-word — without the
    // trailing `\b`, `cook` matches "Cookie consent manager" and `koch`
    // matches "Kochfunktion". The Italian/French stems must NOT have it.
    title: /\b(?:(cuoc|pizzaiol|capo cuoc|cuisinier|küchenchef)|(koch|cook|chef de partie|chef de cuisine|sous chef)\b)/i,
    // "Chef de rang" / "Chef de Réception" are hospitality service titles, not kitchen.
    exclude: /\b(chef de rang|chef de réception|chef d'équipe|chef de service|chef sommelier)\b/i,
  },
  cameriere: {
    // Stem-only alternation — see operaio. The `impiegat/collaborat …
    // ristorazione` alternative catches the official Swiss job-title forms
    // EOC uses ("Impiegato/a della ristorazione", "Collaboratore/trice di
    // ristorazione") that carry no camerier/kellner/waiter stem at all (#5413).
    title: /\b(camerier|kellner|waiter|waitress|serveur|serveuse|chef de rang|commis de salle|barista|barkeeper|(?:impiegat|collaborat)\S*\s+(?:di|della)\s+ristorazione)/i,
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
    // "Tecnico/a di radiologia medica" and "Tecnici / tecniche di radiologia"
    // are how EOC actually writes it — the bare literal matched neither.
    title: /(radiologiefach|fachperson mtr|tecnic[oi](?:\/\w+)?(?:\s*\/\s*tecnich[ei])?\s+di\s+radiologia|technicien en radiologie|radiographer|\bmtra\b)/i,
    // Reject physician titles (Radiologe / medico radiologo are MDs, not TRM).
    exclude: /\b(arzt|ärztin|medico|facharzt|oberarzt)\b/i,
  },
  oss: {
    // `operat(ore|rice) socio` required a literal single space, so the two
    // forms EOC/LIS actually publish were both invisible: the gender-inclusive
    // slash ("Operatore/trice socio sanitario/a") and the closed compound
    // ("Operatori Sociosanitari"). Note `socio` stays open-ended, as before,
    // so socio-assistenziale keeps resolving here — consistent with
    // SECTOR_MATCHERS.oss, which already lists `operatore socio assistenz`.
    title: /(\boss\b|operat(?:ore|rice|ori|rici)(?:\/\w+)?\s+socio|socio-?sanitari|sociosanitari|fachfrau gesundheit|fachmann gesundheit|\bfage\b|assistant en soins|aide-?soignant)/i,
  },
  'ottico-optometrista': {
    // No leading `\b` on the DE/FR stems: the role noun is the tail of a
    // compound ("Augenoptiker", "Augenoptikerin"). `ottic[oa]` keeps both
    // boundaries — it is a bare adjective in Italian and needs them.
    title: /(\bottic[oa]\b|optometrist|optiker|opticien)/i,
    // "ottico/ottica" is a common bare adjective in physics/tech titles
    // (fibra ottica, sensore ottico, ottica adattiva) — reject those so the
    // landing only features eyewear-profession ads.
    exclude: /(ottica adattiva|fibra ottic|sensore ottic|microscopio ottic|lettore ottic|cavo ottic|disco ottic|amplificatore ottic|ricercator|postdoc|dottorato|fisica|physics|laser)/i,
  },
  contabile: {
    title: /\b(contabil|buchhalt|comptab|accountant|accounting)/i,
  },
  'assistente-sociale': {
    // `assistente sociale` was singular-only and missed the plural/feminine
    // Swiss job-posting forms ("Assistenti Sociali", "Assistente/a
    // Sociale") — `assistent[ei] social[ei]` covers both without letting in
    // unrelated "sociale" adjectives (#5413).
    title: /\b(assistent[ei] social[ei]|sozialarbeit|sozialp[äa]dagog|assistant social|social worker)/i,
  },
  macellaio: {
    title: /\b(macella|metzger|fleischfach|boucher\b|butcher)/i,
  },
  saldatore: {
    // No leading `\b`: DE compounds the role noun ("Aluminiumschweisser").
    title: /(saldator|schweisser|schweißer|soudeur|welder)/i,
  },
  architetto: {
    // `architetto\b` missed the plural/feminine ("architetti", "architetta");
    // `architett[oaie]\b` catches them without letting in "Architettura", the
    // discipline. `architekt(?!ur)` does the same job for DE and additionally
    // covers the inclusive suffixes (ArchitektIn, Architekt:in, Architekt/-in)
    // the old hand-listed group only half-covered.
    title: /\b(architett[oaie]\b|architekt(?!ur)|architecte)/i,
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

// Canonical `job.title` only — deliberately excludes `titleByLocale`. This
// match feeds a single job pool shared across every locale's profession
// page, so a mistranslation in any one locale's title must never be able
// to pull an unrelated job in. Every job carries a canonical `job.title`
// (confirmed against the live dataset), so this costs no matching
// coverage. See #4715 (same construct fixed in
// jobSectorLanding.ts::jobMatchesSector).
function jobMatchesProfession(job: JobRecord, m: ProfessionMatcher): boolean {
  const haystacks: string[] = [];
  if (job.title) haystacks.push(job.title);
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

// ── Recently-expired counts (job floor grace window, #5322) ──────────────────

/**
 * Count, per profession, the TI openings that matched recently but have since
 * expired — the grace half of the legacy TI job floor
 * (`shared/professionJobsFloor.ts`).
 *
 * Reads `data/expired-jobs.json`, the archive every job lands in when it leaves
 * the active set (`scripts/lib/expired-jobs-archive.mjs` stamps `expiredAt` at
 * that moment). That makes it the cheapest honest answer to "was this
 * profession empty, or did the feed just blink?": a crawler that fails one
 * round moves its jobs here rather than deleting them, so they keep counting
 * for `withinDays`.
 *
 * Uses the exact same matcher table and TI predicate as
 * `aggregateProfessionJobs`, so the two halves of the floor are commensurable
 * — an expired job counts if and only if it would have counted while active.
 *
 * Returns `null` — NOT an empty tally — when the archive is missing or
 * unparseable. Those are the states a broken build is in, and callers must be
 * able to tell them apart from a genuine zero: see `meetsJobsFloor`, which
 * fails open on `null` rather than flipping live pages to `noindex` on the
 * strength of a file it could not read.
 */
export function aggregateRecentlyExpiredProfessionCounts(
  rootDir: string,
  withinDays: number,
  now: number = Date.now(),
): Record<ProfessionId, number> | null {
  const expiredPath = np.join(rootDir, 'data', 'expired-jobs.json');
  if (!fs.existsSync(expiredPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(expiredPath, 'utf-8'));
  } catch (err) {
    console.warn('[profession-aggregate] failed to read expired-jobs.json:', err);
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const cutoff = now - withinDays * DAY_MS;
  const recentTi = (parsed as Array<JobRecord & { expiredAt?: string }>).filter((job) => {
    const ts = Date.parse(job?.expiredAt ?? '');
    if (!Number.isFinite(ts) || ts < cutoff) return false;
    return resolveJobCanton(job as { canton?: string; location?: string }) === 'TI';
  });

  const out = {} as Record<ProfessionId, number>;
  for (const id of PROFESSION_IDS) {
    const matcher = PROFESSION_MATCHERS[id];
    let n = 0;
    for (const job of recentTi) {
      if (jobMatchesProfession(job, matcher)) n++;
    }
    out[id] = n;
  }
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

// ── Per-city aggregation (profession × city landings, issues #4301 + #4488) ──

let _citySnapshotCache: Record<CityHubKey, Record<ProfessionId, ProfessionJobsSnapshot>> | null = null;
let _cityCacheRootDir: string | null = null;

/** ASCII-fold + lowercase — makes "Zürich"/"Genève" match "zurich"/"geneve". */
function asciiLower(s: string): string {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Non-TI city location match. Unlike cityJobsHub.jobMatchesCity (raw lowercase
 * substring — safe for the ASCII TI city names) this ASCII-folds BOTH sides so
 * a job in "Zürich" / "Genève" matches the folded slug "zurich" / "geneve".
 * Callers pre-filter by canton so short needles ("bern") can't cross-match a
 * same-named town in another canton (e.g. Bernex in GE).
 */
function jobMatchesChCity(job: JobRecord, display: string): boolean {
  const needle = asciiLower(display);
  if (!needle) return false;
  const candidates = [job.addressLocality, job.location]
    .map((v) => (typeof v === 'string' ? asciiLower(v) : ''))
    .filter(Boolean);
  return candidates.some((c) => c.includes(needle));
}

/**
 * Per-(city, profession) snapshot for the profession × city landings — the
 * same PROFESSION_IDS set aggregateProfessionJobs uses (canton-only ids from
 * #3657 are out of scope for a city page). Iterates PROFESSION_CITY_DEFS:
 * each city's jobs are those matching BOTH its canton (resolveJobCanton, which
 * collapses half-cantons to the URL group so Basel jobs resolve to 'BASILEA')
 * AND the city itself. The 5 legacy TI hubs keep the exact TI predicate
 * (resolveJobCanton === 'TI' + cityJobsHub.jobMatchesCity) so their snapshots
 * stay byte-identical to issue #4301; the 6 major CH cities (#4488) use the
 * ASCII-folding city match above.
 *
 * Returns `Record<CityHubKey, Record<ProfessionId, snapshot>>`. Cached per rootDir.
 */
export function aggregateProfessionJobsByCity(
  rootDir: string,
  now: number = Date.now(),
): Record<CityHubKey, Record<ProfessionId, ProfessionJobsSnapshot>> {
  if (_citySnapshotCache && _cityCacheRootDir === rootDir) return _citySnapshotCache;

  const allJobs = loadJobs(rootDir);

  const out = {} as Record<CityHubKey, Record<ProfessionId, ProfessionJobsSnapshot>>;
  for (const def of PROFESSION_CITY_DEFS) {
    const cantonJobs = allJobs.filter(
      (job) => resolveJobCanton(job as { canton?: string; location?: string }) === def.cantonUrlKey,
    );
    const cityJobs = def.isTi
      ? cantonJobs.filter((job) => jobMatchesCity(job, def.key))
      : cantonJobs.filter((job) => jobMatchesChCity(job, def.display));
    const perProfession = {} as Record<ProfessionId, ProfessionJobsSnapshot>;
    for (const id of PROFESSION_IDS) {
      perProfession[id] = buildSnapshotForProfession(cityJobs, PROFESSION_MATCHERS[id], now);
    }
    out[def.key] = perProfession;
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
