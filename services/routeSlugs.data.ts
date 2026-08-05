/**
 * Centralized localized route-slug table (it/en/de/fr).
 *
 * Single source of truth for `services/router.ts` and every Node script /
 * build plugin that needs a route slug outside the SPA's TSX graph
 * (newsletter senders, sitemap/OG/hub-chrome plugins). Importing the full
 * router pulls in its whole route-parsing graph, so those consumers used to
 * keep hand-copied literal tables that silently drifted whenever a slug was
 * renamed here — this module is pure data (no JSX, no side effects) so it's
 * cheap to import from anywhere, including plain Node scripts. See #4315.
 */
import type { Locale } from './i18n';

export interface SlugTable {
 // top-level section slugs
 calcolatore: string;
 confronti: string;
 fisco: string;
 guida: string;
 vita: string;
 stats: string;
 feedback: string;
 privacy: string;
 terms: string;
 dataDeletion: string;
 apiStatus: string;
 newsletter: string;
 gamification: string;
 morning: string;
 forum: string;
 contact: string;
 publish: string;
 publisherDashboard: string;
 journalistDashboard: string;
 forEmployers: string;
 partners: string;
 consulting: string;
 pressKit: string;
 jobBoard: string;
 profile: string;
 dashboard: string;
 // calcolatore sub-tab slugs
 whatif: string;
 payslip: string;
 ral: string;
 bonus: string;
 parentalLeave: string;
 residency: string;
 permitCompare: string;
 // confronti sub-tab slugs
 exchange: string;
 banks: string;
 health: string;
 mobile: string;
 shopping: string;
 costOfLiving: string;
 jobs: string;
 renovation: string;
 // fisco sub-tab slugs
 taxReturn: string;
 taxReturnItalia: string;
 taxReturnSvizzera: string;
 calendar: string;
 holidays: string;
 ristorni: string;
 pension: string;
 pillar3: string;
 quiz: string;
 taxCredit: string;
 withholdingRates: string;
 newFrontierTaxSim: string;
 // guida sub-tab slugs
 firstDay: string;
 permits: string;
 border: string;
 unemployment: string;
 carTransfer: string;
 carCost: string;
 municipalities: string;
 borderMap: string;
 // vita sub-tab slugs
 livingCH: string;
 livingIT: string;
 companies: string;
 schools: string;
 nursery: string;
 places: string;
 transport: string;
 // stats sub-tab slugs
 livability: string;
 jobsObservatory: string;
 salaryCompare: string;
 trafficHistory: string;
 unemploymentStats: string;
 mortgageComparison: string;
 fuelPrices: string;
 healthPremiums: string;
 // calcolatore extra slugs
 salaryQuiz: string;
 // top-level extra slugs
 blog: string;
 /** Switzerland-wide articles hub slug (sibling section of `blog`). */
 blogCh: string;

 // glossario standalone page
 glossario: string;
 // dialetto standalone page
 dialetto: string;
 // faq standalone page
 faq: string;
 // sitemap standalone page
 sitemap: string;
 // contracts / CCNL guide standalone page
 contracts: string;
 // TFR / Liquidazione calculator standalone page
 tfrCalculator: string;
 // Quiz Permesso B o G standalone page
 permitQuiz: string;
 // "Sei pronto a diventare frontaliere?" readiness wizard standalone page
 frontaliereWizard: string;
 // Tredicesima / Quattordicesima calculator standalone page
 tredicesima: string;
 // Weekly digest + Tool of the week
 weeklyDigest: string;
 toolOfWeek: string;
 // Email confirmed welcome page
 emailConfirmed: string;
 // Newsletter preferences (HMAC-authed opt-out page)
 newsletterPreferences: string;
 // "Le mie aziende seguite" — CompanyAlert manager (#5012). Signed-in only,
 // absent from every sitemap and from tests/seo-completeness.ts's
 // `standalones` on purpose: a private page, same convention as
 // newsletterPreferences / publisherDashboard.
 followedCompanies: string;
 // hidden admin route
 admin: string;
 // About / Chi Siamo page (E-E-A-T)
 chiSiamo: string;
 // Public corrections policy + log (Google News compliance B1)
 correzioni: string;
 // Subscription placeholder (adblock-gate CTA target, #3654 — hidden route,
 // no nav/sitemap entry until #3655 builds the real Stripe checkout flow)
 subscribe: string;
 // Editorial methodology page (Google News compliance — A3)
 metodologia: string;
 // Trade unions guide
 sindacati: string;
 // Definitive guide page (SEO pillar content)
 guidaCompleta: string;
 // Taxation hub pillar page (SEO pillar content — P4)
 tassazioneHub: string;
 // legacy slugs (for backward compat parsing)
 costs: string;
 salarySurvey: string;
 comparatori: string;
 strumenti: string;
 guide: string;
}

export const SLUG_TABLES: Record<Locale, SlugTable> = {
 it: {
 calcolatore: 'calcola-stipendio',
 confronti: 'compara-servizi',
 fisco: 'tasse-e-pensione',
 guida: 'guida-frontaliere',
 vita: 'vivere-in-ticino',
 stats: 'statistiche',
 feedback: 'supporto',
 privacy: 'privacy',
 terms: 'termini-di-servizio',
 dataDeletion: 'eliminazione-dati',
 apiStatus: 'stato-api',
 newsletter: 'newsletter',
 gamification: 'gamificazione',
 morning: 'buongiorno-frontaliere',
 forum: 'community',
 contact: 'contattaci',
 publish: 'pubblica-offerta',
 publisherDashboard: 'i-miei-annunci',
 journalistDashboard: 'redazione',
 forEmployers: 'per-le-aziende',
 partners: 'servizi-partner',
 consulting: 'consulenza',
 pressKit: 'stampa',
 jobBoard: 'cerca-lavoro-ticino', // cathedral-allow: TI legacy router slug
 profile: 'profilo',
 dashboard: 'dashboard',
 whatif: 'cosa-cambia-se',
 payslip: 'simula-busta-paga',
 ral: 'confronta-retribuzione-ral',
 bonus: 'stima-bonus-frontaliere',
 parentalLeave: 'verifica-congedo-parentale',
 residency: 'simula-cambio-residenza',
 permitCompare: 'confronta-permesso-g-vs-b',
 exchange: 'cambio-franco-euro',
 banks: 'confronta-banche',
 health: 'confronta-casse-malati',
 mobile: 'confronta-operatori-mobili',
 shopping: 'confronta-prezzi-spesa',
 costOfLiving: 'costo-della-vita',
 jobs: 'confronta-offerte-lavoro',
 renovation: 'calcola-bonus-ristrutturazione',
 taxReturn: 'dichiarazione-redditi',
 taxReturnItalia: 'dichiarazione-redditi-italia',
 taxReturnSvizzera: 'dichiarazione-redditi-svizzera',
 calendar: 'scadenze-fiscali',
 holidays: 'festivita-ticino',
 ristorni: 'ristorni-fiscali',
 pension: 'calcola-previdenza',
 pillar3: 'simula-terzo-pilastro',
 quiz: 'quiz-fiscale',
 taxCredit: 'credito-imposta',
 withholdingRates: 'aliquote-imposta-alla-fonte-ticino-2026',
 newFrontierTaxSim: 'simulazione-tasse-nuovi-frontalieri',
 firstDay: 'primo-giorno-lavoro',
 permits: 'permessi-di-lavoro',
 border: 'tempi-attesa-dogana',
 unemployment: 'disoccupazione-transfrontaliera',
 carTransfer: 'trasferire-auto-svizzera',
 carCost: 'costo-auto-pendolare',
 municipalities: 'comuni-di-frontiera',
 borderMap: 'mappa-confine',
 livingCH: 'vivere-in-svizzera',
 livingIT: 'vivere-in-italia',
 companies: 'aziende-svizzera-italiana',
 schools: 'scuole-svizzera-italiana',
 nursery: 'confronta-asili-nido',
 places: 'attrazioni-svizzera-italiana',
 transport: 'trasporti-frontalieri',
 livability: 'migliori-comuni-frontiera',
 jobsObservatory: 'osservatorio-stipendi-lavori-ticino',
 salaryCompare: 'confronta-stipendi',
 trafficHistory: 'storico-traffico-dogane',
 unemploymentStats: 'disoccupazione-svizzera',
 mortgageComparison: 'confronto-mutui',
 fuelPrices: 'prezzi-benzina-confine',
 healthPremiums: 'premi-malattia-comuni',
 salaryQuiz: 'quanto-guadagneresti-in-svizzera',
 blog: 'articoli-frontaliere',
 blogCh: 'articoli-svizzera',

 glossario: 'glossario-frontaliere',
 dialetto: 'dialetto-ticinese',
 faq: 'domande-frequenti-frontalieri',
 sitemap: 'mappa-del-sito',
 contracts: 'contratti-lavoro-svizzera',
 sindacati: 'sindacati-frontalieri',
 guidaCompleta: 'guida-completa-lavoro-frontaliere-svizzera-2026',
 tassazioneHub: 'guida-tassazione-frontalieri-2026',
 tfrCalculator: 'tfr-liquidazione-frontaliere',
 permitQuiz: 'quiz-permesso-b-o-g',
 frontaliereWizard: 'sei-pronto-a-diventare-frontaliere',
 tredicesima: 'calcolo-tredicesima-frontaliere',
 weeklyDigest: 'digest-settimanale',
 toolOfWeek: 'strumento-della-settimana',
 emailConfirmed: 'benvenuto-frontaliere',
 newsletterPreferences: 'preferenze-newsletter',
 followedCompanies: 'aziende-seguite',
 admin: 'gestione-contenuti-xk9mp2q',
 chiSiamo: 'chi-siamo',
 correzioni: 'correzioni',
 subscribe: 'abbonamento',
 metodologia: 'metodologia',
 costs: 'costi-pendolarismo',
 salarySurvey: 'sondaggio-stipendi',
 comparatori: 'comparatori',
 strumenti: 'strumenti',
 guide: 'guida-frontalieri',
 },
 en: {
 calcolatore: 'calculate-salary',
 confronti: 'service-comparison',
 fisco: 'taxes-and-pension',
 guida: 'cross-border-guide',
 vita: 'living-in-ticino',
 stats: 'statistics',
 feedback: 'support',
 privacy: 'privacy',
 terms: 'terms-of-service',
 dataDeletion: 'data-deletion',
 apiStatus: 'api-status',
 newsletter: 'newsletter',
 gamification: 'gamification',
 morning: 'good-morning',
 forum: 'community',
 contact: 'contact-us',
 publish: 'post-a-job',
 publisherDashboard: 'my-listings',
 journalistDashboard: 'newsroom',
 forEmployers: 'for-employers',
 partners: 'partner-services',
 consulting: 'consulting',
 pressKit: 'press-kit',
 jobBoard: 'find-jobs-ticino', // cathedral-allow: TI legacy router slug
 profile: 'profile',
 dashboard: 'dashboard',
 whatif: 'what-if-scenarios',
 payslip: 'estimate-payslip',
 ral: 'compare-gross-salary',
 bonus: 'simulate-bonus',
 parentalLeave: 'estimate-parental-leave',
 residency: 'simulate-residency-change',
 permitCompare: 'compare-permit-g-vs-b',
 exchange: 'chf-eur-exchange-rate',
 banks: 'compare-banks',
 health: 'compare-health-insurance',
 mobile: 'compare-mobile-plans',
 shopping: 'compare-grocery-prices',
 costOfLiving: 'cost-of-living',
 jobs: 'compare-job-offers',
 renovation: 'calculate-renovation-bonus',
 taxReturn: 'tax-return-guide',
 taxReturnItalia: 'tax-return-italy',
 taxReturnSvizzera: 'tax-return-switzerland',
 calendar: 'tax-deadlines',
 holidays: 'ticino-public-holidays',
 ristorni: 'tax-refunds',
 pension: 'calculate-retirement',
 pillar3: 'simulate-third-pillar',
 quiz: 'tax-quiz',
 taxCredit: 'tax-credit',
 withholdingRates: 'ticino-withholding-tax-rates-2026',
 newFrontierTaxSim: 'tax-simulation-new-cross-border-workers',
 firstDay: 'first-day-at-work',
 permits: 'work-permits-guide',
 border: 'border-waiting-times',
 unemployment: 'unemployment-benefits',
 carTransfer: 'transfer-car-to-switzerland',
 carCost: 'commuting-car-costs',
 municipalities: 'border-municipalities',
 borderMap: 'border-map',
 livingCH: 'living-in-switzerland',
 livingIT: 'living-in-italy',
 companies: 'companies-southern-switzerland',
 schools: 'schools-southern-switzerland',
 nursery: 'compare-nurseries',
 places: 'attractions-southern-switzerland',
 transport: 'cross-border-transport',
 livability: 'best-border-towns',
 jobsObservatory: 'ticino-jobs-salary-observatory',
 salaryCompare: 'compare-salaries',
 trafficHistory: 'border-traffic-history',
 unemploymentStats: 'unemployment-switzerland',
 mortgageComparison: 'mortgage-comparison',
 fuelPrices: 'border-fuel-prices',
 healthPremiums: 'health-insurance-premiums-by-commune',
 salaryQuiz: 'how-much-would-you-earn-in-switzerland',
 blog: 'cross-border-articles',
 blogCh: 'swiss-articles',

 glossario: 'cross-border-glossary',
 dialetto: 'ticinese-dialect',
 faq: 'cross-border-faq',
 sitemap: 'site-map',
 contracts: 'swiss-employment-contracts',
 tfrCalculator: 'tfr-severance-pay-calculator',
 permitQuiz: 'permit-b-or-g-quiz',
 frontaliereWizard: 'ready-to-become-a-cross-border-worker',
 tredicesima: 'thirteenth-salary-calculator',
 weeklyDigest: 'weekly-digest',
 toolOfWeek: 'tool-of-the-week',
 emailConfirmed: 'welcome',
 newsletterPreferences: 'newsletter-preferences',
 followedCompanies: 'followed-companies',
 admin: 'gestione-contenuti-xk9mp2q',
 chiSiamo: 'about-us',
 correzioni: 'corrections',
 subscribe: 'subscribe',
 metodologia: 'methodology',
 sindacati: 'trade-unions-cross-border-workers',
 guidaCompleta: 'complete-guide-cross-border-work-switzerland-2026',
 tassazioneHub: 'cross-border-taxation-guide-2026',
 costs: 'commuting-costs',
 salarySurvey: 'salary-survey',
 comparatori: 'comparators',
 strumenti: 'tools',
 guide: 'frontier-guide',
 },
 de: {
 calcolatore: 'gehalt-berechnen',
 confronti: 'service-vergleich',
 fisco: 'steuern-und-vorsorge',
 guida: 'grenzgaenger-ratgeber',
 vita: 'leben-im-tessin',
 stats: 'statistiken',
 feedback: 'hilfe',
 privacy: 'datenschutz',
 terms: 'nutzungsbedingungen',
 dataDeletion: 'daten-loeschen',
 apiStatus: 'api-status',
 newsletter: 'newsletter',
 gamification: 'gamification',
 morning: 'guten-morgen',
 forum: 'gemeinschaft',
 contact: 'kontakt',
 publish: 'stelle-aufgeben',
 publisherDashboard: 'meine-anzeigen',
 journalistDashboard: 'redaktion',
 forEmployers: 'fuer-unternehmen',
 partners: 'partner-dienste',
 consulting: 'beratung',
 pressKit: 'pressekit',
 jobBoard: 'jobs-im-tessin', // cathedral-allow: TI legacy router slug
 profile: 'profil',
 dashboard: 'dashboard',
 whatif: 'was-waere-wenn',
 payslip: 'lohnabrechnung-simulieren',
 ral: 'bruttogehalt-vergleichen',
 bonus: 'bonus-simulieren',
 parentalLeave: 'elternzeit-simulieren',
 residency: 'wohnsitzwechsel-simulieren',
 permitCompare: 'bewilligung-g-vs-b',
 exchange: 'chf-eur-wechselkurs',
 banks: 'banken-vergleichen',
 health: 'krankenkassen-vergleichen',
 mobile: 'mobilfunk-vergleichen',
 shopping: 'einkaufspreise-vergleichen',
 costOfLiving: 'lebenshaltungskosten',
 jobs: 'stellenangebote-vergleichen',
 renovation: 'renovierungs-bonus-berechnen',
 taxReturn: 'steuererklaerung',
 taxReturnItalia: 'steuererklaerung-italien',
 taxReturnSvizzera: 'steuererklaerung-schweiz',
 calendar: 'steuerfristen',
 holidays: 'tessin-feiertage',
 ristorni: 'steuerrueckerstattung',
 pension: 'rente-berechnen',
 pillar3: 'dritte-saeule-simulieren',
 quiz: 'steuer-quiz',
 taxCredit: 'steuergutschrift',
 withholdingRates: 'quellensteuer-tessin-2026',
 newFrontierTaxSim: 'steuerberechnung-neue-grenzgaenger',
 firstDay: 'erster-arbeitstag',
 permits: 'arbeitsbewilligungen',
 border: 'wartezeiten-grenze',
 unemployment: 'arbeitslosengeld',
 carTransfer: 'auto-in-schweiz-ummelden',
 carCost: 'pendler-autokosten',
 municipalities: 'grenzgemeinden',
 borderMap: 'grenzkarte',
 livingCH: 'leben-in-der-schweiz',
 livingIT: 'leben-in-italien',
 companies: 'unternehmen-suedschweiz',
 schools: 'schulen-suedschweiz',
 nursery: 'kinderkrippen-vergleichen',
 places: 'ausflugsziele-suedschweiz',
 transport: 'grenzpendler-verkehr',
 livability: 'beste-grenzgemeinden',
 jobsObservatory: 'stellen-und-lohn-observatorium-tessin',
 salaryCompare: 'gehaelter-vergleichen',
 trafficHistory: 'grenzverkehr-verlauf',
 unemploymentStats: 'arbeitslosigkeit-schweiz',
 mortgageComparison: 'hypotheken-vergleich',
 fuelPrices: 'spritpreise-grenze',
 healthPremiums: 'krankenkassentraemien-nach-gemeinde',
 salaryQuiz: 'verdienst-in-der-schweiz',
 blog: 'grenzgaenger-artikel',
 blogCh: 'schweiz-artikel',

 glossario: 'grenzgaenger-glossar',
 dialetto: 'tessiner-dialekt',
 faq: 'grenzgaenger-faq',
 sitemap: 'seitenplan',
 contracts: 'schweizer-arbeitsvertraege',
 tfrCalculator: 'tfr-abfindung-grenzgaenger-rechner',
 permitQuiz: 'quiz-bewilligung-b-oder-g',
 frontaliereWizard: 'bereit-grenzgaenger-zu-werden',
 tredicesima: 'dreizehnter-monatslohn-rechner',
 weeklyDigest: 'woechentlicher-bericht',
 toolOfWeek: 'werkzeug-der-woche',
 emailConfirmed: 'willkommen',
 newsletterPreferences: 'newsletter-einstellungen',
 followedCompanies: 'gefolgte-unternehmen',
 admin: 'gestione-contenuti-xk9mp2q',
 chiSiamo: 'ueber-uns',
 correzioni: 'korrekturen',
 subscribe: 'abonnement',
 metodologia: 'methodik',
 sindacati: 'gewerkschaften-grenzgaenger',
 guidaCompleta: 'komplettanleitung-grenzgaenger-arbeit-schweiz-2026',
 tassazioneHub: 'grenzgaenger-besteuerung-leitfaden-2026',
 costs: 'pendelkosten',
 salarySurvey: 'gehaltsumfrage',
 comparatori: 'vergleiche',
 strumenti: 'werkzeuge',
 guide: 'grenzgaenger-guide',
 },
 fr: {
 calcolatore: 'calculer-salaire',
 confronti: 'comparaison-services',
 fisco: 'impots-et-retraite',
 guida: 'guide-frontalier',
 vita: 'vivre-au-tessin',
 stats: 'statistiques',
 feedback: 'assistance',
 privacy: 'confidentialite',
 terms: 'conditions-utilisation',
 dataDeletion: 'suppression-donnees',
 apiStatus: 'etat-api',
 newsletter: 'newsletter',
 gamification: 'gamification',
 morning: 'bonjour-frontalier',
 forum: 'communaute',
 contact: 'contactez-nous',
 publish: 'publier-une-offre',
 publisherDashboard: 'mes-annonces',
 journalistDashboard: 'redaction',
 forEmployers: 'pour-les-entreprises',
 partners: 'services-partenaires',
 consulting: 'consultation',
 pressKit: 'kit-presse',
 jobBoard: 'trouver-emploi-tessin', // cathedral-allow: TI legacy router slug
 profile: 'profil',
 dashboard: 'tableau-de-bord',
 whatif: 'scenarios-hypothetiques',
 payslip: 'simuler-fiche-de-paie',
 ral: 'comparer-salaire-brut',
 bonus: 'estimer-bonus',
 parentalLeave: 'simuler-conge-parental',
 residency: 'simuler-changement-residence',
 permitCompare: 'comparer-permis-g-vs-b',
 exchange: 'taux-change-chf-eur',
 banks: 'comparer-banques',
 health: 'comparer-caisses-maladie',
 mobile: 'comparer-forfaits-mobiles',
 shopping: 'comparer-prix-courses',
 costOfLiving: 'cout-de-la-vie',
 jobs: 'comparer-offres-emploi',
 renovation: 'calculer-bonus-renovation',
 taxReturn: 'declaration-revenus',
 taxReturnItalia: 'declaration-revenus-italie',
 taxReturnSvizzera: 'declaration-revenus-suisse',
 calendar: 'echeances-fiscales',
 holidays: 'jours-feries-tessin',
 ristorni: 'ristornes-fiscaux',
 pension: 'calculer-pension',
 pillar3: 'simuler-troisieme-pilier',
 quiz: 'quiz-fiscal',
 taxCredit: 'credit-impot',
 withholdingRates: 'baremes-impot-a-la-source-tessin-2026',
 newFrontierTaxSim: 'simulation-impots-nouveaux-frontaliers',
 firstDay: 'premier-jour-travail',
 permits: 'permis-de-travail',
 border: 'temps-attente-douane',
 unemployment: 'allocations-chomage',
 carTransfer: 'transferer-voiture-suisse',
 carCost: 'cout-voiture-pendulaire',
 municipalities: 'communes-frontiere',
 borderMap: 'carte-frontiere',
 livingCH: 'vivre-en-suisse',
 livingIT: 'vivre-en-italie',
 companies: 'entreprises-suisse-italienne',
 schools: 'ecoles-suisse-italienne',
 nursery: 'comparer-creches',
 places: 'decouvrir-suisse-italienne',
 transport: 'transports-frontaliers',
 livability: 'meilleures-communes-frontiere',
 jobsObservatory: 'observatoire-emplois-salaires-tessin',
 salaryCompare: 'comparer-salaires',
 trafficHistory: 'historique-trafic-frontiere',
 unemploymentStats: 'chomage-suisse',
 mortgageComparison: 'comparaison-hypotheques',
 fuelPrices: 'prix-essence-frontiere',
 healthPremiums: 'primes-assurance-maladie-communes',
 salaryQuiz: 'combien-gagneriez-vous-en-suisse',
 blog: 'articles-frontalier',
 blogCh: 'articles-suisse',

 glossario: 'glossaire-frontalier',
 dialetto: 'dialecte-tessinois',
 faq: 'faq-frontaliers',
 sitemap: 'plan-du-site',
 contracts: 'contrats-travail-suisses',
 tfrCalculator: 'tfr-indemnite-licenciement-frontalier',
 permitQuiz: 'quiz-permis-b-ou-g',
 frontaliereWizard: 'pret-a-devenir-frontalier',
 tredicesima: 'calculateur-treizieme-salaire',
 weeklyDigest: 'digest-hebdomadaire',
 toolOfWeek: 'outil-de-la-semaine',
 emailConfirmed: 'bienvenue',
 newsletterPreferences: 'preferences-newsletter',
 followedCompanies: 'entreprises-suivies',
 admin: 'gestione-contenuti-xk9mp2q',
 chiSiamo: 'a-propos',
 correzioni: 'corrections',
 subscribe: 'abonnement',
 metodologia: 'methodologie',
 sindacati: 'syndicats-frontaliers',
 guidaCompleta: 'guide-complet-travail-frontalier-suisse-2026',
 tassazioneHub: 'guide-imposition-frontaliers-2026',
 costs: 'couts-pendulaire',
 salarySurvey: 'sondage-salaires',
 comparatori: 'comparateurs',
 strumenti: 'outils',
 guide: 'guide-frontaliers',
 },
};
