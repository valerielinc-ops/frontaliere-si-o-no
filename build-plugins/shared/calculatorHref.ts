/**
 * Per-locale net-salary calculator landing paths. Same slugs as
 * services/router.ts (kept inline so build plugins don't pull in the SPA
 * router).
 *
 * LEAF MODULE — must not import any other build-plugins/shared module.
 * PR #1938 put this table in jobBoardCommuterContext and imported it from
 * cantonSeoProse, but commuterContext itself imports cantonSeoProse: the
 * resulting ESM cycle left the const `undefined` during the production
 * build's module evaluation order ("Cannot read properties of undefined
 * (reading 'it')" in renderCantonSeoProse, deploy run 27402547466) while
 * vitest's different entry order masked it. Keeping the table in a leaf
 * module makes the cycle impossible by construction.
 */

export type CalculatorLocale = 'it' | 'en' | 'de' | 'fr';

export const CALC_HREF: Record<CalculatorLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};
