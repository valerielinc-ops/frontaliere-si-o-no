/**
 * Localized SERP metadata for the Tax & Pension family.
 *
 * The Italian SEO registry is the source of the localized routes, but the
 * static emitter receives the Italian source path while rendering each
 * translated URL. Without an explicit family map those variants fall through
 * to the slug-derived title and generic description. Keep this copy in a
 * leaf module shared by the SSG and the SPA so the two heads cannot drift.
 */

export type FiscoSeoLocale = 'en' | 'de' | 'fr';

export type FiscoSeoSection =
  | 'fisco'
  | 'tax-return'
  | 'tax-return-italia'
  | 'tax-return-svizzera'
  | 'calendar'
  | 'holidays'
  | 'ristorni'
  | 'pension'
  | 'pillar3'
  | 'quiz'
  | 'taxCredit'
  | 'withholdingRates'
  | 'newFrontierTaxSim';

export interface FiscoLocaleSeo {
  /** Title without the brand suffix; callers apply buildTitleWithBrand. */
  title: string;
  description: string;
}

const FISCO_LOCALE_SEO: Record<FiscoSeoLocale, Record<FiscoSeoSection, FiscoLocaleSeo>> = {
  en: {
    fisco: {
      title: 'Taxes & Pension for Cross-Border Workers',
      description: 'Tax section for cross-border workers: withholding tax, IRPEF, 2026 new agreement, tax simulator and pension planning.',
    },
    'tax-return': {
      title: 'Tax Return Guide',
      description: 'Tax return guide for cross-border workers: IRPEF, tax credit, Form CE and 2026 fiscal deadlines.',
    },
    'tax-return-italia': {
      title: 'Italian Tax Return',
      description: 'Italian tax return for cross-border workers: Form 730, Redditi PF, the 10,000-euro exemption, foreign tax credit and 2026 filing deadlines.',
    },
    'tax-return-svizzera': {
      title: 'Swiss Tax Return Guide',
      description: 'Swiss tax return for cross-border workers: withholding tax, tariff correction (TDR), Ticino deductions and third-pillar 3a contributions.',
    },
    calendar: {
      title: 'Tax Deadline Calendar 2026',
      description: "Cross-border workers' 2026 tax deadlines: withholding tax, IRPEF, Form 730, Redditi and AVS, with required documents, countdown and penalties.",
    },
    holidays: {
      title: 'Ticino Public Holidays 2026',
      description: 'Ticino public holidays 2026: official and optional dates, bridge days, Easter, Ascension, Corpus Christi; Italy comparison for cross-border workers.',
    },
    ristorni: {
      title: 'Swiss Tax Rebates for Italy',
      description: 'Statistics on Swiss tax rebates (ristorni) for cross-border workers: amounts by Italian municipality, historical trends and province comparisons.',
    },
    pension: {
      title: 'Cross-Border Pension Planner',
      description: 'AVS/LPP pension simulator for cross-border workers: calculate your Swiss pension, INPS coordination and retirement strategies.',
    },
    pillar3: {
      title: '3rd Pillar Simulator',
      description: 'Pillar 3a for cross-border workers: tax deductions, 2026 limits, best providers and retirement savings strategies.',
    },
    quiz: {
      title: 'Cross-Border Tax Quiz',
      description: 'Weekly Switzerland-Italy tax quiz: test your knowledge of taxes, deductions, permits and cross-border worker rules.',
    },
    taxCredit: {
      title: 'Tax Credit for Double Taxation',
      description: 'Calculate your tax credit to avoid Switzerland-Italy double taxation and understand foreign-tax relief for your cross-border return.',
    },
    withholdingRates: {
      title: 'Ticino Withholding Tax Rates 2026',
      description: 'Ticino tables A, B, C and H with practical examples, FAQ and direct links to the net salary and payslip simulators.',
    },
    newFrontierTaxSim: {
      title: 'Tax Simulation for New Cross-Border Workers',
      description: 'Calculate Ticino withholding tax, Italian IRPEF with EUR 10,000 franchise, tax credit and net salary for workers who started after 17/07/2023.',
    },
  },
  de: {
    fisco: {
      title: 'Steuern & Vorsorge für Grenzgänger',
      description: 'Steuerbereich für Grenzgänger: Quellensteuer, IRPEF, neues Abkommen 2026, Steuerrechner und Vorsorgeplanung.',
    },
    'tax-return': {
      title: 'Leitfaden zur Steuererklärung',
      description: 'Steuererklärung für Grenzgänger: IRPEF, Steuergutschrift, Formulare und Fristen 2026.',
    },
    'tax-return-italia': {
      title: 'Steuererklärung in Italien',
      description: 'Italienische Steuererklärung für Grenzgänger: Formular 730, Redditi PF, 10.000-Euro-Freibetrag, ausländische Steuern und Fristen 2026.',
    },
    'tax-return-svizzera': {
      title: 'Schweizer Steuererklärung',
      description: 'Schweizer Steuererklärung für Grenzgänger: Quellensteuer, Tarifkorrektur (TDR), Tessiner Abzüge und Beiträge zur dritten Säule 3a.',
    },
    calendar: {
      title: 'Steuerterminkalender 2026',
      description: 'Steuertermine der Grenzgänger 2026: Quellensteuer, IRPEF, Formular 730 und Redditi, AHV. Mit Countdown, nötigen Dokumenten und Strafen bei Verspätung.',
    },
    holidays: {
      title: 'Feiertage Tessin 2026',
      description: 'Feiertage im Kanton Tessin 2026 für Grenzgänger: offizielle und fakultative Feiertage, Brückentage und Vergleich mit Italien.',
    },
    ristorni: {
      title: 'Steuerrückerstattungen für Italien',
      description: 'Statistiken zu Ristorni der Grenzgänger: Beträge je italienischer Gemeinde, historischer Verlauf und Vergleich der Provinzen.',
    },
    pension: {
      title: 'Grenzgänger-Rentenplaner',
      description: 'AHV/BVG-Rentenrechner für Grenzgänger: Berechnen Sie Ihre Schweizer Rente, INPS-Koordination und Vorsorgestrategien.',
    },
    pillar3: {
      title: 'Simulator für die 3. Säule',
      description: 'Säule 3a für Grenzgänger: Steuerabzüge, Grenzen 2026, beste Anbieter und Vorsorge-Sparstrategien.',
    },
    quiz: {
      title: 'Steuerquiz für Grenzgänger',
      description: 'Wöchentliches Quiz zur grenzüberschreitenden Besteuerung Schweiz-Italien: teste dein Wissen über Steuern, Abzüge, Bewilligungen und Grenzgängerregeln.',
    },
    taxCredit: {
      title: 'Steuergutschrift bei Doppelbesteuerung',
      description: 'Berechnen Sie die Steuergutschrift zur Vermeidung der Schweiz-Italien-Doppelbesteuerung und verstehen Sie die Entlastung für Ihre Steuererklärung.',
    },
    withholdingRates: {
      title: 'Quellensteuer Tessin 2026',
      description: 'Tessiner Tabellen A, B, C und H mit Praxisbeispielen, FAQ und direkten Links zu Netto- und Lohnabrechnungsrechner.',
    },
    newFrontierTaxSim: {
      title: 'Steuerberechnung für neue Grenzgänger',
      description: 'Berechnen Sie Tessiner Quellensteuer, italienische IRPEF mit EUR 10.000 Franchise, Steuergutschrift und Nettogehalt für Arbeitnehmer ab 17.07.2023.',
    },
  },
  fr: {
    fisco: {
      title: 'Impôts & Prévoyance pour Frontaliers',
      description: 'Section fiscale pour frontaliers : impôt à la source, IRPEF, nouvel accord 2026, simulateur fiscal et planification retraite.',
    },
    'tax-return': {
      title: 'Guide de la déclaration fiscale',
      description: "Guide déclaration d'impôts pour frontaliers : IRPEF, crédit d'impôt, formulaires et échéances fiscales 2026.",
    },
    'tax-return-italia': {
      title: 'Déclaration de revenus en Italie',
      description: "Déclaration de revenus en Italie pour frontaliers : modèle 730 et Redditi PF, franchise de 10 000 euros, crédit d'impôt et échéances fiscales 2026.",
    },
    'tax-return-svizzera': {
      title: 'Déclaration fiscale suisse',
      description: 'Déclaration suisse pour frontaliers : impôt à la source, rectification du tarif (TDR), déductions tessinoises et troisième pilier 3a.',
    },
    calendar: {
      title: 'Échéances fiscales 2026',
      description: 'Échéances fiscales 2026 des frontaliers : impôt à la source, IRPEF, modèle 730, Redditi et AVS, documents requis et pénalités de retard.',
    },
    holidays: {
      title: 'Jours fériés du Tessin 2026',
      description: 'Jours fériés du Tessin 2026 pour frontaliers : jours officiels et facultatifs, ponts, Pâques et comparaison avec les jours fériés italiens.',
    },
    ristorni: {
      title: 'Rétrocessions fiscales aux communes',
      description: 'Statistiques sur les ristorni des frontaliers : montants par commune italienne, évolution historique et comparaison des provinces.',
    },
    pension: {
      title: 'Planificateur de Retraite Frontalier',
      description: 'Simulateur retraite AVS/LPP pour frontaliers : calculez votre rente suisse, coordination INPS et stratégies de prévoyance.',
    },
    pillar3: {
      title: 'Simulateur du 3e pilier',
      description: "3e pilier pour frontaliers : déductions fiscales, limites 2026, meilleurs prestataires et stratégies d'épargne retraite.",
    },
    quiz: {
      title: 'Quiz fiscal pour frontaliers',
      description: 'Quiz hebdomadaire sur la fiscalité Suisse-Italie : testez vos connaissances sur impôts, déductions, permis et règles des frontaliers.',
    },
    taxCredit: {
      title: "Crédit d'impôt pour double imposition",
      description: "Calculez le crédit d'impôt pour éviter la double imposition Suisse-Italie et comprendre l'allègement de votre déclaration fiscale.",
    },
    withholdingRates: {
      title: 'Barèmes impôt à la source Tessin 2026',
      description: 'Barèmes A, B, C et H du Tessin avec exemples concrets, FAQ et liens directs vers les simulateurs de net et de fiche de paie.',
    },
    newFrontierTaxSim: {
      title: 'Simulation fiscale pour nouveaux frontaliers',
      description: "Calculez l'impôt à la source du Tessin, l'IRPEF italienne avec franchise de 10 000 EUR, le crédit d'impôt et le salaire net après le 17/07/2023.",
    },
  },
};

const FISCO_SOURCE_PATH_TO_SECTION: Record<string, FiscoSeoSection> = {
  '/tasse-e-pensione/': 'fisco',
  '/tasse-e-pensione/dichiarazione-redditi/': 'tax-return',
  '/tasse-e-pensione/dichiarazione-redditi-italia/': 'tax-return-italia',
  '/tasse-e-pensione/dichiarazione-redditi-svizzera/': 'tax-return-svizzera',
  '/tasse-e-pensione/scadenze-fiscali/': 'calendar',
  '/tasse-e-pensione/festivita-ticino/': 'holidays',
  '/tasse-e-pensione/ristorni-fiscali/': 'ristorni',
  '/tasse-e-pensione/calcola-previdenza/': 'pension',
  '/tasse-e-pensione/simula-terzo-pilastro/': 'pillar3',
  '/tasse-e-pensione/quiz-fiscale/': 'quiz',
  '/tasse-e-pensione/credito-imposta/': 'taxCredit',
  '/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026/': 'withholdingRates',
  '/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri/': 'newFrontierTaxSim',
};

export function resolveFiscoLocaleSeo(section: string, locale: string): FiscoLocaleSeo | null {
  if (locale !== 'en' && locale !== 'de' && locale !== 'fr') return null;
  return FISCO_LOCALE_SEO[locale][section as FiscoSeoSection] ?? null;
}

export function resolveFiscoLocaleSeoByPath(sourcePath: string, locale: string): FiscoLocaleSeo | null {
  const normalizedPath = sourcePath === '/' ? '/' : `${sourcePath.replace(/\/+$/, '')}/`;
  const section = FISCO_SOURCE_PATH_TO_SECTION[normalizedPath];
  return section ? resolveFiscoLocaleSeo(section, locale) : null;
}

export const FISCO_LOCALE_SEO_SOURCE_PATHS = Object.freeze(Object.keys(FISCO_SOURCE_PATH_TO_SECTION));
