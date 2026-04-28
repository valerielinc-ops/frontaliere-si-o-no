/**
 * Sector-based job hub definitions for high-intent GSC verticals.
 *
 * Modeled after `cityJobsHub.ts`: exposes per-locale slug tables, SEO copy,
 * and filter logic to consolidate signals for health-sector queries like
 *   "case anziani ticino offerte di lavoro"
 *   "offerte lavoro infermieri svizzera italiana"
 *   "concorso educatore ticino"
 * into dedicated hubs at clean URLs such as
 *   /cerca-lavoro-ticino/infermieri/
 *   /en/find-jobs-ticino/nurses/
 *   /de/jobs-im-tessin/pflegepersonal/
 *   /fr/trouver-emploi-tessin/infirmiers/
 *
 * The three sectors map to the highest-opportunity GSC clusters (Apr 2026):
 *   - Infermieri  (nurses)
 *   - Case anziani (elderly care homes)
 *   - Educatori   (educators / socio-pedagogical)
 */

import type { JobBoardLocale } from './jobBoardSeo';
import { clampSiteSuffix, formatSeoH1, formatSeoTitle } from './shared/seoContentTokens';

export type SectorHubKey =
  | 'infermieri'
  | 'case-anziani'
  | 'educatori'
  | 'ingegneri'
  | 'autisti'
  | 'sviluppatori'
  | 'ristorazione'
  | 'oss'
  | 'logistica'
  | 'apprendistato';

export const SECTOR_HUB_KEYS: readonly SectorHubKey[] = [
  'infermieri',
  'case-anziani',
  'educatori',
  'ingegneri',
  'autisti',
  'sviluppatori',
  'ristorazione',
  'oss',
  'logistica',
  'apprendistato',
] as const;

/** Per-locale URL slug for each sector. Query-matching, short. */
export const SECTOR_HUB_SLUG: Record<JobBoardLocale, Record<SectorHubKey, string>> = {
  it: {
    infermieri: 'infermieri',
    'case-anziani': 'case-anziani',
    educatori: 'educatori',
    ingegneri: 'ingegneri',
    autisti: 'autisti',
    sviluppatori: 'sviluppatori',
    ristorazione: 'ristorazione',
    oss: 'operatori-socio-sanitari',
    logistica: 'logistica',
    apprendistato: 'apprendistato',
  },
  en: {
    infermieri: 'nurses',
    'case-anziani': 'elderly-care',
    educatori: 'educators',
    ingegneri: 'engineers',
    autisti: 'drivers',
    sviluppatori: 'developers',
    ristorazione: 'restaurants',
    oss: 'healthcare-assistants',
    logistica: 'logistics',
    apprendistato: 'apprenticeships',
  },
  de: {
    infermieri: 'pflegepersonal',
    'case-anziani': 'altenpflege',
    educatori: 'erzieher',
    ingegneri: 'ingenieure',
    autisti: 'fahrer',
    sviluppatori: 'entwickler',
    ristorazione: 'gastronomie',
    oss: 'pflegeassistenten',
    logistica: 'logistik',
    apprendistato: 'lehrstellen',
  },
  fr: {
    infermieri: 'infirmiers',
    'case-anziani': 'maisons-retraite',
    educatori: 'educateurs',
    ingegneri: 'ingenieurs',
    autisti: 'chauffeurs',
    sviluppatori: 'developpeurs',
    ristorazione: 'restauration',
    oss: 'aides-soignants',
    logistica: 'logistique',
    apprendistato: 'apprentissages',
  },
};

/** Section root slug per locale (mirror of CITY_HUB_SECTION). */
export const SECTOR_HUB_SECTION: Record<JobBoardLocale, string> = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

export const SECTOR_HUB_LOCALE_PREFIX: Record<JobBoardLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** Display name per locale (used in H1, breadcrumbs). */
export const SECTOR_HUB_DISPLAY: Record<JobBoardLocale, Record<SectorHubKey, string>> = {
  it: {
    infermieri: 'Infermieri',
    'case-anziani': 'Case Anziani',
    educatori: 'Educatori',
    ingegneri: 'Ingegneri',
    autisti: 'Autisti',
    sviluppatori: 'Sviluppatori Software',
    ristorazione: 'Ristorazione',
    oss: 'Operatori Socio-Sanitari',
    logistica: 'Logistica',
    apprendistato: 'Apprendistato',
  },
  en: {
    infermieri: 'Nurses',
    'case-anziani': 'Elderly Care',
    educatori: 'Educators',
    ingegneri: 'Engineers',
    autisti: 'Drivers',
    sviluppatori: 'Software Developers',
    ristorazione: 'Restaurants',
    oss: 'Healthcare Assistants',
    logistica: 'Logistics',
    apprendistato: 'Apprenticeships',
  },
  de: {
    infermieri: 'Pflegepersonal',
    'case-anziani': 'Altenpflege',
    educatori: 'Erzieher',
    ingegneri: 'Ingenieure',
    autisti: 'Fahrer',
    sviluppatori: 'Softwareentwickler',
    ristorazione: 'Gastronomie',
    oss: 'Pflegeassistenten',
    logistica: 'Logistik',
    apprendistato: 'Lehrstellen',
  },
  fr: {
    infermieri: 'Infirmiers',
    'case-anziani': 'Maisons de Retraite',
    educatori: 'Éducateurs',
    ingegneri: 'Ingénieurs',
    autisti: 'Chauffeurs',
    sviluppatori: 'Développeurs Logiciel',
    ristorazione: 'Restauration',
    oss: 'Aides-Soignants',
    logistica: 'Logistique',
    apprendistato: 'Apprentissages',
  },
};

/** FIRE emoji threshold — matches cityJobsHub default. */
export const SECTOR_HUB_FIRE_THRESHOLD = 30;

// ── Path helpers ─────────────────────────────────────────────────────

export interface SectorHubPath {
  locale: JobBoardLocale;
  sector: SectorHubKey;
  /** Canonical path with trailing slash, e.g. "/cerca-lavoro-ticino/infermieri/". */
  path: string;
}

export function buildSectorHubPath(locale: JobBoardLocale, sector: SectorHubKey): string {
  const prefix = SECTOR_HUB_LOCALE_PREFIX[locale];
  const section = SECTOR_HUB_SECTION[locale];
  const slug = SECTOR_HUB_SLUG[locale][sector];
  return `${prefix}/${section}/${slug}/`.replace(/\/+/g, '/');
}

/** Return all 12 hub paths (3 sectors × 4 locales). */
export function allSectorHubPaths(): SectorHubPath[] {
  const out: SectorHubPath[] = [];
  for (const locale of ['it', 'en', 'de', 'fr'] as JobBoardLocale[]) {
    for (const sector of SECTOR_HUB_KEYS) {
      out.push({ locale, sector, path: buildSectorHubPath(locale, sector) });
    }
  }
  return out;
}

/** Reverse lookup: parse a path like `/cerca-lavoro-ticino/infermieri/`. */
export function parseSectorHubPath(
  urlPath: string,
): { locale: JobBoardLocale; sector: SectorHubKey } | null {
  if (!urlPath) return null;
  const withSlash = urlPath.endsWith('/') ? urlPath : `${urlPath}/`;
  for (const locale of ['it', 'en', 'de', 'fr'] as JobBoardLocale[]) {
    for (const sector of SECTOR_HUB_KEYS) {
      if (withSlash === buildSectorHubPath(locale, sector)) {
        return { locale, sector };
      }
    }
  }
  return null;
}

// ── Filter logic ─────────────────────────────────────────────────────

export interface SectorCountableJob {
  title?: string;
  description?: string;
  category?: string;
  tags?: readonly string[] | string;
  location?: string;
  addressLocality?: string;
  expired?: boolean;
  needsRetranslation?: boolean | Partial<Record<JobBoardLocale, boolean>>;
  descriptionByLocale?: Partial<Record<JobBoardLocale, string>>;
  titleByLocale?: Partial<Record<JobBoardLocale, string>>;
  company?: string;
  datePosted?: string;
  postedDate?: string;
  slug?: string;
  slugByLocale?: Partial<Record<JobBoardLocale, string>>;
}

/** Keyword patterns per sector (case-insensitive, multilingual). */
export const SECTOR_MATCHERS: Record<SectorHubKey, RegExp> = {
  infermieri: /infermier|infermiere|pfleger|pflegepersonal|pflegefach|krankenpfleg|krankensch|nurse|nursing|infirmier|infirmi[eè]re/i,
  // NOTE: do NOT add 3-letter abbreviations like \bris\b or \blis\b here —
  // they match high-frequency substrings ("Paris", "Polis", random IT/EN
  // tokens) and inflate the count by ~10× with false positives. Instead,
  // require the full Italian institutional acronyms to be followed by a
  // ticinese town to anchor them ("RIS Lugano", "LIS Pregassona", ...).
  'case-anziani':
    /casa[ -]anzian|case[ -]anzian|oscam|pregassona|altenpfleg|altersheim|pflegeheim|residenza[ -]per[ -]anzian|residenza[ -]anzian|elderly[ -]care|nursing[ -]home|maison[ -]de[ -]retraite|ehpad|\b(?:ris|lis)\b[ -](?:lugano|mendrisio|bellinzona|locarno|chiasso|biasca|airolo|tesserete|pregassona|breganzona|massagno|paradiso|melide|morbio|stabio|capolago|riva[ -]san[ -]vitale|sessa|sonvico|tegna|gordola|maggia|cevio)/i,
  educatori:
    /educator|educatric|educatrice|educatori|erzieher|erzieherin|p[aä]dagog|social[ -]pedagog|[eé]ducateur|[eé]ducatrice|educational[ -]assistant|operatore[ -]socio[ -]educativ/i,
  ingegneri:
    /ingegner|ingenieur|ingegnere|engineer|civil[ -]engineer|mechanical[ -]engineer|electrical[ -]engineer|ing[eé]nieur|softwareingenieur/i,
  autisti:
    /autist[aoie]|autotrasport|camionist|driver|trucker|chauffeur|fahrer|berufsfahrer|conducteur[ -]?routier|cdl[ -]driver|delivery[ -]driver/i,
  sviluppatori:
    /sviluppator|sviluppatore|programmator|programmatore|developer|software[ -]engineer|full[ -]?stack|front[ -]?end|back[ -]?end|devops|softwareentwickl|d[eé]veloppeur|programmeur/i,
  ristorazione:
    /ristora|ristoratore|ristorant|cuoc[ho]|cameri[eè]r|chef|sous[ -]chef|gastronom|hospitality|food[ -]service|restaurant|kellner|koch|k[oö]chin|service[ -]de[ -]table|cuisinier|serveur|waiter|waitress|bistro|pizzeri/i,
  oss:
    /operatore[ -]socio[ -]sanitar|operatori[ -]socio[ -]sanitar|\boss\b|\bosa\b|operatore[ -]socio[ -]assistenz|healthcare[ -]assistant|nursing[ -]assistant|nurse[ -]aide|pflegeassistent|pflegehelfer|fachperson[ -]gesundheit|aide[ -]soignant|aide[ -]a[ -]domicile|auxiliaire[ -]de[ -]vie/i,
  logistica:
    /logistic[ao]|logistico|logisticien|logistique|magazzin|magazziner|warehouse|warehouseman|lagerist|lagerlogistik|logistiker|carrellis|fork[ -]?lift|carrelli[ -]elevator|spediz|spedizionier|shipping[ -]clerk|customs[ -]broker|forwarder|spediteur|cargo[ -]handler/i,
  apprendistato:
    /apprendista|apprendistato|apprentice|apprenticeship|internship|intern\b|trainee|stagiaire|stagista|stage[ -]?curric|berufslehre|lehrstelle|lehrling|lehrbetrieb|lehrvertrag|formation[ -]duale|apprentissage|apprenti\b|alternance|tirocin/i,
};

function wordCount(s: string | undefined | null): number {
  if (!s) return 0;
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

function jobIsActive(job: SectorCountableJob, locale: JobBoardLocale): boolean {
  if (!job || typeof job !== 'object') return false;
  if (job.expired) return false;
  const nr = job.needsRetranslation;
  if (nr === true) return false;
  if (nr && typeof nr === 'object' && nr[locale]) return false;
  const localeDesc = job.descriptionByLocale?.[locale];
  const fallback = locale === 'it' ? job.description : undefined;
  const desc = localeDesc && localeDesc.trim().length > 0 ? localeDesc : fallback;
  return wordCount(desc) >= 50;
}

/**
 * True when a job's text metadata matches the sector keyword pattern.
 * Scans title, description, category, and tags. Case-insensitive.
 */
export function jobMatchesSector(job: SectorCountableJob, sector: SectorHubKey): boolean {
  const pattern = SECTOR_MATCHERS[sector];
  const parts: string[] = [];
  if (job.title) parts.push(String(job.title));
  if (job.description) parts.push(String(job.description));
  if (job.category) parts.push(String(job.category));
  if (job.company) parts.push(String(job.company));
  if (job.location) parts.push(String(job.location));
  if (job.addressLocality) parts.push(String(job.addressLocality));
  if (job.tags) {
    if (Array.isArray(job.tags)) parts.push(job.tags.join(' '));
    else parts.push(String(job.tags));
  }
  if (job.titleByLocale) {
    for (const v of Object.values(job.titleByLocale)) {
      if (typeof v === 'string') parts.push(v);
    }
  }
  if (job.descriptionByLocale) {
    for (const v of Object.values(job.descriptionByLocale)) {
      if (typeof v === 'string') parts.push(v);
    }
  }
  const haystack = parts.join(' \n ');
  return pattern.test(haystack);
}

/** Count active jobs by (locale, sector). Returns a 4 × {SECTOR_HUB_KEYS.length} matrix. */
export function countSectorJobsByLocale(
  jobs: readonly SectorCountableJob[],
): Record<JobBoardLocale, Record<SectorHubKey, number>> {
  const empty = (): Record<SectorHubKey, number> => ({
    infermieri: 0,
    'case-anziani': 0,
    educatori: 0,
    ingegneri: 0,
    autisti: 0,
    sviluppatori: 0,
    ristorazione: 0,
    oss: 0,
    logistica: 0,
    apprendistato: 0,
  });
  const counts: Record<JobBoardLocale, Record<SectorHubKey, number>> = {
    it: empty(),
    en: empty(),
    de: empty(),
    fr: empty(),
  };
  if (!Array.isArray(jobs)) return counts;
  for (const job of jobs) {
    for (const sector of SECTOR_HUB_KEYS) {
      if (!jobMatchesSector(job, sector)) continue;
      for (const locale of ['it', 'en', 'de', 'fr'] as JobBoardLocale[]) {
        if (jobIsActive(job, locale)) counts[locale][sector]++;
      }
    }
  }
  return counts;
}

/** Return a sorted list of matching jobs (by datePosted desc, limit N). */
export function filterSectorJobs(
  jobs: readonly SectorCountableJob[],
  sector: SectorHubKey,
  locale: JobBoardLocale,
  maxJobs = 50,
): SectorCountableJob[] {
  if (!Array.isArray(jobs)) return [];
  const matches: SectorCountableJob[] = [];
  for (const job of jobs) {
    if (!jobIsActive(job, locale)) continue;
    if (jobMatchesSector(job, sector)) matches.push(job);
  }
  matches.sort((a, b) => {
    const at = Date.parse(String(a.datePosted || a.postedDate || '')) || 0;
    const bt = Date.parse(String(b.datePosted || b.postedDate || '')) || 0;
    return bt - at;
  });
  return matches.slice(0, maxJobs);
}

// ── SEO copy ─────────────────────────────────────────────────────────

export interface SectorHubSeoEntry {
  title: string;
  desc: string;
  ogT: string;
  ogD: string;
  h1: string;
  intro: string;
  faq: Array<{ question: string; answer: string }>;
}

export function buildSectorHubSeo(
  locale: JobBoardLocale,
  sector: SectorHubKey,
  count: number,
  year: number,
): SectorHubSeoEntry {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  // `useFire`, the legacy emoji prefix, and the display label are no longer
  // used in the title/H1 (Phase 3A: title ≤60 char, no emoji prefix). Kept as
  // a no-op reference to silence "imported but unused" lints if any.
  void SECTOR_HUB_DISPLAY;
  void SECTOR_HUB_FIRE_THRESHOLD;
  const yearStr = String(year);

  switch (locale) {
    case 'it': {
      const nounMap: Record<SectorHubKey, string> = {
        infermieri: 'Infermieri',
        'case-anziani': 'Case Anziani',
        educatori: 'Educatori',
        ingegneri: 'Ingegneri',
        autisti: 'Autisti',
        sviluppatori: 'Sviluppatori Software',
        ristorazione: 'Ristorazione',
        oss: 'Operatori Socio-Sanitari',
        logistica: 'Logistica',
        apprendistato: 'Apprendistato',
      };
      const noun = nounMap[sector];
      // SEO title: keyword-first, ≤60 char (Semrush W2). No emoji prefix, no
      // " | Frontaliere Ticino" overflow. Brand suffix only when it fits.
      // Pass count as the structured `count` field (not as a free-form
       // qualifier) so the formatSeoTitle fallback ladder preserves it
       // when dropping optional fields. Without this, count gets stripped
       // along with qualifier on overflow and distinct sector × count
       // pairs collapse to identical titles, tripping the title-uniqueness
       // gate (sector hub regression caught 2026-04-27).
      const titleBase = formatSeoTitle({
        keyword: `Lavoro ${noun}`,
        location: 'Ticino',
        year: yearStr,
        count: safeCount > 0 ? safeCount : undefined,
      });
      const title = clampSiteSuffix(titleBase, 'Frontaliere Ticino');
      const desc = safeCount > 0
        ? `Trova ${safeCount} offerte di lavoro per ${noun.toLowerCase()} in Ticino, aggiornate ogni giorno. Candidati come frontaliere direttamente online, senza registrazione.`
        : `Trova offerte di lavoro per ${noun.toLowerCase()} in Ticino, aggiornate ogni giorno. Candidati come frontaliere direttamente online, senza registrazione.`;
      // H1: narrative ("990 posti vacanti nel settore Case Anziani in Ticino").
      // Never identical to the SEO title (Semrush W3, issue 105).
      const h1 = safeCount > 0
        ? `${safeCount} posti vacanti nel settore ${noun} in Ticino`
        : `Opportunità di lavoro per ${noun.toLowerCase()} in Ticino`;
      const intro = `Pagina dedicata alle opportunità di lavoro ${noun.toLowerCase()} in Ticino. Contiene solo annunci attivi, pubblicati da ospedali, case anziani, scuole e cooperative ticinesi. Ogni annuncio porta alla candidatura ufficiale dell'azienda.`;
      const faq = [
        {
          question: `Quanti posti di lavoro ci sono per ${noun.toLowerCase()} in Ticino?`,
          answer: safeCount > 0
            ? `Attualmente ci sono ${safeCount} offerte attive per ${noun.toLowerCase()} in Ticino. La lista è aggiornata più volte al giorno dai nostri crawler.`
            : `La lista è aggiornata più volte al giorno. Torna fra qualche ora per nuove offerte ${noun.toLowerCase()} in Ticino.`,
        },
        {
          question: 'Posso candidarmi come frontaliere?',
          answer: 'Sì, la maggior parte dei datori di lavoro in Ticino accetta candidature da lavoratori frontalieri con permesso G. Ogni annuncio indica i dettagli specifici.',
        },
        {
          question: 'Come avviene la candidatura?',
          answer: 'Cliccando su un annuncio ti portiamo direttamente al sito ufficiale del datore di lavoro, dove puoi candidarti senza passaggi intermedi e senza registrazione su Frontaliere Ticino.',
        },
      ];
      return { title, desc, ogT: titleBase, ogD: desc, h1, intro, faq };
    }
    case 'en': {
      const nounMap: Record<SectorHubKey, string> = {
        infermieri: 'Nurses',
        'case-anziani': 'Elderly Care',
        educatori: 'Educators',
        ingegneri: 'Engineers',
        autisti: 'Drivers',
        sviluppatori: 'Software Developers',
        ristorazione: 'Restaurants',
        oss: 'Healthcare Assistants',
        logistica: 'Logistics',
        apprendistato: 'Apprenticeships',
      };
      const noun = nounMap[sector];
      const titleBase = formatSeoTitle({
        keyword: `${noun} Jobs`,
        location: 'Ticino',
        year: yearStr,
        count: safeCount > 0 ? safeCount : undefined,
      });
      const title = clampSiteSuffix(titleBase, 'Frontaliere Ticino');
      const desc = safeCount > 0
        ? `Browse ${safeCount} ${noun.toLowerCase()} jobs in Ticino, Switzerland — updated every day. Apply online for free as a cross-border worker.`
        : `Browse ${noun.toLowerCase()} jobs in Ticino, Switzerland — updated every day. Apply online for free as a cross-border worker.`;
      const h1 = safeCount > 0
        ? `${safeCount} open positions for ${noun} in Ticino`
        : `Career opportunities for ${noun} in Ticino`;
      const intro = `A dedicated hub for ${noun.toLowerCase()} job opportunities in Ticino, Switzerland. Every listing links directly to the employer's official application page.`;
      const faq = [
        {
          question: `How many ${noun.toLowerCase()} jobs are there in Ticino?`,
          answer: safeCount > 0
            ? `There are currently ${safeCount} active ${noun.toLowerCase()} jobs in Ticino. The list refreshes multiple times per day.`
            : `The list refreshes multiple times per day. Check back soon for new ${noun.toLowerCase()} openings in Ticino.`,
        },
        {
          question: 'Can I apply as a cross-border worker?',
          answer: 'Yes. Most Ticino employers accept applications from EU cross-border workers with a G permit. Each listing specifies requirements.',
        },
        {
          question: 'How do I apply?',
          answer: 'Each listing links directly to the employer\'s official application page — no registration needed on Frontaliere Ticino.',
        },
      ];
      return { title, desc, ogT: titleBase, ogD: desc, h1, intro, faq };
    }
    case 'de': {
      const nounMap: Record<SectorHubKey, string> = {
        infermieri: 'Pflegepersonal',
        'case-anziani': 'Altenpflege',
        educatori: 'Erzieher',
        ingegneri: 'Ingenieure',
        autisti: 'Fahrer',
        sviluppatori: 'Softwareentwickler',
        ristorazione: 'Gastronomie',
        oss: 'Pflegeassistenten',
        logistica: 'Logistik',
        apprendistato: 'Lehrstellen',
      };
      const noun = nounMap[sector];
      const titleBase = formatSeoTitle({
        keyword: `Jobs ${noun}`,
        location: 'Tessin',
        year: yearStr,
        count: safeCount > 0 ? safeCount : undefined,
      });
      const title = clampSiteSuffix(titleBase, 'Frontaliere Ticino');
      const desc = safeCount > 0
        ? `Entdecke ${safeCount} Stellen für ${noun} im Tessin, täglich aktualisiert. Kostenlos online bewerben als Grenzgänger.`
        : `Entdecke Stellen für ${noun} im Tessin, täglich aktualisiert. Kostenlos online bewerben als Grenzgänger.`;
      const h1 = safeCount > 0
        ? `${safeCount} offene Stellen für ${noun} im Tessin`
        : `Karrierechancen für ${noun} im Tessin`;
      const intro = `Spezielle Seite für ${noun}-Stellenangebote im Tessin. Jede Anzeige führt direkt zur offiziellen Bewerbungsseite des Arbeitgebers.`;
      const faq = [
        {
          question: `Wie viele Stellen für ${noun} gibt es im Tessin?`,
          answer: safeCount > 0
            ? `Aktuell sind ${safeCount} aktive Stellen für ${noun} im Tessin verfügbar. Die Liste wird mehrmals täglich aktualisiert.`
            : `Die Liste wird mehrmals täglich aktualisiert. Schauen Sie bald wieder für neue Stellen vorbei.`,
        },
        {
          question: 'Kann ich mich als Grenzgänger bewerben?',
          answer: 'Ja, die meisten Tessiner Arbeitgeber akzeptieren Bewerbungen von Grenzgängern mit G-Bewilligung. Details stehen in jeder Anzeige.',
        },
        {
          question: 'Wie bewerbe ich mich?',
          answer: 'Jede Anzeige verlinkt direkt auf die offizielle Bewerbungsseite des Arbeitgebers — keine Registrierung erforderlich.',
        },
      ];
      return { title, desc, ogT: titleBase, ogD: desc, h1, intro, faq };
    }
    case 'fr': {
      const nounMap: Record<SectorHubKey, string> = {
        infermieri: 'Infirmiers',
        'case-anziani': 'Maisons de Retraite',
        educatori: 'Éducateurs',
        ingegneri: 'Ingénieurs',
        autisti: 'Chauffeurs',
        sviluppatori: 'Développeurs Logiciel',
        ristorazione: 'Restauration',
        oss: 'Aides-Soignants',
        logistica: 'Logistique',
        apprendistato: 'Apprentissages',
      };
      const noun = nounMap[sector];
      const titleBase = formatSeoTitle({
        keyword: `Emploi ${noun}`,
        location: 'Tessin',
        year: yearStr,
        count: safeCount > 0 ? safeCount : undefined,
      });
      const title = clampSiteSuffix(titleBase, 'Frontaliere Ticino');
      const desc = safeCount > 0
        ? `Parcourez ${safeCount} offres d'emploi pour ${noun.toLowerCase()} au Tessin, mises à jour chaque jour. Postulez gratuitement en ligne comme frontalier.`
        : `Parcourez les offres d'emploi pour ${noun.toLowerCase()} au Tessin, mises à jour chaque jour. Postulez gratuitement en ligne comme frontalier.`;
      const h1 = safeCount > 0
        ? `${safeCount} postes ouverts pour ${noun} au Tessin`
        : `Opportunités de carrière pour ${noun} au Tessin`;
      const intro = `Page dédiée aux offres d'emploi pour ${noun.toLowerCase()} au Tessin. Chaque annonce renvoie directement à la candidature officielle de l'employeur.`;
      const faq = [
        {
          question: `Combien d'offres pour ${noun.toLowerCase()} au Tessin ?`,
          answer: safeCount > 0
            ? `Il y a actuellement ${safeCount} offres actives pour ${noun.toLowerCase()} au Tessin. La liste est mise à jour plusieurs fois par jour.`
            : `La liste est mise à jour plusieurs fois par jour. Revenez bientôt pour de nouvelles offres.`,
        },
        {
          question: 'Puis-je postuler comme frontalier ?',
          answer: 'Oui, la plupart des employeurs du Tessin acceptent les candidatures de frontaliers avec permis G. Chaque annonce précise les conditions.',
        },
        {
          question: 'Comment postuler ?',
          answer: 'Chaque annonce renvoie directement à la page de candidature officielle de l\'employeur — sans inscription sur Frontaliere Ticino.',
        },
      ];
      return { title, desc, ogT: titleBase, ogD: desc, h1, intro, faq };
    }
  }
}

/** Helper used by the router for parsing path strings. */
export function isSectorHubSlug(locale: JobBoardLocale, slug: string): SectorHubKey | null {
  const table = SECTOR_HUB_SLUG[locale];
  for (const sector of SECTOR_HUB_KEYS) {
    if (table[sector] === slug) return sector;
  }
  return null;
}

// ── Sector prose (Phase 3B) ──────────────────────────────────────────
//
// A 200-400 word prose block injected in the body of every sector landing
// page (above the job list) to address Semrush issue 112 (low text/HTML
// ratio) and issue 117 (low word count). The prose lives in the data file
// `data/sector-descriptions.json` and is keyed by sector slug + locale.
// When a sector slug is missing from the JSON, a generic parametrized blob
// is rendered as fallback so every page hits the >=200 word floor.

export interface SectorProseLocale {
  intro: string;
  salaryRange: string;
  requirements: string;
  trend: string;
  topCities: readonly string[];
}

export interface SectorProseBlock {
  /** Final HTML string (already escaped, safe to inject). */
  html: string;
  /** Plain-text word count of the block's body. */
  wordCount: number;
  /** Whether the block came from the JSON data file (true) or fallback (false). */
  curated: boolean;
}

const SECTOR_PROSE_HEADINGS: Record<JobBoardLocale, {
  overview: string; salary: string; requirements: string; trend: string; topCities: string;
}> = {
  it: {
    overview: 'Panoramica del settore in Ticino',
    salary: 'Range salariale',
    requirements: 'Requisiti tipici',
    trend: 'Trend del mercato',
    topCities: 'Citta principali',
  },
  en: {
    overview: 'Sector overview in Ticino',
    salary: 'Salary range',
    requirements: 'Typical requirements',
    trend: 'Market trend',
    topCities: 'Top cities',
  },
  de: {
    overview: 'Sektoruebersicht im Tessin',
    salary: 'Gehaltsspanne',
    requirements: 'Typische Anforderungen',
    trend: 'Markttrend',
    topCities: 'Wichtigste Staedte',
  },
  fr: {
    overview: 'Apercu du secteur au Tessin',
    salary: 'Fourchette salariale',
    requirements: 'Exigences typiques',
    trend: 'Tendances du marche',
    topCities: 'Villes principales',
  },
};

function escSectorProse(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function countWords(s: string): number {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Build the prose block for a (sector, locale) pair using the supplied data
 * map (typically loaded from `data/sector-descriptions.json`). If no entry
 * exists, falls back to a generic parametrized blob whose word count still
 * lands in the 200-300 range. When a curated entry is present but shorter
 * than 200 words for a given locale, a standard frontaliere "context" tail
 * is appended so every emitted page clears the Semrush gate without
 * relying on per-locale hand-tuning.
 */
export function buildSectorProse(
  sectorKey: string,
  locale: JobBoardLocale,
  displayName: string,
  data: Record<string, Partial<Record<JobBoardLocale, SectorProseLocale>>> | null | undefined,
): SectorProseBlock {
  const entry = data && typeof data === 'object' ? data[sectorKey]?.[locale] : undefined;
  const headings = SECTOR_PROSE_HEADINGS[locale];

  if (entry && entry.intro && entry.salaryRange && entry.requirements && entry.trend) {
    const cities = (entry.topCities || []).slice(0, 5);
    const padded = padToMinWords(
      {
        intro: entry.intro,
        salaryRange: entry.salaryRange,
        requirements: entry.requirements,
        trend: entry.trend,
        topCities: cities,
      },
      locale,
      displayName,
      210,
    );
    const text = `${padded.intro} ${padded.salaryRange} ${padded.requirements} ${padded.trend} ${padded.topCities.join(', ')}`;
    const wordCount = countWords(text);
    const html = renderProseHtml({ headings, ...padded });
    return { html, wordCount, curated: true };
  }

  // Fallback — keep above 200 words by combining standard frontaliere talking points.
  const fallback = buildFallbackProse(displayName, locale);
  const text = `${fallback.intro} ${fallback.salaryRange} ${fallback.requirements} ${fallback.trend} ${fallback.topCities.join(', ')}`;
  const wordCount = countWords(text);
  const html = renderProseHtml({
    headings,
    intro: fallback.intro,
    salaryRange: fallback.salaryRange,
    requirements: fallback.requirements,
    trend: fallback.trend,
    topCities: fallback.topCities,
  });
  return { html, wordCount, curated: false };
}

const FRONTALIERE_CONTEXT_TAIL: Record<JobBoardLocale, string> = {
  it: "I lavoratori frontalieri italiani con permesso G possono accedere a queste opportunita applicando le regole del Nuovo Accordo fiscale 2026 tra Italia e Svizzera, con imposta alla fonte ridotta sui salari maturati nel Cantone e contribuzione AVS/LPP a carico del datore di lavoro elvetico. Il Cantone Ticino conta oltre 76.000 frontalieri attivi con permesso G provenienti soprattutto da Como, Varese, Lecco e Verbano-Cusio-Ossola, e il bacino di reclutamento per questo settore comprende anche piazze italiane confinanti come Luino, Porto Ceresio, Stabio confine, Chiasso e Brogeda.",
  en: "Italian cross-border workers with a G permit can take these jobs under the 2026 New Italy-Switzerland Tax Agreement: reduced withholding tax on Ticino-earned wages, with mandatory AVS/LPP social-security contributions paid by the Swiss employer. Ticino counts over 76,000 active G-permit cross-border workers, mostly from Como, Varese, Lecco and Verbano-Cusio-Ossola, and the recruiting catchment for this sector also includes nearby Italian towns such as Luino, Porto Ceresio, Stabio confine, Chiasso and Brogeda.",
  de: "Italienische Grenzgaenger mit G-Bewilligung koennen diese Stellen im Rahmen des Neuen Steuerabkommens Italien-Schweiz 2026 antreten: ermaessigte Quellensteuer auf im Tessin verdiente Loehne und obligatorische AHV/BVG-Beitraege durch den Schweizer Arbeitgeber. Der Kanton Tessin zaehlt ueber 76.000 aktive G-Grenzgaenger, vor allem aus Como, Varese, Lecco und Verbano-Cusio-Ossola; das Rekrutierungsgebiet fuer diesen Sektor umfasst auch grenznahe italienische Orte wie Luino, Porto Ceresio, Stabio confine, Chiasso und Brogeda.",
  fr: "Les frontaliers italiens avec permis G peuvent occuper ces postes dans le cadre du Nouvel Accord fiscal 2026 entre l'Italie et la Suisse: impot a la source reduit sur les salaires gagnes au Tessin et cotisations AVS/LPP obligatoires a la charge de l'employeur suisse. Le Canton du Tessin compte plus de 76.000 frontaliers G actifs, principalement venus de Como, Varese, Lecco et Verbano-Cusio-Ossola; le bassin de recrutement de ce secteur comprend aussi des localites italiennes proches comme Luino, Porto Ceresio, Stabio confine, Chiasso et Brogeda.",
};

function padToMinWords(
  block: { intro: string; salaryRange: string; requirements: string; trend: string; topCities: readonly string[] },
  locale: JobBoardLocale,
  displayName: string,
  minWords: number,
): { intro: string; salaryRange: string; requirements: string; trend: string; topCities: string[] } {
  void displayName;
  const intro = block.intro;
  const salaryRange = block.salaryRange;
  const requirements = block.requirements;
  const cities = [...block.topCities];
  let trend = block.trend;
  const fullText = () => `${intro} ${salaryRange} ${requirements} ${trend} ${cities.join(', ')}`;
  if (countWords(fullText()) >= minWords) {
    return { intro, salaryRange, requirements, trend, topCities: cities };
  }
  trend = `${trend} ${FRONTALIERE_CONTEXT_TAIL[locale]}`.trim();
  return { intro, salaryRange, requirements, trend, topCities: cities };
}

function renderProseHtml(p: {
  headings: { overview: string; salary: string; requirements: string; trend: string; topCities: string };
  intro: string;
  salaryRange: string;
  requirements: string;
  trend: string;
  topCities: readonly string[];
}): string {
  const cityChips = p.topCities.length > 0
    ? `<p style="margin:6px 0 0;color:var(--color-body);line-height:1.6"><strong>${escSectorProse(p.headings.topCities)}:</strong> ${escSectorProse(p.topCities.join(', '))}</p>`
    : '';
  return [
    `<section class="sector-intro" style="margin:0 0 28px;display:grid;gap:14px;color:var(--color-body)">`,
    `  <div><h2 style="margin:0 0 6px;font-size:20px;color:var(--color-heading)">${escSectorProse(p.headings.overview)}</h2><p style="margin:0;line-height:1.65">${escSectorProse(p.intro)}</p></div>`,
    `  <div><h3 style="margin:0 0 4px;font-size:16px;color:var(--color-heading)">${escSectorProse(p.headings.salary)}</h3><p style="margin:0;line-height:1.65">${escSectorProse(p.salaryRange)}</p></div>`,
    `  <div><h3 style="margin:0 0 4px;font-size:16px;color:var(--color-heading)">${escSectorProse(p.headings.requirements)}</h3><p style="margin:0;line-height:1.65">${escSectorProse(p.requirements)}</p></div>`,
    `  <div><h3 style="margin:0 0 4px;font-size:16px;color:var(--color-heading)">${escSectorProse(p.headings.trend)}</h3><p style="margin:0;line-height:1.65">${escSectorProse(p.trend)}</p>${cityChips}</div>`,
    `</section>`,
  ].join('\n');
}

function buildFallbackProse(displayName: string, locale: JobBoardLocale): SectorProseLocale {
  const cities = ['Lugano', 'Bellinzona', 'Mendrisio', 'Locarno', 'Chiasso'];
  const lname = displayName.toLowerCase();
  switch (locale) {
    case 'it':
      return {
        intro: `Il settore ${lname} in Ticino offre opportunita di lavoro stabili a frontalieri italiani con permesso G. Le aziende del Cantone assumono regolarmente per ruoli operativi, qualificati e di responsabilita, sia nel settore pubblico che privato. La domanda e alimentata dalla prossimita geografica con il bacino di manodopera lombardo, dalla qualita delle infrastrutture cantonali e dal contesto economico stabile della Confederazione.`,
        salaryRange: `Le retribuzioni nel settore ${lname} in Ticino sono mediamente piu alte del 30-50% rispetto all'Italia per profili equivalenti, con range che variano in base a esperienza, qualifica e responsabilita. Le condizioni contrattuali svizzere prevedono 13a mensilita, contributi obbligatori AVS/LPP e un sistema di imposta alla fonte agevolato per i frontalieri.`,
        requirements: `I requisiti tipici nel settore ${lname} includono titolo di studio coerente con la qualifica, esperienza pregressa di settore (variabile a seconda del ruolo) e ottima padronanza dell'italiano. La conoscenza di tedesco, francese o inglese e spesso valorizzata, in particolare per ruoli con clienti internazionali. Il riconoscimento dei titoli italiani e gestito dalle autorita cantonali competenti.`,
        trend: `Le assunzioni nel settore ${lname} in Ticino sono in crescita moderata o sostenuta a seconda della domanda di mercato. Il Cantone supporta l'integrazione dei lavoratori frontalieri tramite servizi di orientamento e accordi bilaterali Svizzera-UE che disciplinano la mobilita transfrontaliera.`,
        topCities: cities,
      };
    case 'en':
      return {
        intro: `The ${lname} sector in Ticino offers stable job opportunities for Italian cross-border workers with G permits. Local employers regularly hire for operational, qualified and supervisory roles in both public and private sectors. Demand is driven by geographic proximity to the Lombardy labour pool, the quality of cantonal infrastructure, and Switzerland's stable economic environment.`,
        salaryRange: `Salaries in the Ticino ${lname} sector are typically 30-50% higher than equivalent roles in Italy, with ranges varying by experience, qualification and responsibility. Swiss employment terms include a 13th-month bonus, mandatory AVS/LPP contributions and a favourable withholding-tax regime for cross-border workers.`,
        requirements: `Typical requirements in the ${lname} sector include sector-relevant qualifications, prior experience (varying by role), and strong Italian fluency. Knowledge of German, French or English is often valued, especially for client-facing positions. Italian credentials are recognized by competent cantonal authorities through standard equivalence procedures.`,
        trend: `Hiring in the Ticino ${lname} sector is growing moderately to strongly depending on market demand. The Canton supports cross-border-worker integration through orientation services and the Switzerland-EU bilateral agreements governing labour mobility.`,
        topCities: cities,
      };
    case 'de':
      return {
        intro: `Der Sektor ${lname} im Tessin bietet stabile Arbeitsmoeglichkeiten fuer italienische Grenzgaenger mit G-Bewilligung. Lokale Arbeitgeber stellen regelmaessig fuer operative, qualifizierte und Fuehrungspositionen ein, sowohl im oeffentlichen als auch im privaten Sektor. Die Nachfrage wird durch die geografische Naehe zum lombardischen Arbeitsmarkt, die Qualitaet der kantonalen Infrastruktur und das stabile wirtschaftliche Umfeld der Schweiz gestuetzt.`,
        salaryRange: `Die Gehaelter im Tessiner ${lname}-Sektor sind in der Regel 30-50% hoeher als bei vergleichbaren italienischen Stellen, mit Spannen je nach Erfahrung, Qualifikation und Verantwortung. Die Schweizer Anstellungsbedingungen umfassen 13. Monatsgehalt, obligatorische AHV/BVG-Beitraege und ein guenstiges Quellensteuerregime fuer Grenzgaenger.`,
        requirements: `Typische Anforderungen im Sektor ${lname} sind sektor-relevante Qualifikationen, bisherige Berufserfahrung (je nach Rolle) und gute Italienischkenntnisse. Deutsch-, Franzoesisch- oder Englischkenntnisse sind oft willkommen, besonders bei kundenorientierten Funktionen. Italienische Diplome werden ueber Standard-Anerkennungsverfahren der zustaendigen kantonalen Behoerden anerkannt.`,
        trend: `Die Einstellungen im Tessiner Sektor ${lname} wachsen je nach Nachfrage moderat bis stark. Der Kanton unterstuetzt die Integration von Grenzgaengern durch Beratungsdienste und die Schweiz-EU-Bilateralen, die die grenzueberschreitende Arbeitsmobilitaet regeln.`,
        topCities: cities,
      };
    case 'fr':
    default:
      return {
        intro: `Le secteur ${lname} au Tessin offre des emplois stables aux frontaliers italiens avec permis G. Les employeurs locaux recrutent regulierement pour des postes operationnels, qualifies et d'encadrement, dans le secteur public comme prive. La demande est alimentee par la proximite geographique avec le bassin de main-d'oeuvre lombard, la qualite des infrastructures cantonales et un environnement economique stable.`,
        salaryRange: `Les salaires du secteur ${lname} au Tessin sont en moyenne 30-50% plus eleves que pour des postes equivalents en Italie, avec des fourchettes variant selon l'experience, la qualification et le niveau de responsabilite. Les conditions suisses incluent un 13e salaire, des cotisations obligatoires AVS/LPP et un regime d'impot a la source avantageux pour les frontaliers.`,
        requirements: `Les exigences typiques dans le secteur ${lname} comprennent un titre adapte a la qualification, une experience prealable du secteur (variable selon le poste) et une excellente maitrise de l'italien. L'allemand, le francais ou l'anglais sont souvent apprecies, en particulier pour les fonctions tournees vers la clientele. Les diplomes italiens sont reconnus par les autorites cantonales competentes via des procedures d'equivalence standard.`,
        trend: `Les recrutements dans le secteur ${lname} au Tessin progressent moderement ou fortement selon la demande du marche. Le Canton soutient l'integration des frontaliers via des services d'orientation et les accords bilateraux Suisse-UE qui regissent la mobilite transfrontaliere.`,
        topCities: cities,
      };
  }
}

export type SectorProseDataMap = Record<string, Partial<Record<JobBoardLocale, SectorProseLocale>>>;

/** Synchronously load `data/sector-descriptions.json`. Returns `{}` on failure. */
export function loadSectorProseData(rootDir: string): SectorProseDataMap {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs: typeof import('node:fs') = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path: typeof import('node:path') = require('node:path');
    const filePath = path.resolve(rootDir, 'data/sector-descriptions.json');
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    // Drop the `_meta` key — never a sector entry.
    const out: SectorProseDataMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k === '_meta') continue;
      if (v && typeof v === 'object') out[k] = v as SectorProseDataMap[string];
    }
    return out;
  } catch {
    return {};
  }
}
