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
  },
};

export function buildProfessionLandingPath(locale: ProfessionLocale, id: ProfessionId): string {
  const prefix = PROFESSION_LOCALE_PREFIX[locale];
  const slug = PROFESSION_SLUGS[locale][id];
  return `${prefix}/${slug}/`.replace(/\/+/g, '/');
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
    cclUrl: 'https://www.seco.admin.ch/seco/it/home/Arbeit/Personenfreizugigkeit_Arbeitsbeziehungen/flankierende-massnahmen/usuelle-arbeits--und-lohnbedingungen/gesamtarbeitsvertraege-gav.html',
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
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
    cclReference: 'CCL di settore (metallurgia, chimica, alimentare)',
    cclUrl: 'https://www.seco.admin.ch/seco/it/home/Arbeit/Personenfreizugigkeit_Arbeitsbeziehungen/flankierende-massnahmen/usuelle-arbeits--und-lohnbedingungen/gesamtarbeitsvertraege-gav.html',
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
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
    cclReference: 'CCL di settore (banche, commercio al dettaglio, industria)',
    cclUrl: 'https://www.seco.admin.ch/seco/it/home/Arbeit/Personenfreizugigkeit_Arbeitsbeziehungen/flankierende-massnahmen/usuelle-arbeits--und-lohnbedingungen/gesamtarbeitsvertraege-gav.html',
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
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
    cclReference: 'CCL Settore socio-educativo Ticino',
    cclUrl: 'https://www.seco.admin.ch/seco/it/home/Arbeit/Personenfreizugigkeit_Arbeitsbeziehungen/flankierende-massnahmen/usuelle-arbeits--und-lohnbedingungen/gesamtarbeitsvertraege-gav.html',
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
    recognitionAuthorityUrl: 'https://www.astra.admin.ch/astra/it/home/temi/patenti/riconoscimento.html',
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
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
    cclReference: 'CNM – Contratto nazionale mantello edilizia principale',
    cclUrl: 'https://www.seco.admin.ch/seco/it/home/Arbeit/Personenfreizugigkeit_Arbeitsbeziehungen/flankierende-massnahmen/usuelle-arbeits--und-lohnbedingungen/gesamtarbeitsvertraege-gav.html',
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
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
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
    recognitionAuthorityUrl: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
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
    cclUrl: 'https://www.seco.admin.ch/seco/it/home/Arbeit/Personenfreizugigkeit_Arbeitsbeziehungen/flankierende-massnahmen/usuelle-arbeits--und-lohnbedingungen/gesamtarbeitsvertraege-gav.html',
    recognitionLeadTimeMonths: [3, 9],
  },
};
