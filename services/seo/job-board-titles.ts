/**
 * SEO title templates for job-board listing pages (F3a — Job Page CTR
 * Optimization).
 *
 * Returns short, CTR-optimized title tags in the 50-60 visible-character
 * range recommended by Google for SERP rendering. Patterns:
 *
 *   - Listing hub (home):    "Offerte di lavoro Ticino 2026 — {N} posti aggiornati oggi 🔥"
 *   - Per-city:              "Lavoro {City} 2026 — {N} offerte aggiornate ogni giorno"
 *   - Per-role:              "{Role} Ticino 2026 — {N} offerte | Candidati oggi"
 *   - Employer hub:          "Lavorare da {Company} in Svizzera 2026 — {N} posizioni aperte"
 *                            (issue #4306: job-intent framing, never a canton
 *                            name — the old "{Company} Offerte Lavoro Ticino"
 *                            copy hardcoded "Ticino"/"Tessin" even on
 *                            non-TI per-canton/per-city employer hubs, e.g.
 *                            a Basel-scoped JYSK page titled "... Ticino
 *                            2026". "in Svizzera"/"in Switzerland" is
 *                            canton-agnostic by construction so every
 *                            caller — TI-only, per-canton, per-canton-city
 *                            (build-plugins/jobsSeoPagesPlugin.ts) — is
 *                            correct. Scoped callers pass the real canton
 *                            or city through `location`, which the builder
 *                            preserves before applying its length cap.
 *   - Recency (last N days): "Offerte Lavoro Ticino Ultimi {N} Giorni — {M} Nuove 2026"
 *
 * Each function takes a numeric live-job count read from `data/jobs.json`
 * at build time and returns a title string. A 🔥 emoji is injected above
 * {@link FIRE_EMOJI_THRESHOLD} to boost CTR on high-impression queries.
 *
 * All outputs are validated at 50-60 code-points (see
 * {@link isValidTitleLength}). If a particular input combination falls
 * below 50, the helper augments the suffix with an extra qualifier so the
 * visible length stays within range. If a combination exceeds 60, the
 * helper switches to a shorter suffix variant.
 *
 * Visible length is measured via `[...s].length` (code points) because
 * Google counts visible characters, not UTF-16 code units.
 */

import { peelDanglingClauseTail } from '../../build-plugins/shared/clauseTail.mjs';
import { buildTitleWithBrand, stableTitleToken } from '../../build-plugins/shared/titleSuffix';

export type JobPageLocale = 'it' | 'en' | 'de' | 'fr';

export const JOB_PAGE_LOCALES: readonly JobPageLocale[] = ['it', 'en', 'de', 'fr'] as const;

/** Minimum visible title length (Google SERP truncation floor). */
export const TITLE_MIN_CHARS = 50;
/**
 * Maximum visible title length. Aligned with the universal title rule in
 * build-plugins/shared/titleSuffix.ts (60 target + 10 % tolerance = 66 chars
 * including the " | Frontaliere Ticino" brand suffix when it fits).
 */
export const TITLE_MAX_CHARS = 66;
/** Minimum active jobs above which we append 🔥 to boost CTR. */
export const FIRE_EMOJI_THRESHOLD = 500;

/**
 * Count visible characters (code points), which is what Google displays
 * in SERP. Using plain `.length` over-counts astral emojis.
 */
export function visibleLength(s: string): number {
  return [...s].length;
}

/**
 * Returns true when the string's visible length lies in the SERP-safe
 * 50-60 range.
 */
export function isValidTitleLength(s: string): boolean {
  const n = visibleLength(s);
  return n >= TITLE_MIN_CHARS && n <= TITLE_MAX_CHARS;
}

function safeCount(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * Pad the end of `title` with `padWord` until its visible length hits
 * `TITLE_MIN_CHARS`, but never exceed `TITLE_MAX_CHARS`. Used as a safety
 * net when a short city name / small count would otherwise yield a title
 * under 50 chars.
 */
function padToMin(title: string, padWord: string): string {
  let out = title;
  while (visibleLength(out) < TITLE_MIN_CHARS) {
    const candidate = `${out} ${padWord}`;
    if (visibleLength(candidate) > TITLE_MAX_CHARS) break;
    out = candidate;
  }
  return out;
}

/**
 * Trim the title to fit under TITLE_MAX_CHARS if needed, preserving word
 * boundaries and stripping a trailing 🔥 emoji before word-trimming.
 */
function trimToMax(title: string): string {
  if (visibleLength(title) <= TITLE_MAX_CHARS) return title;
  // Remove trailing emoji first
  let base = title.replace(/\s*🔥\s*$/, '');
  if (visibleLength(base) <= TITLE_MAX_CHARS) return base;
  // Word-trim
  const chars = [...base];
  chars.length = TITLE_MAX_CHARS;
  let trimmed = chars.join('');
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace > TITLE_MIN_CHARS) trimmed = trimmed.slice(0, lastSpace);
  // A word-boundary cut can still stop mid-clause ("Offerte di lavoro a"),
  // which reads as broken in the SERP. Shared peel — see clauseTail.mjs.
  return peelDanglingClauseTail(trimmed);
}

/**
 * Apply the 🔥 emoji suffix when count is above threshold. Returns the
 * title as-is when below threshold or when adding the emoji would blow
 * past TITLE_MAX_CHARS.
 */
function withFire(title: string, count: number): string {
  if (count < FIRE_EMOJI_THRESHOLD) return title;
  const candidate = `${title} 🔥`;
  return visibleLength(candidate) <= TITLE_MAX_CHARS ? candidate : title;
}

interface CantonLandingArgs {
  locale: JobPageLocale;
  /** Already-localized canton (or country) display name, e.g. "Zurigo". */
  cantonDisplay: string;
  count: number;
  year: number;
}

function germanCantonTitlePlace(display: string): string {
  if (['Tessin', 'Wallis', 'Jura'].includes(display)) return `im ${display}`;
  if (display === 'Schweiz') return 'in der Schweiz';
  return `in ${display}`;
}

function frenchCantonTitlePlace(display: string): string {
  if (display === 'Suisse') return 'en Suisse';
  if (display === 'Tessin' || display === 'Jura') return `au ${display}`;
  if (display === 'Grisons') return `aux ${display}`;
  if (display === 'Valais') return `en ${display}`;
  return `dans le canton de ${display}`;
}

/**
 * Build a live, SERP-focused title for a per-canton job-board landing.
 *
 * The non-Ticino canton pages previously used a static place-only title while
 * their meta description already carried the live listing count. That made
 * `/cerca-lavoro-zurigo/` and every sibling canton look stale in the result
 * page. Keep the count/year/freshness signal in the shared title generator so
 * all four locale variants receive the same fix; compact fallbacks preserve a
 * complete place name when a long canton label would exceed the title cap.
 */
export function buildCantonLandingTitle({
  locale,
  cantonDisplay,
  count,
  year,
}: CantonLandingArgs): string {
  const n = safeCount(count);
  const place = String(cantonDisplay || '').trim();
  const location = locale === 'de'
    ? germanCantonTitlePlace(place)
    : locale === 'fr'
      ? frenchCantonTitlePlace(place)
      : place;

  let dynamic: string;
  let fresh: string;
  let compact: string;
  let fallback: string;
  let qualifier: string;
  switch (locale) {
    case 'it':
      dynamic = n > 0
        ? `Offerte di lavoro in ${location} ${year} — ${n} posti oggi`
        : `Offerte di lavoro in ${location} ${year} — Aggiornate ogni giorno`;
      fresh = `Offerte di lavoro in ${location} ${year} — Aggiornate ogni giorno`;
      compact = `Offerte di lavoro in ${location} ${year}`;
      fallback = `Offerte di lavoro in ${location}`;
      qualifier = 'in Svizzera';
      break;
    case 'en':
      dynamic = n > 0
        ? `Jobs in ${location} ${year} — ${n} openings today`
        : `Jobs in ${location} ${year} — Updated daily`;
      fresh = `Jobs in ${location} ${year} — Updated daily`;
      compact = `Jobs in ${location} ${year}`;
      fallback = `Jobs in ${location}`;
      qualifier = 'Switzerland';
      break;
    case 'de':
      dynamic = n > 0
        ? `Grenzgänger-Jobs ${location} ${year} — ${n} Stellen heute`
        : `Grenzgänger-Jobs ${location} ${year} — Täglich aktualisiert`;
      fresh = `Grenzgänger-Jobs ${location} ${year} — Täglich aktualisiert`;
      compact = `Grenzgänger-Jobs ${location} ${year}`;
      fallback = `Grenzgänger-Jobs ${location}`;
      qualifier = 'Schweiz';
      break;
    case 'fr':
    default:
      dynamic = n > 0
        ? `Emploi ${location} ${year} — ${n} postes aujourd'hui`
        : `Emploi ${location} ${year} — Mises à jour quotidiennes`;
      fresh = `Emploi ${location} ${year} — Mises à jour quotidiennes`;
      compact = `Emploi ${location} ${year}`;
      fallback = `Emploi ${location}`;
      qualifier = 'Suisse';
      break;
  }

  const candidates = n > 0
    ? [withFire(dynamic, n), dynamic, fresh, compact, fallback]
    : [dynamic, fresh, compact, fallback];
  const selected = candidates.find((candidate) => visibleLength(candidate) <= TITLE_MAX_CHARS)
    ?? fallback;
  const padded = visibleLength(selected) < TITLE_MIN_CHARS
    ? padToMin(selected, qualifier)
    : selected;
  return buildTitleWithBrand(padded, undefined, TITLE_MAX_CHARS, visibleLength);
}

// ────────────────────────────────────────────────────────────────
// Listing hub (home)
// ────────────────────────────────────────────────────────────────

interface ListingHubArgs {
  locale: JobPageLocale;
  count: number;
  year: number;
}

/**
 * Build the SEO title for the main job-board landing (the listing hub
 * that lives at `/cerca-lavoro-ticino/` and its 3 locale variants).
 *
 * This is the highest-impression page in the domain (1928 imp/mo for
 * "offerte di lavoro ticino") so the title is optimized for 50-60
 * visible chars with primary keyword + year + live count + 🔥.
 */
export function buildListingHubTitle({ locale, count, year }: ListingHubArgs): string {
  const n = safeCount(count);
  let base: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `Offerte di lavoro Ticino ${year} — ${n} offerte aggiornate`
        : `Offerte di lavoro Ticino ${year} — Aggiornate ogni giorno`;
      break;
    case 'en':
      base = n > 0
        ? `Jobs in Ticino Switzerland ${year} — ${n} positions today`
        : `Jobs in Ticino Switzerland ${year} — Updated Daily`;
      break;
    case 'de':
      base = n > 0
        ? `Jobs im Tessin Schweiz ${year} — ${n} Stellen heute`
        : `Jobs im Tessin Schweiz ${year} — Täglich aktualisiert`;
      break;
    case 'fr':
      base = n > 0
        ? `Emploi Tessin Suisse ${year} — ${n} postes aujourd'hui`
        : `Emploi Tessin Suisse ${year} — Mises à jour quotidiennes`;
      break;
  }
  base = trimToMax(withFire(base, n));
  if (visibleLength(base) < TITLE_MIN_CHARS) {
    base = padToMin(base, locale === 'it' ? 'in Svizzera' : locale === 'en' ? 'free' : locale === 'de' ? 'kostenlos' : 'gratuit');
  }
  return base;
}

// ────────────────────────────────────────────────────────────────
// Per-city hub
// ────────────────────────────────────────────────────────────────

interface CityHubArgs {
  locale: JobPageLocale;
  cityDisplay: string;
  count: number;
  year: number;
  /** Override the fire-emoji threshold. Defaults to FIRE_EMOJI_THRESHOLD. */
  fireThreshold?: number;
  /**
   * Optional canton display label (e.g. 'Basilea Città', 'Zurigo'). When set,
   * the base title and pad-to-min use the actual canton instead of the legacy
   * Ticino/Tessin fallback. Omit to preserve the legacy TI behavior — keeps
   * existing TI city-hub titles byte-identical.
   */
  cantonDisplay?: string;
}

/** Default fire-emoji threshold for per-city hubs: single-city counts rarely
 *  exceed a few hundred, so we lower the bar from the site-wide 500. Callers
 *  (e.g. `build-plugins/cityJobsHub.ts`) can override by passing `fireThreshold`. */
export const DEFAULT_CITY_HUB_FIRE_THRESHOLD = 30;

export function buildCityHubTitle({
  locale,
  cityDisplay,
  count,
  year,
  fireThreshold = DEFAULT_CITY_HUB_FIRE_THRESHOLD,
  cantonDisplay,
}: CityHubArgs): string {
  const n = safeCount(count);
  const city = cityDisplay;
  // When the caller passes a non-TI cantonDisplay, weave it into the base
  // title (en/de/fr) and into the pad-to-min fallback. For TI callers the
  // arg is undefined and the legacy "Ticino/Tessin" copy stays byte-identical.
  const regionLabels = {
    en: cantonDisplay ?? 'Ticino',
    de: cantonDisplay ?? 'Tessin',
    fr: cantonDisplay ?? 'Tessin',
  };
  let base: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `Lavoro ${city} ${year} — ${n} offerte aggiornate oggi`
        : `Lavoro ${city} ${year} — Offerte aggiornate ogni giorno`;
      break;
    case 'en':
      base = n > 0
        ? `Jobs in ${city} ${regionLabels.en} ${year} — ${n} open positions today`
        : `Jobs in ${city} ${regionLabels.en} Switzerland ${year} — Updated Daily`;
      break;
    case 'de':
      base = n > 0
        ? `Jobs in ${city} ${regionLabels.de} ${year} — ${n} offene Stellen heute`
        : `Jobs in ${city} ${regionLabels.de} Schweiz ${year} — Täglich aktuell`;
      break;
    case 'fr':
      base = n > 0
        ? `Emploi à ${city} ${regionLabels.fr} ${year} — ${n} postes aujourd'hui`
        : `Emploi à ${city} ${regionLabels.fr} Suisse ${year} — Mises à jour`;
      break;
  }
  // Use per-caller fire threshold; city hubs pass 30, site-wide hub inherits 500.
  const shouldFire = n >= fireThreshold;
  const candidateWithFire = `${base} 🔥`;
  if (shouldFire && visibleLength(candidateWithFire) <= TITLE_MAX_CHARS) {
    base = candidateWithFire;
  }
  base = trimToMax(base);
  if (visibleLength(base) < TITLE_MIN_CHARS) {
    const padWord = locale === 'it'
      ? (cantonDisplay ? `in ${cantonDisplay}` : 'in Ticino')
      : locale === 'en'
        ? 'Switzerland'
        : locale === 'de'
          ? 'Schweiz'
          : 'Suisse';
    base = padToMin(base, padWord);
  }
  return base;
}

// ────────────────────────────────────────────────────────────────
// Per-role hub (sector / role landing)
// ────────────────────────────────────────────────────────────────

interface RoleHubArgs {
  locale: JobPageLocale;
  roleDisplay: string;
  count: number;
  year: number;
}

export function buildRoleHubTitle({ locale, roleDisplay, count, year }: RoleHubArgs): string {
  const n = safeCount(count);
  const role = roleDisplay;
  let base: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `${role} Ticino ${year} — ${n} offerte | Candidati oggi`
        : `${role} in Ticino ${year} — Offerte aggiornate ogni giorno`;
      break;
    case 'en':
      base = n > 0
        ? `${role} Jobs Ticino Switzerland ${year} — ${n} open today`
        : `${role} Jobs in Ticino Switzerland ${year} — Updated Daily`;
      break;
    case 'de':
      base = n > 0
        ? `${role} Jobs Tessin Schweiz ${year} — ${n} offen heute`
        : `${role} Stellen im Tessin Schweiz ${year} — Täglich aktuell`;
      break;
    case 'fr':
      base = n > 0
        ? `Emploi ${role} Tessin Suisse ${year} — ${n} postes ouverts`
        : `Emploi ${role} Tessin Suisse ${year} — Mises à jour quotidiennes`;
      break;
  }
  base = trimToMax(withFire(base, n));
  if (visibleLength(base) < TITLE_MIN_CHARS) {
    const padWord = locale === 'it'
      ? 'gratis'
      : locale === 'en'
        ? 'apply free'
        : locale === 'de'
          ? 'kostenlos'
          : 'gratuit';
    base = padToMin(base, padWord);
  }
  return base;
}

// ────────────────────────────────────────────────────────────────
// Employer hub
// ────────────────────────────────────────────────────────────────

interface EmployerHubArgs {
  locale: JobPageLocale;
  companyDisplay: string;
  count: number;
  year: number;
  /**
   * Optional real scope of a per-canton or per-city hub.  The scope belongs
   * in the title even when the company name is long enough to consume the
   * whole budget: otherwise two URLs for the same employer collapse to the
   * same SERP title after `trimToMax`.
   */
  location?: string;
}

/**
 * Keep the shortest stable company identity when a crawler supplied a legal
 * name with an editorial suffix (for example `KSML — Kantonaler Stellenmarkt
 * für Lehrerinnen und Lehrer (Kanton Bern)`).  The complete name remains in
 * the H1 and body; this compact form only protects the title's location
 * discriminant from being cut off at the 66-character boundary.
 */
function compactEmployerName(companyDisplay: string): string {
  const raw = String(companyDisplay || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const beforeQualifier = raw.split(/\s+[—–-]\s+/, 1)[0]?.trim() || raw;
  if (visibleLength(beforeQualifier) <= 32) return beforeQualifier;
  const chars = [...beforeQualifier];
  const head = chars.slice(0, 14).join('');
  const tail = chars.slice(-7).join('');
  // Keep the familiar prefix and tail, plus a stable identity token. Two
  // long legal names can share both visible slices while differing in the
  // middle; the token preserves that distinction without adding a keyword.
  return `${head}…${tail}·${stableTitleToken(raw)}`;
}

export function buildEmployerHubTitle({
  locale,
  companyDisplay,
  count,
  year,
  location,
}: EmployerHubArgs): string {
  const n = safeCount(count);
  const co = companyDisplay;
  const place = String(location || '').replace(/\s+/g, ' ').trim();

  // Per-canton and per-city hubs share an employer name by design.  Put the
  // actual place in a candidate that is checked BEFORE trimming; using
  // `${co} (${place})` as one long companyDisplay looked correct in the H1 but
  // was cut after the same company prefix in `<title>`, producing duplicate
  // titles for e.g. the Bern and Zurich KSML routes.
  if (place) {
    const shortCo = compactEmployerName(co);
    const scopedCandidates = (() => {
      switch (locale) {
        case 'it':
          return [
            n > 0
              ? `${co}: offerte di lavoro a ${place} — ${n} posizioni aperte`
              : `${co}: offerte di lavoro a ${place} — Candidature aperte`,
            n > 0
              ? `${shortCo}: offerte di lavoro a ${place} — ${n} posizioni aperte`
              : `${shortCo}: offerte di lavoro a ${place} — Candidature aperte`,
            `Offerte di lavoro a ${place}: ${shortCo} — Candidati oggi`,
          ];
        case 'en':
          return [
            n > 0
              ? `${co}: jobs in ${place} — ${n} open roles`
              : `${co}: jobs in ${place} — Open roles updated`,
            n > 0
              ? `${shortCo}: jobs in ${place} — ${n} open roles`
              : `${shortCo}: jobs in ${place} — Open roles updated`,
            `Jobs in ${place}: ${shortCo} — Apply today`,
          ];
        case 'de':
          return [
            n > 0
              ? `${co}: offene Stellen in ${place} — ${n} Jobs`
              : `${co}: offene Stellen in ${place} — Bewerben`,
            n > 0
              ? `${shortCo}: offene Stellen in ${place} — ${n} Jobs`
              : `${shortCo}: offene Stellen in ${place} — Bewerben`,
            `Jobs in ${place}: ${shortCo} — Jetzt bewerben`,
          ];
        case 'fr':
          return [
            n > 0
              ? `${co} : offres d’emploi à ${place} — ${n} postes`
              : `${co} : offres d’emploi à ${place} — Postuler`,
            n > 0
              ? `${shortCo} : offres d’emploi à ${place} — ${n} postes`
              : `${shortCo} : offres d’emploi à ${place} — Postuler`,
            `Emplois à ${place} : ${shortCo} — Postulez`,
          ];
      }
    })();
    const scoped = scopedCandidates.find((candidate) => visibleLength(candidate) <= TITLE_MAX_CHARS)
      ?? scopedCandidates[scopedCandidates.length - 1];
    let scopedTitle = trimToMax(withFire(scoped, n));
    if (visibleLength(scopedTitle) < TITLE_MIN_CHARS) {
      const padWord = locale === 'it'
        ? 'in Svizzera'
        : locale === 'en'
          ? 'in Switzerland'
          : locale === 'de'
            ? 'in der Schweiz'
            : 'en Suisse';
      scopedTitle = padToMin(scopedTitle, padWord);
    }
    return scopedTitle;
  }

  let base: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `Lavorare da ${co} in Svizzera ${year} — ${n} posizioni aperte`
        : `Lavorare da ${co} in Svizzera ${year} — Candidature Aperte`;
      break;
    case 'en':
      base = n > 0
        ? `Work at ${co} in Switzerland ${year} — ${n} open roles`
        : `Work at ${co} in Switzerland ${year} — Open Roles Updated`;
      break;
    case 'de':
      base = n > 0
        ? `Arbeiten bei ${co} in der Schweiz ${year} — ${n} offene Stellen`
        : `Arbeiten bei ${co} in der Schweiz ${year} — Offene Stellen`;
      break;
    case 'fr':
      base = n > 0
        ? `Travailler chez ${co} en Suisse ${year} — ${n} postes ouverts`
        : `Travailler chez ${co} en Suisse ${year} — Postes Ouverts`;
      break;
  }
  base = trimToMax(withFire(base, n));
  if (visibleLength(base) < TITLE_MIN_CHARS) {
    const padWord = locale === 'it'
      ? 'candidati'
      : locale === 'en'
        ? 'apply today'
        : locale === 'de'
          ? 'bewerben'
          : 'postuler';
    base = padToMin(base, padWord);
  }
  return base;
}

// ────────────────────────────────────────────────────────────────
// Recency hub (last 3 days / since yesterday)
// ────────────────────────────────────────────────────────────────

interface RecencyHubArgs {
  locale: JobPageLocale;
  /** Window in days; e.g. 1 for "since yesterday", 3 for "last 3 days". */
  days: number;
  count: number;
  year: number;
}

/**
 * Build the SEO title for a recency-filtered hub (last-3-days / since-yesterday).
 *
 * Recency pages carry an intrinsic "urgency" signal (freshness is their
 * selling point) so we always inject 🔥 when count > 0 — no threshold.
 */
export function buildRecencyHubTitle({ locale, days, count, year }: RecencyHubArgs): string {
  const n = safeCount(count);
  const d = Math.max(1, Math.floor(days));
  // For days=1 use "since yesterday" idioms per locale; for days>=2 use
  // "last N days" idioms. GSC queries cluster around these exact phrases.
  const windowLabel: Record<JobPageLocale, string> = d === 1
    ? { it: 'da ieri', en: 'since yesterday', de: 'seit gestern', fr: 'depuis hier' }
    : {
        it: `ultimi ${d} giorni`,
        en: `last ${d} days`,
        de: `letzte ${d} Tage`,
        fr: `${d} derniers jours`,
      };
  const w = windowLabel[locale];
  let base: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `Offerte Lavoro Ticino ${w} — ${n} nuove ${year}`
        : `Offerte Lavoro Ticino ${w} — Nuove ogni giorno ${year}`;
      break;
    case 'en':
      base = n > 0
        ? `Ticino Jobs ${w} ${year} — ${n} new openings today`
        : `Ticino Jobs ${w} ${year} — New openings every day`;
      break;
    case 'de':
      base = n > 0
        ? `Tessin Jobs ${w} ${year} — ${n} neue Stellen heute`
        : `Tessin Jobs ${w} ${year} — Neue Stellen jeden Tag`;
      break;
    case 'fr':
      base = n > 0
        ? `Emploi Tessin ${w} ${year} — ${n} nouveaux postes`
        : `Emploi Tessin ${w} ${year} — Nouveaux chaque jour`;
      break;
  }
  // Always fire for recency when count > 0 (freshness is the page's raison d'être).
  const withFireStr = n > 0 ? `${base} 🔥` : base;
  base = visibleLength(withFireStr) <= TITLE_MAX_CHARS ? withFireStr : base;
  base = trimToMax(base);
  if (visibleLength(base) < TITLE_MIN_CHARS) {
    const padWord = locale === 'it'
      ? 'gratis'
      : locale === 'en'
        ? 'apply'
        : locale === 'de'
          ? 'bewerben'
          : 'postuler';
    base = padToMin(base, padWord);
  }
  return base;
}

// Note: legacy helpers (`buildJobBoardSeo`, `countActiveJobsByLocale`,
// `getActiveJobCountsByLocale`, `isJobActiveForLocale`, `isJobBoardLandingPath`,
// `JOB_BOARD_LANDING_PATHS`) live in `build-plugins/jobBoardSeo.ts`. They are
// not re-exported here to avoid a circular import — `jobBoardSeo.ts` delegates
// its listing-hub title/description to the functions in this module.
