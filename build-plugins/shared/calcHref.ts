// calcHref.ts — leaf module, NO imports.
//
// Per-locale net-salary calculator landing paths. Single source of truth
// shared by jobBoardCommuterContext, cantonSeoProse, jobListingProse and
// host plugins (care-variant CTA in jobsSeoPagesPlugin, …).
//
// Lives in its own dependency-free module because the previous single
// source (`jobBoardCommuterContext.ts`) sits in an import cycle with
// `cantonSeoProse.ts` (commuter-context renders the canton prose):
// when the bundle evaluated jobBoardCommuterContext first, cantonSeoProse's
// `import { CALC_HREF }` read an uninitialized binding → undefined →
// `TypeError: Cannot read properties of undefined (reading 'it')` in
// buildSlotCopy at closeBundle — deploy build down on main (run
// 27401576244, post #1938). A leaf module makes the cycle impossible
// by construction.

export const CALC_HREF: Record<'it' | 'en' | 'de' | 'fr', string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};
