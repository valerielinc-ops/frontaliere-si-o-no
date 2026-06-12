/**
 * Per-locale net-salary calculator landing paths.
 *
 * LEAF MODULE on purpose — no imports. CALC_HREF used to live in
 * jobBoardCommuterContext.ts, but cantonSeoProse.ts importing it from there
 * created an ESM cycle (jobBoardCommuterContext → cantonSeoProse →
 * jobBoardCommuterContext): under the vite.config bundle eval order the
 * binding was still uninitialized when cantonSeoProse's module scope ran,
 * so `CALCULATOR_HREF = CALC_HREF` captured undefined and the build died
 * with "Cannot read properties of undefined (reading 'it')" in
 * buildSlotCopy (run 27402547466). Keep this file import-free so it can
 * never participate in a cycle.
 *
 * Same paths as CALCULATOR_URL in professionLandingsPlugin.ts. Previously
 * pointed at the locale homepage ('/'), which made the "calcolatore
 * stipendio netto frontaliere" cross-link land on the homepage instead of
 * the calculator.
 */
export const CALC_HREF: Record<'it' | 'en' | 'de' | 'fr', string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};
