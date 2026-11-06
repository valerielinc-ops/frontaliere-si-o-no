/**
 * HTML sitemap page (relative dir under dist/) per locale — the one page
 * that's on every page's nav (main-nav reachable, depth ≤ 1 IT / ≤ 2
 * en-de-fr), so it's the standard injection target every `*LinksPlugin.ts`
 * uses to pull an orphaned SEO-landing family back within
 * `audit:max-bfs-depth`'s crawl-depth budget.
 *
 * Extracted per CLAUDE.md non-negotiable #6 (a regex/constant duplicated
 * literally in ≥2 files → one shared module) — this exact object had drifted
 * into 6 near-identical copies (bfsSalaryLinksPlugin, employerProfilePages-
 * LinksPlugin, professionCantonLandingsLinksPlugin, professionCityLinksPlugin,
 * publisherAdLinksPlugin, salaryProfessionCantonLinksPlugin), each typed to
 * its own local locale alias even though the four path VALUES are always the
 * same physical pages. One definition makes that drift impossible
 * by-construction; consumers index it by any `'it'|'en'|'de'|'fr'`-shaped
 * locale type (structural typing — no cast needed at the common 4-locale type).
 */
export const SITE_MAP_PAGE_DIR: Record<'it' | 'en' | 'de' | 'fr', string> = {
  it: 'mappa-del-sito',
  en: 'en/site-map',
  de: 'de/seitenplan',
  fr: 'fr/plan-du-site',
};
