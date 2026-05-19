/**
 * SEO title templates for job-board listing pages (F3a — Job Page CTR
 * Optimization).
 *
 * Returns short, CTR-optimized title tags in the 50-60 visible-character
 * range recommended by Google for SERP rendering. Patterns:
 *
 *   - Listing hub (home):    "Offerte Lavoro Ticino 2026 — {N} posti aggiornati oggi 🔥"
 *   - Per-city:              "Lavoro {City} 2026 — {N} offerte aggiornate ogni giorno"
 *   - Per-role:              "{Role} Ticino 2026 — {N} offerte | Candidati oggi"
 *   - Employer hub:          "{Company} Offerte Lavoro Ticino — {N} aperte 2026"
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
  if (visibleLength(out) >= TITLE_MIN_CHARS) return out;
  const candidate = `${out} ${padWord}`;
  if (visibleLength(candidate) <= TITLE_MAX_CHARS) {
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
  return trimmed;
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
        ? `Offerte Lavoro Ticino ${year} — ${n} posti aggiornati oggi`
        : `Offerte Lavoro Ticino ${year} — Aggiornate Ogni Giorno`;
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
}

export function buildEmployerHubTitle({
  locale,
  companyDisplay,
  count,
  year,
}: EmployerHubArgs): string {
  const n = safeCount(count);
  const co = companyDisplay;
  let base: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `${co} Offerte Lavoro Ticino ${year} — ${n} posizioni aperte`
        : `${co} Offerte Lavoro Ticino ${year} — Candidature Aperte`;
      break;
    case 'en':
      base = n > 0
        ? `${co} Jobs Ticino Switzerland ${year} — ${n} open roles today`
        : `${co} Jobs Ticino Switzerland ${year} — Open Roles Updated`;
      break;
    case 'de':
      base = n > 0
        ? `${co} Jobs Tessin Schweiz ${year} — ${n} offene Stellen heute`
        : `${co} Jobs Tessin Schweiz ${year} — Offene Stellen täglich`;
      break;
    case 'fr':
      base = n > 0
        ? `${co} Emploi Tessin Suisse ${year} — ${n} postes ouverts`
        : `${co} Emploi Tessin Suisse ${year} — Postes Ouverts quotidiens`;
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
