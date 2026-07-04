/**
 * Profession landings (AE-3) — slug tables + path matchers.
 *
 * 10 programmatic profession landing pages × 4 locales = 40 URLs.
 * Professions picked by volume in data/jobs.json + task prompt:
 *
 *   infermiere, operaio, impiegato, ingegnere, educatore,
 *   autista, muratore, cuoco, cameriere, elettricista
 *
 * IT canonical pattern:
 *   /lavoro-ticino-<profession>/
 * Locale variants:
 *   /en/jobs-ticino-<profession>/
 *   /de/arbeit-tessin-<profession>/
 *   /fr/travail-tessin-<profession>/
 *
 * Unlocked by MEBEKO (healthcare) + SEFRI/SECO (trades) public equivalence
 * tables, snapshotted in data/seo/*.json. Every regulated claim on the
 * rendered HTML cites its primary source inline.
 */

export const PROFESSION_LOCALES = ['it', 'en', 'de', 'fr'] as const;
export type ProfessionLocale = (typeof PROFESSION_LOCALES)[number];

export const PROFESSION_IDS = [
  'infermiere',
  'operaio',
  'impiegato',
  'ingegnere',
  'educatore',
  'autista',
  'muratore',
  'cuoco',
  'cameriere',
  'elettricista',
  // Batch sanitario/paramedico (#3393) — >700 ricerche on-site/60g scoperte.
  'psicologo',
  'fisioterapista',
  'logopedista',
  'farmacista',
  'ostetrica',
  'assistente-dentale',
  'tecnico-radiologia',
  'oss',
  // Batch 2 (#3393) — domanda on-site validata da annunci crawler.
  'ottico-optometrista',
  'contabile',
  'assistente-sociale',
  'macellaio',
  'saldatore',
  'architetto',
] as const;
export type ProfessionId = (typeof PROFESSION_IDS)[number];

export const PROFESSION_LOCALE_PREFIX: Record<ProfessionLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/**
 * Per-locale slug. IT is canonical. EN/DE/FR pick a locale-natural slug
 * while preserving the keyword intent ("lavoro ticino" → "jobs ticino",
 * "arbeit tessin", "travail tessin").
 */
export const PROFESSION_SLUGS: Record<ProfessionLocale, Record<ProfessionId, string>> = {
  it: {
    infermiere: 'lavoro-ticino-infermiere',
    operaio: 'lavoro-ticino-operaio',
    impiegato: 'lavoro-ticino-impiegato',
    ingegnere: 'lavoro-ticino-ingegnere',
    educatore: 'lavoro-ticino-educatore',
    autista: 'lavoro-ticino-autista',
    muratore: 'lavoro-ticino-muratore',
    cuoco: 'lavoro-ticino-cuoco',
    cameriere: 'lavoro-ticino-cameriere',
    elettricista: 'lavoro-ticino-elettricista',
    psicologo: 'lavoro-ticino-psicologo',
    fisioterapista: 'lavoro-ticino-fisioterapista',
    logopedista: 'lavoro-ticino-logopedista',
    farmacista: 'lavoro-ticino-farmacista',
    ostetrica: 'lavoro-ticino-ostetrica',
    'assistente-dentale': 'lavoro-ticino-assistente-dentale',
    'tecnico-radiologia': 'lavoro-ticino-tecnico-radiologia',
    oss: 'lavoro-ticino-oss',
    'ottico-optometrista': 'lavoro-ticino-ottico-optometrista',
    contabile: 'lavoro-ticino-contabile',
    'assistente-sociale': 'lavoro-ticino-assistente-sociale',
    macellaio: 'lavoro-ticino-macellaio',
    saldatore: 'lavoro-ticino-saldatore',
    architetto: 'lavoro-ticino-architetto',
  },
  en: {
    infermiere: 'jobs-ticino-nurse',
    operaio: 'jobs-ticino-worker',
    impiegato: 'jobs-ticino-clerk',
    ingegnere: 'jobs-ticino-engineer',
    educatore: 'jobs-ticino-educator',
    autista: 'jobs-ticino-driver',
    muratore: 'jobs-ticino-mason',
    cuoco: 'jobs-ticino-cook',
    cameriere: 'jobs-ticino-waiter',
    elettricista: 'jobs-ticino-electrician',
    psicologo: 'jobs-ticino-psychologist',
    fisioterapista: 'jobs-ticino-physiotherapist',
    logopedista: 'jobs-ticino-speech-therapist',
    farmacista: 'jobs-ticino-pharmacist',
    ostetrica: 'jobs-ticino-midwife',
    'assistente-dentale': 'jobs-ticino-dental-assistant',
    'tecnico-radiologia': 'jobs-ticino-radiographer',
    oss: 'jobs-ticino-healthcare-assistant',
    'ottico-optometrista': 'jobs-ticino-optician-optometrist',
    contabile: 'jobs-ticino-accountant',
    'assistente-sociale': 'jobs-ticino-social-worker',
    macellaio: 'jobs-ticino-butcher',
    saldatore: 'jobs-ticino-welder',
    architetto: 'jobs-ticino-architect',
  },
  de: {
    infermiere: 'arbeit-tessin-krankenpfleger',
    operaio: 'arbeit-tessin-arbeiter',
    impiegato: 'arbeit-tessin-sachbearbeiter',
    ingegnere: 'arbeit-tessin-ingenieur',
    educatore: 'arbeit-tessin-erzieher',
    autista: 'arbeit-tessin-fahrer',
    muratore: 'arbeit-tessin-maurer',
    cuoco: 'arbeit-tessin-koch',
    cameriere: 'arbeit-tessin-kellner',
    elettricista: 'arbeit-tessin-elektriker',
    psicologo: 'arbeit-tessin-psychologe',
    fisioterapista: 'arbeit-tessin-physiotherapeut',
    logopedista: 'arbeit-tessin-logopaede',
    farmacista: 'arbeit-tessin-apotheker',
    ostetrica: 'arbeit-tessin-hebamme',
    'assistente-dentale': 'arbeit-tessin-dentalassistent',
    'tecnico-radiologia': 'arbeit-tessin-radiologiefachmann',
    oss: 'arbeit-tessin-fage',
    'ottico-optometrista': 'arbeit-tessin-optiker-optometrist',
    contabile: 'arbeit-tessin-buchhalter',
    'assistente-sociale': 'arbeit-tessin-sozialarbeiter',
    macellaio: 'arbeit-tessin-metzger',
    saldatore: 'arbeit-tessin-schweisser',
    architetto: 'arbeit-tessin-architekt',
  },
  fr: {
    infermiere: 'travail-tessin-infirmier',
    operaio: 'travail-tessin-ouvrier',
    impiegato: 'travail-tessin-employe',
    ingegnere: 'travail-tessin-ingenieur',
    educatore: 'travail-tessin-educateur',
    autista: 'travail-tessin-chauffeur',
    muratore: 'travail-tessin-macon',
    cuoco: 'travail-tessin-cuisinier',
    cameriere: 'travail-tessin-serveur',
    elettricista: 'travail-tessin-electricien',
    psicologo: 'travail-tessin-psychologue',
    fisioterapista: 'travail-tessin-physiotherapeute',
    logopedista: 'travail-tessin-logopede',
    farmacista: 'travail-tessin-pharmacien',
    ostetrica: 'travail-tessin-sage-femme',
    'assistente-dentale': 'travail-tessin-assistant-dentaire',
    'tecnico-radiologia': 'travail-tessin-technicien-radiologie',
    oss: 'travail-tessin-assistant-soins',
    'ottico-optometrista': 'travail-tessin-opticien-optometriste',
    contabile: 'travail-tessin-comptable',
    'assistente-sociale': 'travail-tessin-assistant-social',
    macellaio: 'travail-tessin-boucher',
    saldatore: 'travail-tessin-soudeur',
    architetto: 'travail-tessin-architecte',
  },
};

export function buildProfessionLandingPath(locale: ProfessionLocale, id: ProfessionId): string {
  const prefix = PROFESSION_LOCALE_PREFIX[locale];
  const slug = PROFESSION_SLUGS[locale][id];
  return `${prefix}/${slug}/`.replace(/\/+/g, '/');
}

/**
 * Locale-natural "area" prefix shared by every profession slug
 * ("lavoro-ticino", "jobs-ticino", "arbeit-tessin", "travail-tessin").
 * Stripping it from a slug yields the role keyword. Co-located with
 * PROFESSION_SLUGS so the two can't drift; if a slug ever stops matching its
 * prefix the keyword degrades gracefully to the full slug, never crashes.
 */
export const PROFESSION_SLUG_AREA_PREFIX: Record<ProfessionLocale, string> = {
  it: 'lavoro-ticino-',
  en: 'jobs-ticino-',
  de: 'arbeit-tessin-',
  fr: 'travail-tessin-',
};

/**
 * Role keyword for the SPA job-board `?q=` filter: the profession slug with
 * its area prefix removed. Keeping every role token (not just the last
 * segment via `.split('-').pop()`) means multi-word roles like
 * "operatore-socio-sanitario" filter on the full role instead of a degenerate
 * tail ("sanitario"). The board's `?q=` tokenizer normalises hyphens to
 * spaces, so the hyphenated remainder matches as a multi-word query.
 */
export function professionRoleKeyword(locale: ProfessionLocale, id: ProfessionId): string {
  const slug = PROFESSION_SLUGS[locale][id];
  const prefix = PROFESSION_SLUG_AREA_PREFIX[locale];
  return slug.startsWith(prefix) ? slug.slice(prefix.length) : slug;
}

/** Flat list of every canonical (all 4 locales × 10 ids = 40 URLs). */
export const PROFESSION_LANDING_ROUTES: readonly string[] = PROFESSION_LOCALES.flatMap((loc) =>
  PROFESSION_IDS.map((id) => buildProfessionLandingPath(loc, id)),
);

export function parseProfessionLandingPath(
  pathname: string,
): { locale: ProfessionLocale; id: ProfessionId } | null {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const locale of PROFESSION_LOCALES) {
    for (const id of PROFESSION_IDS) {
      if (buildProfessionLandingPath(locale, id) === normalized) return { locale, id };
    }
  }
  return null;
}

export function isProfessionLandingPath(pathname: string): boolean {
  return parseProfessionLandingPath(pathname) !== null;
}

/**
 * Per-profession employer/city/salary snapshot. Derived at AE-3 plan time
 * from data/jobs.json (2,506 records) and frozen here so build-time word
 * counts don't flicker when the JSON snapshot refreshes.
 *
 * Regenerate via scripts/build-profession-snapshot.mjs (TODO — deferred,
 * current values are stable for the 2026-04-23 snapshot and validated
 * against the data/seo/ae3-professions.csv file shipped in the same commit).
 */
export interface ProfessionFacts {
  /** Volume of matching jobs in the 2026-04 dataset. */
  jobsCount: number;
  /** Median CHF gross annual salary from jobs.json baseSalary intervals. */
  medianSalaryChf: number;
  /** Typical salary range (CHF gross annual, CCL-backed). */
  typicalSalaryRange: readonly [number, number];
  /** Top 5 Ticino / Swiss-Italian employers for this profession. */
  topEmployers: readonly string[];
  /** Top 3 cities. */
  topCities: readonly string[];
  /** True if the role requires authority pre-approval before hire. */
  regulated: boolean;
  /** Recognition authority for Italian diplomas. */
  recognitionAuthority: string;
  /** Primary authority URL for inline citation. */
  recognitionAuthorityUrl: string;
  /** Applicable CCL (or "non coperto"). */
  cclReference: string;
  /** CCL source URL. */
  cclUrl: string;
  /** Typical recognition lead-time in months [min, max]. 0,0 = non-regulated. */
  recognitionLeadTimeMonths: readonly [number, number];
}

export const PROFESSION_FACTS: Record<ProfessionId, ProfessionFacts> = {
  infermiere: {
    jobsCount: 89,
    medianSalaryChf: 78000,
    typicalSalaryRange: [75000, 110000],
    topEmployers: [
      'EOC – Ente Ospedaliero Cantonale',
      'Clinica Luganese Moncucco',
      'Clinica Sant\'Anna Sorengo',
      'LIS – Lugano Istituti Sociali',
      'Fondazione Ticino Cuore',
    ],
    topCities: ['Bellinzona', 'Lugano', 'Mendrisio'],
    regulated: true,
    recognitionAuthority: 'SRK (Croce Rossa Svizzera) su delega MEBEKO',
    recognitionAuthorityUrl: 'https://www.redcross.ch/it/offerte-della-crs/riconoscimento-di-diplomi-esteri',
    cclReference: 'CCL EOC + CCL Cliniche private ticinesi',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [4, 9],
  },
  operaio: {
    jobsCount: 14,
    medianSalaryChf: 65000,
    typicalSalaryRange: [55000, 78000],
    topEmployers: [
      'Amministrazione Cantonale Ticino',
      'PEMSA',
      'Bell Schweiz AG',
      'Heineken Switzerland',
      'Tether Operations',
    ],
    topCities: ['Bellinzona', 'Mendrisio', 'Lugano'],
    regulated: false,
    recognitionAuthority: 'Nessuna (non regolamentata)',
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/it',
    cclReference: 'CCL di settore (metallurgia, chimica, alimentare)',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [0, 0],
  },
  impiegato: {
    jobsCount: 185,
    medianSalaryChf: 65000,
    typicalSalaryRange: [55000, 95000],
    topEmployers: ['Coop', 'VOLG', 'Interdiscount', 'Läderach (Schweiz) AG', 'BancaStato'],
    topCities: ['Lugano', 'Bellinzona', 'Mendrisio'],
    regulated: false,
    recognitionAuthority: 'SEFRI (facoltativo)',
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/it',
    cclReference: 'CCL di settore (banche, commercio al dettaglio, industria)',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [2, 5],
  },
  ingegnere: {
    jobsCount: 95,
    medianSalaryChf: 95000,
    typicalSalaryRange: [80000, 130000],
    topEmployers: [
      'Hamilton Bonaduz AG',
      'ABB Svizzera (sede Ticino)',
      'Tether Operations',
      'Lombardi Group',
      'AGIE Charmilles SA',
    ],
    topCities: ['Lugano', 'Manno', 'Bellinzona'],
    regulated: false,
    recognitionAuthority: 'SEFRI + REG (Registro ingegneri svizzeri)',
    recognitionAuthorityUrl: 'https://www.reg.ch/',
    cclReference: 'Nessun CCL obbligatorio sitewide',
    cclUrl: 'https://www.reg.ch/',
    recognitionLeadTimeMonths: [3, 8],
  },
  educatore: {
    jobsCount: 2,
    medianSalaryChf: 82000,
    typicalSalaryRange: [70000, 105000],
    topEmployers: [
      'Fondazione La Fonte',
      'LIS – Lugano Istituti Sociali',
      'Città di Lugano',
      'Pro Juventute Ticino',
      'Fondazione Amilcare',
    ],
    topCities: ['Lugano', 'Bellinzona', 'Locarno'],
    regulated: true,
    recognitionAuthority: 'SEFRI (per titoli Bachelor) + CRS per formazione sanitaria',
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/it',
    cclReference: 'CCL Settore socio-educativo Ticino',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [3, 8],
  },
  autista: {
    jobsCount: 19,
    medianSalaryChf: 62000,
    typicalSalaryRange: [55000, 75000],
    topEmployers: ['TSMG', 'Heineken Switzerland', 'Autopostale Svizzera', 'SBB Cargo', 'Planzer Ticino'],
    topCities: ['Bellinzona', 'Lugano', 'Mendrisio'],
    regulated: true,
    recognitionAuthority: 'USTRA + SEFRI',
    recognitionAuthorityUrl: 'https://www.astra.admin.ch/astra/it/home.html',
    cclReference: 'CCL Trasporti stradali Ticino',
    cclUrl: 'https://www.les-routiers.ch/it/',
    recognitionLeadTimeMonths: [1, 3],
  },
  muratore: {
    jobsCount: 0, // Not in dataset — copy cites CCL CNM public data instead.
    medianSalaryChf: 77000,
    typicalSalaryRange: [68000, 90000],
    topEmployers: [
      'Implenia Svizzera SA',
      'Garzoni SA',
      'Cofferati SA',
      'Consorzio Imprenditori Edili Ticino',
      'Leonardi SA',
    ],
    topCities: ['Lugano', 'Bellinzona', 'Mendrisio'],
    regulated: true,
    recognitionAuthority: 'SEFRI',
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/it',
    cclReference: 'CNM – Contratto nazionale mantello edilizia principale',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [4, 6],
  },
  cuoco: {
    jobsCount: 28,
    medianSalaryChf: 60000,
    typicalSalaryRange: [52000, 78000],
    topEmployers: [
      'Kulm Hotel St. Moritz',
      'Grand Hotel Kronenhof',
      'EOC – Ente Ospedaliero Cantonale',
      'Weisse Arena Gruppe',
      'Coop Genossenschaft',
    ],
    topCities: ['Lugano', 'Ascona', 'Mendrisio'],
    regulated: false,
    recognitionAuthority: 'SEFRI (facoltativo)',
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/it',
    cclReference: 'L-GAV – CCNL gastronomia e alberghiero (obbligatorio)',
    cclUrl: 'https://www.l-gav.ch/it/',
    recognitionLeadTimeMonths: [2, 5],
  },
  cameriere: {
    jobsCount: 7,
    medianSalaryChf: 54000,
    typicalSalaryRange: [46000, 66000],
    topEmployers: [
      'Kulm Hotel St. Moritz',
      'Marriott International',
      'Grand Hotel des Bains Kempinski',
      'Tschuggen Collection',
      'Casa al Lago Locarno',
    ],
    topCities: ['Lugano', 'Ascona', 'Locarno'],
    regulated: false,
    recognitionAuthority: 'Nessuno (non regolamentata)',
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/it',
    cclReference: 'L-GAV – CCNL gastronomia e alberghiero (obbligatorio)',
    cclUrl: 'https://www.l-gav.ch/it/',
    recognitionLeadTimeMonths: [0, 0],
  },
  elettricista: {
    jobsCount: 38,
    medianSalaryChf: 72000,
    typicalSalaryRange: [62000, 90000],
    topEmployers: [
      'Grichting & Valterio Electro SA',
      'TZ Stromag',
      'Caviezel AG',
      'Elettricità Luganese',
      'Romelli SA',
    ],
    topCities: ['Lugano', 'Bellinzona', 'Mendrisio'],
    regulated: true,
    recognitionAuthority: 'SEFRI + ESTI (Ispettorato federale impianti elettrici)',
    recognitionAuthorityUrl: 'https://www.esti.admin.ch/it/temi/riconoscimento-di-diplomi',
    cclReference: 'CCL Ramo installazione elettrotelecomunicazioni',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [3, 9],
  },
  // ── Batch sanitario/paramedico + batch 2 (#3393) ────────────────────────
  // Snapshot 2026-07 from data/jobs/by-crawler shards (same matchers as
  // professionJobsAggregate). Salary medians from dataset baseSalary
  // intervals; oss + assistente-dentale use CCL-conservative values because
  // their matcher sample skews toward adjacent higher-paid roles (declared
  // in PR #3393).
  psicologo: {
    jobsCount: 155,
    medianSalaryChf: 78000,
    typicalSalaryRange: [70000, 105000],
    topEmployers: [
      'Organizzazione Sociopsichiatrica Cantonale (OSC)',
      'WePractice',
      'Luzerner Psychiatrie (LUPS)',
      'Clienia AG',
      'Spital Thurgau (STGAG)',
    ],
    topCities: ['Lugano', 'Mendrisio', 'Zürich'],
    regulated: true,
    recognitionAuthority: 'PsyCo — Commissione delle professioni psicologiche (UFSP, LPPsi)',
    recognitionAuthorityUrl: 'https://www.bag.admin.ch/it',
    cclReference: 'CCL EOC / contratti istituzionali OSC per il settore pubblico',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [3, 8],
  },
  fisioterapista: {
    jobsCount: 77,
    medianSalaryChf: 78000,
    typicalSalaryRange: [68000, 95000],
    topEmployers: [
      'EOC – Ente Ospedaliero Cantonale',
      'Hirslanden Klinik',
      'ZURZACH Care',
      'Kliniken Valens',
      'Luzerner Kantonsspital (LUKS)',
    ],
    topCities: ['Lugano', 'Bellinzona', 'Luzern'],
    regulated: true,
    recognitionAuthority: 'CRS (Croce Rossa Svizzera) — professioni LPSan',
    recognitionAuthorityUrl: 'https://www.redcross.ch/it/offerte-della-crs/riconoscimento-di-diplomi-esteri',
    cclReference: 'CCL EOC + CCL Cliniche private ticinesi',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [4, 9],
  },
  logopedista: {
    jobsCount: 7,
    medianSalaryChf: 86000,
    typicalSalaryRange: [72000, 98000],
    topEmployers: [
      'Stiftung Bachtelen',
      'Universitäts-Kinderspital Zürich',
      'Kantonsspital Winterthur (KSW)',
      'Solothurner Spitäler AG (soH)',
      'Universitätsspital Basel',
    ],
    topCities: ['Solothurn', 'Zürich', 'Winterthur'],
    regulated: true,
    recognitionAuthority: 'CDPE/EDK — riconoscimento dei diplomi esteri di logopedia',
    recognitionAuthorityUrl: 'https://www.edk.ch',
    cclReference: 'Contratti cantonali scuola/sanità (nessun CCL nazionale)',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [3, 7],
  },
  farmacista: {
    jobsCount: 49,
    medianSalaryChf: 92500,
    typicalSalaryRange: [85000, 125000],
    topEmployers: [
      'Galenica AG',
      'Hirslanden Klinik',
      'EOC – Ente Ospedaliero Cantonale',
      'Kantonsspital Glarus (KSGL)',
      'Universitätsklinik Balgrist',
    ],
    topCities: ['Lugano', 'Bern', 'Zürich'],
    regulated: true,
    recognitionAuthority: 'MEBEKO — Commissione delle professioni mediche (UFSP)',
    recognitionAuthorityUrl: 'https://www.bag.admin.ch/it/commissione-delle-professioni-mediche-mebeko',
    cclReference: 'Nessun CCL obbligatorio (raccomandazioni salariali pharmaSuisse)',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [3, 6],
  },
  ostetrica: {
    jobsCount: 27,
    medianSalaryChf: 84500,
    typicalSalaryRange: [75000, 100000],
    topEmployers: [
      'EOC – Ente Ospedaliero Cantonale',
      'Hirslanden Klinik',
      'HUG – Hôpitaux Universitaires de Genève',
      'Flury Stiftung',
      'HOCH Health Ostschweiz',
    ],
    topCities: ['Bellinzona', 'Locarno', 'Mendrisio'],
    regulated: true,
    recognitionAuthority: 'CRS (Croce Rossa Svizzera) — procedura armonizzata direttiva UE 2005/36/CE',
    recognitionAuthorityUrl: 'https://www.redcross.ch/it/offerte-della-crs/riconoscimento-di-diplomi-esteri',
    cclReference: 'CCL EOC',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [2, 6],
  },
  'assistente-dentale': {
    jobsCount: 6,
    medianSalaryChf: 58000,
    typicalSalaryRange: [50000, 68000],
    topEmployers: [
      'Universität Zürich (cliniche odontoiatriche)',
      'Universität Bern (cliniche odontoiatriche)',
      'Studi dentistici privati ticinesi',
      'Catene odontoiatriche (Adent, Ardentis)',
      'Cliniche dentarie transfrontaliere',
    ],
    topCities: ['Lugano', 'Zürich', 'Bern'],
    regulated: false,
    recognitionAuthority: 'SEFRI (riconoscimento del titolo AFC, facoltativo)',
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/it',
    cclReference: 'Nessun CCL obbligatorio (raccomandazioni SSO — Società svizzera odontoiatri)',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [2, 4],
  },
  'tecnico-radiologia': {
    jobsCount: 62,
    medianSalaryChf: 86000,
    typicalSalaryRange: [78000, 102000],
    topEmployers: [
      'EOC – Ente Ospedaliero Cantonale',
      'Hirslanden Klinik',
      'Universitätsspital Basel',
      'HOCH Health Ostschweiz',
      'Luzerner Kantonsspital (LUKS)',
    ],
    topCities: ['Bellinzona', 'Basel', 'Luzern'],
    regulated: true,
    recognitionAuthority: 'CRS (Croce Rossa Svizzera)',
    recognitionAuthorityUrl: 'https://www.redcross.ch/it/offerte-della-crs/riconoscimento-di-diplomi-esteri',
    cclReference: 'CCL EOC + CCL Cliniche private ticinesi',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [3, 6],
  },
  oss: {
    jobsCount: 300,
    medianSalaryChf: 64000,
    typicalSalaryRange: [54000, 74000],
    topEmployers: [
      'Tertianum',
      'EOC – Ente Ospedaliero Cantonale',
      'Universitätsspital Zürich (USZ)',
      'Hirslanden Klinik',
      'Case per anziani comunali ticinesi',
    ],
    topCities: ['Lugano', 'Zürich', 'Luzern'],
    regulated: false,
    recognitionAuthority: 'CRS (Croce Rossa Svizzera) — professioni sanitarie non universitarie',
    recognitionAuthorityUrl: 'https://www.redcross.ch/it/offerte-della-crs/riconoscimento-di-diplomi-esteri',
    cclReference: 'CCL EOC + ROCA (case per anziani ticinesi)',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [3, 6],
  },
  'ottico-optometrista': {
    jobsCount: 26,
    medianSalaryChf: 78000,
    typicalSalaryRange: [65000, 95000],
    topEmployers: [
      'Fielmann Group',
      'Visilab',
      'McOptic',
      'Ottiche indipendenti ticinesi',
      'Studi di optometria',
    ],
    topCities: ['Lugano', 'Zürich', 'Winterthur'],
    regulated: true,
    recognitionAuthority: 'CRS (optometrista, LPSan) / SEFRI (ottico AFC)',
    recognitionAuthorityUrl: 'https://www.redcross.ch/it/offerte-della-crs/riconoscimento-di-diplomi-esteri',
    cclReference: 'Nessun CCL obbligatorio',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [3, 6],
  },
  contabile: {
    jobsCount: 58,
    medianSalaryChf: 86000,
    typicalSalaryRange: [70000, 110000],
    topEmployers: [
      'Roche',
      'Sulzer',
      'Richemont',
      'PwC Switzerland',
      'Fiduciarie ticinesi',
    ],
    topCities: ['Lugano', 'Zürich', 'Basel'],
    regulated: false,
    recognitionAuthority: 'Nessuna (professione non regolamentata; riconoscimento SEFRI facoltativo)',
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/it',
    cclReference: 'Nessun CCL obbligatorio',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [0, 0],
  },
  'assistente-sociale': {
    jobsCount: 59,
    medianSalaryChf: 78000,
    typicalSalaryRange: [70000, 95000],
    topEmployers: [
      'Luzerner Psychiatrie (LUPS)',
      'Psychiatrische Dienste Aargau (PDAG)',
      'Stiftung Bachtelen',
      'Servizi sociali comunali ticinesi',
      'Psychiatrische Universitätsklinik Zürich',
    ],
    topCities: ['Lugano', 'Zürich', 'Luzern'],
    regulated: false,
    recognitionAuthority: 'SEFRI (riconoscimento del titolo SUP, facoltativo)',
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/it',
    cclReference: 'CCL Settore sociale ticinese (istituti sociali)',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [2, 5],
  },
  macellaio: {
    jobsCount: 139,
    medianSalaryChf: 74000,
    typicalSalaryRange: [63000, 86000],
    topEmployers: [
      'Coop Genossenschaft',
      'Migros',
      'Transgourmet',
      'Bell Schweiz AG',
      'Macellerie artigianali ticinesi',
    ],
    topCities: ['Lugano', 'Basel', 'Zürich'],
    regulated: false,
    recognitionAuthority: 'SEFRI (riconoscimento del titolo AFC, facoltativo)',
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/it',
    cclReference: 'CCL per l\'industria svizzera della carne (obbligatorietà generale)',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [2, 4],
  },
  saldatore: {
    jobsCount: 7,
    medianSalaryChf: 72000,
    typicalSalaryRange: [60000, 85000],
    topEmployers: [
      'Sulzer',
      'PEMSA',
      'Bühler Group',
      'Officine meccaniche ticinesi',
      'Carpenterie metalliche',
    ],
    topCities: ['Bellinzona', 'Genève', 'Bulle'],
    regulated: false,
    recognitionAuthority: 'Nessuna (certificazioni di saldatura EN ISO 9606 richieste dai datori)',
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/it',
    cclReference: 'CCL industria MEM / metalcostruzione',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [0, 0],
  },
  architetto: {
    jobsCount: 9,
    medianSalaryChf: 88000,
    typicalSalaryRange: [75000, 110000],
    topEmployers: [
      'Artisa Group',
      'ETH Zürich',
      'Studi di architettura ticinesi',
      'Confederazione Svizzera',
      'Immobiliari e general contractor',
    ],
    topCities: ['Lugano', 'Zürich', 'Lausanne'],
    regulated: true,
    recognitionAuthority: 'REG (Fondazione dei Registri svizzeri) + OTIA per l\'esercizio in Ticino',
    recognitionAuthorityUrl: 'https://www.reg.ch/',
    cclReference: 'Nessun CCL (onorari secondo regolamenti SIA)',
    cclUrl: 'https://www.seco.admin.ch/it/contratti-collettivi-di-lavoro',
    recognitionLeadTimeMonths: [2, 6],
  },
};
