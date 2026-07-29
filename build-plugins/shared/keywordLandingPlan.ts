/**
 * keywordLandingPlan — the set of GSC keyword-landing URLs this build actually
 * emits, in EVERY locale, registered by the plugins that own them.
 *
 * The defect this closes
 * ----------------------
 * `audit:hreflang` reported 75 `missingTarget` offenders on post-deploy run
 * 30376520728: pages serving `<link rel="alternate">` for locale siblings that
 * do not exist. Example verified on production —
 * `/fr/trouver-emploi-tessin/recherche-groupe-mutuel-emploi/` serves 200 with
 * four alternates while its IT, EN and DE siblings all 301.
 *
 * The `/{section}/{ricerca|search|suche|recherche}-{slug}/` family is emitted
 * per locale from per-locale query data, so a keyword that earns a landing in
 * FR need not earn one in IT. The emitter still writes the full four-locale
 * alternate set. In a single-process build `hreflangGuard` would catch that:
 * it stats `dist/` and drops alternates whose file is absent.
 *
 * A `BUILD_LOCALE` shard cannot. An alternate for a locale the shard does not
 * emit is absent from ITS dist by design — the page lives on another shard —
 * so the guard keeps it unchecked (`hreflangGuard.ts`, and the same
 * short-circuit in `filterExistingAlternatesWith`). That is correct for a
 * sibling that exists elsewhere and blind for one that exists nowhere, and
 * nothing downstream re-checks: each shard force-pushes a tree built fresh
 * from its own `dist/` (`scripts/lib/push-section-shard.sh` rebuilds the
 * staging dir from scratch every run), so no later pass ever sees the union.
 *
 * Why a registry rather than more filesystem checks
 * ------------------------------------------------
 * Every shard loads the byte-identical source data, so every shard can answer
 * "will this URL be emitted?" for ANY locale without touching another shard's
 * disk. The owning emitters register the canonical paths they write; the
 * hreflang pass then treats an alternate pointing outside that plan as broken,
 * which is exactly the judgement the cross-shard branch had to skip.
 *
 * Fail-closed on incompleteness
 * -----------------------------
 * A partial plan is worse than none — it would call live pages broken. The
 * plan is therefore sealed on OWNER completeness (see {@link REQUIRED_OWNERS}):
 * until every owner has registered, {@link hasKeywordLandingPlan} is false and
 * every consumer behaves exactly as before.
 *
 * Memory: paths only, no HTML. Well under 100 MB of strings on the 2026-07
 * corpus, against a build that peaks near 9.8 GB.
 */

/** Planned pathnames, normalised: leading slash, no trailing slash. */
const planned = new Set<string>();

/**
 * Owners that have reported in. BOTH emitters of this URL family must
 * register before the plan may be treated as authoritative.
 *
 * A PARTIAL plan is worse than no plan: if only jobsSeoPagesPlugin had
 * registered — the cluster plugin takes a cache-hit path that never builds
 * `contexts` — every live cluster page would look unplanned and lose its
 * hreflang. Sealing on owner completeness makes that failure impossible
 * instead of merely unlikely.
 */
export type KeywordLandingOwner = 'related-search-clusters' | 'jobs-seo-pages';
const REQUIRED_OWNERS: readonly KeywordLandingOwner[] = [
  'related-search-clusters',
  'jobs-seo-pages',
];
const owners = new Set<KeywordLandingOwner>();

/** Normalise a URL or pathname to the registry's key form. */
export function normalizeLandingPath(urlOrPath: string): string {
  let p = urlOrPath;
  const schemeEnd = p.indexOf('://');
  if (schemeEnd !== -1) {
    const slash = p.indexOf('/', schemeEnd + 3);
    p = slash === -1 ? '/' : p.slice(slash);
  }
  const q = p.indexOf('?');
  if (q !== -1) p = p.slice(0, q);
  const h = p.indexOf('#');
  if (h !== -1) p = p.slice(0, h);
  p = p.replace(/\/+$/, '');
  if (p === '') return '/';
  return p.startsWith('/') ? p : `/${p}`;
}

/**
 * Last path segment of a GSC keyword landing, in all four locales. The
 * section segment before it varies (`cerca-lavoro-ticino`,
 * `en/find-jobs-zurigo`, …) and is deliberately not constrained.
 */
const LANDING_SEGMENT_RE = /\/(?:ricerca|search|suche|recherche)-[^/]+$/;

/** Does this path belong to the GSC keyword-landing URL family? */
export function isKeywordLandingPath(urlOrPath: string): boolean {
  return LANDING_SEGMENT_RE.test(normalizeLandingPath(urlOrPath));
}

/**
 * Register paths this build will emit. Safe to call many times per owner —
 * jobsSeoPagesPlugin registers once per landing batch.
 */
export function registerKeywordLandingPaths(
  owner: KeywordLandingOwner,
  paths: Iterable<string>,
): void {
  for (const p of paths) planned.add(normalizeLandingPath(p));
  owners.add(owner);
}

/**
 * True only once EVERY owner has registered. Until then the plan is
 * incomplete and callers must not draw conclusions from a path's absence.
 */
export function hasKeywordLandingPlan(): boolean {
  return REQUIRED_OWNERS.every((o) => owners.has(o));
}

/** Is this URL one the current build plans to emit? */
export function isPlannedKeywordLanding(urlOrPath: string): boolean {
  return planned.has(normalizeLandingPath(urlOrPath));
}

/** Registered path count — for build-log reporting. */
export function keywordLandingPlanSize(): number {
  return planned.size;
}

/**
 * Convert a dist-relative HTML file path into the URL path it serves.
 * `fr/trouver-emploi-tessin/recherche-x/index.html` → `/fr/trouver-emploi-tessin/recherche-x`
 * `fr/trouver-emploi-tessin/recherche-x.html`       → `/fr/trouver-emploi-tessin/recherche-x`
 */
export function landingPathFromDistRelative(rel: string): string {
  let p = rel.split('\\').join('/');
  if (p.endsWith('/index.html')) p = p.slice(0, -'/index.html'.length);
  else if (p === 'index.html') p = '';
  else if (p.endsWith('.html')) p = p.slice(0, -'.html'.length);
  return normalizeLandingPath(p);
}

/**
 * Is this page a keyword landing that the current build does not emit?
 *
 * Answers false whenever it cannot be sure: no plan registered, or a path
 * outside this URL family. A page is only called stale when a plan exists and
 * positively does not contain it.
 *
 * Locally decidable on a `BUILD_LOCALE` shard — a page under `dist/` on this
 * shard is in a locale this shard owns, so its own planned set is complete
 * here. No cross-shard knowledge is required.
 */
export function isStaleKeywordLanding(urlOrPath: string): boolean {
  if (!hasKeywordLandingPlan()) return false;
  const p = normalizeLandingPath(urlOrPath);
  if (!LANDING_SEGMENT_RE.test(p)) return false;
  return !planned.has(p);
}

/** Test-only: drop all state so cases cannot leak into each other. */
export function __resetKeywordLandingPlanForTests(): void {
  planned.clear();
  owners.clear();
}
