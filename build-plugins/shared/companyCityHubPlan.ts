/**
 * Per-canton company × city hub plan: which `/{section}/azienda-{company}-{city}/`
 * pages exist, computed ONCE and shared by the emitter and by every page that
 * links them.
 *
 * Why it exists (2026-10-02). `jobsSeoPagesPlugin` Phase 3.4 emitted these
 * hubs and listed them in `sitemap-jobs.xml` (priority 0.65), but no page
 * linked to them: the bucket that decided which hubs exist lived inside the
 * emitter loop, so no other template could know the set. Measured on build
 * f3659686 (deploy run 36965808597): 3 112 of the 16 194 URLs in
 * `sitemap-jobs.xml` are company × city hubs; in the Zurich section all 587
 * of them had zero inbound links, and they were 587 of the 718 Zurich URLs
 * `audit:max-bfs-depth` counts as buried (deeper than 4 or unreachable from
 * `/`). Google discovers pages through links ("Every page you care about
 * should have a link from at least one other page"); a sitemap is a hint.
 *
 * Now the plan is built before the city hubs (Phase 3.1) and read by:
 *   - Phase 3.1 city hubs → "companies hiring in {city}" links, one per
 *     emitted company × city hub of that city (city hubs sit one click below
 *     the canton hub's navigator);
 *   - Phase 3.3 per-canton company hubs → "{company} locations" links;
 *   - Phase 3.4 itself → the set of pages to emit.
 * A link can therefore never point at a page that is not emitted, and an
 * emitted page can never lack its parents' links.
 *
 * Pure: every project-specific rule (canton resolution, company slug, city
 * slug) is injected, so the module has no build-time imports.
 */

/** Floor below which a (company, city) pair gets a noindex bridge, not a hub. */
export const MIN_JOBS_PER_CANTON_COMPANY_CITY = 2;

export interface CompanyCityBucket<J> {
  /** Company display name (first job seen). */
  readonly name: string;
  /** City display name, as written in the first job's location. */
  readonly cityDisplay: string;
  readonly jobs: J[];
}

/** canton → company slug → city slug → bucket. */
export type CompanyCityPlan<J> = Map<string, Map<string, Map<string, CompanyCityBucket<J>>>>;

export interface CompanyCityKeyDeps<J> {
  /** Canton code of the job (e.g. `ZH`). */
  resolveCanton(job: J): string;
  /** Canonical company hub slug of the job, or '' when it has none. */
  companySlug(job: J): string;
  /** Raw location string of the job. */
  location(job: J): string;
  /** Company display name of the job. */
  company(job: J): string;
  /** City slug of a raw location (`normalizeCitySlug`). */
  citySlug(rawLocation: string): string;
}

/** The location part a company × city hub is keyed on: text before `,` or `(`. */
export function companyCityRawLocation(location: unknown): string {
  return String(location || '').split(/[,(]/)[0].trim();
}

/** Key of a job's company × city hub, or null when the job has none. */
export function companyCityKeyOf<J>(
  job: J,
  deps: CompanyCityKeyDeps<J>,
): { canton: string; companySlug: string; citySlug: string; rawLocation: string } | null {
  const canton = deps.resolveCanton(job);
  if (!canton || canton === 'TI') return null;
  const companySlug = deps.companySlug(job);
  if (!companySlug) return null;
  const rawLocation = companyCityRawLocation(deps.location(job));
  if (!rawLocation) return null;
  const citySlug = deps.citySlug(rawLocation);
  if (!citySlug) return null;
  return { canton, companySlug, citySlug, rawLocation };
}

/**
 * Bucket every job by (canton, company, city). TI is excluded: any
 * `/cerca-lavoro-ticino/azienda-…` URL already belongs to a TI company hub.
 */
export function buildCompanyCityPlan<J>(jobs: Iterable<J>, deps: CompanyCityKeyDeps<J>): CompanyCityPlan<J> {
  const plan: CompanyCityPlan<J> = new Map();
  for (const job of jobs) {
    const key = companyCityKeyOf(job, deps);
    if (!key) continue;
    let byCompany = plan.get(key.canton);
    if (!byCompany) plan.set(key.canton, (byCompany = new Map()));
    let byCity = byCompany.get(key.companySlug);
    if (!byCity) byCompany.set(key.companySlug, (byCity = new Map()));
    let bucket = byCity.get(key.citySlug);
    if (!bucket) {
      bucket = { name: deps.company(job), cityDisplay: key.rawLocation, jobs: [] };
      byCity.set(key.citySlug, bucket);
    }
    bucket.jobs.push(job);
  }
  return plan;
}

/** True when the pair renders a real (indexable) hub rather than a bridge. */
export function isEmittedCompanyCityHub<J>(bucket: CompanyCityBucket<J> | undefined): boolean {
  return !!bucket && bucket.jobs.length >= MIN_JOBS_PER_CANTON_COMPANY_CITY;
}

export interface CompanyCityLink {
  readonly companySlug: string;
  readonly citySlug: string;
  readonly companyName: string;
  readonly cityDisplay: string;
  readonly count: number;
}

function byCountThenName(a: CompanyCityLink, b: CompanyCityLink): number {
  if (a.count !== b.count) return b.count - a.count;
  return a.companyName.localeCompare(b.companyName) || a.citySlug.localeCompare(b.citySlug);
}

/**
 * Emitted company × city hubs among the given jobs (a city hub passes ALL its
 * jobs, not the capped card list, so no hub of that city is left out).
 */
export function companyCityLinksForJobs<J>(
  plan: CompanyCityPlan<J>,
  jobs: Iterable<J>,
  deps: CompanyCityKeyDeps<J>,
): CompanyCityLink[] {
  const seen = new Map<string, CompanyCityLink>();
  for (const job of jobs) {
    const key = companyCityKeyOf(job, deps);
    if (!key) continue;
    const id = `${key.canton}|${key.companySlug}|${key.citySlug}`;
    if (seen.has(id)) continue;
    const bucket = plan.get(key.canton)?.get(key.companySlug)?.get(key.citySlug);
    if (!isEmittedCompanyCityHub(bucket)) continue;
    seen.set(id, {
      companySlug: key.companySlug,
      citySlug: key.citySlug,
      companyName: bucket!.name,
      cityDisplay: bucket!.cityDisplay,
      count: bucket!.jobs.length,
    });
  }
  return [...seen.values()].sort(byCountThenName);
}

/** Emitted company × city hubs of one company in one canton. */
export function companyCityLinksForCompany<J>(
  plan: CompanyCityPlan<J>,
  canton: string,
  companySlug: string,
): CompanyCityLink[] {
  const byCity = plan.get(canton)?.get(companySlug);
  if (!byCity) return [];
  const out: CompanyCityLink[] = [];
  for (const [citySlug, bucket] of byCity) {
    if (!isEmittedCompanyCityHub(bucket)) continue;
    out.push({ companySlug, citySlug, companyName: bucket.name, cityDisplay: bucket.cityDisplay, count: bucket.jobs.length });
  }
  return out.sort((a, b) => (b.count - a.count) || a.cityDisplay.localeCompare(b.cityDisplay) || a.citySlug.localeCompare(b.citySlug));
}

type HubLocale = 'it' | 'en' | 'de' | 'fr';

function escHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function jobsCountLabel(locale: HubLocale, n: number): string {
  if (locale === 'it') return `${n} offert${n === 1 ? 'a' : 'e'}`;
  if (locale === 'en') return `${n} job${n === 1 ? '' : 's'}`;
  if (locale === 'de') return `${n} Stelle${n === 1 ? '' : 'n'}`;
  return `${n} offre${n === 1 ? '' : 's'}`;
}

/** Heading of the block on a city hub. */
export function companyCityCityHubHeading(locale: HubLocale, cityDisplay: string): string {
  if (locale === 'it') return `Aziende che assumono a ${cityDisplay}`;
  if (locale === 'en') return `Companies hiring in ${cityDisplay}`;
  if (locale === 'de') return `Arbeitgeber mit offenen Stellen in ${cityDisplay}`;
  return `Entreprises qui recrutent à ${cityDisplay}`;
}

/** Heading of the block on a per-canton company hub. */
export function companyCityCompanyHubHeading(locale: HubLocale, companyName: string): string {
  if (locale === 'it') return `Sedi di ${companyName} con offerte attive`;
  if (locale === 'en') return `${companyName} locations with open jobs`;
  if (locale === 'de') return `Standorte von ${companyName} mit offenen Stellen`;
  return `Sites de ${companyName} avec des offres actives`;
}

/**
 * The link block, or '' when there is nothing to link. `labelOf` picks the
 * anchor text (company name on a city hub, city name on a company hub), so
 * every anchor is descriptive. `hrefOf` must be the emitter's own path
 * builder, so link and page cannot drift.
 */
export function renderCompanyCityLinks(
  links: readonly CompanyCityLink[],
  locale: HubLocale,
  heading: string,
  labelOf: (link: CompanyCityLink) => string,
  hrefOf: (link: CompanyCityLink) => string,
): string {
  if (links.length === 0) return '';
  const items = links
    .map((link) => `<li><a href="${escHtml(hrefOf(link))}">${escHtml(labelOf(link))}</a> — ${escHtml(jobsCountLabel(locale, link.count))}</li>`)
    .join('');
  return `<section class="s-7uP4UM"><h2>${escHtml(heading)}</h2><ul>${items}</ul></section>`;
}
