/**
 * Dynamic SEO copy for the main job board landing pages.
 *
 * Generates title and description variants that include a live job count
 * computed at build time from `data/jobs.json`. A count ≥ FIRE_EMOJI_THRESHOLD
 * adds a 🔥 emoji to signal freshness and boost CTR on high-impression queries
 * like "offerte di lavoro ticino".
 *
 * Kept as a standalone module so the logic is easily unit-tested without
 * booting Vite plugins.
 */

import fs from 'node:fs'
import path from 'node:path'

export type JobBoardLocale = 'it' | 'en' | 'de' | 'fr'

export interface JobBoardSeoEntry {
  title: string
  desc: string
  ogT: string
  ogD: string
}

export const FIRE_EMOJI_THRESHOLD = 500

export const JOB_BOARD_LANDING_PATHS: Record<JobBoardLocale, string> = {
  it: '/cerca-lavoro-ticino/',
  en: '/en/find-jobs-ticino/',
  de: '/de/jobs-im-tessin/',
  fr: '/fr/trouver-emploi-tessin/',
}

const LANDING_PATH_SET = new Set<string>(Object.values(JOB_BOARD_LANDING_PATHS))

/**
 * Returns true when `urlPath` matches one of the main job-board landings
 * across all 4 locales (with or without trailing slash).
 */
export function isJobBoardLandingPath(urlPath: string): boolean {
  if (!urlPath) return false
  const withSlash = urlPath.endsWith('/') ? urlPath : `${urlPath}/`
  return LANDING_PATH_SET.has(withSlash)
}

interface RawJob {
  expired?: boolean
  needsRetranslation?: boolean | Partial<Record<JobBoardLocale, boolean>>
  description?: string
  descriptionByLocale?: Partial<Record<JobBoardLocale, string>>
}

/**
 * Count words in a description string. Trims and splits on whitespace.
 */
function wordCount(s: string | undefined | null): number {
  if (!s) return 0
  return String(s).trim().split(/\s+/).filter(Boolean).length
}

/**
 * Decide whether a job should be counted as "active" for the given locale.
 * Filter rules:
 *   - not expired
 *   - not needsRetranslation (globally or per-locale)
 *   - has a description with ≥ 50 words in the target locale
 *     (IT falls back to the top-level `description` when descriptionByLocale.it
 *     is missing)
 */
export function isJobActiveForLocale(job: RawJob, locale: JobBoardLocale): boolean {
  if (!job || typeof job !== 'object') return false
  if (job.expired) return false

  const nr = job.needsRetranslation
  if (nr === true) return false
  if (nr && typeof nr === 'object' && nr[locale]) return false

  const localeDesc = job.descriptionByLocale?.[locale]
  const fallback = locale === 'it' ? job.description : undefined
  const desc = localeDesc && localeDesc.trim().length > 0 ? localeDesc : fallback
  return wordCount(desc) >= 50
}

/**
 * Count active jobs for each locale from a list of raw job records.
 */
export function countActiveJobsByLocale(
  jobs: readonly RawJob[],
): Record<JobBoardLocale, number> {
  const counts: Record<JobBoardLocale, number> = { it: 0, en: 0, de: 0, fr: 0 }
  if (!Array.isArray(jobs)) return counts
  for (const job of jobs) {
    for (const locale of Object.keys(counts) as JobBoardLocale[]) {
      if (isJobActiveForLocale(job, locale)) counts[locale]++
    }
  }
  return counts
}

/**
 * Read `data/jobs.json` from `rootDir` and compute per-locale active counts.
 * Returns zero counts if the file is missing or malformed — callers should
 * treat zeros as "skip dynamic override".
 */
export function getActiveJobCountsByLocale(
  rootDir: string,
): Record<JobBoardLocale, number> {
  const file = path.resolve(rootDir, 'data/jobs.json')
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return { it: 0, en: 0, de: 0, fr: 0 }
    return countActiveJobsByLocale(parsed as RawJob[])
  } catch {
    return { it: 0, en: 0, de: 0, fr: 0 }
  }
}

/**
 * Build title + description metadata for a job-board landing page.
 *
 * `count` is the number of active jobs for the locale. `year` is usually
 * `new Date().getFullYear()` — passed in so callers stay deterministic
 * across a single build.
 */
export function buildJobBoardSeo(
  locale: JobBoardLocale,
  count: number,
  year: number,
): JobBoardSeoEntry {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  const useFire = safeCount >= FIRE_EMOJI_THRESHOLD
  const prefix = safeCount > 0 ? (useFire ? `🔥 ${safeCount} ` : `${safeCount} `) : ''

  switch (locale) {
    case 'it': {
      const title = `${prefix}Offerte di Lavoro Ticino ${year} — Aggiornate Oggi | Frontaliere Ticino`
      const desc = safeCount > 0
        ? `Cerca tra ${safeCount} offerte di lavoro in Ticino aggiornate ogni giorno: case anziani, EOC, Lidl, Aldi, scuole. Candidati gratuitamente online.`
        : `Cerca offerte di lavoro in Ticino aggiornate ogni giorno: case anziani, EOC, Lidl, Aldi, scuole. Candidati gratuitamente online.`
      const ogT = `${prefix}Offerte di Lavoro Ticino ${year} | Aggiornate Oggi`
      return { title, desc, ogT, ogD: desc }
    }
    case 'en': {
      const title = `${prefix}Jobs in Ticino ${year} — Updated Daily | Frontaliere Ticino`
      const desc = safeCount > 0
        ? `Browse ${safeCount} jobs in Ticino, Switzerland updated every day: healthcare, EOC, Lidl, Aldi, schools. Apply online for free.`
        : `Browse jobs in Ticino, Switzerland updated every day: healthcare, EOC, Lidl, Aldi, schools. Apply online for free.`
      const ogT = `${prefix}Jobs in Ticino ${year} | Updated Daily`
      return { title, desc, ogT, ogD: desc }
    }
    case 'de': {
      const title = `${prefix}Jobs im Tessin ${year} — Täglich Aktualisiert | Frontaliere Ticino`
      const desc = safeCount > 0
        ? `Entdecke ${safeCount} Stellenangebote im Tessin, täglich aktualisiert: Pflege, EOC, Lidl, Aldi, Schulen. Kostenlos online bewerben.`
        : `Entdecke Stellenangebote im Tessin, täglich aktualisiert: Pflege, EOC, Lidl, Aldi, Schulen. Kostenlos online bewerben.`
      const ogT = `${prefix}Jobs im Tessin ${year} | Täglich Aktualisiert`
      return { title, desc, ogT, ogD: desc }
    }
    case 'fr': {
      const title = `${prefix}Emploi au Tessin ${year} — Mises à Jour Quotidiennes | Frontaliere Ticino`
      const desc = safeCount > 0
        ? `Parcourez ${safeCount} offres d'emploi au Tessin mises à jour chaque jour : santé, EOC, Lidl, Aldi, écoles. Postulez gratuitement en ligne.`
        : `Parcourez les offres d'emploi au Tessin mises à jour chaque jour : santé, EOC, Lidl, Aldi, écoles. Postulez gratuitement en ligne.`
      const ogT = `${prefix}Emploi au Tessin ${year} | Mises à Jour Quotidiennes`
      return { title, desc, ogT, ogD: desc }
    }
  }
}
