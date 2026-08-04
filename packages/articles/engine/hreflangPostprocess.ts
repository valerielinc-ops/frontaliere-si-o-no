/**
 * hreflang postprocess (fast-publish step 4).
 *
 * Strips any `<link rel="alternate" hreflang=...>` whose target file does not
 * exist in `distDir`. All 4 locale `index.html` for the article being
 * published are on disk by the time this runs, so the self-referencing
 * alternates an article page emits always resolve; the transform exists to
 * drop the ones that do not.
 *
 * Transported for issue #4974 item 3 (migration §10.4 step 2) BY FUNCTION
 * CLOSURE from `build-plugins/hreflangPostprocessPlugin.ts` (346 lines) plus
 * the three shared modules it reaches. The Vite plugin wrapper stays in the
 * host.
 *
 * The keyword-landing gate and the BUILD_LOCALE shard filter are carried
 * VERBATIM rather than pruned, even though neither fires during a fast
 * publish: `hasKeywordLandingPlan()` is false until the host's two plan owners
 * register in-process (nothing registers here), and `EMIT_ALL_LOCALES` is true
 * unless BUILD_LOCALE is set. Both degrade to the identity behaviour on their
 * own terms — pruning them would fork the transform for no gain.
 *
 * SINGLE PRODUCER: the host's `build-plugins/hreflangPostprocessPlugin.ts`
 * re-exports `transformHreflang` from here.
 */

import fs from 'node:fs';
import path from 'node:path';


export type EmitLocale = 'it' | 'en' | 'de' | 'fr';

export const ALL_EMIT_LOCALES: readonly EmitLocale[] = ['it', 'en', 'de', 'fr'] as const;

function isEmitLocale(value: string): value is EmitLocale {
  return (ALL_EMIT_LOCALES as readonly string[]).includes(value);
}

function parseEmitLocales(): Set<EmitLocale> {
  const raw = (process.env.BUILD_LOCALE ?? '').trim();
  if (!raw) return new Set(ALL_EMIT_LOCALES);
  const wanted = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter(isEmitLocale);
  // Defensive: an unrecognised / empty value must NEVER silently emit zero
  // pages (that would ship an empty shard). Fall back to all four locales.
  if (wanted.length === 0) return new Set(ALL_EMIT_LOCALES);
  return new Set(wanted);
}

/**
 * Locales this build is responsible for emitting. Read once at module load
 * (the build process sets `BUILD_LOCALE` before Node starts).
 */
export const EMIT_LOCALES: ReadonlySet<EmitLocale> = parseEmitLocales();

/** True when the filter is inactive (all four locales emitted — the default). */
export const EMIT_ALL_LOCALES: boolean = EMIT_LOCALES.size === ALL_EMIT_LOCALES.length;

/** Whether this shard build should emit pages for the given locale. */
export function shouldEmitLocale(locale: string): boolean {
  if (EMIT_ALL_LOCALES) return true;
  return isEmitLocale(locale) && EMIT_LOCALES.has(locale);
}

/**
 * Map an hreflang locale VALUE to the base emit-locale that OWNS its target,
 * for the shard-ownership decision only (NOT for resolving the target path).
 *
 * The hreflang guards short-circuit `!shouldEmitLocale(locale) → keep` to
 * preserve cross-shard alternates whose page lives on another shard. But
 * `shouldEmitLocale` only knows the 4 base locales (`it/en/de/fr`), so two
 * value shapes slip through that short-circuit and get kept UNCONDITIONALLY —
 * skipping the real file-existence check — even on the shard that owns their
 * target page, where a missing file should be dropped as a broken hreflang:
 *   - `x-default`: always points at the IT root, owned by the `it`/main shard.
 *   - region/script-tagged values (`en-US`, `de-CH`, `fr-CH`): the page still
 *     lives in the base-locale subtree owned by that shard.
 *
 * Normalising to the owning base locale before `shouldEmitLocale` lets the
 * guard subject these to the existence check on the owning shard, while still
 * keeping them unconditionally on shards that don't own the target. A plain
 * base locale or an unknown value passes through unchanged (lowercased), so
 * `shouldEmitLocale` classifies it exactly as before.
 */
export function ownerEmitLocale(locale: string): string {
  const value = locale.trim().toLowerCase();
  if (value === 'x-default') return 'it';
  // Strip a region/script subtag: `en-us` → `en`, `de-ch` → `de`.
  return value.split('-')[0];
}

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

/**
 * Register the paths an owner will emit. Safe to call many times per owner.
 *
 * This writer was missing when the readers were extracted into this package,
 * and nothing caught it: `build-plugins/shared/keywordLandingPlan.ts` kept its
 * own copy of `owners`/`planned` and its own writer, so the emitters registered
 * there while `transformHreflang` — which lives HERE — read a registry no one
 * ever wrote to. `hasKeywordLandingPlan()` was therefore permanently false and
 * the stale-landing repair below never fired in a real build. The four tests
 * that cover it failed on `main` for days, reading as noise.
 *
 * The shim in build-plugins now re-exports these, so there is one registry.
 */
export function registerKeywordLandingPaths(
  owner: KeywordLandingOwner,
  paths: readonly string[],
): void {
  for (const p of paths) planned.add(normalizeLandingPath(p));
  owners.add(owner);
}

/** How many distinct paths the plan holds. Test/diagnostic surface. */
export function keywordLandingPlanSize(): number {
  return planned.size;
}

/** Drop all plan state. Tests only — a build registers once and never resets. */
export function __resetKeywordLandingPlanForTests(): void {
  planned.clear();
  owners.clear();
}

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

export interface LocaleAlternates {
  readonly locale: string;
  readonly url: string;
}

/**
 * Filter hreflang alternates: keep only locales whose HTML file actually
 * exists in dist/. Prevents Semrush "broken hreflang" + "broken internal
 * link" issues by emitting hreflangs only for translated pages that ship.
 *
 * Accepts either absolute URLs (with or without trailing slash) or
 * pathname-only entries. The lookup checks for both `dist/<path>/index.html`
 * and `dist/<path>.html` (flat sibling) so it survives the
 * flatHtmlRedirectPlugin rewrite pass.
 *
 * Pure function: never mutates the input array.
 */
export function filterExistingAlternates(
  alternates: readonly LocaleAlternates[],
  distDir: string,
  baseUrl: string,
): readonly LocaleAlternates[] {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  return alternates.filter(({ locale, url }) => {
    // Per-locale shard build (BUILD_LOCALE): an alternate for a locale this
    // shard did not emit points to a page that lives on ANOTHER shard. Its
    // absence from THIS shard's dist is by design, not a broken link — keep
    // it so the cross-shard hreflang graph stays complete. No-op in the
    // default all-locale build (EMIT_ALL_LOCALES short-circuits).
    // Normalise first so `x-default` (IT-owned) and region-tagged values
    // (`en-US`, `de-CH`) the shard actually owns still hit the existence check.
    if (!EMIT_ALL_LOCALES && !shouldEmitLocale(ownerEmitLocale(locale))) return true;
    const pathname = stripBaseAndTrailingSlash(url, trimmedBase);
    if (pathname === '' || pathname === '/') {
      // Root index — always exists if the build ran at all.
      return fs.existsSync(path.join(distDir, 'index.html'));
    }
    const candidate = path.join(distDir, pathname, 'index.html');
    const flat = path.join(distDir, `${pathname}.html`);
    return fs.existsSync(candidate) || fs.existsSync(flat);
  });
}

/**
 * Convert a (possibly absolute) URL into a leading-slash pathname with
 * any trailing slash stripped. Resilient to query strings + fragments
 * (rare in hreflang but cheap to handle).
 */
function stripBaseAndTrailingSlash(url: string, trimmedBase: string): string {
  let p = url;
  if (p.startsWith(trimmedBase)) p = p.slice(trimmedBase.length);
  // Drop query/hash if anything ever sneaks in.
  const q = p.indexOf('?');
  if (q !== -1) p = p.slice(0, q);
  const h = p.indexOf('#');
  if (h !== -1) p = p.slice(0, h);
  // Strip ALL trailing slashes (handles `//` edge case).
  p = p.replace(/\/+$/, '');
  if (p === '') return '';
  return p.startsWith('/') ? p.slice(1) : p;
}

/**
 * Match a single `<link rel="alternate" hreflang="..." href="...">` tag.
 *
 * - Accepts either ordering of `rel` / `hreflang` / `href` attributes (Vite/
 *   Rollup does not reorder, but emitters across the codebase use both
 *   orders).
 * - Tolerates self-closing (`/>`) and HTML5 (`>`) variants.
 * - Captures the locale (group 1) and the href (group 2).
 *
 * NOTE: we keep the regex deliberately strict (no `\s*` between attrs other
 * than the canonical single-space form used by every emitter) to avoid
 * false-positives in inline `<script>`/`<style>` content.
 */
const HREFLANG_LINK_RX =
  /<link\s+rel="alternate"\s+hreflang="([^"]+)"\s+href="([^"]+)"\s*\/?>(?:\s*\n?)?/g;

/**
 * Pure transform: strip `<link rel="alternate" hreflang>` tags whose target
 * file does not pass the supplied existence predicate. Returns `null` if the
 * HTML has no hreflang tags or all tags survive (no rewrite needed).
 *
 * Extracted from the plugin's closeBundle handler so the
 * `postWalkCoordinatorPlugin` can apply it during a single shared dist/ walk.
 *
 * Inputs:
 *   - html: current HTML string (already potentially mutated by prior steps)
 *   - distDir / baseUrl: passed through to `filterExistingAlternates`
 *   - existsCheck (optional): override the disk lookup. Useful when the
 *     coordinator has built an in-memory Set of every emitted HTML path so
 *     the walk avoids repeated `fs.existsSync` syscalls.
 */
export interface HreflangTransformResult {
  readonly html: string;
  readonly kept: number;
  readonly dropped: number;
}

export function transformHreflang(
  html: string,
  distDir: string,
  baseUrl: string,
  existsCheck?: (absPath: string) => boolean,
  /** dist-relative path of the page being rewritten (enables the stale-landing repair). */
  pagePath?: string,
): HreflangTransformResult | null {
  if (!html.includes('hreflang=')) return null;

  const matches: Array<{
    full: string;
    entry: LocaleAlternates;
    index: number;
  }> = [];
  HREFLANG_LINK_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HREFLANG_LINK_RX.exec(html)) !== null) {
    matches.push({
      full: m[0],
      entry: { locale: m[1], url: m[2] },
      index: m.index,
    });
  }
  if (matches.length === 0) return null;

  const alternates: readonly LocaleAlternates[] = matches.map((x) => x.entry);

  // Landing-plan gate. Fires only once both owners have sealed the plan
  // (shared/keywordLandingPlan.ts) and only on that URL family.
  //
  // The `/{section}/{ricerca|search|suche|recherche}-{slug}/` pages are
  // emitted per locale from per-locale query data, so a keyword can earn a
  // landing in one locale and not in another while the emitter still writes
  // the full four-locale alternate set. On a BUILD_LOCALE shard the existence
  // check cannot see that: an alternate for a locale this shard does not emit
  // is absent by design, so it is kept unchecked — correct for a sibling that
  // lives on another shard, blind for one that exists nowhere. That blind spot
  // is the 75 `missingTarget` offenders on run 30376520728.
  //
  // The whole block goes, not the offending entries: audit-hreflang requires
  // 4 locales + x-default once ANY hreflang is present, so a thinned set only
  // trades `[missingTarget]` for `[tooFew]`. Pages carrying no hreflang are
  // explicitly skipped by that audit, and no page is deleted — only the
  // unresolvable block is.
  //
  // Deliberately narrower than the blanket "drop ALL if kept < 5" that Phase
  // 8a reverted on 2026-05-12: that fired everywhere, on the premise that
  // every page emitting hreflang has its full set on disk. This fires only
  // where the build's own plan says a target is never written.
  if (hasKeywordLandingPlan()) {
    const pageIsStale =
      pagePath !== undefined && isStaleKeywordLanding(landingPathFromDistRelative(pagePath));
    const hasUnplannedTarget = alternates.some(
      (a) => isKeywordLandingPath(a.url) && !isPlannedKeywordLanding(a.url),
    );
    if (pageIsStale || hasUnplannedTarget) {
      let stripped = html;
      for (let i = matches.length - 1; i >= 0; i--) {
        const match = matches[i];
        const end = match.index + match.full.length;
        const tail = stripped.slice(end);
        const trailingNl = tail.startsWith('\n') ? 1 : 0;
        stripped = stripped.slice(0, match.index) + stripped.slice(end + trailingNl);
      }
      return { html: stripped, kept: 0, dropped: matches.length };
    }
  }

  const kept = existsCheck
    ? filterExistingAlternatesWith(alternates, distDir, baseUrl, existsCheck)
    : filterExistingAlternates(alternates, distDir, baseUrl);
  const keptUrls = new Set(kept.map((k) => `${k.locale}|${k.url}`));

  if (kept.length === alternates.length) {
    // Nothing to drop — return null so the coordinator skips a write.
    return null;
  }

  // Phase 8a (2026-05-12) reverted the previous "drop ALL if kept < 5"
  // band-aid. With the per-job emit now dedup-keyed by
  // `(canton, locale, slug)` instead of `(locale, slug)`, cross-canton
  // slug collisions no longer suppress sibling locale files — every
  // page that emits hreflang has its full 4-locale + x-default set on
  // disk. Strip only the genuinely broken alternates and keep the rest;
  // the audit's `alternates.size === 0` short-circuit is no longer the
  // escape hatch.
  let rewritten = html;
  let droppedCount = 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const key = `${match.entry.locale}|${match.entry.url}`;
    if (keptUrls.has(key)) continue;
    droppedCount++;
    const end = match.index + match.full.length;
    const tail = rewritten.slice(end);
    const trailingNl = tail.startsWith('\n') ? 1 : 0;
    rewritten =
      rewritten.slice(0, match.index) +
      rewritten.slice(end + trailingNl);
  }

  return { html: rewritten, kept: keptUrls.size, dropped: droppedCount };
}

/**
 * Variant of {@link filterExistingAlternates} that accepts a custom existence
 * predicate. Used by the coordinator to substitute disk lookups with an
 * in-memory Set of every HTML path emitted during the build.
 */
function filterExistingAlternatesWith(
  alternates: readonly LocaleAlternates[],
  distDir: string,
  baseUrl: string,
  existsCheck: (absPath: string) => boolean,
): readonly LocaleAlternates[] {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  return alternates.filter(({ locale, url }) => {
    // Per-locale shard build (BUILD_LOCALE): keep alternates for locales this
    // shard didn't emit — their pages live on another shard, not broken links.
    // No-op in the default all-locale build. Normalise first so `x-default`
    // (IT-owned) and region-tagged values the shard owns still hit the check.
    if (!EMIT_ALL_LOCALES && !shouldEmitLocale(ownerEmitLocale(locale))) return true;
    let p = url;
    if (p.startsWith(trimmedBase)) p = p.slice(trimmedBase.length);
    const q = p.indexOf('?');
    if (q !== -1) p = p.slice(0, q);
    const h = p.indexOf('#');
    if (h !== -1) p = p.slice(0, h);
    p = p.replace(/\/+$/, '');
    if (p === '' || p === '/') {
      return existsCheck(path.join(distDir, 'index.html'));
    }
    if (p.startsWith('/')) p = p.slice(1);
    return (
      existsCheck(path.join(distDir, p, 'index.html')) ||
      existsCheck(path.join(distDir, `${p}.html`))
    );
  });
}
