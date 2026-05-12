/**
 * Pure data + types for relatedSearchClustersPlugin.ts.
 *
 * Extracted to keep the main plugin file focused on emission logic. No I/O,
 * no side effects, no DOM. Locale copy lives here so translation drift can
 * be reviewed in one place.
 */

import type { Locale } from '../services/i18n';

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = ['it', 'en', 'de', 'fr'] as const;

export const LOCALE_PREFIX: Record<Locale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

export const OG_LOCALE: Record<Locale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

/** Known Swiss cities used to detect a city suffix in `sampleTerms[0]`. */
export const KNOWN_CITIES: ReadonlyArray<string> = [
  'Lugano-Paradiso', 'Locarno-Muralto',
  'Lugano', 'Bellinzona', 'Mendrisio', 'Locarno', 'Chiasso',
  'Chur', 'Davos', 'St. Moritz',
  'Sion', 'Brig', 'Visp', 'Martigny', 'Monthey', 'Sierre',
  'Zürich', 'Zurich', 'Basel', 'Bern', 'Geneva', 'Genève', 'Lausanne',
  'Winterthur', 'Lucerne', 'Luzern', 'Fribourg', 'Neuchâtel', 'Neuchatel',
  'Aarau', 'Zug', 'Schaffhausen', 'Thun', 'Biel', 'Bienne',
];

export interface CandidateEntry {
  slug: string;
  locale: Locale;
  jobCount: number;
  sampleJobIds?: string[];
  sampleTerms?: string[];
  editorialCollision: unknown;
  gscMatch?: boolean;
}

export interface CandidatesFile {
  generatedAt?: string;
  candidates: CandidateEntry[];
}

export interface EnrichedFaq {
  // Wire format produced by `scripts/enrich-related-search-clusters.mjs`
  // (and historical entries in `data/related-search-enriched.json`).
  q: string;
  a: string;
}

export interface EnrichedEntry {
  slug: string;
  locale: Locale;
  keyword: string;
  city: string | null;
  intro: string;
  faqs: EnrichedFaq[];
}

export interface EnrichedFile {
  entries: Record<string, EnrichedEntry>;
}

export interface RawJob {
  id?: string;
  slug?: string;
  slugByLocale?: Partial<Record<Locale, string>>;
  title?: string;
  titleByLocale?: Partial<Record<Locale, string>>;
  description?: string;
  descriptionByLocale?: Partial<Record<Locale, string>>;
  company?: string;
  companyKey?: string;
  companyDomain?: string;
  location?: string;
  addressLocality?: string;
  canton?: string;
  contract?: string;
  postedDate?: string;
  datePosted?: string;
  salaryMin?: number | string | null;
  salaryMax?: number | string | null;
  needsRetranslation?: boolean | Partial<Record<Locale, boolean>>;
  expired?: boolean;
}

export interface LocaleCopy {
  homeBreadcrumb: string;
  jobsBreadcrumb: string;
  searchBreadcrumb: string;
  taglineSingular: (n: number, kw: string, city: string | null) => string;
  jobsHeading: string;
  introSummary: string;
  faqSummary: string;
  relatedHeading: string;
  hubH1: string;
  hubIntro: (n: number) => string;
  hubTitle: string;
  hubDescription: string;
  ctaAllJobs: string;
  ctaCalculator: string;
  pageNavigatorLabel: string;
  citySectionLabel: string;
  alphabeticalLabel: string;
  /** H1 suffix used when matchingJobs.length === 0 — forward-framed
   *  ("alert quotidiano" / "daily alert") so the static-body H1 differs
   *  from <title> without surfacing a "0 offerte" negative-signal. */
  alertCta: string;
}

export const COPY: Record<Locale, LocaleCopy> = {
  it: {
    homeBreadcrumb: 'Home',
    jobsBreadcrumb: 'Cerca lavoro Ticino',
    searchBreadcrumb: 'Ricerche',
    taglineSingular: (n, kw, city) =>
      city
        ? `${n} offerte di lavoro per "${kw}" a ${city}, aggiornate ogni giorno.`
        : `${n} offerte di lavoro per "${kw}", aggiornate ogni giorno.`,
    jobsHeading: 'Offerte aperte',
    introSummary: 'Cosa cercare per questa posizione',
    faqSummary: 'Domande frequenti',
    relatedHeading: 'Ricerche correlate',
    hubH1: 'Tutte le ricerche di lavoro',
    hubIntro: (n) => `Indice di ${n} ricerche specifiche per il mercato del lavoro ticinese, con offerte aggiornate ogni giorno.`,
    hubTitle: 'Tutte le ricerche di lavoro',
    hubDescription: 'Indice completo delle ricerche di lavoro per frontalieri italo-svizzeri.',
    ctaAllJobs: 'Tutte le offerte',
    ctaCalculator: 'Calcola stipendio netto',
    pageNavigatorLabel: 'Pagina',
    citySectionLabel: 'Per città',
    alphabeticalLabel: 'Altre ricerche',
    alertCta: 'alert quotidiano nuove offerte',
  },
  en: {
    homeBreadcrumb: 'Home',
    jobsBreadcrumb: 'Find jobs Ticino',
    searchBreadcrumb: 'Searches',
    taglineSingular: (n, kw, city) =>
      city
        ? `${n} jobs matching "${kw}" in ${city}, updated daily.`
        : `${n} jobs matching "${kw}", updated daily.`,
    jobsHeading: 'Open positions',
    introSummary: 'About these jobs',
    faqSummary: 'Frequently asked questions',
    relatedHeading: 'Related searches',
    hubH1: 'All job searches',
    hubIntro: (n) => `Index of ${n} specific searches for the Ticino labour market, with daily-refreshed openings.`,
    hubTitle: 'All job searches',
    hubDescription: 'Full index of job searches for Italian-Swiss cross-border workers.',
    ctaAllJobs: 'All openings',
    ctaCalculator: 'Calculate net salary',
    pageNavigatorLabel: 'Page',
    citySectionLabel: 'By city',
    alphabeticalLabel: 'Other searches',
    alertCta: 'daily alert for new openings',
  },
  de: {
    homeBreadcrumb: 'Home',
    jobsBreadcrumb: 'Jobs im Tessin',
    searchBreadcrumb: 'Suchen',
    taglineSingular: (n, kw, city) =>
      city
        ? `${n} Stellen für "${kw}" in ${city}, täglich aktualisiert.`
        : `${n} Stellen für "${kw}", täglich aktualisiert.`,
    jobsHeading: 'Offene Stellen',
    introSummary: 'Über diese Stellen',
    faqSummary: 'Häufige Fragen',
    relatedHeading: 'Verwandte Suchen',
    hubH1: 'Alle Suchen',
    hubIntro: (n) => `Index von ${n} spezifischen Suchen für den Tessiner Arbeitsmarkt, mit täglich aktualisierten Inseraten.`,
    hubTitle: 'Alle Suchen',
    hubDescription: 'Vollständiger Index der Stellensuchen für italienisch-schweizerische Grenzgänger.',
    ctaAllJobs: 'Alle Stellen',
    ctaCalculator: 'Nettolohn berechnen',
    pageNavigatorLabel: 'Seite',
    citySectionLabel: 'Nach Stadt',
    alphabeticalLabel: 'Weitere Suchen',
    alertCta: 'täglicher Alert für neue Inserate',
  },
  fr: {
    homeBreadcrumb: 'Home',
    jobsBreadcrumb: 'Trouver emploi Tessin',
    searchBreadcrumb: 'Recherches',
    taglineSingular: (n, kw, city) =>
      city
        ? `${n} offres pour "${kw}" à ${city}, mises à jour quotidiennement.`
        : `${n} offres pour "${kw}", mises à jour quotidiennement.`,
    jobsHeading: 'Postes ouverts',
    introSummary: 'À propos de ces offres',
    faqSummary: 'Questions fréquentes',
    relatedHeading: 'Recherches associées',
    hubH1: 'Toutes les recherches',
    hubIntro: (n) => `Index de ${n} recherches spécifiques pour le marché du travail tessinois, avec offres mises à jour quotidiennement.`,
    hubTitle: 'Toutes les recherches',
    hubDescription: 'Index complet des recherches d\'emploi pour les frontaliers italo-suisses.',
    ctaAllJobs: 'Toutes les offres',
    ctaCalculator: 'Calculer salaire net',
    pageNavigatorLabel: 'Page',
    citySectionLabel: 'Par ville',
    alphabeticalLabel: 'Autres recherches',
    alertCta: 'alerte quotidienne pour nouvelles offres',
  },
};

/** Build the locale-specific template intro paragraph. */
export function buildTemplateIntro(opts: {
  locale: Locale;
  jobCount: number;
  keyword: string;
  city: string | null;
  topCompanies: ReadonlyArray<string>;
}): string {
  const { locale, jobCount, keyword, city, topCompanies } = opts;
  const citySuffix = city ? ` ${locale === 'it' || locale === 'fr' ? 'a' : 'in'} ${city}` : '';
  const top3 = topCompanies.length > 0 ? topCompanies.join(', ') : '';

  // Template intro is ~140-160 words to ensure visible-text/total-HTML ratio
  // exceeds the 10% Semrush threshold (audit:text-html-ratio gate). Each
  // paragraph adds context that's coherent and page-relevant — never filler:
  // (1) what the page lists + frontaliere context, (2) salary/permit angle,
  // (3) how to apply / next steps with cross-link to the calculator. Variability
  // comes from {jobCount}, {keyword}, {citySuffix}, {top3} so 1,500 pages
  // don't share boilerplate that would trigger doorway-page detection.
  if (locale === 'it') {
    const companyPart = top3 ? ` Le aziende che assumono di più in questo momento sono ${top3}.` : '';
    const cityClause = city ? `a ${city}` : 'in tutta la Svizzera italofona';
    return `In questa pagina trovi ${jobCount} offerte di lavoro per ${keyword}${citySuffix}. Le posizioni sono aggiornate ogni giorno e includono opportunità sia per chi vive in Svizzera sia per i lavoratori frontalieri residenti in Italia. Per ciascun annuncio puoi consultare il salario indicativo (quando disponibile), il tipo di contratto e la sede esatta.${companyPart} Per i frontalieri, una posizione ${cityClause} comporta valutazioni specifiche su permesso G, tassazione del Nuovo Accordo del 2026, contributi previdenziali AVS/LPP e assicurazione malattia LAMal. Il salario lordo svizzero in CHF, una volta convertito in EUR e dedotti i contributi obbligatori, va confrontato con il costo della vita italiano e con i tempi di pendolarismo dal proprio comune di residenza. Visita le pagine dei singoli annunci per i dettagli completi su mansioni e requisiti, oppure usa il calcolatore di stipendio netto per stimare il guadagno reale e confrontare residenza B vs frontaliere G.`;
  }
  if (locale === 'en') {
    const companyPart = top3 ? ` Top hiring employers right now: ${top3}.` : '';
    const cityClause = city ? `in ${city}` : 'across Italian-speaking Switzerland';
    return `This page lists ${jobCount} open positions for ${keyword}${citySuffix}. Listings refresh every day and cover both Swiss residents and Italian cross-border workers. Each ad shows the salary range (when available), contract type, and exact location.${companyPart} For cross-border workers ("frontalieri"), a role ${cityClause} comes with specific considerations: G permit eligibility, taxation under the 2026 New Agreement, AVS/LPP pension contributions, and LAMal/Italian health-insurance interplay. The gross CHF salary, once converted to EUR and net of mandatory contributions, should be weighed against Italian cost of living and the daily commute time from your home municipality. Open individual listings for full details on duties and requirements, or use the net-salary calculator to estimate real take-home pay and compare a Swiss B residence vs an Italian G frontaliere setup.`;
  }
  if (locale === 'de') {
    const companyPart = top3 ? ` Die wichtigsten Arbeitgeber, die aktuell einstellen: ${top3}.` : '';
    const cityClause = city ? `in ${city}` : 'im italienischsprachigen Teil der Schweiz';
    return `Auf dieser Seite finden Sie ${jobCount} offene Stellen für ${keyword}${citySuffix}. Die Inserate werden täglich aktualisiert und decken sowohl in der Schweiz wohnhafte als auch italienische Grenzgängerinnen und Grenzgänger ab. Jedes Inserat zeigt Lohnspanne (sofern verfügbar), Vertragsart und Arbeitsort.${companyPart} Für Grenzgänger ("frontalieri") bringt eine Stelle ${cityClause} spezifische Überlegungen mit sich: Bewilligung G, Besteuerung nach dem neuen Abkommen 2026, AHV-/BVG-Beiträge sowie das Zusammenspiel von LAMal-Krankenversicherung und italienischem Gesundheitssystem. Der Schweizer Bruttolohn in CHF, umgerechnet in EUR und nach Abzug der Pflichtbeiträge, ist gegen die italienischen Lebenshaltungskosten und die Pendelzeit ab Ihrem Wohnort abzuwägen. Öffnen Sie die einzelnen Inserate für vollständige Angaben zu Aufgaben und Anforderungen oder nutzen Sie den Nettolohnrechner, um den realen Verdienst zu schätzen und Aufenthalt B mit Grenzgänger G zu vergleichen.`;
  }
  // fr
  const companyPart = top3 ? ` Les principaux employeurs qui recrutent actuellement : ${top3}.` : '';
  const cityClause = city ? `à ${city}` : 'dans toute la Suisse italophone';
  return `Cette page liste ${jobCount} offres d'emploi pour ${keyword}${citySuffix}. Les annonces sont mises à jour chaque jour et concernent aussi bien les résidents suisses que les frontaliers italiens. Chaque annonce indique la fourchette de salaire (lorsqu'elle est disponible), le type de contrat et la localisation exacte.${companyPart} Pour les travailleurs frontaliers ("frontalieri"), un poste ${cityClause} implique des considérations spécifiques : permis G, fiscalité selon le Nouvel Accord 2026, cotisations AVS/LPP et articulation entre l'assurance-maladie LAMal suisse et le système italien. Le salaire brut suisse en CHF, converti en EUR et net des cotisations obligatoires, doit être mis en perspective avec le coût de la vie italien et le temps de trajet quotidien depuis votre commune de résidence. Consultez les annonces individuelles pour le détail des missions et des prérequis, ou utilisez le calculateur de salaire net pour estimer le revenu réel et comparer un séjour B avec un statut frontalier G.`;
}
