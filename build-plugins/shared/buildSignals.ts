/**
 * Build-phase synchronisation signals shared across Vite plugins.
 *
 * Vite/Rollup runs `closeBundle` hooks IN PARALLEL via `hookParallel`, so even
 * with `enforce: 'post'` two plugins that both write to the same file paths
 * race against each other. The `WriteCollector.add()` API is synchronous but
 * auto-flushes in the background once the pending queue crosses 5 000 writes,
 * which means a target file can be written by a background batch BEFORE the
 * plugin's own `closeBundle` reaches its final `await collector.flush()`.
 *
 * Post-injection plugins (e.g. `professionLandingsLinksPlugin`) need a
 * deterministic way to wait until every write to their target files has
 * landed on disk. This module exposes one explicit signal per source plugin
 * so consumers can `await` instead of polling for `mtime` stability.
 *
 * Usage:
 *
 *   // Producer plugin (e.g. staticPagesPlugin):
 *   await collector.flush();
 *   resolveStaticPagesFlushed();
 *
 *   // Consumer plugin (e.g. professionLandingsLinksPlugin):
 *   await staticPagesFlushed;
 *   // …safe to read/patch the files staticPagesPlugin wrote.
 *
 * Signals are intentionally NEVER rejected — a plugin failure should surface
 * via the producer's own thrown error, not via a downstream consumer awaiting
 * forever. If a producer fails before resolving, every other process is
 * already terminating because Vite propagates the original error.
 *
 * Idempotency: each `resolve*()` is a no-op when called twice (Vite may run
 * `closeBundle` once per build, but tests / dev-mode can re-invoke). The
 * underlying Promise resolves to the first value passed.
 */

function makeSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolveFn: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  let resolved = false;
  return {
    promise,
    resolve: () => {
      if (resolved) return;
      resolved = true;
      resolveFn();
    },
  };
}

/** Like {@link makeSignal} but carries a value to the awaiting consumer. */
function makeValueSignal<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolveFn: (v: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  let resolved = false;
  return {
    promise,
    resolve: (v: T) => {
      if (resolved) return;
      resolved = true;
      resolveFn(v);
    },
  };
}

const staticPagesSignal = makeSignal();
const professionLandingsSignal = makeSignal();
const salaryHubSignal = makeSignal();
const jobsSeoPagesSignal = makeSignal();
const sectorPagesSignal = makeSignal();
const professionCantonsSignal = makeValueSignal<readonly string[]>();
const professionCitiesSignal = makeValueSignal<readonly string[]>();
const bfsSalarySignal = makeValueSignal<readonly string[]>();
const salaryProfessionCantonsSignal = makeValueSignal<readonly string[]>();
const salaryStatsSignal = makeSignal();

/** A health facility emitted as a full (above-floor) indexable page. */
export interface EmittedFacility {
  readonly slug: string;
  readonly canton: string;
  readonly name: string;
  readonly liveCount: number;
}

const nursingLandingsSignal = makeSignal();
const healthFacilitiesSignal = makeValueSignal<readonly EmittedFacility[]>();

/** An indexable employer-profile page emitted this build, one entry per locale. */
export interface EmittedEmployerProfile {
  readonly locale: 'it' | 'en' | 'de' | 'fr';
  readonly path: string;
  readonly label: string;
}

const employerProfilesSignal = makeValueSignal<readonly EmittedEmployerProfile[]>();
const fiscalMunicipalitiesSignal = makeValueSignal<readonly string[]>();
const frenchBorderMunicipalitiesSignal = makeValueSignal<readonly string[]>();
const germanBorderMunicipalitiesSignal = makeValueSignal<readonly string[]>();
const liechtensteinBorderMunicipalitiesSignal = makeValueSignal<readonly string[]>();
const austrianBorderMunicipalitiesSignal = makeValueSignal<readonly string[]>();

/** Resolves when {@link staticPagesPlugin} has flushed all its queued writes. */
export const staticPagesFlushed: Promise<void> = staticPagesSignal.promise;
export function resolveStaticPagesFlushed(): void {
  staticPagesSignal.resolve();
}

/** Resolves when {@link professionLandingsPlugin} has finished writing the 40 landings. */
export const professionLandingsFlushed: Promise<void> = professionLandingsSignal.promise;
export function resolveProfessionLandingsFlushed(): void {
  professionLandingsSignal.resolve();
}

/**
 * Resolves when {@link salaryHubPlugin} has flushed every salary scenario,
 * evergreen article AND the new browseable scenario index pages
 * (`/calcola-stipendio/scenari/` + 3 locale twins).
 *
 * Consumed by {@link salaryHubIndexLinkPlugin} which patches the calculator
 * hub HTML produced by {@link staticPagesPlugin} so BFS from `/` can reach
 * the scenario index (and through it, all 1 732 scenario pages — closing
 * the `sitemap-salary-hub.xml` orphan gap flagged by Semrush).
 */
export const salaryHubFlushed: Promise<void> = salaryHubSignal.promise;
export function resolveSalaryHubFlushed(): void {
  salaryHubSignal.resolve();
}

/**
 * Resolves when {@link jobsSeoPagesPlugin} has flushed all queued writes,
 * including previousSlugs bridge HTML. Consumed by
 * {@link relatedSearchClustersPlugin} so its sitemap canonical-mismatch
 * filter reads the final on-disk content. Without this barrier, parallel
 * `closeBundle` lets the cluster sitemap be written while bridge HTML is
 * still buffered, and bridge URLs (canonical → active slug) leak into
 * sitemap-search-clusters.xml — `audit:sitemap-canonicals` then fails.
 */
export const jobsSeoPagesFlushed: Promise<void> = jobsSeoPagesSignal.promise;
export function resolveJobsSeoPagesFlushed(): void {
  jobsSeoPagesSignal.resolve();
}

/**
 * Resolves when {@link jobSectorPagesPlugin} has written every sector-hub
 * landing (49 sectors × 4 locales). Consumed by {@link sectorHubLinksPlugin},
 * which patches the 4 job-board hub pages with an `<aside>` listing the
 * highest-demand sector hubs so BFS from `/` reaches them (today the root hub
 * links the sector INDEX once but none of the 49 sector-hub canonicals → ~37
 * are orphaned with ~0 internal links). Awaiting this barrier guarantees the
 * link targets exist on disk before we inject anchors to them, mirroring the
 * salaryHubFlushed → salaryHubIndexLinkPlugin contract.
 */
export const sectorPagesFlushed: Promise<void> = sectorPagesSignal.promise;
export function resolveSectorPagesFlushed(): void {
  sectorPagesSignal.resolve();
}

/**
 * Resolves with the list of canonical paths {@link professionCantonLandings}
 * actually wrote this build (job-floor gated → a data-dependent subset of the
 * enumerated routes). Consumed by {@link professionCantonLandingsLinksPlugin},
 * which injects a "same role, other cantons" link block into the per-locale
 * HTML sitemap pages so BFS-from-`/` reaches every emitted page at depth ≤ 3
 * (closing the `sitemap-profession-cantons.xml` orphan tier flagged by
 * `audit:max-bfs-depth`).
 */
export const professionCantonsFlushed: Promise<readonly string[]> =
  professionCantonsSignal.promise;
export function resolveProfessionCantonsFlushed(paths: readonly string[]): void {
  professionCantonsSignal.resolve(paths);
}

/**
 * Resolves with the list of canonical paths {@link professionCityLandings}
 * actually wrote this build (job-floor + word-count gated subset of the
 * enumerated profession×city routes). Consumed by
 * {@link professionCityLinksPlugin}, which injects a "jobs by city and
 * profession" link block into the per-locale HTML sitemap pages so
 * BFS-from-`/` reaches every emitted page (closes the
 * `sitemap-profession-cities.xml` orphan tier flagged by
 * `audit:max-bfs-depth`, 62.65% unreachable), mirroring the
 * professionCantonsFlushed contract.
 */
export const professionCitiesFlushed: Promise<readonly string[]> =
  professionCitiesSignal.promise;
export function resolveProfessionCitiesFlushed(paths: readonly string[]): void {
  professionCitiesSignal.resolve(paths);
}

/**
 * Resolves with every non-thin page path {@link bfsSalaryLandingsPlugin}
 * actually wrote this build (age-anchor + education-level landings, all
 * locales). The family only cross-links its own 3-nearest siblings (a
 * disconnected island with no external inbound link), so it shipped
 * 55.56% unreachable per `audit:max-bfs-depth`. Consumed by
 * {@link bfsSalaryLinksPlugin}, which — since the whole family is only
 * ~9 identities × 4 locales — links every one of them directly from the
 * per-locale HTML sitemap page rather than relying on ring propagation.
 */
export const bfsSalaryFlushed: Promise<readonly string[]> = bfsSalarySignal.promise;
export function resolveBfsSalaryFlushed(paths: readonly string[]): void {
  bfsSalarySignal.resolve(paths);
}

/** An indexable, non-canary publisher-ad detail page emitted this build. */
export interface EmittedPublisherAd {
  readonly locale: 'it' | 'en' | 'de' | 'fr';
  readonly path: string;
  readonly label: string;
}

const publisherAdsSignal = makeValueSignal<readonly EmittedPublisherAd[]>();

/**
 * Resolves with every indexable, non-canary `/lavoro/{slug}/` publisher-ad
 * page {@link publisherAdPagesPlugin} wrote this build. Paid ad content with
 * no crawlable inbound link anywhere on the site (job-card renderers build
 * their own canton/section href rather than respecting a publisher ad's own
 * URL) — currently only 1 URL, but 100% unreachable per
 * `audit:max-bfs-depth`, and revenue-critical (CLAUDE.md §7-adjacent: paid
 * content must be discoverable). Consumed by {@link publisherAdLinksPlugin},
 * which injects a CTA into the per-locale HTML sitemap page, mirroring the
 * professionCantonsFlushed contract.
 */
export const publisherAdsFlushed: Promise<readonly EmittedPublisherAd[]> =
  publisherAdsSignal.promise;
export function resolvePublisherAdsFlushed(ads: readonly EmittedPublisherAd[]): void {
  publisherAdsSignal.resolve(ads);
}

/**
 * Resolves once {@link nursingLandingsPlugin} has flushed its landing pages.
 * Consumed by {@link healthFacilitiesLinksPlugin} so it can safely read +
 * patch the nursing landing HTML on disk before injecting the "facilities
 * hiring near you" cross-link block (mirrors the staticPagesFlushed →
 * professionLandingsLinksPlugin barrier contract).
 */
export const nursingLandingsFlushed: Promise<void> = nursingLandingsSignal.promise;
export function resolveNursingLandingsFlushed(): void {
  nursingLandingsSignal.resolve();
}

/**
 * Resolves with the list of above-floor health facilities that
 * {@link healthFacilitiesPlugin} emitted this build (a data-dependent subset
 * of the committed registry). Consumed by {@link healthFacilitiesLinksPlugin},
 * which links the nursing landings to them — never to a below-floor facility.
 */
export const healthFacilitiesFlushed: Promise<readonly EmittedFacility[]> =
  healthFacilitiesSignal.promise;
export function resolveHealthFacilitiesFlushed(facilities: readonly EmittedFacility[]): void {
  healthFacilitiesSignal.resolve(facilities);
}

/**
 * Resolves with the list of canonical paths {@link salaryProfessionCantonPages}
 * actually wrote this build (median-preset + job-floor gated subset of the
 * enumerated salary-intent routes). Consumed by
 * {@link salaryProfessionCantonLinksPlugin}, which injects a "salary by
 * profession and canton" link block into the per-locale HTML sitemap pages so
 * BFS-from-`/` reaches every emitted page (closing the
 * `sitemap-salary-profession-cantons.xml` orphan tier flagged by
 * `audit:max-bfs-depth`), mirroring the professionCantonsFlushed contract.
 */
export const salaryProfessionCantonsFlushed: Promise<readonly string[]> =
  salaryProfessionCantonsSignal.promise;
export function resolveSalaryProfessionCantonsFlushed(paths: readonly string[]): void {
  salaryProfessionCantonsSignal.resolve(paths);
}

/**
 * Resolves when {@link salaryStatsChCantonPages} has flushed every per-canton
 * salary-stats hub page (`/stipendi-{canton}/` + locale twins). Consumed by
 * {@link salaryProfessionCantonLinksPlugin}, which patches each canton hub with
 * a "salary by profession" spoke block (hub→spoke half of the bidirectional
 * hub-spoke rule, docs/SALARY-INTENT-CANONICAL-PLAN.md §4.2), so the hub pages
 * are guaranteed on disk before the patch reads them.
 */
export const salaryStatsFlushed: Promise<void> = salaryStatsSignal.promise;
export function resolveSalaryStatsFlushed(): void {
  salaryStatsSignal.resolve();
}

/**
 * Resolves with every indexable `/aziende/{slug}/` employer-profile page
 * {@link employerProfilePagesPlugin} wrote this build (one entry per
 * indexable locale — below-floor noindex bridges excluded). Consumed by
 * {@link employerProfilePagesLinksPlugin}, which injects a "Lavorare in..."
 * link block into the per-locale HTML sitemap pages so BFS-from-`/` reaches
 * every emitted page (closes the `sitemap-employer-profiles.xml` orphan tier
 * flagged by `audit:max-bfs-depth`, 468/468 unreachable), mirroring the
 * professionCantonsFlushed contract. Carries `label` (the company display
 * name) directly since the URL slug is a one-way hash of it.
 */
export const employerProfilesFlushed: Promise<readonly EmittedEmployerProfile[]> =
  employerProfilesSignal.promise;
export function resolveEmployerProfilesFlushed(profiles: readonly EmittedEmployerProfile[]): void {
  employerProfilesSignal.resolve(profiles);
}

/**
 * Resolves with every indexable `/tasse-frontalieri-comune/{slug}/` page
 * {@link fiscalMunicipalityPagesPlugin} wrote this build (below-floor
 * bridges excluded). `fiscalMunicipalityPagesPlugin` never published a
 * completion signal at all — unlike every sibling SEO-landing family, no
 * plugin ever linked INTO the 4 locale `FISCAL_HUB_PATH` hub pages (the hub
 * itself already links every above-floor comune below it), so the whole
 * `sitemap-comuni-fiscale.xml` shard shipped 33/33 unreachable from `/`
 * (audit:max-bfs-depth regression #4593). Consumed by
 * {@link fiscalMunicipalityLinksPlugin}, which injects a hub link into the
 * per-locale HTML sitemap pages — mirrors the professionCantonsFlushed /
 * employerProfilesFlushed contract exactly.
 */
export const fiscalMunicipalitiesFlushed: Promise<readonly string[]> =
  fiscalMunicipalitiesSignal.promise;
export function resolveFiscalMunicipalitiesFlushed(paths: readonly string[]): void {
  fiscalMunicipalitiesSignal.resolve(paths);
}

/**
 * Resolves with every indexable French border-municipality page
 * {@link frenchBorderMunicipalityPagesPlugin} wrote this build (below-floor
 * bridges excluded). Same orphan-tier hazard as
 * {@link fiscalMunicipalitiesFlushed} above (the hub already links every
 * above-floor commune below it, but nothing links INTO the hub) — consumed
 * by {@link frenchBorderMunicipalityLinksPlugin}, which injects a hub link
 * into the per-locale HTML sitemap pages.
 */
export const frenchBorderMunicipalitiesFlushed: Promise<readonly string[]> =
  frenchBorderMunicipalitiesSignal.promise;
export function resolveFrenchBorderMunicipalitiesFlushed(paths: readonly string[]): void {
  frenchBorderMunicipalitiesSignal.resolve(paths);
}

/**
 * Resolves with every indexable German border-municipality page
 * {@link germanBorderMunicipalityPagesPlugin} wrote this build (below-floor
 * bridges excluded). Same orphan-tier hazard/contract as
 * {@link frenchBorderMunicipalitiesFlushed} — consumed by
 * {@link germanBorderMunicipalityLinksPlugin}, which injects a hub link
 * into the per-locale HTML sitemap pages.
 */
export const germanBorderMunicipalitiesFlushed: Promise<readonly string[]> =
  germanBorderMunicipalitiesSignal.promise;
export function resolveGermanBorderMunicipalitiesFlushed(paths: readonly string[]): void {
  germanBorderMunicipalitiesSignal.resolve(paths);
}

/**
 * Resolves with every indexable Liechtenstein border-municipality page
 * {@link liechtensteinBorderMunicipalityPagesPlugin} wrote this build
 * (below-floor bridges excluded). Same orphan-tier hazard/contract as
 * {@link frenchBorderMunicipalitiesFlushed} — consumed by
 * {@link liechtensteinBorderMunicipalityLinksPlugin}, which injects a hub
 * link into the per-locale HTML sitemap pages.
 */
export const liechtensteinBorderMunicipalitiesFlushed: Promise<readonly string[]> =
  liechtensteinBorderMunicipalitiesSignal.promise;
export function resolveLiechtensteinBorderMunicipalitiesFlushed(paths: readonly string[]): void {
  liechtensteinBorderMunicipalitiesSignal.resolve(paths);
}

/**
 * Resolves with every indexable Austrian border-municipality page
 * {@link austrianBorderMunicipalityPagesPlugin} wrote this build (below-floor
 * bridges excluded). Same orphan-tier hazard/contract as
 * {@link frenchBorderMunicipalitiesFlushed} — consumed by
 * {@link austrianBorderMunicipalityLinksPlugin}, which injects a hub link
 * into the per-locale HTML sitemap pages.
 */
export const austrianBorderMunicipalitiesFlushed: Promise<readonly string[]> =
  austrianBorderMunicipalitiesSignal.promise;
export function resolveAustrianBorderMunicipalitiesFlushed(paths: readonly string[]): void {
  austrianBorderMunicipalitiesSignal.resolve(paths);
}
