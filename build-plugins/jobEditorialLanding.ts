export type JobLandingLocale = 'it' | 'en' | 'de' | 'fr';
export type JobLandingTypeKey = 'apprenticeship' | 'internship' | 'partTime';
export type JobLandingSectorKey = 'health' | 'finance' | 'tech' | 'engineering' | 'admin' | 'hospitality' | 'sales';
export type JobCareClusterKey = 'clinics' | 'careHomes' | 'oss' | 'educators';

export const JOB_PART_TIME_LANDING_SLUGS: Record<JobLandingLocale, string> = {
  it: 'lavoro-part-time',
  en: 'part-time-jobs',
  de: 'teilzeit-jobs',
  fr: 'emploi-temps-partiel',
};

export const JOB_TODAY_LANDING_SLUGS: Record<JobLandingLocale, string> = {
  it: 'offerte-di-lavoro-ticino-oggi',
  en: 'ticino-jobs-today',
  de: 'jobs-tessin-heute',
  fr: 'offres-emploi-tessin-aujourdhui',
};

export const JOB_OFFICIAL_GAZETTE_LANDING_SLUGS: Record<JobLandingLocale, string> = {
  it: 'foglio-ufficiale-offerte-di-lavoro-ticino',
  en: 'official-gazette-ticino-jobs',
  de: 'amtsblatt-stellen-tessin',
  fr: 'feuille-officielle-emplois-tessin',
};

export const JOB_NURSES_HUB_SLUGS: Record<JobLandingLocale, string> = {
  it: 'infermieri-in-ticino',
  en: 'nurses-in-ticino',
  de: 'pflege-jobs-im-tessin',
  fr: 'infirmiers-au-tessin',
};

const SEARCH_ROUTE_PREFIX: Record<JobLandingLocale, string> = {
  it: 'ricerca',
  en: 'search',
  de: 'suche',
  fr: 'recherche',
};

const SUPPORTED_EDITORIAL_LOCATIONS = ['Lugano', 'Bellinzona', 'Mendrisio', 'Locarno', 'Chiasso'] as const;
const SUPPORTED_EDITORIAL_LOCATION_SET = new Set<string>(SUPPORTED_EDITORIAL_LOCATIONS);

// SEO plugin uses Italian sector keys that don't always match JOB_SECTOR_DEFS slugs
const SECTOR_SLUG_ALIASES: Record<string, JobLandingSectorKey> = {
  informatica: 'tech',
  vendita: 'sales',
  ristorazione: 'hospitality',
};

type JobLike = Record<string, any>;

type LandingJobLink = {
  title: string;
  company: string;
  location: string;
  href: string;
};

type LandingSection = {
  label: string;
  jobs: LandingJobLink[];
};

type CityLeader = {
  name: string;
  count: number;
  href: string;
};

type TypeLink = {
  key: JobLandingTypeKey;
  label: string;
  href: string;
  count: number;
};

type SectorLink = {
  key: JobLandingSectorKey;
  label: string;
  href: string;
  count: number;
};

export type JobTodayLandingModel = {
  slug: string;
  title: string;
  heading: string;
  description: string;
  intro: string;
  updatedLabel: string;
  countsLabel: string;
  totalJobs: number;
  sections: {
    last24Hours: LandingSection;
    last3Days: LandingSection;
    partTime: LandingSection;
    cityHubLabel: string;
    cities: CityLeader[];
  };
  internalLinks: Array<{ label: string; href: string }>;
  openAllLabel: string;
};

export type JobLocationLandingModel = {
  kind: 'location';
  slug: string;
  location: string;
  title: string;
  heading: string;
  description: string;
  intro: string;
  updatedLabel: string;
  countsLabel: string;
  totalJobs: number;
  feed: LandingSection;
  latestLabel: string;
  latestJobs: LandingJobLink[];
  relatedTypeLinks: TypeLink[];
  relatedSectorLinks: SectorLink[];
  openAllLabel: string;
};

export type JobLocationTypeLandingModel = {
  kind: 'location-type';
  slug: string;
  location: string;
  typeKey: JobLandingTypeKey;
  title: string;
  heading: string;
  description: string;
  intro: string;
  updatedLabel: string;
  countsLabel: string;
  totalJobs: number;
  feed: LandingSection;
  latestLabel: string;
  latestJobs: LandingJobLink[];
  parentLocationHref: string;
  siblingTypeLinks: TypeLink[];
  openAllLabel: string;
};

export type JobLocationSectorLandingModel = {
  kind: 'location-sector';
  slug: string;
  location: string;
  sectorKey: JobLandingSectorKey;
  title: string;
  heading: string;
  description: string;
  intro: string;
  updatedLabel: string;
  countsLabel: string;
  totalJobs: number;
  feed: LandingSection;
  latestLabel: string;
  latestJobs: LandingJobLink[];
  parentLocationHref: string;
  siblingSectorLinks: SectorLink[];
  openAllLabel: string;
};

export type JobSectorRegionLandingModel = {
  kind: 'sector-region';
  slug: string;
  sectorKey: JobLandingSectorKey;
  title: string;
  heading: string;
  description: string;
  intro: string;
  updatedLabel: string;
  countsLabel: string;
  totalJobs: number;
  feed: LandingSection;
  latestLabel: string;
  latestJobs: LandingJobLink[];
  siblingSectorLinks: SectorLink[];
  openAllLabel: string;
};

export type JobOfficialGazetteLandingModel = {
  kind: 'official-gazette';
  slug: string;
  title: string;
  heading: string;
  description: string;
  intro: string;
  updatedLabel: string;
  countsLabel: string;
  totalJobs: number;
  feed: LandingSection;
  latestLabel: string;
  latestJobs: LandingJobLink[];
  explainerTitle: string;
  explainerCards: Array<{ title: string; body: string }>;
  officialSourceLabel: string;
  officialSourceUrl: string;
  internalLinks: Array<{ label: string; href: string }>;
  faq: Array<{ question: string; answer: string }>;
  openAllLabel: string;
};

type CareVariantLink = {
  key: JobCareClusterKey;
  label: string;
  href: string;
  count: number;
};

export type JobNursesHubLandingModel = {
  kind: 'nurses-hub';
  slug: string;
  title: string;
  heading: string;
  description: string;
  intro: string;
  updatedLabel: string;
  countsLabel: string;
  totalJobs: number;
  feed: LandingSection;
  latestLabel: string;
  latestJobs: LandingJobLink[];
  variantTitle: string;
  variants: CareVariantLink[];
  explainerCards: Array<{ title: string; body: string }>;
  faq: Array<{ question: string; answer: string }>;
  openAllLabel: string;
};

export type JobCareVariantLandingModel = {
  kind: 'care-variant';
  slug: string;
  clusterKey: JobCareClusterKey;
  title: string;
  heading: string;
  description: string;
  intro: string;
  updatedLabel: string;
  countsLabel: string;
  totalJobs: number;
  feed: LandingSection;
  latestLabel: string;
  latestJobs: LandingJobLink[];
  parentHubHref: string;
  siblingLinks: CareVariantLink[];
  openAllLabel: string;
};

export type JobPartTimeLandingModel = {
  kind: 'part-time';
  slug: string;
  title: string;
  heading: string;
  description: string;
  intro: string;
  updatedLabel: string;
  countsLabel: string;
  totalJobs: number;
  feed: LandingSection;
  latestLabel: string;
  latestJobs: LandingJobLink[];
  cityLinks: CityLeader[];
  cityHubLabel: string;
  faq: Array<{ question: string; answer: string }>;
  openAllLabel: string;
};

export type EditorialLandingDescriptor =
  | { kind: 'today' }
  | { kind: 'official-gazette' }
  | { kind: 'nurses-hub' }
  | { kind: 'part-time' }
  | { kind: 'care-variant'; clusterKey: JobCareClusterKey }
  | { kind: 'location'; location: string }
  | { kind: 'location-type'; location: string; typeKey: JobLandingTypeKey }
  | { kind: 'location-sector'; location: string; sectorKey: JobLandingSectorKey }
  | { kind: 'sector-region'; sectorKey: JobLandingSectorKey };

const TODAY_COPY: Record<JobLandingLocale, {
  title: string;
  heading: string;
  description: string;
  intro: string;
  updatedLabel: string;
  countsLabel: string;
  fresh24h: string;
  fresh3d: string;
  partTime: string;
  cityHub: string;
  openAll: string;
  internalLinks: [string, string, string];
}> = {
  it: {
    title: 'Offerte di lavoro Ticino oggi | Ultime 24 ore e ultimi 3 giorni',
    heading: 'Offerte di lavoro Ticino oggi',
    description: 'Scopri le offerte di lavoro in Ticino pubblicate oggi o negli ultimi 3 giorni, con blocchi dedicati a ultime 24 ore, part-time e citta come Lugano, Bellinzona, Mendrisio, Locarno e Chiasso.',
    intro: 'Questa landing editoriale raccoglie gli annunci piu freschi del nostro job board Ticino e li organizza in blocchi utili per chi cerca lavoro in Ticino e vuole capire subito dove si sta muovendo il mercato.',
    updatedLabel: 'Aggiornamento',
    countsLabel: 'annunci attivi monitorati',
    fresh24h: 'Ultime 24 ore',
    fresh3d: 'Ultimi 3 giorni',
    partTime: 'Part-time in Ticino',
    cityHub: 'Per citta',
    openAll: 'Vedi tutte le offerte di lavoro in Ticino',
    internalLinks: ['Ultime 24 ore', 'Ultimi 3 giorni', 'Part-time in Ticino'],
  },
  en: {
    title: 'Ticino jobs today | Last 24 hours and last 3 days',
    heading: 'Ticino jobs today',
    description: 'Browse Ticino jobs published today or in the last 3 days, with dedicated blocks for the last 24 hours, part-time roles and key cities such as Lugano, Bellinzona, Mendrisio, Locarno and Chiasso.',
    intro: 'This editorial landing page groups the freshest jobs from our Ticino job board and makes it easier to scan where employers are actively hiring.',
    updatedLabel: 'Updated',
    countsLabel: 'active jobs tracked',
    fresh24h: 'New jobs in the last 24 hours',
    fresh3d: 'Jobs from the last 3 days',
    partTime: 'Part-time jobs in Ticino',
    cityHub: 'Browse by city',
    openAll: 'See all jobs in Ticino',
    internalLinks: ['Last 24 hours', 'Last 3 days', 'Part-time jobs in Ticino'],
  },
  de: {
    title: 'Jobs im Tessin heute | Letzte 24 Stunden und letzte 3 Tage',
    heading: 'Jobs im Tessin heute',
    description: 'Entdecken Sie Jobs im Tessin, die heute oder in den letzten 3 Tagen veroffentlicht wurden, mit Bereichen fur die letzten 24 Stunden, Teilzeit und Stadte wie Lugano, Bellinzona, Mendrisio, Locarno und Chiasso.',
    intro: 'Diese Landingpage bundelt die frischesten Stellen aus unserem Tessiner Job Board und ordnet sie in nutzliche Blöcke fur eine schnelle Orientierung.',
    updatedLabel: 'Aktualisiert',
    countsLabel: 'aktive Jobs im Monitoring',
    fresh24h: 'Neue Jobs in den letzten 24 Stunden',
    fresh3d: 'Jobs der letzten 3 Tage',
    partTime: 'Teilzeitjobs im Tessin',
    cityHub: 'Nach Stadt suchen',
    openAll: 'Alle Jobs im Tessin ansehen',
    internalLinks: ['Neue Jobs in den letzten 24 Stunden', 'Jobs der letzten 3 Tage', 'Teilzeitjobs im Tessin'],
  },
  fr: {
    title: "Offres d'emploi au Tessin aujourd'hui | Dernieres 24 heures et 3 derniers jours",
    heading: "Offres d'emploi au Tessin aujourd'hui",
    description: "Consultez les offres d'emploi au Tessin publiees aujourd'hui ou durant les 3 derniers jours, avec des blocs dedies aux 24 dernieres heures, au temps partiel et aux villes comme Lugano, Bellinzone, Mendrisio, Locarno et Chiasso.",
    intro: "Cette landing page regroupe les offres les plus recentes de notre job board au Tessin et les organise en blocs utiles pour lire rapidement le marche.",
    updatedLabel: 'Mis a jour',
    countsLabel: 'offres actives suivies',
    fresh24h: 'Nouvelles offres des dernieres 24 heures',
    fresh3d: 'Offres des 3 derniers jours',
    partTime: 'Temps partiel au Tessin',
    cityHub: 'Par ville',
    openAll: 'Voir toutes les offres au Tessin',
    internalLinks: ['Dernieres 24 heures', '3 derniers jours', 'Temps partiel au Tessin'],
  },
};

const OFFICIAL_GAZETTE_COPY: Record<JobLandingLocale, {
  title: string;
  heading: string;
  description: (count: number) => string;
  intro: string;
  updatedLabel: string;
  countsLabel: string;
  feedLabel: string;
  latestLabel: string;
  openAll: string;
  officialSourceLabel: string;
  explainerTitle: string;
  explainerCards: Array<{ title: string; body: string }>;
  internalLinks: [string, string];
  faq: Array<{ question: string; answer: string }>;
}> = {
  it: {
    title: 'Foglio ufficiale offerte di lavoro Ticino | Concorsi pubblici e fonti ufficiali',
    heading: 'Foglio ufficiale offerte di lavoro Ticino',
    description: (count) => `Consulta ${count} concorsi pubblici e offerte di lavoro dal Foglio ufficiale del Ticino gia indicizzati da Frontaliere Ticino, con differenze tra concorsi pubblici, job board e fonti ufficiali.`,
    intro: 'Questa pagina ti aiuta a distinguere tra concorsi pubblici, annunci del nostro job board e fonti ufficiali cantonali. Qui trovi soprattutto concorsi pubblici indicizzati da fonti ufficiali come concorsi.ti.ch, con link interni alle schede gia pulite e leggibili.',
    updatedLabel: 'Aggiornamento',
    countsLabel: 'concorsi pubblici indicizzati',
    feedLabel: 'Concorsi pubblici e offerte dal Foglio ufficiale',
    latestLabel: 'Nuovi concorsi negli ultimi 3 giorni',
    openAll: 'Vedi tutte le offerte in Ticino',
    officialSourceLabel: 'Fonte ufficiale cantonale',
    explainerTitle: 'Come leggere le offerte del Foglio ufficiale in Ticino',
    explainerCards: [
      {
        title: 'Concorsi pubblici',
        body: 'Sono bandi per enti pubblici o amministrazioni. Hanno requisiti formali, documenti obbligatori, scadenze precise e procedure di candidatura rigidamente definite.',
      },
      {
        title: 'Job board aggregato',
        body: 'Il nostro job board unisce aziende private, enti pubblici e concorsi ufficiali in un unico posto. Serve per confrontare piu opportunita, non sostituisce la fonte originaria.',
      },
      {
        title: 'Fonti ufficiali',
        body: 'Le fonti ufficiali come concorsi.ti.ch restano il riferimento per testo integrale, formulari, allegati e validita del bando. Noi le rendiamo piu facili da trovare e filtrare.',
      },
    ],
    internalLinks: ['Ultimi concorsi pubblici', 'Tutte le offerte in Ticino'],
    faq: [
      {
        question: 'Che differenza c e tra Foglio ufficiale e job board?',
        answer: 'Il Foglio ufficiale pubblica concorsi pubblici e bandi istituzionali. Il job board di Frontaliere Ticino raccoglie sia queste fonti ufficiali sia annunci di aziende private.',
      },
      {
        question: 'Queste offerte sostituiscono la fonte ufficiale?',
        answer: 'No. La fonte ufficiale resta il riferimento per il testo completo del concorso, i documenti richiesti e la candidatura. Le nostre schede servono per trovare e leggere piu rapidamente i bandi.',
      },
      {
        question: 'Trovo solo concorsi pubblici?',
        answer: 'In questa pagina il focus e sui concorsi pubblici e sulle offerte da fonti ufficiali cantonali gia indicizzate da noi.',
      },
    ],
  },
  en: {
    title: 'Official Gazette Ticino jobs | Public competitions and official sources',
    heading: 'Official Gazette jobs in Ticino',
    description: (count) => `Browse ${count} public competitions and job listings from the Ticino Official Gazette already indexed by Frontaliere Ticino, with a clear explanation of public competitions, job boards and official sources.`,
    intro: 'This page helps you understand the difference between public competitions, our broader job board and official canton sources. It focuses on public-sector listings already indexed from official sources such as concorsi.ti.ch.',
    updatedLabel: 'Updated',
    countsLabel: 'indexed public competitions',
    feedLabel: 'Public competitions and Official Gazette jobs',
    latestLabel: 'Newest public competitions in the last 3 days',
    openAll: 'See all jobs in Ticino',
    officialSourceLabel: 'Official canton source',
    explainerTitle: 'How to read Official Gazette job listings in Ticino',
    explainerCards: [
      {
        title: 'Public competitions',
        body: 'These are formal openings for public institutions or government bodies. They usually include strict deadlines, required documents and a defined hiring process.',
      },
      {
        title: 'Aggregated job board',
        body: 'Our job board combines private employers, public institutions and official competitions in one place so you can compare opportunities faster.',
      },
      {
        title: 'Official sources',
        body: 'Official sources such as concorsi.ti.ch remain the source of truth for the full text, attachments and final application rules. We make them easier to discover and filter.',
      },
    ],
    internalLinks: ['Latest public competitions', 'All jobs in Ticino'],
    faq: [
      {
        question: 'What is the difference between the Official Gazette and a job board?',
        answer: 'The Official Gazette publishes public competitions and institutional openings. Frontaliere Ticino also includes private-company openings in its job board.',
      },
      {
        question: 'Does this page replace the official source?',
        answer: 'No. The official source remains the reference for the full competition text, required documents and the final application process.',
      },
      {
        question: 'Does this page only include public-sector roles?',
        answer: 'This page focuses on public competitions and openings indexed from official canton sources.',
      },
    ],
  },
  de: {
    title: 'Amtsblatt Stellen Tessin | Offentliche Ausschreibungen und offizielle Quellen',
    heading: 'Amtsblatt-Stellen im Tessin',
    description: (count) => `Entdecken Sie ${count} offentliche Ausschreibungen und Stellen aus offiziellen Tessiner Quellen, die bereits von Frontaliere Ticino indexiert wurden, inklusive Erklarung zu Wettbewerb, Job Board und offizieller Quelle.`,
    intro: 'Diese Seite hilft bei der Unterscheidung zwischen offentlichen Ausschreibungen, unserem umfassenderen Job Board und offiziellen kantonalen Quellen. Im Fokus stehen bereits indexierte Ausschreibungen aus offiziellen Quellen wie concorsi.ti.ch.',
    updatedLabel: 'Aktualisiert',
    countsLabel: 'indexierte offentliche Ausschreibungen',
    feedLabel: 'Offentliche Ausschreibungen und Stellen aus dem Amtsblatt',
    latestLabel: 'Neueste offentliche Ausschreibungen der letzten 3 Tage',
    openAll: 'Alle Jobs im Tessin ansehen',
    officialSourceLabel: 'Offizielle Kantonsquelle',
    explainerTitle: 'So lesen Sie Amtsblatt-Stellen im Tessin',
    explainerCards: [
      {
        title: 'Offentliche Ausschreibungen',
        body: 'Das sind formelle Verfahren fur offentliche Stellen oder Verwaltungen. Sie enthalten meist feste Fristen, Pflichtdokumente und klar definierte Bewerbungsregeln.',
      },
      {
        title: 'Aggregiertes Job Board',
        body: 'Unser Job Board kombiniert private Arbeitgeber, offentliche Einrichtungen und offizielle Ausschreibungen an einem Ort, damit Sie Angebote schneller vergleichen konnen.',
      },
      {
        title: 'Offizielle Quellen',
        body: 'Offizielle Quellen wie concorsi.ti.ch bleiben massgeblich fur Volltext, Anhange und die endgultigen Bewerbungsregeln. Wir machen sie leichter auffindbar.',
      },
    ],
    internalLinks: ['Neueste offentliche Ausschreibungen', 'Alle Jobs im Tessin'],
    faq: [
      {
        question: 'Was ist der Unterschied zwischen Amtsblatt und Job Board?',
        answer: 'Im Amtsblatt erscheinen offentliche Ausschreibungen und institutionelle Stellen. Das Job Board von Frontaliere Ticino umfasst zusatzlich private Arbeitgeber.',
      },
      {
        question: 'Ersetzt diese Seite die offizielle Quelle?',
        answer: 'Nein. Die offizielle Quelle bleibt massgeblich fur den vollstandigen Text, die Unterlagen und den finalen Bewerbungsprozess.',
      },
      {
        question: 'Sind hier nur offentliche Stellen enthalten?',
        answer: 'Diese Seite fokussiert sich auf offentliche Ausschreibungen und Stellen aus offiziellen kantonalen Quellen.',
      },
    ],
  },
  fr: {
    title: "Feuille officielle emplois Tessin | Concours publics et sources officielles",
    heading: "Emplois de la Feuille officielle au Tessin",
    description: (count) => `Consultez ${count} concours publics et offres issues de sources officielles du Tessin deja indexes par Frontaliere Ticino, avec une explication claire entre concours publics, job board et source officielle.`,
    intro: "Cette page vous aide a distinguer les concours publics, notre job board plus large et les sources officielles cantonales. Elle se concentre sur les offres publiques deja indexees depuis des sources officielles comme concorsi.ti.ch.",
    updatedLabel: 'Mis a jour',
    countsLabel: 'concours publics indexes',
    feedLabel: "Concours publics et offres de la Feuille officielle",
    latestLabel: 'Nouveaux concours publics des 3 derniers jours',
    openAll: 'Voir toutes les offres au Tessin',
    officialSourceLabel: 'Source officielle cantonale',
    explainerTitle: "Comment lire les offres de la Feuille officielle au Tessin",
    explainerCards: [
      {
        title: 'Concours publics',
        body: "Il s'agit d'ouvertures formelles pour des administrations ou organismes publics. Elles comportent souvent des delais stricts, des documents obligatoires et une procedure precise.",
      },
      {
        title: 'Job board agrege',
        body: "Notre job board regroupe entreprises privees, institutions publiques et concours officiels au meme endroit pour comparer les opportunites plus vite.",
      },
      {
        title: 'Sources officielles',
        body: 'Les sources officielles comme concorsi.ti.ch restent la reference pour le texte complet, les pieces jointes et les regles finales de candidature. Nous les rendons plus faciles a trouver.',
      },
    ],
    internalLinks: ['Derniers concours publics', 'Toutes les offres au Tessin'],
    faq: [
      {
        question: "Quelle difference entre la Feuille officielle et un job board ?",
        answer: "La Feuille officielle publie des concours publics et des offres institutionnelles. Le job board de Frontaliere Ticino inclut aussi des offres d'entreprises privees.",
      },
      {
        question: 'Cette page remplace-t-elle la source officielle ?',
        answer: "Non. La source officielle reste la reference pour le texte integral du concours, les documents demandes et la procedure finale de candidature.",
      },
      {
        question: 'Cette page contient-elle seulement des offres publiques ?',
        answer: 'Cette page se concentre sur les concours publics et les offres indexees depuis des sources cantonales officielles.',
      },
    ],
  },
};

const NURSES_HUB_COPY: Record<JobLandingLocale, {
  title: string;
  heading: string;
  description: (count: number) => string;
  intro: string;
  updatedLabel: string;
  countsLabel: string;
  feedLabel: string;
  latestLabel: string;
  variantTitle: string;
  explainerCards: Array<{ title: string; body: string }>;
  faq: Array<{ question: string; answer: string }>;
  openAll: string;
}> = {
  it: {
    title: 'Infermieri in Ticino | Cliniche, case anziani, OSS ed educatori',
    heading: 'Infermieri e sanita in Ticino',
    description: (count) => `Scopri ${count} offerte per infermieri, OSS, educatori e ruoli nelle cliniche o case anziani in Ticino, con pagine dedicate ai cluster che convertono meglio.`,
    intro: 'Questo hub raccoglie i lavori sanita e care che intercettano piu domanda: infermieri, OSS, educatori, cliniche private e case anziani. Serve per trovare piu velocemente le opportunita davvero vicine al tuo profilo.',
    updatedLabel: 'Aggiornamento',
    countsLabel: 'offerte sanita e care',
    feedLabel: 'Offerte per infermieri e sanita in Ticino',
    latestLabel: 'Nuove offerte sanita negli ultimi 3 giorni',
    variantTitle: 'Percorsi piu cercati nel cluster sanita',
    explainerCards: [
      { title: 'Cliniche', body: 'Ruoli in cliniche private, ospedali e strutture sanitarie dove il volume di candidature e alto ma la domanda resta costante.' },
      { title: 'Case anziani', body: 'Annunci in RSA, geriatria, strutture assistenziali e cure a lungo termine, utili per chi cerca continuita e turni stabili.' },
      { title: 'OSS ed educatori', body: 'Sottocluster ad alta conversione per operatori sociosanitari, socioassistenziali ed educatori attivi in scuole, centri e strutture sociali.' },
    ],
    faq: [
      { question: 'Qui trovo solo infermieri?', answer: 'No. L hub include anche OSS, educatori, case anziani e cliniche, cioe i cluster care che generano piu interesse e candidature in Ticino.' },
      { question: 'Le offerte arrivano da strutture pubbliche e private?', answer: 'Si. Il feed include annunci da ospedali, cliniche, enti pubblici, case anziani e altri datori di lavoro gia indicizzati nel nostro job board.' },
      { question: 'Come conviene usare questa pagina?', answer: 'Parti dal cluster piu vicino al tuo profilo, poi apri le pagine dedicate per affinare la ricerca tra cliniche, case anziani, OSS o educatori.' },
    ],
    openAll: 'Vedi tutte le offerte in Ticino',
  },
  en: {
    title: 'Nurses in Ticino | Clinics, care homes, healthcare assistants and educators',
    heading: 'Nurses and healthcare jobs in Ticino',
    description: (count) => `Browse ${count} jobs for nurses, healthcare assistants, educators and roles in clinics or care homes in Ticino, with dedicated pages for the strongest converting clusters.`,
    intro: 'This hub groups together the healthcare and care jobs that attract the strongest demand: nurses, healthcare assistants, educators, private clinics and care homes.',
    updatedLabel: 'Updated',
    countsLabel: 'healthcare and care jobs',
    feedLabel: 'Nursing and healthcare jobs in Ticino',
    latestLabel: 'Newest healthcare jobs in the last 3 days',
    variantTitle: 'Most searched healthcare paths',
    explainerCards: [
      { title: 'Clinics', body: 'Roles in private clinics, hospitals and medical facilities where hiring demand stays consistently high.' },
      { title: 'Care homes', body: 'Openings in elderly care, geriatrics and long-term care facilities for candidates looking for stable healthcare roles.' },
      { title: 'Healthcare assistants and educators', body: 'High-intent subclusters for OSS-style roles, socio-assistance and educators active in care or social settings.' },
    ],
    faq: [
      { question: 'Does this hub only cover nurses?', answer: 'No. It also includes healthcare assistants, educators, care-home roles and clinic jobs across Ticino.' },
      { question: 'Are these jobs public or private?', answer: 'Both. The feed can include hospitals, clinics, public institutions, care homes and other employers already indexed in our job board.' },
      { question: 'How should I use this page?', answer: 'Start from the subcluster closest to your profile, then open the dedicated pages to narrow the search.' },
    ],
    openAll: 'See all jobs in Ticino',
  },
  de: {
    title: 'Pflege Jobs im Tessin | Kliniken, Altersheime, OSS und Erzieher',
    heading: 'Pflege- und Gesundheitsjobs im Tessin',
    description: (count) => `Entdecken Sie ${count} Jobs fur Pflege, OSS-nahe Rollen, Erzieher und Positionen in Kliniken oder Altersheimen im Tessin, mit eigenen Seiten fur die relevantesten Cluster.`,
    intro: 'Dieser Hub bundelt die Gesundheits- und Care-Jobs mit hoher Nachfrage: Pflege, Betreuung, Erziehung, Kliniken und Altersheime.',
    updatedLabel: 'Aktualisiert',
    countsLabel: 'Pflege- und Care-Jobs',
    feedLabel: 'Pflege- und Gesundheitsjobs im Tessin',
    latestLabel: 'Neue Gesundheitsjobs der letzten 3 Tage',
    variantTitle: 'Meistgesuchte Wege im Gesundheitsbereich',
    explainerCards: [
      { title: 'Kliniken', body: 'Rollen in Privatkliniken, Spitalern und medizinischen Einrichtungen mit konstantem Bedarf.' },
      { title: 'Altersheime', body: 'Angebote in Geriatrie, Langzeitpflege und betreuten Einrichtungen fur Kandidaten mit Fokus auf Kontinuitat.' },
      { title: 'OSS und Erzieher', body: 'Wichtige Untercluster fur sozio-sanitarische Assistenz und padagogische Rollen in sozialen Strukturen.' },
    ],
    faq: [
      { question: 'Geht es hier nur um Pflegefachpersonen?', answer: 'Nein. Der Hub umfasst auch OSS-nahe Rollen, Erzieher, Altersheime und Kliniken im Tessin.' },
      { question: 'Sind die Stellen offentlich oder privat?', answer: 'Beides. Der Feed kann Stellen aus Kliniken, Spitalern, offentlichen Einrichtungen und Pflegeheimen enthalten.' },
      { question: 'Wie nutzt man diese Seite am besten?', answer: 'Starten Sie mit dem passendsten Untercluster und gehen Sie dann in die jeweilige Spezialseite.' },
    ],
    openAll: 'Alle Jobs im Tessin ansehen',
  },
  fr: {
    title: 'Infirmiers au Tessin | Cliniques, EMS, OSS et educateurs',
    heading: 'Infirmiers et sante au Tessin',
    description: (count) => `Consultez ${count} offres pour infirmiers, OSS, educateurs et roles en cliniques ou en maisons de retraite au Tessin, avec des pages dediees aux sous-clusters les plus performants.`,
    intro: 'Ce hub regroupe les offres sante et care qui attirent le plus de demande: infirmiers, OSS, educateurs, cliniques privees et maisons de retraite.',
    updatedLabel: 'Mis a jour',
    countsLabel: 'offres sante et care',
    feedLabel: 'Offres infirmiers et sante au Tessin',
    latestLabel: 'Nouvelles offres sante des 3 derniers jours',
    variantTitle: 'Parcours les plus recherches en sante',
    explainerCards: [
      { title: 'Cliniques', body: 'Postes en cliniques privees, hopitaux et structures medicales ou la demande reste constante.' },
      { title: 'Maisons de retraite', body: 'Offres en geriatrie, soins de longue duree et structures medico-sociales pour des profils cherchant de la stabilite.' },
      { title: 'OSS et educateurs', body: 'Sous-clusters a forte intention pour les roles socio-sanitaires, socio-educatifs et pedagogiques.' },
    ],
    faq: [
      { question: 'Ce hub parle-t-il seulement des infirmiers ?', answer: 'Non. Il inclut aussi les OSS, les educateurs, les maisons de retraite et les cliniques au Tessin.' },
      { question: 'Les offres viennent-elles du public et du prive ?', answer: 'Oui. Le feed peut inclure hopitaux, cliniques, institutions publiques, EMS et autres employeurs deja indexes.' },
      { question: 'Comment utiliser cette page ?', answer: 'Commencez par le sous-cluster le plus proche de votre profil puis ouvrez la page dediee pour affiner la recherche.' },
    ],
    openAll: 'Voir toutes les offres au Tessin',
  },
};

const CARE_CLUSTER_DEFS: Record<JobCareClusterKey, {
  slug: Record<JobLandingLocale, string>;
  label: Record<JobLandingLocale, string>;
  matcher: (job: JobLike) => boolean;
}> = {
  clinics: {
    slug: { it: 'cliniche-ticino', en: 'clinics-ticino-jobs', de: 'kliniken-tessin-jobs', fr: 'cliniques-tessin' },
    label: { it: 'Cliniche in Ticino', en: 'Clinics in Ticino', de: 'Kliniken im Tessin', fr: 'Cliniques au Tessin' },
    matcher: (job) => {
      const titleText = normalizeSpace(`${job.title || ''}`);
      const contextText = normalizeSpace(`${job.title || ''} ${job.description || ''}`);
      return HEALTHCARE_TITLE_ROLE_REGEX.test(titleText) && /\b(clinic|clinica|cliniche|hospital|ospedal|medical center|medizin)\b/i.test(contextText);
    },
  },
  careHomes: {
    slug: { it: 'case-anziani-ticino', en: 'care-homes-ticino-jobs', de: 'altersheime-tessin-jobs', fr: 'maisons-retraite-tessin' },
    label: { it: 'Case anziani in Ticino', en: 'Care homes in Ticino', de: 'Altersheime im Tessin', fr: 'Maisons de retraite au Tessin' },
    matcher: (job) => {
      const titleText = normalizeSpace(`${job.title || ''}`);
      const contextText = normalizeSpace(`${job.title || ''} ${job.description || ''}`);
      return HEALTHCARE_TITLE_ROLE_REGEX.test(titleText) && /\b(casa anziani|case anziani|geriatria|geriatric|rsa\b|ems\b|elderly|long[-\s]?term care|senior living)\b/i.test(contextText);
    },
  },
  oss: {
    slug: { it: 'oss-ticino', en: 'healthcare-assistants-ticino', de: 'pflegeassistenz-tessin', fr: 'oss-tessin' },
    label: { it: 'OSS in Ticino', en: 'Healthcare assistants in Ticino', de: 'Pflegeassistenz im Tessin', fr: 'OSS au Tessin' },
    matcher: (job) => /\b(oss\b|operatore socio|operatrice socio|socioassist|socioassistenziale|healthcare assistant|pflegeassist|assistente di cura|addetto alle cure)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
  },
  educators: {
    slug: { it: 'educatori-ticino', en: 'educators-ticino', de: 'paedagogen-tessin', fr: 'educateurs-tessin' },
    label: { it: 'Educatori in Ticino', en: 'Educators in Ticino', de: 'Padagogen im Tessin', fr: 'Educateurs au Tessin' },
    matcher: (job) => /\b(educator|educatrice|educatore|educatori|pedagog|socioeduc|social care worker|leisure management)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
  },
};

const HEALTHCARE_TITLE_ROLE_REGEX = /\b(nurse|infermier\w*|midwife|ostetric\w*|caregiver|oss\b|operatore socio\w*|operatrice socio\w*|socioassist\w*|assistente di cura|assistente di studio medico|medical assistant|assistant medical|dietist\w*|therap\w*|physio\w*|ergoterap\w*|educator\w*|educatric\w*|educatori|educatore|educatori|socioeduc\w*|social care|geriatri\w*|spitex|medic\w*|sanitar\w*)\b/i;
const LOCATION_COPY: Record<JobLandingLocale, {
  heading: (location: string) => string;
  title: (location: string) => string;
  description: (location: string, count: number) => string;
  intro: (location: string) => string;
  countsLabel: string;
  updatedLabel: string;
  feedLabel: (location: string) => string;
  latestLabel: (location: string) => string;
  openAll: string;
}> = {
  it: {
    heading: (location) => `Lavoro a ${location} in Ticino`,
    title: (location) => `Offerte di lavoro a ${location} in Ticino | Lavoro ${location} aggiornato`,
    description: (location, count) => `Scopri ${count} offerte di lavoro a ${location} in Ticino, con annunci aggiornati, aziende che assumono, nuovi annunci degli ultimi 3 giorni e link diretti alle candidature ufficiali.`,
    intro: (location) => `Questa pagina raccoglie in un solo punto gli annunci con sede a ${location}, cosi puoi capire subito quali aziende stanno assumendo davvero in citta e quali profili compaiono piu spesso.`,
    countsLabel: 'annunci attivi in citta',
    updatedLabel: 'Aggiornamento',
    feedLabel: (location) => `Offerte attive a ${location}`,
    latestLabel: (location) => `Nuovi annunci a ${location} negli ultimi 3 giorni`,
    openAll: 'Vedi tutte le offerte in Ticino',
  },
  en: {
    heading: (location) => `Jobs in ${location}, Ticino`,
    title: (location) => `Jobs in ${location}, Ticino | Updated job listings and employers`,
    description: (location, count) => `Browse ${count} jobs in ${location}, Ticino, with updated job listings, active employers, roles from the last 3 days and direct links to the original application pages.`,
    intro: (location) => `This page groups together jobs based in ${location}, so you can quickly see which employers are hiring locally and which roles appear most often.`,
    countsLabel: 'active local jobs',
    updatedLabel: 'Updated',
    feedLabel: (location) => `Active jobs in ${location}`,
    latestLabel: (location) => `New jobs in ${location} over the last 3 days`,
    openAll: 'See all jobs in Ticino',
  },
  de: {
    heading: (location) => `Jobs in ${location}, Tessin`,
    title: (location) => `Jobs in ${location}, Tessin | Aktuelle Stellenangebote und Arbeitgeber`,
    description: (location, count) => `Entdecken Sie ${count} Jobs in ${location} im Tessin mit aktuellen Stellenangeboten, aktiven Arbeitgebern, neuen Inseraten der letzten 3 Tage und direkten Links zur offiziellen Bewerbung.`,
    intro: (location) => `Diese Seite bundelt Stellen mit Arbeitsort ${location}, damit Sie sofort sehen, welche Arbeitgeber vor Ort einstellen und welche Profile besonders gefragt sind.`,
    countsLabel: 'aktive lokale Jobs',
    updatedLabel: 'Aktualisiert',
    feedLabel: (location) => `Aktive Jobs in ${location}`,
    latestLabel: (location) => `Neue Jobs in ${location} in den letzten 3 Tagen`,
    openAll: 'Alle Jobs im Tessin ansehen',
  },
  fr: {
    heading: (location) => `Emploi a ${location}, Tessin`,
    title: (location) => `Offres d'emploi a ${location}, Tessin | Emploi local a jour`,
    description: (location, count) => `Consultez ${count} offres d'emploi a ${location} au Tessin, avec des annonces a jour, des employeurs actifs, des offres des 3 derniers jours et des liens directs vers la candidature officielle.`,
    intro: (location) => `Cette page regroupe les offres basees a ${location} afin de voir rapidement quelles entreprises recrutent localement et quels profils reviennent le plus souvent.`,
    countsLabel: 'offres locales actives',
    updatedLabel: 'Mis a jour',
    feedLabel: (location) => `Offres actives a ${location}`,
    latestLabel: (location) => `Nouvelles offres a ${location} sur 3 jours`,
    openAll: 'Voir toutes les offres au Tessin',
  },
};

const LOCATION_TYPE_COPY: Record<JobLandingLocale, {
  heading: (label: string, location: string) => string;
  title: (label: string, location: string) => string;
  description: (label: string, location: string, count: number) => string;
  intro: (label: string, location: string) => string;
  countsLabel: string;
  updatedLabel: string;
  feedLabel: (label: string, location: string) => string;
  latestLabel: (label: string, location: string) => string;
  openAll: string;
}> = {
  it: {
    heading: (label, location) => `${label} a ${location} in Ticino`,
    title: (label, location) => `${label} a ${location} in Ticino | Offerte di lavoro aggiornate`,
    description: (label, location, count) => `Scopri ${count} offerte di ${label.toLowerCase()} a ${location} in Ticino, con annunci aggiornati, nuovi inserimenti degli ultimi 3 giorni e link diretti alle candidature ufficiali.`,
    intro: (label, location) => `Questa pagina raccoglie le offerte di ${label.toLowerCase()} con sede a ${location}, utile per chi cerca un ingresso nel mercato locale o un percorso piu compatibile con studio e formazione.`,
    countsLabel: 'annunci attivi',
    updatedLabel: 'Aggiornamento',
    feedLabel: (label, location) => `Offerte di ${label.toLowerCase()} a ${location}`,
    latestLabel: (label, location) => `Nuovi ${label.toLowerCase()} a ${location} negli ultimi 3 giorni`,
    openAll: 'Vedi tutte le offerte in Ticino',
  },
  en: {
    heading: (label, location) => `${label} jobs in ${location}, Ticino`,
    title: (label, location) => `${label} jobs in ${location}, Ticino | Updated job offers`,
    description: (label, location, count) => `Browse ${count} ${label.toLowerCase()} jobs in ${location}, Ticino, with updated job listings, roles from the last 3 days and direct links to official applications.`,
    intro: (label, location) => `This page focuses on ${label.toLowerCase()} opportunities based in ${location}, useful if you want a more specific local job feed rather than a generic filtered list.`,
    countsLabel: 'active listings',
    updatedLabel: 'Updated',
    feedLabel: (label, location) => `${label} roles in ${location}`,
    latestLabel: (label, location) => `Newest ${label.toLowerCase()} jobs in ${location}`,
    openAll: 'See all jobs in Ticino',
  },
  de: {
    heading: (label, location) => `${label} in ${location}, Tessin`,
    title: (label, location) => `${label} in ${location}, Tessin | Aktuelle Jobangebote`,
    description: (label, location, count) => `Entdecken Sie ${count} Stellen fur ${label.toLowerCase()} in ${location} im Tessin mit aktuellen Stellenangeboten, Inseraten der letzten 3 Tage und direkten Links zur offiziellen Bewerbung.`,
    intro: (label, location) => `Diese Seite sammelt ${label.toLowerCase()}-Angebote mit Arbeitsort ${location} und bietet damit eine gezieltere lokale Auswahl statt nur einer gefilterten Liste.`,
    countsLabel: 'aktive Inserate',
    updatedLabel: 'Aktualisiert',
    feedLabel: (label, location) => `${label}-Jobs in ${location}`,
    latestLabel: (label, location) => `Neueste ${label.toLowerCase()} in ${location}`,
    openAll: 'Alle Jobs im Tessin ansehen',
  },
  fr: {
    heading: (label, location) => `${label} a ${location}, Tessin`,
    title: (label, location) => `${label} a ${location}, Tessin | Offres d'emploi a jour`,
    description: (label, location, count) => `Consultez ${count} offres de ${label.toLowerCase()} a ${location} au Tessin, avec annonces a jour, nouvelles offres des 3 derniers jours et liens directs vers la candidature officielle.`,
    intro: (label, location) => `Cette page regroupe les offres de ${label.toLowerCase()} basees a ${location}, afin d'offrir un flux local plus utile qu'une simple liste filtree.`,
    countsLabel: 'offres actives',
    updatedLabel: 'Mis a jour',
    feedLabel: (label, location) => `Offres ${label.toLowerCase()} a ${location}`,
    latestLabel: (label, location) => `Nouveaux ${label.toLowerCase()} a ${location}`,
    openAll: 'Voir toutes les offres au Tessin',
  },
};

const LOCATION_SECTOR_COPY: Record<JobLandingLocale, {
  heading: (label: string, location: string) => string;
  title: (label: string, location: string) => string;
  description: (label: string, location: string, count: number) => string;
  intro: (label: string, location: string) => string;
  countsLabel: string;
  updatedLabel: string;
  feedLabel: (label: string, location: string) => string;
  latestLabel: (label: string, location: string) => string;
  openAll: string;
}> = {
  it: {
    heading: (label, location) => `${label} a ${location} in Ticino`,
    title: (label, location) => `${label} a ${location} in Ticino | Offerte di lavoro aggiornate`,
    description: (label, location, count) => `Scopri ${count} offerte di lavoro nel settore ${label.toLowerCase()} a ${location} in Ticino, con aziende attive, annunci aggiornati, nuovi inserimenti degli ultimi 3 giorni e link diretti alle candidature ufficiali.`,
    intro: (label, location) => `Questa pagina raccoglie le offerte di ${label.toLowerCase()} con sede a ${location}, utile per capire subito quali aziende cercano profili di questo settore nella zona.`,
    countsLabel: 'annunci attivi',
    updatedLabel: 'Aggiornamento',
    feedLabel: (label, location) => `${label} attivi a ${location}`,
    latestLabel: (label, location) => `Nuovi annunci ${label.toLowerCase()} a ${location}`,
    openAll: 'Vedi tutte le offerte in Ticino',
  },
  en: {
    heading: (label, location) => `${label} jobs in ${location}, Ticino`,
    title: (label, location) => `${label} jobs in ${location}, Ticino | Updated job offers`,
    description: (label, location, count) => `Browse ${count} ${label.toLowerCase()} jobs in ${location}, Ticino, with active employers, fresh job listings, roles from the last 3 days and direct links to official application pages.`,
    intro: (label, location) => `This page groups ${label.toLowerCase()} opportunities based in ${location}, so you can focus on a local sector instead of a generic listing.`,
    countsLabel: 'active listings',
    updatedLabel: 'Updated',
    feedLabel: (label, location) => `${label} jobs in ${location}`,
    latestLabel: (label, location) => `Newest ${label.toLowerCase()} jobs in ${location}`,
    openAll: 'See all jobs in Ticino',
  },
  de: {
    heading: (label, location) => `${label} in ${location}, Tessin`,
    title: (label, location) => `${label} in ${location}, Tessin | Aktuelle Jobangebote`,
    description: (label, location, count) => `Entdecken Sie ${count} Stellen im Bereich ${label.toLowerCase()} in ${location} im Tessin mit aktiven Arbeitgebern, aktuellen Stellenangeboten, Inseraten der letzten 3 Tage und direkten Bewerbungslinks.`,
    intro: (label, location) => `Diese Seite bundelt ${label.toLowerCase()}-Stellen mit Arbeitsort ${location}, damit Sie einen lokalen Sektor gezielt durchsuchen konnen.`,
    countsLabel: 'aktive Inserate',
    updatedLabel: 'Aktualisiert',
    feedLabel: (label, location) => `${label} in ${location}`,
    latestLabel: (label, location) => `Neueste ${label.toLowerCase()} in ${location}`,
    openAll: 'Alle Jobs im Tessin ansehen',
  },
  fr: {
    heading: (label, location) => `${label} a ${location}, Tessin`,
    title: (label, location) => `${label} a ${location}, Tessin | Offres d'emploi a jour`,
    description: (label, location, count) => `Consultez ${count} offres de ${label.toLowerCase()} a ${location} au Tessin, avec employeurs actifs, annonces a jour, offres des 3 derniers jours et liens directs vers la candidature officielle.`,
    intro: (label, location) => `Cette page rassemble les offres de ${label.toLowerCase()} basees a ${location}, afin de suivre un secteur local de maniere plus utile qu'une liste generaliste.`,
    countsLabel: 'offres actives',
    updatedLabel: 'Mis a jour',
    feedLabel: (label, location) => `${label} a ${location}`,
    latestLabel: (label, location) => `Nouvelles offres ${label.toLowerCase()} a ${location}`,
    openAll: 'Voir toutes les offres au Tessin',
  },
};

const JOB_TYPE_DEFS: Record<JobLandingTypeKey, {
  slug: Record<JobLandingLocale, string>;
  label: Record<JobLandingLocale, string>;
  matcher: (job: JobLike) => boolean;
}> = {
  apprenticeship: {
    slug: { it: 'apprendistato', en: 'apprenticeship', de: 'lehrstelle', fr: 'apprentissage' },
    label: { it: 'Apprendistati', en: 'Apprenticeship', de: 'Lehrstellen', fr: 'Apprentissage' },
    matcher: (job) => /apprendist|apprenticeship|apprentissage|lehrstell|lernende|ausbildung/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
  },
  internship: {
    slug: { it: 'stage', en: 'internship', de: 'praktikum', fr: 'stage' },
    label: { it: 'Stage', en: 'Internship', de: 'Praktikum', fr: 'Stage' },
    matcher: (job) => /stage|internship|stagiaire|praktikum|intern\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''} ${job.contract || ''}`)),
  },
  partTime: {
    slug: { it: 'part-time', en: 'part-time', de: 'teilzeit', fr: 'temps-partiel' },
    label: { it: 'Part-time', en: 'Part-time', de: 'Teilzeit', fr: 'Temps partiel' },
    matcher: (job) => isPartTime(job),
  },
};

const JOB_SECTOR_DEFS: Record<JobLandingSectorKey, {
  slug: Record<JobLandingLocale, string>;
  label: Record<JobLandingLocale, string>;
  matcher: (job: JobLike) => boolean;
}> = {
  health: {
    slug: { it: 'sanita', en: 'health', de: 'gesundheit', fr: 'sante' },
    label: { it: 'Sanita', en: 'Health', de: 'Gesundheit', fr: 'Sante' },
    matcher: (job) => normalizeSpace(job.category || '').toLowerCase() === 'health' || /\b(nurse|infermier|caregiver|oss|socioassist|health|clinic|clinica|hospital|ospedal|spitex)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
  },
  finance: {
    slug: { it: 'finanza', en: 'finance', de: 'finanzen', fr: 'finance' },
    label: { it: 'Finanza', en: 'Finance', de: 'Finanzen', fr: 'Finance' },
    matcher: (job) => normalizeSpace(job.category || '').toLowerCase() === 'finance' || /\b(finance|financial|bank|banking|payroll|tax|accounting|contabil|private banker|treasury)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
  },
  tech: {
    slug: { it: 'tecnologia', en: 'tech', de: 'technik', fr: 'tech' },
    label: { it: 'Tecnologia', en: 'Tech', de: 'Technik', fr: 'Tech' },
    matcher: (job) => normalizeSpace(job.category || '').toLowerCase() === 'tech' || /\b(software|developer|engineer|it\b|data|frontend|backend|devops|cloud|cyber|analytics)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
  },
  engineering: {
    slug: { it: 'ingegneria', en: 'engineering', de: 'ingenieurwesen', fr: 'ingenierie' },
    label: { it: 'Ingegneria', en: 'Engineering', de: 'Ingenieurwesen', fr: 'Ingenierie' },
    matcher: (job) => normalizeSpace(job.category || '').toLowerCase() === 'engineering' || /\b(engineer|mechanic|mechanical|electrical|elettric|production|impianti|construction|project manager)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
  },
  admin: {
    slug: { it: 'amministrazione', en: 'admin', de: 'verwaltung', fr: 'administration' },
    label: { it: 'Amministrazione', en: 'Admin', de: 'Verwaltung', fr: 'Administration' },
    matcher: (job) => normalizeSpace(job.category || '').toLowerCase() === 'admin' || /\b(admin|office|back office|assistant|assistente|segretari|hr\b|human resources|customer service|contabile)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
  },
  hospitality: {
    slug: { it: 'ristorazione-hotel', en: 'hospitality', de: 'gastgewerbe', fr: 'hotellerie-restauration' },
    label: { it: 'Ristorazione e hotel', en: 'Hospitality', de: 'Gastgewerbe', fr: 'Hotellerie et restauration' },
    matcher: (job) => normalizeSpace(job.category || '').toLowerCase() === 'hospitality' || /\b(hotel|restaurant|ristor|bar|kitchen|chef|manora|waiter|service)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
  },
  sales: {
    slug: { it: 'vendite', en: 'sales', de: 'vertrieb', fr: 'vente' },
    label: { it: 'Vendite', en: 'Sales', de: 'Vertrieb', fr: 'Vente' },
    matcher: (job) => normalizeSpace(job.category || '').toLowerCase() === 'sales' || /\b(sales|vendit|retail|store|negozio|clientela|commerciale|business development)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
  },
};

function normalizeSpace(value = ''): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugifyTerm(value = ''): string {
  return normalizeSpace(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function isPartTime(job: JobLike): boolean {
  const raw = normalizeSpace(`${job.contract || ''} ${job.title || ''}`);
  if (!raw) return false;
  if (/(part[\s-]?time|tempo parziale|teilzeit|temps partiel)/i.test(raw)) return true;
  const pctMatches = raw.match(/(\d{1,3})\s*%/g) || [];
  return pctMatches.some((match) => {
    const pct = Number(match.replace(/[^0-9]/g, ''));
    return Number.isFinite(pct) && pct > 0 && pct < 100;
  });
}

function parseDate(value: string): Date | null {
  const raw = normalizeSpace(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getJobFreshnessDate(job: JobLike): Date | null {
  return parseDate(job.postedDate) || parseDate(job.datePosted) || parseDate(job.crawledAt) || parseDate(job.updatedAt);
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function diffDays(a: Date, b: Date): number {
  const dayMs = 24 * 60 * 60 * 1000;
  const utcA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const utcB = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.floor((utcA - utcB) / dayMs);
}

function isInLast24Hours(jobDate: Date | null, now: Date): boolean {
  if (!jobDate) return false;
  const rawValue = now.getTime() - jobDate.getTime();
  if (rawValue <= 24 * 60 * 60 * 1000 && rawValue >= 0) return true;
  return dayKey(now) === dayKey(jobDate);
}

function isInLast3Days(jobDate: Date | null, now: Date): boolean {
  if (!jobDate) return false;
  const rawValue = now.getTime() - jobDate.getTime();
  if (rawValue <= 3 * 24 * 60 * 60 * 1000 && rawValue >= 0) return true;
  const calendarDiff = diffDays(now, jobDate);
  return calendarDiff >= 0 && calendarDiff <= 2;
}

function isTicinoScoped(job: JobLike): boolean {
  const canton = normalizeSpace(job.canton || '').toUpperCase();
  return !canton || canton === 'TI';
}

function isOfficialGazetteJob(job: JobLike): boolean {
  const source = normalizeSpace(`${job.companyDomain || ''} ${job.url || ''} ${job.company || ''}`).toLowerCase();
  return source.includes('concorsi.ti.ch') || source.includes('ti.ch/concorsi');
}

function buildSearchHref(baseUrl: string, localePrefix: string, sectionSlug: string, locale: JobLandingLocale, term: string): string {
  const searchSlug = `${SEARCH_ROUTE_PREFIX[locale]}-${slugifyTerm(term) || 'ticino'}`;
  return ensureTrailingSlash(`${baseUrl}${`${localePrefix}/${sectionSlug}/${searchSlug}`.replace(/\/+/g, '/')}`);
}

function buildJobHref(baseUrl: string, localePrefix: string, sectionSlug: string, slug: string): string {
  return ensureTrailingSlash(`${baseUrl}${`${localePrefix}/${sectionSlug}/${slug}`.replace(/\/+/g, '/')}`);
}

function sortByFreshness(jobs: JobLike[], now: Date): JobLike[] {
  return [...jobs].sort((a, b) => {
    const aTime = getJobFreshnessDate(a)?.getTime() || 0;
    const bTime = getJobFreshnessDate(b)?.getTime() || 0;
    if (bTime !== aTime) return bTime - aTime;
    return normalizeSpace(a.title).localeCompare(normalizeSpace(b.title), 'it', { sensitivity: 'base' });
  });
}

function toLinkedJobs(jobs: JobLike[], now: Date, locale: JobLandingLocale, options: { baseUrl: string; localePrefix: string; sectionSlug: string; localizedSlug: (job: JobLike, locale: JobLandingLocale) => string }, max = 12): LandingJobLink[] {
  return sortByFreshness(jobs, now).slice(0, max).map((job) => ({
    title: normalizeSpace(String(job?.titleByLocale?.[locale] || job.title || 'Offerta lavoro')),
    company: normalizeSpace(job.company || ''),
    location: normalizeSpace(job.location || ''),
    href: buildJobHref(options.baseUrl, options.localePrefix, options.sectionSlug, options.localizedSlug(job, locale)),
  }));
}

function normalizeLocation(value: string): string {
  const raw = normalizeSpace(value);
  const canonical = SUPPORTED_EDITORIAL_LOCATIONS.find((location) => location.toLowerCase() === raw.toLowerCase());
  return canonical || raw;
}

function getTypeDef(typeKey: JobLandingTypeKey) {
  return JOB_TYPE_DEFS[typeKey];
}

function getSectorDef(sectorKey: JobLandingSectorKey) {
  return JOB_SECTOR_DEFS[sectorKey];
}

function getCareClusterDef(clusterKey: JobCareClusterKey) {
  return CARE_CLUSTER_DEFS[clusterKey];
}

function findTypeKeyBySlug(slug: string): JobLandingTypeKey | null {
  const clean = normalizeSpace(slug);
  return (Object.keys(JOB_TYPE_DEFS) as JobLandingTypeKey[]).find((key) =>
    Object.values(JOB_TYPE_DEFS[key].slug).includes(clean),
  ) || null;
}

function findSectorKeyBySlug(slug: string): JobLandingSectorKey | null {
  const clean = normalizeSpace(slug);
  return (Object.keys(JOB_SECTOR_DEFS) as JobLandingSectorKey[]).find((key) =>
    Object.values(JOB_SECTOR_DEFS[key].slug).includes(clean),
  ) || null;
}

function findSectorKeyBySlugExtended(slug: string): JobLandingSectorKey | null {
  return findSectorKeyBySlug(slug) || SECTOR_SLUG_ALIASES[normalizeSpace(slug)] || null;
}

function findCareClusterKeyBySlug(slug: string): JobCareClusterKey | null {
  const clean = normalizeSpace(slug);
  return (Object.keys(CARE_CLUSTER_DEFS) as JobCareClusterKey[]).find((key) =>
    Object.values(CARE_CLUSTER_DEFS[key].slug).includes(clean),
  ) || null;
}

function matchesLocation(job: JobLike, location: string): boolean {
  return normalizeSpace(job.location || '').toLowerCase() === normalizeSpace(location).toLowerCase();
}

function buildLocationSlug(locale: JobLandingLocale, location: string): string {
  return `${SEARCH_ROUTE_PREFIX[locale]}-${slugifyTerm(location)}`;
}

function buildLocationTypeSlug(locale: JobLandingLocale, location: string, typeKey: JobLandingTypeKey): string {
  return `${buildLocationSlug(locale, location)}-${getTypeDef(typeKey).slug[locale]}`;
}

function buildLocationSectorSlug(locale: JobLandingLocale, location: string, sectorKey: JobLandingSectorKey): string {
  return `${buildLocationSlug(locale, location)}-${getSectorDef(sectorKey).slug[locale]}`;
}

function buildLocationTypeLinks(options: {
  jobs: JobLike[];
  locale: JobLandingLocale;
  location: string;
  now: Date;
  baseUrl: string;
  localePrefix: string;
  sectionSlug: string;
  localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
}): TypeLink[] {
  const locationJobs = options.jobs.filter((job) => matchesLocation(job, options.location));
  return (Object.keys(JOB_TYPE_DEFS) as JobLandingTypeKey[])
    .map((typeKey) => {
      const typeDef = getTypeDef(typeKey);
      const count = locationJobs.filter((job) => typeDef.matcher(job)).length;
      return {
        key: typeKey,
        label: `${typeDef.label[options.locale]} a ${options.location}`,
        href: ensureTrailingSlash(`${options.baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${buildLocationTypeSlug(options.locale, options.location, typeKey)}`.replace(/\/+/g, '/')}`),
        count,
      };
    })
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
}

function buildLocationSectorLinks(options: {
  jobs: JobLike[];
  locale: JobLandingLocale;
  location: string;
  now: Date;
  baseUrl: string;
  localePrefix: string;
  sectionSlug: string;
  localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
}): SectorLink[] {
  const locationJobs = options.jobs.filter((job) => matchesLocation(job, options.location));
  return (Object.keys(JOB_SECTOR_DEFS) as JobLandingSectorKey[])
    .map((sectorKey) => {
      const sectorDef = getSectorDef(sectorKey);
      const count = locationJobs.filter((job) => sectorDef.matcher(job)).length;
      return {
        key: sectorKey,
        label: `${sectorDef.label[options.locale]} a ${options.location}`,
        href: ensureTrailingSlash(`${options.baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${buildLocationSectorSlug(options.locale, options.location, sectorKey)}`.replace(/\/+/g, '/')}`),
        count,
      };
    })
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
}

export function isJobTodayLandingSlug(value: string): boolean {
  const slug = normalizeSpace(value);
  return Object.values(JOB_TODAY_LANDING_SLUGS).includes(slug as (typeof JOB_TODAY_LANDING_SLUGS)[JobLandingLocale]);
}

export function resolveEditorialJobLandingDescriptor(value: string): EditorialLandingDescriptor | null {
  const slug = normalizeSpace(value);
  if (!slug) return null;
  if (isJobTodayLandingSlug(slug)) return { kind: 'today' };
  if (Object.values(JOB_OFFICIAL_GAZETTE_LANDING_SLUGS).includes(slug as (typeof JOB_OFFICIAL_GAZETTE_LANDING_SLUGS)[JobLandingLocale])) {
    return { kind: 'official-gazette' };
  }
  if (Object.values(JOB_NURSES_HUB_SLUGS).includes(slug as (typeof JOB_NURSES_HUB_SLUGS)[JobLandingLocale])) {
    return { kind: 'nurses-hub' };
  }
  if (Object.values(JOB_PART_TIME_LANDING_SLUGS).includes(slug as (typeof JOB_PART_TIME_LANDING_SLUGS)[JobLandingLocale])) {
    return { kind: 'part-time' };
  }
  const careClusterKey = findCareClusterKeyBySlug(slug);
  if (careClusterKey) return { kind: 'care-variant', clusterKey: careClusterKey };

  const parts = slug.split('-');
  if (parts.length < 2) return null;
  const prefixes = new Set(Object.values(SEARCH_ROUTE_PREFIX));
  if (!prefixes.has(parts[0])) return null;

  const locationPart = parts[1];
  const location = SUPPORTED_EDITORIAL_LOCATIONS.find((entry) => slugifyTerm(entry) === locationPart);
  if (!location) {
    // Try sector-region pattern: ricerca-{sector}-ticino / search-{sector}-ticino
    const REGION_SLUGS = new Set(['ticino', 'tessin']);
    const sectorSlug = parts.slice(1, -1).join('-'); // everything between prefix and last part
    const regionSlug = parts[parts.length - 1];
    if (parts.length >= 3 && REGION_SLUGS.has(regionSlug)) {
      const sectorKey = findSectorKeyBySlugExtended(sectorSlug);
      if (sectorKey) return { kind: 'sector-region', sectorKey };
    }
    // Also try entire suffix as sector (ricerca-sanita → sector without region)
    const fullSuffix = parts.slice(1).join('-');
    const directSectorKey = findSectorKeyBySlugExtended(fullSuffix);
    if (directSectorKey) return { kind: 'sector-region', sectorKey: directSectorKey };
    return null;
  }
  if (parts.length === 2) return { kind: 'location', location };

  const typeSlug = parts.slice(2).join('-');
  const typeKey = findTypeKeyBySlug(typeSlug);
  if (typeKey) return { kind: 'location-type', location, typeKey };
  const sectorKey = findSectorKeyBySlug(typeSlug);
  if (sectorKey) return { kind: 'location-sector', location, sectorKey };
  return null;
}

export function buildJobOfficialGazetteLandingModel(options: {
  jobs: JobLike[];
  locale: JobLandingLocale;
  now?: string | Date;
  localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
  baseUrl: string;
  sectionSlug: string;
  localePrefix: string;
}): JobOfficialGazetteLandingModel {
  const locale = options.locale;
  const copy = OFFICIAL_GAZETTE_COPY[locale];
  const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const landingHref = ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${JOB_OFFICIAL_GAZETTE_LANDING_SLUGS[locale]}`.replace(/\/+/g, '/')}`);
  const officialJobs = options.jobs.filter((job) => isOfficialGazetteJob(job));
  const latestJobs = officialJobs.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
  const allJobsHref = ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}`.replace(/\/+/g, '/')}`);
  return {
    kind: 'official-gazette',
    slug: JOB_OFFICIAL_GAZETTE_LANDING_SLUGS[locale],
    title: copy.title,
    heading: copy.heading,
    description: copy.description(officialJobs.length),
    intro: copy.intro,
    updatedLabel: copy.updatedLabel,
    countsLabel: copy.countsLabel,
    totalJobs: officialJobs.length,
    feed: { label: copy.feedLabel, jobs: toLinkedJobs(officialJobs, now, locale, { ...options, baseUrl }, 18) },
    latestLabel: copy.latestLabel,
    latestJobs: toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 12),
    explainerTitle: copy.explainerTitle,
    explainerCards: copy.explainerCards,
    officialSourceLabel: copy.officialSourceLabel,
    officialSourceUrl: 'https://www.concorsi.ti.ch/offerte-d-impieghi.html',
    internalLinks: [
      { label: copy.internalLinks[0], href: `${landingHref}#official-competitions` },
      { label: copy.internalLinks[1], href: allJobsHref },
    ],
    faq: copy.faq,
    openAllLabel: copy.openAll,
  };
}

function isNursingHubJob(job: JobLike): boolean {
  return (Object.values(CARE_CLUSTER_DEFS) as Array<{ matcher: (job: JobLike) => boolean }>).some((cluster) => cluster.matcher(job));
}

function buildCareVariantLinks(options: {
  jobs: JobLike[];
  locale: JobLandingLocale;
  now: Date;
  baseUrl: string;
  localePrefix: string;
  sectionSlug: string;
}): CareVariantLink[] {
  const jobs = options.jobs.filter((job) => isNursingHubJob(job));
  return (Object.keys(CARE_CLUSTER_DEFS) as JobCareClusterKey[])
    .map((key) => {
      const def = getCareClusterDef(key);
      const count = jobs.filter((job) => def.matcher(job)).length;
      return {
        key,
        label: def.label[options.locale],
        href: ensureTrailingSlash(`${options.baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${def.slug[options.locale]}`.replace(/\/+/g, '/')}`),
        count,
      };
    })
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
}

export function buildJobNursesHubLandingModel(options: {
  jobs: JobLike[];
  locale: JobLandingLocale;
  now?: string | Date;
  localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
  baseUrl: string;
  sectionSlug: string;
  localePrefix: string;
}): JobNursesHubLandingModel {
  const locale = options.locale;
  const copy = NURSES_HUB_COPY[locale];
  const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const matches = options.jobs.filter((job) => isNursingHubJob(job));
  const latestJobs = matches.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
  return {
    kind: 'nurses-hub',
    slug: JOB_NURSES_HUB_SLUGS[locale],
    title: copy.title,
    heading: copy.heading,
    description: copy.description(matches.length),
    intro: copy.intro,
    updatedLabel: copy.updatedLabel,
    countsLabel: copy.countsLabel,
    totalJobs: matches.length,
    feed: { label: copy.feedLabel, jobs: toLinkedJobs(matches, now, locale, { ...options, baseUrl }, 18) },
    latestLabel: copy.latestLabel,
    latestJobs: toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 12),
    variantTitle: copy.variantTitle,
    variants: buildCareVariantLinks({ jobs: options.jobs, locale, now, baseUrl, localePrefix: options.localePrefix, sectionSlug: options.sectionSlug }),
    explainerCards: copy.explainerCards,
    faq: copy.faq,
    openAllLabel: copy.openAll,
  };
}

export function buildJobCareVariantLandingModel(options: {
  jobs: JobLike[];
  locale: JobLandingLocale;
  clusterKey: JobCareClusterKey;
  now?: string | Date;
  localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
  baseUrl: string;
  sectionSlug: string;
  localePrefix: string;
}): JobCareVariantLandingModel {
  const locale = options.locale;
  const clusterKey = options.clusterKey;
  const def = getCareClusterDef(clusterKey);
  const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const matches = options.jobs.filter((job) => isNursingHubJob(job) && def.matcher(job));
  const latestJobs = matches.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
  const label = def.label[locale];
  const title = locale === 'it'
    ? `${label} | Offerte di lavoro aggiornate in Ticino`
    : locale === 'en'
      ? `${label} | Updated job offers in Ticino`
      : locale === 'de'
        ? `${label} | Aktuelle Jobangebote im Tessin`
        : `${label} | Offres d'emploi a jour au Tessin`;
  const description = locale === 'it'
    ? `Scopri ${matches.length} offerte per ${label.toLowerCase()} con annunci aggiornati, nuovi inserimenti degli ultimi 3 giorni e link diretti alle candidature ufficiali in Ticino.`
    : locale === 'en'
      ? `Browse ${matches.length} ${label.toLowerCase()} job offers in Ticino, with updated listings, jobs from the last 3 days and direct links to official applications.`
      : locale === 'de'
        ? `Entdecken Sie ${matches.length} Jobangebote fur ${label.toLowerCase()} im Tessin mit aktuellen Inseraten der letzten 3 Tage und direkten Bewerbungslinks.`
        : `Consultez ${matches.length} offres pour ${label.toLowerCase()} au Tessin, avec annonces a jour, offres des 3 derniers jours et liens directs vers la candidature officielle.`;
  const intro = locale === 'it'
    ? `Questa pagina restringe il cluster sanita ai profili ${label.toLowerCase()}, cosi puoi leggere solo gli annunci davvero pertinenti senza passare da una lista troppo ampia.`
    : locale === 'en'
      ? `This page narrows the healthcare hub down to ${label.toLowerCase()} roles, so you can focus on the most relevant listings without scanning a broad generic feed.`
      : locale === 'de'
        ? `Diese Seite fokussiert den Gesundheits-Hub auf ${label.toLowerCase()}, damit Sie die relevantesten Stellen schneller sehen.`
        : `Cette page resserre le hub sante sur les roles ${label.toLowerCase()} pour aller directement aux offres les plus pertinentes.`;
  const siblingLinks = buildCareVariantLinks({ jobs: options.jobs, locale, now, baseUrl, localePrefix: options.localePrefix, sectionSlug: options.sectionSlug }).filter((entry) => entry.key !== clusterKey);
  return {
    kind: 'care-variant',
    slug: def.slug[locale],
    clusterKey,
    title,
    heading: label,
    description,
    intro,
    updatedLabel: locale === 'it' ? 'Aggiornamento' : locale === 'en' ? 'Updated' : locale === 'de' ? 'Aktualisiert' : 'Mis a jour',
    countsLabel: locale === 'it' ? 'offerte attive' : locale === 'en' ? 'active job offers' : locale === 'de' ? 'aktive Angebote' : 'offres actives',
    totalJobs: matches.length,
    feed: {
      label: locale === 'it' ? `Offerte ${label.toLowerCase()}` : locale === 'en' ? `${label} job offers` : locale === 'de' ? `${label} Jobs` : `Offres ${label.toLowerCase()}`,
      jobs: toLinkedJobs(matches, now, locale, { ...options, baseUrl }, 18),
    },
    latestLabel: locale === 'it' ? `Nuove offerte ${label.toLowerCase()} negli ultimi 3 giorni` : locale === 'en' ? `Newest ${label.toLowerCase()} jobs in the last 3 days` : locale === 'de' ? `Neueste ${label.toLowerCase()} der letzten 3 Tage` : `Nouvelles offres ${label.toLowerCase()} des 3 derniers jours`,
    latestJobs: toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 12),
    parentHubHref: ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${JOB_NURSES_HUB_SLUGS[locale]}`.replace(/\/+/g, '/')}`),
    siblingLinks,
    openAllLabel: locale === 'it' ? 'Vedi tutte le offerte in Ticino' : locale === 'en' ? 'See all jobs in Ticino' : locale === 'de' ? 'Alle Jobs im Tessin ansehen' : 'Voir toutes les offres au Tessin',
  };
}

export function buildJobTodayLandingModel(options: {
  jobs: JobLike[];
  locale: JobLandingLocale;
  now?: string | Date;
  localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
  baseUrl: string;
  sectionSlug: string;
  localePrefix: string;
}): JobTodayLandingModel {
  const locale = options.locale;
  const copy = TODAY_COPY[locale];
  const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const landingHref = ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${JOB_TODAY_LANDING_SLUGS[locale]}`.replace(/\/+/g, '/')}`);
  const recent24h = options.jobs.filter((job) => isInLast24Hours(getJobFreshnessDate(job), now));
  const recent3d = options.jobs.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
  const partTime = options.jobs.filter((job) => isPartTime(job));
  const citySourceJobs = options.jobs.some((job) => normalizeSpace(job.canton || ''))
    ? options.jobs.filter((job) => isTicinoScoped(job))
    : options.jobs;
  const cityLeaders = Array.from(
    citySourceJobs.reduce<Map<string, number>>((map, job) => {
      const location = normalizeSpace(job.location || '');
      if (!location) return map;
      map.set(location, (map.get(location) || 0) + 1);
      return map;
    }, new Map<string, number>()),
  )
    .map(([name, count]) => ({
      name,
      count,
      href: buildSearchHref(baseUrl, options.localePrefix, options.sectionSlug, locale, name),
    }))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }))
    .slice(0, 8);

  return {
    slug: JOB_TODAY_LANDING_SLUGS[locale],
    title: copy.title,
    heading: copy.heading,
    description: copy.description,
    intro: copy.intro,
    updatedLabel: copy.updatedLabel,
    countsLabel: copy.countsLabel,
    totalJobs: options.jobs.length,
    sections: {
      last24Hours: { label: copy.fresh24h, jobs: toLinkedJobs(recent24h, now, locale, { ...options, baseUrl }) },
      last3Days: { label: copy.fresh3d, jobs: toLinkedJobs(recent3d, now, locale, { ...options, baseUrl }) },
      partTime: { label: copy.partTime, jobs: toLinkedJobs(partTime, now, locale, { ...options, baseUrl }) },
      cityHubLabel: copy.cityHub,
      cities: cityLeaders,
    },
    internalLinks: [
      { label: copy.internalLinks[0], href: `${landingHref}#last-24-hours` },
      { label: copy.internalLinks[1], href: `${landingHref}#last-3-days` },
      { label: copy.internalLinks[2], href: `${landingHref}#part-time` },
    ],
    openAllLabel: copy.openAll,
  };
}

export function buildJobLocationLandingModel(options: {
  jobs: JobLike[];
  locale: JobLandingLocale;
  location: string;
  now?: string | Date;
  localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
  baseUrl: string;
  sectionSlug: string;
  localePrefix: string;
}): JobLocationLandingModel {
  const locale = options.locale;
  const location = normalizeLocation(options.location);
  const copy = LOCATION_COPY[locale];
  const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const locationJobs = options.jobs.filter((job) => matchesLocation(job, location));
  const latestJobs = locationJobs.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
  return {
    kind: 'location',
    slug: buildLocationSlug(locale, location),
    location,
    title: copy.title(location),
    heading: copy.heading(location),
    description: copy.description(location, locationJobs.length),
    intro: copy.intro(location),
    updatedLabel: copy.updatedLabel,
    countsLabel: copy.countsLabel,
    totalJobs: locationJobs.length,
    feed: { label: copy.feedLabel(location), jobs: toLinkedJobs(locationJobs, now, locale, { ...options, baseUrl }, 18) },
    latestLabel: copy.latestLabel(location),
    latestJobs: toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 12),
    relatedTypeLinks: buildLocationTypeLinks({ ...options, location, now, baseUrl }),
    relatedSectorLinks: buildLocationSectorLinks({ ...options, location, now, baseUrl }),
    openAllLabel: copy.openAll,
  };
}

export function buildJobLocationTypeLandingModel(options: {
  jobs: JobLike[];
  locale: JobLandingLocale;
  location: string;
  typeKey: JobLandingTypeKey;
  now?: string | Date;
  localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
  baseUrl: string;
  sectionSlug: string;
  localePrefix: string;
}): JobLocationTypeLandingModel {
  const locale = options.locale;
  const location = normalizeLocation(options.location);
  const typeKey = options.typeKey;
  const typeDef = getTypeDef(typeKey);
  const label = typeDef.label[locale];
  const copy = LOCATION_TYPE_COPY[locale];
  const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const matches = options.jobs.filter((job) => matchesLocation(job, location) && typeDef.matcher(job));
  const latestJobs = matches.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
  const siblingTypeLinks = buildLocationTypeLinks({ ...options, location, now, baseUrl }).filter((link) => link.key !== typeKey);
  return {
    kind: 'location-type',
    slug: buildLocationTypeSlug(locale, location, typeKey),
    location,
    typeKey,
    title: copy.title(label, location),
    heading: copy.heading(label, location),
    description: copy.description(label, location, matches.length),
    intro: copy.intro(label, location),
    updatedLabel: copy.updatedLabel,
    countsLabel: copy.countsLabel,
    totalJobs: matches.length,
    feed: { label: copy.feedLabel(label, location), jobs: toLinkedJobs(matches, now, locale, { ...options, baseUrl }, 18) },
    latestLabel: copy.latestLabel(label, location),
    latestJobs: toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 12),
    parentLocationHref: ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${buildLocationSlug(locale, location)}`.replace(/\/+/g, '/')}`),
    siblingTypeLinks,
    openAllLabel: copy.openAll,
  };
}

export function buildJobLocationSectorLandingModel(options: {
  jobs: JobLike[];
  locale: JobLandingLocale;
  location: string;
  sectorKey: JobLandingSectorKey;
  now?: string | Date;
  localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
  baseUrl: string;
  sectionSlug: string;
  localePrefix: string;
}): JobLocationSectorLandingModel {
  const locale = options.locale;
  const location = normalizeLocation(options.location);
  const sectorKey = options.sectorKey;
  const sectorDef = getSectorDef(sectorKey);
  const label = sectorDef.label[locale];
  const copy = LOCATION_SECTOR_COPY[locale];
  const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const matches = options.jobs.filter((job) => matchesLocation(job, location) && sectorDef.matcher(job));
  const latestJobs = matches.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
  const siblingSectorLinks = buildLocationSectorLinks({ ...options, location, now, baseUrl }).filter((link) => link.key !== sectorKey);
  return {
    kind: 'location-sector',
    slug: buildLocationSectorSlug(locale, location, sectorKey),
    location,
    sectorKey,
    title: copy.title(label, location),
    heading: copy.heading(label, location),
    description: copy.description(label, location, matches.length),
    intro: copy.intro(label, location),
    updatedLabel: copy.updatedLabel,
    countsLabel: copy.countsLabel,
    totalJobs: matches.length,
    feed: { label: copy.feedLabel(label, location), jobs: toLinkedJobs(matches, now, locale, { ...options, baseUrl }, 18) },
    latestLabel: copy.latestLabel(label, location),
    latestJobs: toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 12),
    parentLocationHref: ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${buildLocationSlug(locale, location)}`.replace(/\/+/g, '/')}`),
    siblingSectorLinks,
    openAllLabel: copy.openAll,
  };
}

const SECTOR_REGION_COPY: Record<JobLandingLocale, {
  heading: (label: string) => string;
  title: (label: string) => string;
  description: (label: string, count: number) => string;
  intro: (label: string) => string;
  countsLabel: string;
  updatedLabel: string;
  feedLabel: (label: string) => string;
  latestLabel: (label: string) => string;
  openAll: string;
}> = {
  it: {
    heading: (label) => `Lavoro ${label} in Ticino`,
    title: (label) => `Lavoro ${label} in Ticino | Offerte aggiornate`,
    description: (label, count) => `Scopri ${count} offerte di lavoro nel settore ${label.toLowerCase()} in Ticino. Posizioni attive aggiornate ogni giorno per frontalieri.`,
    intro: (label) => `Tutte le offerte nel settore ${label.toLowerCase()} disponibili nel Canton Ticino, ideale per chi cerca lavoro come frontaliere.`,
    countsLabel: 'annunci attivi',
    updatedLabel: 'Aggiornamento',
    feedLabel: (label) => `${label} attivi in Ticino`,
    latestLabel: (label) => `Nuovi annunci ${label.toLowerCase()} in Ticino`,
    openAll: 'Vedi tutte le offerte in Ticino',
  },
  en: {
    heading: (label) => `${label} Jobs in Ticino`,
    title: (label) => `${label} Jobs in Ticino | Updated Listings`,
    description: (label, count) => `Browse ${count} ${label.toLowerCase()} job openings in Ticino. Updated daily for cross-border workers.`,
    intro: (label) => `All ${label.toLowerCase()} positions available in Canton Ticino for cross-border workers.`,
    countsLabel: 'active listings',
    updatedLabel: 'Updated',
    feedLabel: (label) => `${label} jobs in Ticino`,
    latestLabel: (label) => `Latest ${label.toLowerCase()} jobs in Ticino`,
    openAll: 'View all Ticino jobs',
  },
  de: {
    heading: (label) => `${label}-Jobs im Tessin`,
    title: (label) => `${label}-Jobs im Tessin | Aktuelle Stellenangebote`,
    description: (label, count) => `Entdecken Sie ${count} offene Stellen im Bereich ${label} im Tessin. Taglich aktualisiert fur Grenzganger.`,
    intro: (label) => `Alle Stellenangebote im Bereich ${label} im Kanton Tessin fur Grenzganger.`,
    countsLabel: 'aktive Inserate',
    updatedLabel: 'Aktualisiert',
    feedLabel: (label) => `${label}-Stellen im Tessin`,
    latestLabel: (label) => `Neueste ${label}-Stellen im Tessin`,
    openAll: 'Alle Stellen im Tessin ansehen',
  },
  fr: {
    heading: (label) => `Emplois ${label} au Tessin`,
    title: (label) => `Emplois ${label} au Tessin | Offres a jour`,
    description: (label, count) => `Decouvrez ${count} offres d'emploi dans le secteur ${label.toLowerCase()} au Tessin. Mises a jour quotidiennement pour les frontaliers.`,
    intro: (label) => `Toutes les offres dans le secteur ${label.toLowerCase()} disponibles au Tessin pour les frontaliers.`,
    countsLabel: 'annonces actives',
    updatedLabel: 'Mis a jour',
    feedLabel: (label) => `Emplois ${label} au Tessin`,
    latestLabel: (label) => `Derniers emplois ${label.toLowerCase()} au Tessin`,
    openAll: 'Voir toutes les offres au Tessin',
  },
};

export function buildJobSectorRegionLandingModel(options: {
  jobs: JobLike[];
  locale: JobLandingLocale;
  sectorKey: JobLandingSectorKey;
  now?: string | Date;
  localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
  baseUrl: string;
  sectionSlug: string;
  localePrefix: string;
}): JobSectorRegionLandingModel {
  const locale = options.locale;
  const sectorKey = options.sectorKey;
  const sectorDef = getSectorDef(sectorKey);
  const label = sectorDef.label[locale];
  const copy = SECTOR_REGION_COPY[locale];
  const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const sectorSlug = sectorDef.slug[locale];
  const slug = `${SEARCH_ROUTE_PREFIX[locale]}-${sectorSlug}-${locale === 'de' ? 'tessin' : 'ticino'}`;
  const matches = options.jobs.filter((job) => sectorDef.matcher(job));
  const latestJobs = matches.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
  const siblingSectorLinks = (Object.keys(JOB_SECTOR_DEFS) as JobLandingSectorKey[])
    .filter((k) => k !== sectorKey)
    .map((k) => {
      const def = getSectorDef(k);
      const count = options.jobs.filter((job) => def.matcher(job)).length;
      if (count === 0) return null;
      const kSlug = def.slug[locale];
      const kRegion = locale === 'de' ? 'tessin' : 'ticino';
      return {
        key: k,
        label: def.label[locale],
        count,
        href: ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${SEARCH_ROUTE_PREFIX[locale]}-${kSlug}-${kRegion}`.replace(/\/+/g, '/')}`),
      };
    })
    .filter(Boolean) as SectorLink[];

  return {
    kind: 'sector-region',
    slug,
    sectorKey,
    title: copy.title(label),
    heading: copy.heading(label),
    description: copy.description(label, matches.length),
    intro: copy.intro(label),
    updatedLabel: copy.updatedLabel,
    countsLabel: copy.countsLabel,
    totalJobs: matches.length,
    feed: { label: copy.feedLabel(label), jobs: toLinkedJobs(matches, now, locale, { ...options, baseUrl }, 18) },
    latestLabel: copy.latestLabel(label),
    latestJobs: toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 12),
    siblingSectorLinks,
    openAllLabel: copy.openAll,
  };
}

const PART_TIME_COPY: Record<JobLandingLocale, {
  title: string;
  heading: string;
  description: (count: number) => string;
  intro: string;
  updatedLabel: string;
  countsLabel: string;
  feedLabel: string;
  latestLabel: string;
  cityHub: string;
  openAll: string;
  faq: Array<{ question: string; answer: string }>;
}> = {
  it: {
    title: 'Lavoro part-time in Ticino | Offerte a tempo parziale per frontalieri',
    heading: 'Lavoro part-time in Ticino',
    description: (count) => `Scopri ${count} offerte di lavoro part-time in Ticino per frontalieri. Posizioni a tempo parziale aggiornate ogni giorno da aziende svizzere, con filtri per citta, settore e percentuale di impiego.`,
    intro: 'Questa landing raccoglie tutte le offerte a tempo parziale disponibili nel Canton Ticino, ideale per chi cerca flessibilita lavorativa come frontaliere. Le posizioni spaziano da contratti al 20% fino al 80% e coprono tutti i principali settori.',
    updatedLabel: 'Aggiornamento',
    countsLabel: 'annunci part-time attivi',
    feedLabel: 'Offerte part-time in Ticino',
    latestLabel: 'Nuove offerte part-time negli ultimi 3 giorni',
    cityHub: 'Part-time per citta',
    openAll: 'Vedi tutte le offerte di lavoro in Ticino',
    faq: [
      {
        question: 'Cosa si intende per lavoro part-time in Svizzera?',
        answer: 'In Svizzera il lavoro part-time indica qualsiasi contratto con un grado di occupazione inferiore al 100%. Puo essere espresso in percentuale (es. 60%, 80%) o in ore settimanali. Anche contratti al 90% sono considerati part-time.',
      },
      {
        question: 'Un frontaliere puo lavorare part-time con il permesso G?',
        answer: 'Si, il permesso G consente anche contratti a tempo parziale. L\'importante e che il rapporto di lavoro sia regolare e dichiarato. Il part-time non influisce sulla validita del permesso.',
      },
      {
        question: 'Come vengono filtrate le offerte part-time?',
        answer: 'Il nostro sistema identifica le offerte part-time analizzando il titolo, il contratto e la percentuale di impiego indicata nell\'annuncio. Le posizioni con percentuale tra 1% e 99% vengono automaticamente classificate come part-time.',
      },
    ],
  },
  en: {
    title: 'Part-time jobs in Ticino | Flexible positions for cross-border workers',
    heading: 'Part-time jobs in Ticino',
    description: (count) => `Browse ${count} part-time job openings in Ticino for cross-border workers. Flexible positions updated daily from Swiss employers, filterable by city, sector and employment percentage.`,
    intro: 'This page collects all part-time positions available in Canton Ticino, ideal for cross-border workers seeking flexibility. Roles range from 20% to 80% contracts across all major sectors.',
    updatedLabel: 'Updated',
    countsLabel: 'active part-time jobs',
    feedLabel: 'Part-time jobs in Ticino',
    latestLabel: 'New part-time jobs in the last 3 days',
    cityHub: 'Part-time by city',
    openAll: 'See all jobs in Ticino',
    faq: [
      {
        question: 'What counts as part-time work in Switzerland?',
        answer: 'In Switzerland, part-time means any contract with an employment level below 100%. It can be expressed as a percentage (e.g. 60%, 80%) or weekly hours. Even 90% contracts are considered part-time.',
      },
      {
        question: 'Can a cross-border worker hold a part-time job with a G permit?',
        answer: 'Yes, the G permit allows part-time contracts. The key requirement is that the employment relationship is regular and declared. Part-time status does not affect permit validity.',
      },
      {
        question: 'How are part-time jobs identified?',
        answer: 'Our system identifies part-time jobs by analysing the title, contract type and employment percentage stated in the listing. Positions with a percentage between 1% and 99% are automatically classified as part-time.',
      },
    ],
  },
  de: {
    title: 'Teilzeitjobs im Tessin | Flexible Stellen fur Grenzganger',
    heading: 'Teilzeitjobs im Tessin',
    description: (count) => `Entdecken Sie ${count} Teilzeitstellen im Tessin fur Grenzganger. Flexible Positionen von Schweizer Arbeitgebern, taglich aktualisiert, filterbar nach Stadt, Branche und Beschaftigungsgrad.`,
    intro: 'Diese Seite sammelt alle Teilzeitstellen im Kanton Tessin, ideal fur Grenzganger auf der Suche nach flexibler Arbeit. Die Positionen reichen von 20%- bis 80%-Vertragen in allen wichtigen Branchen.',
    updatedLabel: 'Aktualisiert',
    countsLabel: 'aktive Teilzeitstellen',
    feedLabel: 'Teilzeitstellen im Tessin',
    latestLabel: 'Neue Teilzeitstellen der letzten 3 Tage',
    cityHub: 'Teilzeit nach Stadt',
    openAll: 'Alle Jobs im Tessin ansehen',
    faq: [
      {
        question: 'Was gilt in der Schweiz als Teilzeitarbeit?',
        answer: 'In der Schweiz bezeichnet Teilzeitarbeit jeden Vertrag mit einem Beschaftigungsgrad unter 100%. Er kann als Prozentsatz (z. B. 60%, 80%) oder in Wochenstunden angegeben werden. Auch 90%-Vertrage gelten als Teilzeit.',
      },
      {
        question: 'Darf ein Grenzganger mit G-Bewilligung Teilzeit arbeiten?',
        answer: 'Ja, die G-Bewilligung erlaubt auch Teilzeitvertrage. Wichtig ist, dass das Arbeitsverhaltnis regulaer und gemeldet ist. Der Teilzeitstatus beeinflusst die Gultigkeit der Bewilligung nicht.',
      },
      {
        question: 'Wie werden Teilzeitstellen erkannt?',
        answer: 'Unser System erkennt Teilzeitstellen anhand von Titel, Vertragsart und angegebenem Beschaftigungsgrad. Positionen mit einem Pensum zwischen 1% und 99% werden automatisch als Teilzeit klassifiziert.',
      },
    ],
  },
  fr: {
    title: "Emploi temps partiel au Tessin | Postes flexibles pour frontaliers",
    heading: "Emploi temps partiel au Tessin",
    description: (count) => `Consultez ${count} offres d'emploi a temps partiel au Tessin pour les frontaliers. Postes flexibles mis a jour quotidiennement par des employeurs suisses, filtrables par ville, secteur et taux d'occupation.`,
    intro: "Cette page regroupe toutes les offres a temps partiel disponibles dans le canton du Tessin, ideales pour les frontaliers a la recherche de flexibilite. Les postes vont de contrats a 20% jusqu'a 80% dans tous les secteurs majeurs.",
    updatedLabel: 'Mis a jour',
    countsLabel: 'offres temps partiel actives',
    feedLabel: "Offres a temps partiel au Tessin",
    latestLabel: 'Nouvelles offres temps partiel des 3 derniers jours',
    cityHub: 'Temps partiel par ville',
    openAll: 'Voir toutes les offres au Tessin',
    faq: [
      {
        question: "Qu'est-ce que le temps partiel en Suisse ?",
        answer: "En Suisse, le temps partiel designe tout contrat avec un taux d'occupation inferieur a 100%. Il peut etre exprime en pourcentage (ex. 60%, 80%) ou en heures hebdomadaires. Meme les contrats a 90% sont consideres comme du temps partiel.",
      },
      {
        question: "Un frontalier peut-il travailler a temps partiel avec un permis G ?",
        answer: "Oui, le permis G autorise egalement les contrats a temps partiel. L'essentiel est que la relation de travail soit reguliere et declaree. Le statut a temps partiel n'affecte pas la validite du permis.",
      },
      {
        question: "Comment les offres a temps partiel sont-elles identifiees ?",
        answer: "Notre systeme identifie les offres a temps partiel en analysant le titre, le type de contrat et le taux d'occupation indique dans l'annonce. Les postes avec un taux entre 1% et 99% sont automatiquement classes comme temps partiel.",
      },
    ],
  },
};

export function buildJobPartTimeLandingModel(options: {
  jobs: JobLike[];
  locale: JobLandingLocale;
  now?: string | Date;
  localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
  baseUrl: string;
  sectionSlug: string;
  localePrefix: string;
}): JobPartTimeLandingModel {
  const locale = options.locale;
  const copy = PART_TIME_COPY[locale];
  const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const matches = options.jobs.filter((job) => isTicinoScoped(job) && isPartTime(job));
  const latestJobs = matches.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));

  // Build city breakdown for part-time jobs
  const cityCountMap = new Map<string, number>();
  for (const job of matches) {
    const loc = normalizeSpace(job.location || '');
    if (!loc) continue;
    const canonical = SUPPORTED_EDITORIAL_LOCATIONS.find((l) => l.toLowerCase() === loc.toLowerCase());
    if (canonical) {
      cityCountMap.set(canonical, (cityCountMap.get(canonical) || 0) + 1);
    }
  }
  const cityLinks: CityLeader[] = Array.from(cityCountMap.entries())
    .map(([name, count]) => ({
      name,
      count,
      href: ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${buildLocationTypeSlug(locale, name, 'partTime')}`.replace(/\/+/g, '/')}`),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    kind: 'part-time',
    slug: JOB_PART_TIME_LANDING_SLUGS[locale],
    title: copy.title,
    heading: copy.heading,
    description: copy.description(matches.length),
    intro: copy.intro,
    updatedLabel: copy.updatedLabel,
    countsLabel: copy.countsLabel,
    totalJobs: matches.length,
    feed: { label: copy.feedLabel, jobs: toLinkedJobs(matches, now, locale, { ...options, baseUrl }, 18) },
    latestLabel: copy.latestLabel,
    latestJobs: toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 12),
    cityLinks,
    cityHubLabel: copy.cityHub,
    faq: copy.faq,
    openAllLabel: copy.openAll,
  };
}
