/**
 * Dynamic SEO copy for the main job board landing pages.
 *
 * Generates title and description variants that include a live job count
 * computed at build time from `data/jobs.json`. A count ≥ FIRE_EMOJI_THRESHOLD
 * adds a 🔥 emoji to signal freshness and boost CTR on high-impression queries
 * like "offerte di lavoro ticino".
 *
 * F3a — Job Page CTR Optimization (2026-04-20): the primary `title` is now
 * delegated to the shared `services/seo/job-board-titles.ts` module so the
 * listing hub, per-city, per-role and recency pages all share the same
 * 50-60 char CTR-optimized template (see LIN-XXXX). The verbose
 * "| Frontaliere Ticino" brand suffix stays on `ogT` (Open Graph title)
 * where length is unconstrained — only the `<title>` tag was driving the
 * SERP CTR drag.
 *
 * Kept as a standalone module so the logic is easily unit-tested without
 * booting Vite plugins.
 */

import fs from 'node:fs'
import path from 'node:path'
import { buildListingHubTitle } from '../services/seo/job-board-titles'
import { buildListingHubMeta } from '../services/seo/meta-descriptions'

export type JobBoardLocale = 'it' | 'en' | 'de' | 'fr'

export interface JobBoardSeoEntry {
  title: string
  desc: string
  ogT: string
  ogD: string
}

export const FIRE_EMOJI_THRESHOLD = 500

// Per-locale legacy TI landing paths — kept as exports for callers that need
// the explicit TI URL string (e.g. canonical builders, redirect maps).
export const JOB_BOARD_LANDING_PATHS: Record<JobBoardLocale, string> = {
  it: '/cerca-lavoro-ticino/',
  en: '/en/find-jobs-ticino/',
  de: '/de/jobs-im-tessin/',
  fr: '/fr/trouver-emploi-tessin/',
}

/**
 * Predicate: does this URL path match a job-board landing for any canton
 * (TI legacy + 25 cathedral cantons + Switzerland aggregator)?
 *
 * Matches (with or without trailing slash):
 *   /cerca-lavoro-ticino/, /cerca-lavoro-zurigo/, /cerca-lavoro-svizzera/
 *   /en/find-jobs-ticino/, /en/find-jobs-zurich/, /en/find-jobs-switzerland/
 *   /de/jobs-im-tessin/, /de/jobs-in-zurich/, /de/jobs-in-der-waadt/, /de/jobs-in-schweiz/
 *   /fr/trouver-emploi-tessin/, /fr/trouver-emploi-zurich/, /fr/trouver-emploi-suisse/
 *
 * Does NOT match sub-pages like /cerca-lavoro-ticino/lugano/ or
 * /cerca-lavoro-ticino/azienda-foo/.
 *
 * Regex ordering note (P2-C): JS regex left-to-right alternation matches
 * greedily on the first hit, so the LONGEST prefix MUST come first.
 *   jobs-in-der > jobs-in > jobs-im
 * This ensures `/de/jobs-in-der-waadt/` matches the `jobs-in-der` branch
 * (not `jobs-in`), and `/de/jobs-in-zurich/` matches `jobs-in` (not
 * partially matching `jobs-im`).
 */
const CANTON_LANDING_RE =
  /^\/(?:(?:it|en|de|fr)\/)?(?:cerca-lavoro|find-jobs|jobs-in-der|jobs-in|jobs-im|trouver-emploi)-[a-z-]+\/?$/

/**
 * Returns true when `urlPath` matches one of the main job-board landings
 * across all 4 locales and every canton + aggregator URL (with or without
 * trailing slash). See `CANTON_LANDING_RE` for the canonical regex.
 */
export function isJobBoardLandingPath(urlPath: string): boolean {
  if (!urlPath) return false
  return CANTON_LANDING_RE.test(urlPath)
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
  // The short `<title>` is delegated to the shared module so per-city / per-role
  // pages share the same template. The OG title keeps the legacy "| Frontaliere
  // Ticino" brand suffix because OG renderers don't truncate at 60 chars.
  const title = buildListingHubTitle({ locale, count: safeCount, year })
  const desc = buildListingHubMeta({ locale, count: safeCount })
  const ogPrefix = safeCount > 0 ? (useFire ? `🔥 ${safeCount} ` : `${safeCount} `) : ''

  switch (locale) {
    case 'it': {
      const ogT = `${ogPrefix}Offerte di Lavoro Ticino ${year} | Aggiornate Oggi`
      return { title, desc, ogT, ogD: desc }
    }
    case 'en': {
      const ogT = `${ogPrefix}Jobs in Ticino ${year} | Updated Daily`
      return { title, desc, ogT, ogD: desc }
    }
    case 'de': {
      const ogT = `${ogPrefix}Jobs im Tessin ${year} | Täglich Aktualisiert`
      return { title, desc, ogT, ogD: desc }
    }
    case 'fr': {
      const ogT = `${ogPrefix}Emploi au Tessin ${year} | Mises à Jour Quotidiennes`
      return { title, desc, ogT, ogD: desc }
    }
  }
}
