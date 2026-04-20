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

export type SectorHubKey = 'infermieri' | 'case-anziani' | 'educatori';

export const SECTOR_HUB_KEYS: readonly SectorHubKey[] = [
  'infermieri',
  'case-anziani',
  'educatori',
] as const;

/** Per-locale URL slug for each sector. Query-matching, short. */
export const SECTOR_HUB_SLUG: Record<JobBoardLocale, Record<SectorHubKey, string>> = {
  it: { infermieri: 'infermieri', 'case-anziani': 'case-anziani', educatori: 'educatori' },
  en: { infermieri: 'nurses', 'case-anziani': 'elderly-care', educatori: 'educators' },
  de: { infermieri: 'pflegepersonal', 'case-anziani': 'altenpflege', educatori: 'erzieher' },
  fr: { infermieri: 'infirmiers', 'case-anziani': 'maisons-retraite', educatori: 'educateurs' },
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
  it: { infermieri: 'Infermieri', 'case-anziani': 'Case Anziani', educatori: 'Educatori' },
  en: { infermieri: 'Nurses', 'case-anziani': 'Elderly Care', educatori: 'Educators' },
  de: { infermieri: 'Pflegepersonal', 'case-anziani': 'Altenpflege', educatori: 'Erzieher' },
  fr: { infermieri: 'Infirmiers', 'case-anziani': 'Maisons de Retraite', educatori: 'Éducateurs' },
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
  'case-anziani':
    /casa[ -]anzian|case[ -]anzian|oscam|pregassona|altenpfleg|altersheim|pflegeheim|residenza[ -]per[ -]anzian|residenza[ -]anzian|elderly[ -]care|nursing[ -]home|maison[ -]de[ -]retraite|ehpad|ris\b|lis\b/i,
  educatori:
    /educator|educatric|educatrice|educatori|erzieher|erzieherin|p[aä]dagog|social[ -]pedagog|[eé]ducateur|[eé]ducatrice|educational[ -]assistant|operatore[ -]socio[ -]educativ/i,
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

/** Count active jobs by (locale, sector). Returns a 4 × 3 matrix. */
export function countSectorJobsByLocale(
  jobs: readonly SectorCountableJob[],
): Record<JobBoardLocale, Record<SectorHubKey, number>> {
  const empty = (): Record<SectorHubKey, number> => ({
    infermieri: 0,
    'case-anziani': 0,
    educatori: 0,
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
  const useFire = safeCount >= SECTOR_HUB_FIRE_THRESHOLD;
  const prefix = safeCount > 0 ? (useFire ? `🔥 ${safeCount} ` : `${safeCount} `) : '';
  const display = SECTOR_HUB_DISPLAY[locale][sector];

  switch (locale) {
    case 'it': {
      const nounMap: Record<SectorHubKey, string> = {
        infermieri: 'Infermieri',
        'case-anziani': 'Case Anziani',
        educatori: 'Educatori',
      };
      const noun = nounMap[sector];
      const title = `${prefix}Offerte di Lavoro ${noun} Ticino ${year} — Aggiornate Oggi | Frontaliere Ticino`;
      const desc = safeCount > 0
        ? `Trova ${safeCount} offerte di lavoro per ${noun.toLowerCase()} in Ticino, aggiornate ogni giorno. Candidati come frontaliere direttamente online, senza registrazione.`
        : `Trova offerte di lavoro per ${noun.toLowerCase()} in Ticino, aggiornate ogni giorno. Candidati come frontaliere direttamente online, senza registrazione.`;
      const h1 = safeCount > 0 ? `${safeCount} Offerte di Lavoro ${noun} in Ticino` : `Offerte di Lavoro ${noun} in Ticino`;
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
      return { title, desc, ogT: `${prefix}Offerte di Lavoro ${noun} Ticino ${year} | Aggiornate Oggi`, ogD: desc, h1, intro, faq };
    }
    case 'en': {
      const nounMap: Record<SectorHubKey, string> = {
        infermieri: 'Nurses',
        'case-anziani': 'Elderly Care',
        educatori: 'Educators',
      };
      const noun = nounMap[sector];
      const title = `${prefix}${noun} Jobs in Ticino ${year} — Updated Daily | Frontaliere Ticino`;
      const desc = safeCount > 0
        ? `Browse ${safeCount} ${noun.toLowerCase()} jobs in Ticino, Switzerland — updated every day. Apply online for free as a cross-border worker.`
        : `Browse ${noun.toLowerCase()} jobs in Ticino, Switzerland — updated every day. Apply online for free as a cross-border worker.`;
      const h1 = safeCount > 0 ? `${safeCount} ${noun} Jobs in Ticino` : `${noun} Jobs in Ticino`;
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
      return { title, desc, ogT: `${prefix}${noun} Jobs in Ticino ${year} | Updated Daily`, ogD: desc, h1, intro, faq };
    }
    case 'de': {
      const nounMap: Record<SectorHubKey, string> = {
        infermieri: 'Pflegepersonal',
        'case-anziani': 'Altenpflege',
        educatori: 'Erzieher',
      };
      const noun = nounMap[sector];
      const title = `${prefix}Jobs ${noun} Tessin ${year} — Täglich Aktualisiert | Frontaliere Ticino`;
      const desc = safeCount > 0
        ? `Entdecke ${safeCount} Stellen für ${noun} im Tessin, täglich aktualisiert. Kostenlos online bewerben als Grenzgänger.`
        : `Entdecke Stellen für ${noun} im Tessin, täglich aktualisiert. Kostenlos online bewerben als Grenzgänger.`;
      const h1 = safeCount > 0 ? `${safeCount} Stellen ${noun} im Tessin` : `Stellen ${noun} im Tessin`;
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
      return { title, desc, ogT: `${prefix}Jobs ${noun} Tessin ${year} | Täglich Aktualisiert`, ogD: desc, h1, intro, faq };
    }
    case 'fr': {
      const nounMap: Record<SectorHubKey, string> = {
        infermieri: 'Infirmiers',
        'case-anziani': 'Maisons de Retraite',
        educatori: 'Éducateurs',
      };
      const noun = nounMap[sector];
      const title = `${prefix}Emploi ${noun} Tessin ${year} — Mises à Jour Quotidiennes | Frontaliere Ticino`;
      const desc = safeCount > 0
        ? `Parcourez ${safeCount} offres d'emploi pour ${noun.toLowerCase()} au Tessin, mises à jour chaque jour. Postulez gratuitement en ligne comme frontalier.`
        : `Parcourez les offres d'emploi pour ${noun.toLowerCase()} au Tessin, mises à jour chaque jour. Postulez gratuitement en ligne comme frontalier.`;
      const h1 = safeCount > 0 ? `${safeCount} Offres d'emploi ${noun} au Tessin` : `Offres d'emploi ${noun} au Tessin`;
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
      return { title, desc, ogT: `${prefix}Emploi ${noun} Tessin ${year} | Mises à Jour Quotidiennes`, ogD: desc, h1, intro, faq };
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
