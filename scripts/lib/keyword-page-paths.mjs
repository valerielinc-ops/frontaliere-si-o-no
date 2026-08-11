/**
 * keyword-page-paths.mjs — the ONE place that turns an entry of
 * `data/keyword-pages-config.json` into the URL the site actually serves.
 *
 * The defect this closes
 * ----------------------
 * `scripts/profession-keyword-opportunities.mjs` wrote the coverage reason as
 * `keyword page /${page.slug}/` — the bare slug, as if it were a path. It is
 * not: `jobsSeoPagesPlugin` emits keyword landings under
 * `{localePrefix}/{section}/{searchRoutePrefix}-{slug}/`, so the report told
 * every reader that `medico-ticino` lived at `/medico-ticino/` (404) when the
 * live page is `/cerca-lavoro-ticino/ricerca-medico-ticino/` (200, and in
 * `sitemap-jobs.xml`).
 *
 * Measured on the 2026-08-10 report: 23 of the 52 "Già coperte" rows carried a
 * path that 404s. The cost is not cosmetic — the report is consumed by humans
 * AND by the autonomous issue/fix loop, and a reader who probes the printed
 * path concludes the emission chain is broken. That is exactly what happened
 * on 2026-08-11: the eight professions the report marked "Promuovibile ✅"
 * were all live at the real convention, and a session spent measuring the
 * wrong one before finding out.
 *
 * Why a module rather than a fixed string
 * ---------------------------------------
 * The report (which names a page) and the feed (which creates one) must agree
 * on the slug AND the URL, or the report goes back to naming something that
 * does not exist. One `keywordPageSlugify` + one `keywordLandingPath` makes a
 * disagreement unrepresentable, the same shape `isPromotable` already gives
 * the promotion predicate.
 *
 * The maps below mirror `build-plugins/jobsSeoPagesPlugin.ts` (`localePrefix`,
 * `sectionByLocale`, `searchRoutePrefix`). They are pinned to the plugin's own
 * literals by `tests/profession-gap-double-validated-gate.test.ts`, so a
 * rename on the emitter side fails the suite instead of silently making every
 * URL this module prints a 404.
 */

/** Locale URL prefix — mirrors `localePrefix` in jobsSeoPagesPlugin.ts. */
export const KEYWORD_LANDING_LOCALE_PREFIX = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** Job-board section slug — mirrors `sectionByLocale` in jobsSeoPagesPlugin.ts. */
export const KEYWORD_LANDING_SECTION = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

/** Search-route prefix — mirrors `searchRoutePrefix` in jobsSeoPagesPlugin.ts. */
export const KEYWORD_LANDING_SEARCH_PREFIX = {
  it: 'ricerca',
  en: 'search',
  de: 'suche',
  fr: 'recherche',
};

/**
 * The canonical URL path of the keyword landing for `slug` in `locale`.
 * Trailing slash by construction (AGENTS.md → Architecture).
 *
 * Returns '' for an empty slug so a caller can print nothing rather than a
 * path that points at the section hub.
 */
export function keywordLandingPath(slug, locale = 'it') {
  const clean = String(slug || '').replace(/^\/+|\/+$/g, '').trim();
  if (!clean) return '';
  const prefix = KEYWORD_LANDING_LOCALE_PREFIX[locale] ?? '';
  const section = KEYWORD_LANDING_SECTION[locale] || KEYWORD_LANDING_SECTION.it;
  const search = KEYWORD_LANDING_SEARCH_PREFIX[locale] || KEYWORD_LANDING_SEARCH_PREFIX.it;
  return `${prefix}/${section}/${search}-${clean}/`.replace(/\/{2,}/g, '/');
}

/**
 * Slug of a keyword page from its query string. Lifted verbatim out of
 * `scripts/generate-keyword-pages-config.mjs`, which is the script that
 * actually writes the slug into the config — importing it here is what lets
 * the weekly report predict a URL the feed will really create.
 */
export function keywordPageSlugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * The query string the profession-gap feed builds for a taxonomy label —
 * parenthetical qualifiers dropped ("Operatore socio sanitario (OSS)" →
 * "operatore socio sanitario"), lowercased, suffixed with the canton the
 * pages target. Returns '' when nothing is left to name a page after.
 */
export function professionKeywordQuery(label) {
  const clean = String(label || '').replace(/\s*\([^)]*\)/g, '').trim().toLowerCase();
  return clean ? `${clean} ticino` : '';
}

/**
 * URL the profession-gap feed will give `label` at the next
 * `refresh-keyword-config` run, or '' when the feed would produce no slug.
 * Same three steps the feed runs, in the same order.
 */
export function professionKeywordLandingPath(label, locale = 'it') {
  const slug = keywordPageSlugify(professionKeywordQuery(label));
  if (!slug || slug.length < 5) return '';
  return keywordLandingPath(slug, locale);
}
