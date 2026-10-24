/**
 * Who writes the 28 topic section pages (7 sections × 4 locales).
 *
 * `sectionPagesPlugin` renders them (h1, lede, latest-article list,
 * CollectionPage JSON-LD). Their URLs are also listed in the seeded sitemaps
 * with hreflang alternates, so `staticPagesPlugin` meets every one of them in
 * its sitemap loop: the IT path as a primary URL, the EN/DE/FR paths as
 * hreflang variants. Before this module the IT path was protected only by a
 * `fs.existsSync` probe and the EN/DE/FR variants by nothing at all — the
 * hreflang loop regenerated them unconditionally and its WriteCollector flush
 * replaced the section page with the generic slug-derived fallback
 * («Douane (guide frontalier)» + the homepage editorial). Measured on the live
 * site 2026-10-24: 21 locale section pages shipped as that identical fallback,
 * which is what sank the `fr:/fr/~83248f` and `de:/de/~5b78c1`
 * information-gain cohorts to a 0 % median.
 *
 * The decision is now deterministic and shared: one predicate, read by both
 * plugins, keyed on the canonical path table in `sectionPagesPathsData.ts`.
 * When the section plugin is switched off (`SKIP_SECTION_PAGES=1`, local
 * builds only) nobody owns the paths and `staticPagesPlugin` keeps emitting
 * its fallback, so a sitemap URL never ends up without an HTML file.
 */
import { isSectionPagePath } from '../sectionPagesPathsData';

type Env = Readonly<Record<string, string | undefined>>;

/** `sectionPagesPlugin` is registered and emits (vite.config.ts reads the same flag). */
export function sectionPagesEnabled(env: Env = process.env): boolean {
  return env.SKIP_SECTION_PAGES !== '1';
}

/**
 * True when `urlPath` (any slash form) is one of the 28 section pages AND the
 * section plugin is active in this build: then it is the single owner and no
 * other plugin may write that path.
 */
export function isSectionPageOwnedPath(urlPath: string, env: Env = process.env): boolean {
  return sectionPagesEnabled(env) && isSectionPagePath(urlPath);
}
