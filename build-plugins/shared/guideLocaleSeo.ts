/**
 * Localized SERP metadata for the evergreen Guide pages.
 *
 * The static emitter and the SPA used to have two different fallbacks for
 * these routes: the emitter title-cased the translated slug, while the SPA
 * used a short navigation label. Both shapes dropped the page intent (and the
 * EN unemployment/car pages even shipped the slug-derived title in static
 * HTML). Keep the copy in one leaf module so the two renderers cannot drift.
 */

export type GuideSeoLocale = 'en' | 'de' | 'fr';

export type GuideSeoSection =
  | 'guide'
  | 'firstDay'
  | 'permits'
  | 'border'
  | 'unemployment'
  | 'carTransfer'
  | 'car-cost'
  | 'permit-compare'
  | 'border-map';

export interface GuideLocaleSeo {
  title: string;
  description: string;
}

const GUIDE_LOCALE_SEO: Record<GuideSeoLocale, Record<GuideSeoSection, GuideLocaleSeo>> = {
  en: {
    guide: {
      title: 'Complete Cross-Border Guide',
      description: 'Complete guide for cross-border workers: everything you need to know to work in Switzerland from Italy in 2026.',
    },
    firstDay: {
      title: 'First Day as Cross-border Worker Guide',
      description: 'First-day guide for new cross-border workers: a checklist of every step, from the G permit and AIRE registration to opening your Swiss bank account.',
    },
    permits: {
      title: 'Work Permits in Switzerland',
      description: 'Swiss work permits guide for cross-border workers: G permit, B permit, requirements, procedures and practical differences.',
    },
    border: {
      title: 'Chiasso Border Traffic & Wait Times',
      description: 'Live traffic at the Chiasso border: waiting times at Brogeda A2, Chiasso Strada and Ponte Chiasso, BAZG webcams and alternative Ticino crossing points.',
    },
    unemployment: {
      title: 'Unemployment: Switzerland and Italy',
      description: 'Unemployment for cross-border workers in Switzerland: when you need the PD U1 form, how to claim Italian NASpI, 2026 amounts and steps after dismissal.',
    },
    carTransfer: {
      title: 'Transfer Your Car to Switzerland',
      description: 'Complete guide: customs, registration, Swiss plates, driving license exchange, and insurance',
    },
    'car-cost': {
      title: 'Car Cost Calculator',
      description: 'Compare annual car ownership costs between Italy and Switzerland: insurance, road tax, fuel, maintenance, customs clearance and plates.',
    },
    'permit-compare': {
      title: 'Permit G vs Permit B',
      description: 'Detailed comparison between living in Italy (Permit G) and moving to Switzerland (Permit B). Tax analysis, cost of living and quality of life.',
    },
    'border-map': {
      title: 'Italy-Switzerland Border Map',
      description: 'Interactive Italy-Switzerland border map: 9 Ticino crossings (Chiasso, Brogeda, Gaggiolo, Ponte Tresa) with live waiting times, webcams and nearby towns.',
    },
  },
  de: {
    guide: {
      title: 'Vollständiger Grenzgänger-Leitfaden',
      description: 'Kompletter Leitfaden für Grenzgänger: alles Wissenswerte zum Arbeiten in der Schweiz aus Italien im Jahr 2026.',
    },
    firstDay: {
      title: 'Leitfaden Erster Tag als Grenzgänger',
      description: 'Leitfaden für den ersten Tag als Grenzgänger: Checkliste mit allen Schritten, von der G-Bewilligung über die AIRE-Anmeldung bis zum Schweizer Bankkonto.',
    },
    permits: {
      title: 'Arbeitsbewilligungen in der Schweiz',
      description: 'Arbeitsbewilligungen Schweiz für Grenzgänger: G-Bewilligung, B-Bewilligung, Anforderungen und praktische Unterschiede.',
    },
    border: {
      title: 'Grenzverkehr Chiasso & Wartezeiten',
      description: 'Echtzeitverkehr am Zoll Chiasso: Wartezeiten an Brogeda A2, Chiasso Strada und Ponte Chiasso, BAZG-Webcams und alternative Grenzübergänge im Tessin.',
    },
    unemployment: {
      title: 'Arbeitslosigkeit: Schweiz und Italien',
      description: 'Arbeitslosigkeit für Grenzgänger in der Schweiz: wann das Dokument PD U1 nötig ist, wie man italienisches NASpI beantragt, Beträge 2026 und Schritte danach.',
    },
    carTransfer: {
      title: 'Auto in die Schweiz überführen',
      description: 'Komplette Anleitung: Zoll, Immatrikulation, Schweizer Kennzeichen, Führerscheinumtausch und Versicherung',
    },
    'car-cost': {
      title: 'Autokosten-Rechner',
      description: 'Vergleichen Sie die jährlichen Autobesitzkosten zwischen Italien und der Schweiz: Versicherung, Steuer, Kraftstoff, Wartung, Verzollung und Kennzeichen.',
    },
    'permit-compare': {
      title: 'Bewilligung G vs B',
      description: 'Vergleich zwischen Leben in Italien (Bewilligung G) und Umzug in die Schweiz (Bewilligung B): Steuern, Lebenshaltungskosten und Lebensqualität.',
    },
    'border-map': {
      title: 'Grenzkarte Italien-Schweiz',
      description: 'Interaktive Grenzkarte Italien-Schweiz: 9 Tessiner Übergänge (Chiasso, Brogeda, Gaggiolo, Ponte Tresa) mit Live-Wartezeiten, Webcams und Nachbargemeinden.',
    },
  },
  fr: {
    guide: {
      title: 'Guide complet du frontalier',
      description: 'Guide complet pour frontaliers : tout ce qu\'il faut savoir pour travailler en Suisse depuis l\'Italie en 2026.',
    },
    firstDay: {
      title: 'Guide Premier Jour de Frontalier',
      description: 'Guide du premier jour de frontalier : checklist de toutes les étapes, du permis G à l\'inscription AIRE jusqu\'à l\'ouverture du compte bancaire suisse.',
    },
    permits: {
      title: 'Permis de Travail en Suisse',
      description: 'Guide des permis de travail suisses pour frontaliers : permis G, permis B, exigences, procédures et différences pratiques.',
    },
    border: {
      title: 'Trafic frontière Chiasso & temps d’attente',
      description: 'Trafic en temps réel à la douane de Chiasso : temps d\'attente à Brogeda A2, Chiasso Strada et Ponte Chiasso, webcams BAZG et passages alternatifs du Tessin.',
    },
    unemployment: {
      title: 'Chômage : Suisse et Italie',
      description: 'Chômage des frontaliers en Suisse : quand le document PD U1 est requis, comment demander la NASpI en Italie, montants 2026 et démarches après licenciement.',
    },
    carTransfer: {
      title: 'Transférer sa voiture en Suisse',
      description: 'Guide complet : douane, immatriculation, plaques suisses, échange de permis et assurance',
    },
    'car-cost': {
      title: 'Calculateur Coût Auto',
      description: 'Comparez les coûts annuels de possession automobile entre l\'Italie et la Suisse : assurance, taxe, carburant, entretien, dédouanement et plaques.',
    },
    'permit-compare': {
      title: 'Permis G vs Permis B',
      description: 'Comparaison détaillée entre vivre en Italie (Permis G) et s\'installer en Suisse (Permis B). Analyse fiscale, coût de la vie et qualité de vie.',
    },
    'border-map': {
      title: 'Carte frontière Italie-Suisse',
      description: 'Carte interactive de la frontière Italie-Suisse : 9 passages tessinois (Chiasso, Brogeda, Gaggiolo, Ponte Tresa) avec temps d\'attente, webcams et communes.',
    },
  },
};

const GUIDE_SOURCE_PATH_TO_SECTION: Record<string, GuideSeoSection> = {
  '/guida-frontaliere/': 'guide',
  '/guida-frontaliere/primo-giorno-lavoro/': 'firstDay',
  '/guida-frontaliere/permessi-di-lavoro/': 'permits',
  '/guida-frontaliere/tempi-attesa-dogana/': 'border',
  '/guida-frontaliere/disoccupazione-transfrontaliera/': 'unemployment',
  '/guida-frontaliere/trasferire-auto-svizzera/': 'carTransfer',
  '/guida-frontaliere/costo-auto-pendolare/': 'car-cost',
  '/guida-frontaliere/confronta-permesso-g-vs-b/': 'permit-compare',
  '/guida-frontaliere/mappa-confine/': 'border-map',
};

export function resolveGuideLocaleSeo(section: string, locale: string): GuideLocaleSeo | null {
  if (locale !== 'en' && locale !== 'de' && locale !== 'fr') return null;
  return GUIDE_LOCALE_SEO[locale][section as GuideSeoSection] ?? null;
}

export function resolveGuideLocaleSeoByPath(sourcePath: string, locale: string): GuideLocaleSeo | null {
  const normalizedPath = sourcePath === '/' ? '/' : `${sourcePath.replace(/\/+$/, '')}/`;
  const section = GUIDE_SOURCE_PATH_TO_SECTION[normalizedPath];
  return section ? resolveGuideLocaleSeo(section, locale) : null;
}

export const GUIDE_LOCALE_SEO_SOURCE_PATHS = Object.freeze(Object.keys(GUIDE_SOURCE_PATH_TO_SECTION));
