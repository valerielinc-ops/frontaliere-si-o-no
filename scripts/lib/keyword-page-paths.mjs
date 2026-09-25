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
 * real convention puts it at `/cerca-lavoro-ticino/ricerca-medico-ticino/`.
 *
 * What this module does NOT promise, and the example that proves it: the path
 * above is the URL the keyword landing WOULD occupy, not evidence that the
 * keyword landing is what answers there. Measured 2026-08-11, that exact URL
 * is 200 — but it is served by `relatedSearchClustersPlugin`'s legacy-canton
 * mirror, `index,follow` with `<link rel=canonical>` pointing at
 * `/cerca-lavoro-svizzera/ricerca-medico-ticino/`, and it is in NO sitemap;
 * only the canonical twin is (`sitemap-search-clusters-003.xml`). An earlier
 * revision of this comment asserted it was "200, and in `sitemap-jobs.xml`" —
 * it is not, and that sentence sent a later session hunting a missing-sitemap
 * bug that did not exist. A 200 at a predicted path proves the path is taken,
 * never by whom: `curl` the canonical and the robots meta before concluding.
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
 * The maps below correspond to `build-plugins/jobsSeoPagesPlugin.ts`
 * (`localePrefix`, `sectionByLocale`, `searchRoutePrefix`). The section table
 * is IMPORTED from its canonical home rather than copied; the other two are
 * pinned to the plugin's own literals by
 * `tests/profession-gap-double-validated-gate.test.ts`, so a rename on the
 * emitter side fails the suite instead of silently making every URL this
 * module prints a 404.
 */

import { SECTION_LEGACY_TI } from '../../build-plugins/shared/cantonResolvers.mjs';

/** Locale URL prefix — mirrors `localePrefix` in jobsSeoPagesPlugin.ts. */
export const KEYWORD_LANDING_LOCALE_PREFIX = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/**
 * Job-board section slug. NOT a copy: this is the canonical TI legacy section
 * table from `build-plugins/shared/cantonResolvers.mjs`, re-exported under the
 * name this module's callers use. `tests/seo/cathedral-no-ti-hardcodes.test.ts`
 * is the gate that forbids a second copy anywhere under `build-plugins/`,
 * `services/` or `scripts/lib/` — and it caught this file when the table was
 * inlined here, which is the correct outcome: the point of this module is one
 * URL builder, not one more place the section slug lives.
 *
 * `cantonResolvers.mjs` is pure (no `fs`, no JSON import) precisely so raw-node
 * scripts can import it, which is why this costs nothing at load time.
 */
export const KEYWORD_LANDING_SECTION = SECTION_LEGACY_TI;

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
