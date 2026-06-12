/**
 * Per-locale net-salary calculator landing paths.
 *
 * Leaf module with NO imports: both `jobBoardCommuterContext.ts` and
 * `cantonSeoProse.ts` need this table, but they also import each other's
 * render helpers — importing it across that pair (PR #1938 put it in
 * jobBoardCommuterContext and had cantonSeoProse pull it from there)
 * created a circular module init: `const CALCULATOR_HREF = CALC_HREF`
 * evaluated while jobBoardCommuterContext was still in its temporal dead
 * zone. tsx surfaces it as "Cannot access 'CALC_HREF' before
 * initialization"; the Vite-bundled config surfaced it as "Cannot read
 * properties of undefined (reading 'it')" inside buildSlotCopy and killed
 * the whole build (run 27401576244). Keep this file import-free so the
 * cycle cannot re-form.
 *
 * Same paths as CALCULATOR_URL in professionLandingsPlugin.ts. Previously
 * the table pointed at the locale homepage ('/'), sending the "calcolatore
 * stipendio netto frontaliere" cross-link to the homepage instead of the
 * calculator.
 */
export type CalcHrefLocale = 'it' | 'en' | 'de' | 'fr';

export const CALC_HREF: Record<CalcHrefLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};
