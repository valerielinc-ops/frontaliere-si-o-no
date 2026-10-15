/**
 * Per-locale net-salary calculator landing paths — LEAF module, zero imports.
 *
 * Single source of truth shared by jobBoardCommuterContext, cantonSeoProse,
 * jobListingProse and host plugins (jobsSeoPagesPlugin care-variant CTA).
 *
 * It MUST stay a leaf: #1938 imported this table from
 * jobBoardCommuterContext.ts into cantonSeoProse.ts, while
 * jobBoardCommuterContext already imported renderCantonSeoProse from
 * cantonSeoProse — a circular import. In the esbuild-bundled vite.config
 * graph the cycle made `CALC_HREF` evaluate to `undefined` at
 * cantonSeoProse's module init, so its module-level alias froze undefined and
 * the first canton-prose render crashed the FULL build on main
 * (`TypeError: Cannot read properties of undefined (reading 'it')`, deploy
 * run 27401576244 — the PR gate never executes that path, only the post-merge
 * build does). A leaf module makes the cycle impossible by construction.
 * Guarded by tests/canton-seo-prose-calc-href.test.ts.
 */

export type CalcHrefLocale = 'it' | 'en' | 'de' | 'fr';

// Same paths as CALCULATOR_URL in professionLandingsPlugin.ts. Previously the
// canton-prose table pointed at the locale homepage ('/'), which made the
// "calcolatore stipendio netto frontaliere" cross-link land on the homepage
// instead of the calculator (#1938).
export const CALC_HREF: Record<CalcHrefLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};
