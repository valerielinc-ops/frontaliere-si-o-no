/**
 * calculatorRegimeScope — LEAF module, zero imports.
 *
 * The net-salary calculator at CALC_HREF is hardwired to the ITALY-Switzerland
 * regime: Ticino withholding tables A/B/C/H (services/calculationService.ts
 * getTicinoTaxRate), Italian IRPEF brackets 23/35/43% with addizionali, and
 * FRANCHIGIA_NUOVI_FRONTALIERI (EUR 10'000, Art. 1 c.175 L.147/2013). There is
 * no country-of-residence input: every run returns an Italian-regime net.
 *
 * The France, Germany, Austria and Liechtenstein border-municipality families
 * all link it as their primary CTA ("Calcola il tuo stipendio netto"). A
 * resident of Lörrach following that CTA gets a net computed under the
 * Italy-Switzerland regime — a wrong NUMBER, which is worse than wrong prose
 * because a number is believed. Those pages are otherwise written with care to
 * state each border's own regime, so an unqualified calculator link
 * contradicts the page it sits on.
 *
 * Until the calculator is country-aware, the link stays (removing it would
 * strip those pages of the tool that makes them useful) but it must be
 * explicitly scoped, so the reader knows the result does not describe their
 * border. This module holds that notice for all four families rather than
 * duplicating four copies (AGENTS.md Non-Negotiable #6).
 *
 * When the calculator gains a residence-country input, delete this notice and
 * the `calculator.regimeScope.*` keys in services/locales/*-calculator.ts
 * together — they exist for the same reason.
 */

export type CalculatorScopeLocale = 'it' | 'en' | 'de' | 'fr';

/**
 * Shown next to the calculator CTA on every non-Italian border-municipality
 * page. States the regime the calculator implements and that it is not the
 * one described on the page — no figure is quoted here, so nothing to drift.
 */
export const CALCULATOR_REGIME_SCOPE_NOTICE: Record<CalculatorScopeLocale, string> = {
  it: 'Il calcolatore applica il regime frontalieri Italia-Svizzera (imposta alla fonte ticinese e IRPEF italiana con franchigia): non riproduce il regime descritto in questa pagina, quindi il risultato non vale per chi risiede qui.',
  en: 'The calculator implements the Italy-Switzerland cross-border regime (Ticino withholding tax plus Italian IRPEF with its allowance). It does not reproduce the regime described on this page, so its result does not apply to residents here.',
  de: 'Der Rechner bildet das Grenzgänger-Regime Italien-Schweiz ab (Tessiner Quellensteuer und italienische IRPEF mit Freibetrag). Er bildet NICHT das auf dieser Seite beschriebene Regime ab — das Ergebnis gilt daher nicht für Einwohner hier.',
  fr: "Le calculateur applique le régime frontalier Italie-Suisse (impôt à la source tessinois et IRPEF italienne avec franchise). Il ne reproduit pas le régime décrit sur cette page : son résultat ne s'applique donc pas aux résidents d'ici.",
};

/** Short suffix for the CTA label itself, so the scope is visible before the click. */
export const CALCULATOR_REGIME_SCOPE_TAG: Record<CalculatorScopeLocale, string> = {
  it: 'regime Italia-Svizzera',
  en: 'Italy-Switzerland regime',
  de: 'Regime Italien-Schweiz',
  fr: 'régime Italie-Suisse',
};
