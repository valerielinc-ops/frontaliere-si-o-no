/**
 * Page-template classifier for the per-page ad diagnosis (`ad_page_diag`).
 *
 * One ordered table of `[template, regex source, needs JobPosting]` rules is
 * the single source of truth for two runtimes:
 *  - `classifyAdPageTemplate()` below, used by the SPA (services/adPageDiag.ts);
 *  - `AD_PAGE_TEMPLATE_INLINE_FN`, the ES5 twin embedded in the static AdSense
 *    loader (build-plugins/shared/adPageDiagInline.ts → ADSENSE_LOADER_CONTENT),
 *    which serialises the SAME table instead of re-typing it.
 * Both walk the table in order and return the first match, so they cannot
 * disagree on a path; tests/ad-page-diag-parity.test.ts executes both over the
 * same path matrix anyway.
 *
 * Why not `deriveAnalyticsPageContext()` (services/analyticsPageContext.ts):
 * its `page_template` answers a different question (content family for
 * page_view) and cannot tell the Ticino board from the other cantons or the
 * EN/DE/FR boards, which is exactly the split the ad-value diagnosis needs.
 * Its job-detail test also needs the full sector-slug table, too heavy for an
 * inline loader served on every static page; here a job detail is recognised
 * by the JobPosting JSON-LD the page carries (`hasJobPosting`).
 *
 * Every slug comes from the table the router and the emitters already read:
 * JOB_BOARD_SECTION_PREFIX_SOURCE / PROFESSION_CITY_SLUG_SOURCE
 * (scripts/lib/jobBoardSections.mjs), SLUG_TABLES (services/routeSlugs.data.ts)
 * and FUEL_SECTION_SLUG (build-plugins/fuelDailyData.ts).
 */
import {
  JOB_BOARD_SECTION_PREFIX_SOURCE,
  PROFESSION_CITY_SLUG_SOURCE,
} from '../scripts/lib/jobBoardSections.mjs';
import { FUEL_SECTION_SLUG } from '../build-plugins/fuelDailyData';
import { SLUG_TABLES, type SlugTable } from './routeSlugs.data';

export type AdPageTemplate =
  | 'home'
  | 'jobboard_hub'
  | 'jobboard_ticino'
  | 'jobboard_canton_it'
  | 'jobboard_locale'
  | 'job_detail'
  | 'role_landing'
  | 'company'
  | 'article'
  | 'fuel'
  | 'tool'
  | 'other';

/** `[template, regex source (matched case-insensitively), 1 = only with JobPosting JSON-LD]`. */
export type AdPageTemplateRule = readonly [AdPageTemplate, string, 0 | 1];

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const OPTIONAL_LOCALE = '(?:/(?:en|de|fr))?';
const OPTIONAL_BOARD_LOCALE = '(?:/(?:it|en|de|fr))?';
const BOARD_SECTION = `/(?:${JOB_BOARD_SECTION_PREFIX_SOURCE})-[a-z][a-z-]*`;

function slugsFor(keys: ReadonlyArray<keyof SlugTable>): string[] {
  const out = new Set<string>();
  for (const locale of LOCALES) {
    for (const key of keys) out.add(String(SLUG_TABLES[locale][key]));
  }
  return [...out];
}

function topLevel(slugs: readonly string[]): string {
  return `^${OPTIONAL_LOCALE}/(?:${slugs.join('|')})(?:/|$)`;
}

const ARTICLE_SLUGS = slugsFor(['blog', 'blogCh']);
const FUEL_SLUGS = [
  ...new Set([
    ...LOCALES.flatMap((locale) => Object.values(FUEL_SECTION_SLUG[locale])),
    ...slugsFor(['fuelPrices']),
  ]),
];
// The salary calculator and the service comparators, with the tools the
// router serves at top level (payslip, what-if, TFR, 13th salary).
const TOOL_SLUGS = slugsFor(['calcolatore', 'confronti', 'comparatori', 'payslip', 'whatif', 'tfrCalculator', 'tredicesima']);

/**
 * Order matters: the first match wins. Job-board rules go from the most
 * specific (a job detail, a section root) to the generic canton bucket.
 */
export const AD_PAGE_TEMPLATE_RULES: readonly AdPageTemplateRule[] = [
  ['home', `^${OPTIONAL_BOARD_LOCALE}/?$`, 0],
  ['job_detail', `^${OPTIONAL_BOARD_LOCALE}${BOARD_SECTION}/[^/]`, 1],
  ['jobboard_hub', `^${OPTIONAL_BOARD_LOCALE}${BOARD_SECTION}/?$`, 0],
  ['jobboard_locale', `^/(?:en|de|fr)${BOARD_SECTION}(?:/|$)`, 0],
  ['jobboard_ticino', '^(?:/it)?/cerca-lavoro-ticino(?:/|$)', 0],
  ['jobboard_canton_it', `^${OPTIONAL_BOARD_LOCALE}${BOARD_SECTION}(?:/|$)`, 0],
  ['role_landing', `^${OPTIONAL_LOCALE}/(?:lavoro|jobs|arbeit|travail)-(?:ticino|tessin|${PROFESSION_CITY_SLUG_SOURCE})-[a-z0-9]`, 0],
  ['company', `^${OPTIONAL_LOCALE}/aziende`, 0],
  ['article', topLevel(ARTICLE_SLUGS), 0],
  ['fuel', topLevel(FUEL_SLUGS), 0],
  ['tool', topLevel(TOOL_SLUGS), 0],
];

const COMPILED_RULES = AD_PAGE_TEMPLATE_RULES.map(
  ([template, source, needsJobPosting]) => [template, new RegExp(source, 'i'), needsJobPosting] as const,
);

/**
 * @param pathname a browser pathname (`location.pathname`).
 * @param hasJobPosting whether the document carries JobPosting JSON-LD.
 */
export function classifyAdPageTemplate(pathname: string, hasJobPosting = false): AdPageTemplate {
  const path = String(pathname || '/');
  for (const [template, rx, needsJobPosting] of COMPILED_RULES) {
    if (needsJobPosting && !hasJobPosting) continue;
    if (rx.test(path)) return template;
  }
  return 'other';
}

/** JobPosting JSON-LD marker, shared with the inline twin. */
export const JOB_POSTING_LD_SOURCE = '"@type"\\s*:\\s*"JobPosting"';

/** True when a `script[type="application/ld+json"]` in `doc` declares a JobPosting. */
export function documentHasJobPosting(doc: Document): boolean {
  const rx = new RegExp(JOB_POSTING_LD_SOURCE);
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    if (rx.test(scripts[i].textContent || '')) return true;
  }
  return false;
}

/**
 * ES5 twin of `classifyAdPageTemplate()` + `documentHasJobPosting()` as a
 * function-expression string `function(path, doc)`. Generated from the table
 * above, never hand-copied.
 */
export const AD_PAGE_TEMPLATE_INLINE_FN = `function(p,d){var j=false;try{var L=d.querySelectorAll('script[type="application/ld+json"]'),X=new RegExp(${JSON.stringify(JOB_POSTING_LD_SOURCE)});for(var k=0;k<L.length;k++)if(X.test(L[k].textContent||'')){j=true;break;}}catch(e){}var R=${JSON.stringify(AD_PAGE_TEMPLATE_RULES)};p=String(p||'/');for(var i=0;i<R.length;i++){if(R[i][2]&&!j)continue;if(new RegExp(R[i][1],'i').test(p))return R[i][0];}return 'other';}`;
