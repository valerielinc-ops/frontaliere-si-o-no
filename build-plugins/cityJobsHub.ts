/**
 * Geo-hub definitions for the top Ticino cities: Lugano, Mendrisio, Bellinzona.
 *
 * These pages live at clean, SEO-friendly URLs like `/cerca-lavoro-ticino/lugano/`
 * (one per locale). They reuse the existing editorial "location landing" model
 * (kind: 'location') but are exposed via a canonical clean slug so Google treats
 * them as the primary target for high-intent geo queries ("lavoro lugano",
 * "offerte di lavoro mendrisio", etc.).
 *
 * The older `/cerca-lavoro-ticino/ricerca-lugano/` landings continue to exist
 * for backward compatibility but emit `<link rel="canonical">` pointing at the
 * clean URL to resolve GSC cannibalization.
 */

import type { JobBoardLocale } from './jobBoardSeo';
import { buildCityHubTitle } from '../services/seo/job-board-titles';
import { buildCityHubMeta } from '../services/seo/meta-descriptions';

export type CityHubKey = 'lugano' | 'mendrisio' | 'bellinzona';

export const CITY_HUB_KEYS: readonly CityHubKey[] = ['lugano', 'mendrisio', 'bellinzona'] as const;

/** Display name for each city (used in breadcrumbs and headings). */
export const CITY_HUB_DISPLAY_NAME: Record<CityHubKey, string> = {
  lugano: 'Lugano',
  mendrisio: 'Mendrisio',
  bellinzona: 'Bellinzona',
};

/** Per-locale URL slug for each city. Italian-friendly proper nouns — same across locales. */
export const CITY_HUB_SLUG: Record<JobBoardLocale, Record<CityHubKey, string>> = {
  it: { lugano: 'lugano', mendrisio: 'mendrisio', bellinzona: 'bellinzona' },
  en: { lugano: 'lugano', mendrisio: 'mendrisio', bellinzona: 'bellinzona' },
  de: { lugano: 'lugano', mendrisio: 'mendrisio', bellinzona: 'bellinzona' },
  fr: { lugano: 'lugano', mendrisio: 'mendrisio', bellinzona: 'bellinzona' },
};

/** Section root slug per locale (same as job-board landing). */
export const CITY_HUB_SECTION: Record<JobBoardLocale, string> = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

export const CITY_HUB_LOCALE_PREFIX: Record<JobBoardLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

export interface CityHubPath {
  locale: JobBoardLocale;
  city: CityHubKey;
  /** Canonical URL path, always with trailing slash, e.g. "/cerca-lavoro-ticino/lugano/". */
  path: string;
}

/**
 * Return the canonical path for a given locale+city.
 * Always ends with a trailing slash.
 */
export function buildCityHubPath(locale: JobBoardLocale, city: CityHubKey): string {
  const prefix = CITY_HUB_LOCALE_PREFIX[locale];
  const section = CITY_HUB_SECTION[locale];
  const slug = CITY_HUB_SLUG[locale][city];
  return `${prefix}/${section}/${slug}/`.replace(/\/+/g, '/');
}

/**
 * Return all 12 city-hub paths (3 cities × 4 locales).
 */
export function allCityHubPaths(): CityHubPath[] {
  const out: CityHubPath[] = [];
  for (const locale of ['it', 'en', 'de', 'fr'] as JobBoardLocale[]) {
    for (const city of CITY_HUB_KEYS) {
      out.push({ locale, city, path: buildCityHubPath(locale, city) });
    }
  }
  return out;
}

/**
 * Parse a city from a URL path if it matches one of the canonical city-hub
 * paths (in any locale). Returns `null` when the path does not match.
 */
export function parseCityHubPath(urlPath: string): { locale: JobBoardLocale; city: CityHubKey } | null {
  if (!urlPath) return null;
  const withSlash = urlPath.endsWith('/') ? urlPath : `${urlPath}/`;
  for (const locale of ['it', 'en', 'de', 'fr'] as JobBoardLocale[]) {
    for (const city of CITY_HUB_KEYS) {
      if (withSlash === buildCityHubPath(locale, city)) {
        return { locale, city };
      }
    }
  }
  return null;
}

export interface CityHubSeoEntry {
  title: string;
  desc: string;
  ogT: string;
  ogD: string;
  /** H1 used on the page body. */
  h1: string;
}

export const CITY_HUB_FIRE_THRESHOLD = 30;

/**
 * Build locale-aware, count-aware SEO copy for a city hub page.
 *
 * Mirrors the pattern of {@link buildJobBoardSeo} — inserts a live job count
 * and a 🔥 emoji above {@link CITY_HUB_FIRE_THRESHOLD} to boost CTR on
 * high-intent queries like "lavoro lugano".
 */
export function buildCityHubSeo(
  locale: JobBoardLocale,
  city: CityHubKey,
  count: number,
  year: number,
): CityHubSeoEntry {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const useFire = safeCount >= CITY_HUB_FIRE_THRESHOLD;
  const prefix = safeCount > 0 ? (useFire ? `🔥 ${safeCount} ` : `${safeCount} `) : '';
  const name = CITY_HUB_DISPLAY_NAME[city];
  // F3a — short <title> comes from the shared module (50-60 visible chars).
  // OG title + H1 keep the verbose legacy copy (unconstrained length).
  const title = buildCityHubTitle({
    locale,
    cityDisplay: name,
    count: safeCount,
    year,
    fireThreshold: CITY_HUB_FIRE_THRESHOLD,
  });
  const desc = buildCityHubMeta({ locale, cityDisplay: name, count: safeCount });

  switch (locale) {
    case 'it': {
      const ogT = `${prefix}Offerte di Lavoro ${name} ${year} | Aggiornate Oggi`;
      const h1 = safeCount > 0 ? `${safeCount} Offerte di Lavoro a ${name}` : `Offerte di Lavoro a ${name}`;
      return { title, desc, ogT, ogD: desc, h1 };
    }
    case 'en': {
      const ogT = `${prefix}Jobs in ${name} ${year} | Updated Daily`;
      const h1 = safeCount > 0 ? `${safeCount} Jobs in ${name}` : `Jobs in ${name}`;
      return { title, desc, ogT, ogD: desc, h1 };
    }
    case 'de': {
      const ogT = `${prefix}Jobs in ${name} ${year} | Täglich Aktualisiert`;
      const h1 = safeCount > 0 ? `${safeCount} Jobs in ${name}` : `Jobs in ${name}`;
      return { title, desc, ogT, ogD: desc, h1 };
    }
    case 'fr': {
      const ogT = `${prefix}Emploi à ${name} ${year} | Mises à Jour Quotidiennes`;
      const h1 = safeCount > 0 ? `${safeCount} Offres d'emploi à ${name}` : `Offres d'emploi à ${name}`;
      return { title, desc, ogT, ogD: desc, h1 };
    }
  }
}

/**
 * Count active jobs for a specific city. Matches jobs where `location` or
 * `addressLocality` contains the city name (case-insensitive). Uses the same
 * activity filter as {@link isJobActiveForLocale} from `jobBoardSeo.ts`.
 */
export interface CityCountableJob {
  location?: string;
  addressLocality?: string;
  expired?: boolean;
  needsRetranslation?: boolean | Partial<Record<JobBoardLocale, boolean>>;
  description?: string;
  descriptionByLocale?: Partial<Record<JobBoardLocale, string>>;
}

function wordCount(s: string | undefined | null): number {
  if (!s) return 0;
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

function jobIsActive(job: CityCountableJob, locale: JobBoardLocale): boolean {
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
 * Returns true when the job's location matches the given city.
 * Case-insensitive; matches either `addressLocality` or `location`.
 * A city like "Lugano" matches "Lugano", "LUGANO", "Lugano-Paradiso",
 * "Paradiso (Lugano)", etc.
 */
export function jobMatchesCity(job: CityCountableJob, city: CityHubKey): boolean {
  const needle = CITY_HUB_DISPLAY_NAME[city].toLowerCase();
  const candidates = [job.addressLocality, job.location]
    .map((v) => (typeof v === 'string' ? v.toLowerCase() : ''))
    .filter(Boolean);
  return candidates.some((c) => c.includes(needle));
}

/**
 * Count active jobs per (locale, city). Returns a 4 × 3 matrix.
 */
export function countCityJobsByLocale(
  jobs: readonly CityCountableJob[],
): Record<JobBoardLocale, Record<CityHubKey, number>> {
  const empty: Record<CityHubKey, number> = { lugano: 0, mendrisio: 0, bellinzona: 0 };
  const counts: Record<JobBoardLocale, Record<CityHubKey, number>> = {
    it: { ...empty },
    en: { ...empty },
    de: { ...empty },
    fr: { ...empty },
  };
  if (!Array.isArray(jobs)) return counts;
  for (const job of jobs) {
    for (const locale of ['it', 'en', 'de', 'fr'] as JobBoardLocale[]) {
      if (!jobIsActive(job, locale)) continue;
      for (const city of CITY_HUB_KEYS) {
        if (jobMatchesCity(job, city)) counts[locale][city]++;
      }
    }
  }
  return counts;
}
