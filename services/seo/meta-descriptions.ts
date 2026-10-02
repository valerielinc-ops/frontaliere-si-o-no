/**
 * SEO meta description templates for job-board listing pages (F3a — Job
 * Page CTR Optimization).
 *
 * Returns descriptions in the 140-160 visible-character range that Google
 * uses to render SERP snippets. Each description includes:
 *
 *   1. keyword match (primary query e.g. "offerte di lavoro in Ticino")
 *   2. emotional hook ("Scopri", "Cerca tra", "Candidati oggi", "nuove")
 *   3. specific dynamic number (live count from `data/jobs.json`)
 *   4. complete CTA: reading is open, signing in to apply is free
 *
 * All outputs are validated at 140-160 code-points (see
 * {@link isValidMetaLength}). Helpers auto-pad with a generic qualifier
 * when a combination falls below 140, and trim descriptive text on word
 * boundaries while reserving the complete CTA inside the 160-char budget.
 *
 * Visible length is measured via `[...s].length` (code points) because
 * Google counts visible characters, not UTF-16 code units.
 */

import type { JobPageLocale } from './job-board-titles';
import { peelDanglingClauseTail } from '../../build-plugins/shared/clauseTail.mjs';

/** Minimum visible meta-description length (Google SERP floor). */
export const META_MIN_CHARS = 140;
/** Maximum visible meta-description length (Google SERP ceiling). */
export const META_MAX_CHARS = 160;

export function visibleLength(s: string): number {
  return [...s].length;
}

export function isValidMetaLength(s: string): boolean {
  const n = visibleLength(s);
  return n >= META_MIN_CHARS && n <= META_MAX_CHARS;
}

function safeCount(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * Pad the description by appending the given qualifier until it hits
 * META_MIN_CHARS, without exceeding META_MAX_CHARS.
 */
function padToMin(desc: string, qualifier: string): string {
  let out = desc;
  const candidate = `${out} ${qualifier}`;
  if (visibleLength(out) < META_MIN_CHARS && visibleLength(candidate) <= META_MAX_CHARS) {
    out = candidate;
  }
  return out;
}

/**
 * Trim the description on a word boundary so its visible length lands
 * ≤ META_MAX_CHARS. Keeps trailing punctuation cleaner.
 */
function trimToMax(desc: string): string {
  if (visibleLength(desc) <= META_MAX_CHARS) return desc;
  const chars = [...desc];
  chars.length = META_MAX_CHARS;
  let trimmed = chars.join('');
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace > META_MIN_CHARS - 10) trimmed = trimmed.slice(0, lastSpace);
  // A word-boundary cut still lands mid-CLAUSE: without this peel the snippet
  // ends on a preposition and the terminal stop below just freezes it in place
  // ("…requisiti e costi con B, C e."). Shared peel — see clauseTail.mjs.
  trimmed = peelDanglingClauseTail(trimmed);
  // Ensure final punctuation
  if (!/[.!?]$/.test(trimmed)) trimmed = `${trimmed.replace(/[,;:—–-]\s*$/, '')}.`;
  return trimmed;
}

function finalize(desc: string, qualifier: string): string {
  let out = padToMin(desc, qualifier);
  out = trimToMax(out);
  return out;
}

/**
 * Public wrapper over the internal pad-to-min / trim-to-max pipeline so other
 * SEO emitters (e.g. the thin canton sub-hubs in
 * `build-plugins/seoHubsPlugin.ts`) can produce 140-160 char descriptions
 * without duplicating the length logic. `base` is the keyword-rich sentence;
 * `qualifier` is a short clause appended only when `base` falls below 140.
 */
export function finalizeMeta(base: string, qualifier: string): string {
  return finalize(base, qualifier);
}

/** Reserve the complete reading/sign-in CTA before shortening sector prose. */
function finalizeJobHubMeta(base: string, locale: JobPageLocale): string {
  const cta = {
    it: 'Leggi gli annunci; accesso gratuito per candidarti.',
    en: 'Read listings freely; free sign-in to apply.',
    de: 'Anzeigen frei lesen; kostenlose Anmeldung zur Bewerbung.',
    fr: 'Annonces en accès libre ; connexion gratuite pour postuler.',
  }[locale];
  const qualifier = {
    it: 'Annunci aggiornati.',
    en: 'Explore open roles.',
    de: 'Stellen entdecken.',
    fr: 'Offres actualisées.',
  }[locale];
  const prefixBudget = META_MAX_CHARS - visibleLength(cta) - 1;
  let prefix = base.trim();
  if (visibleLength(prefix) > prefixBudget) {
    let clipped = [...prefix].slice(0, prefixBudget - 1).join('');
    const space = clipped.lastIndexOf(' ');
    if (space > 0) clipped = clipped.slice(0, space);
    prefix = `${peelDanglingClauseTail(clipped).replace(/[.,;:—–-]\s*$/, '')}.`;
  }
  if (visibleLength(`${prefix} ${cta}`) < META_MIN_CHARS) {
    const padded = `${prefix} ${qualifier}`;
    if (visibleLength(`${padded} ${cta}`) <= META_MAX_CHARS) prefix = padded;
  }
  return `${prefix} ${cta}`;
}

// ────────────────────────────────────────────────────────────────
// Listing hub (home)
// ────────────────────────────────────────────────────────────────

interface ListingHubArgs {
  locale: JobPageLocale;
  count: number;
}

export function buildListingHubMeta({ locale, count }: ListingHubArgs): string {
  const n = safeCount(count);
  let base: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `Scopri ${n} offerte di lavoro in Ticino aggiornate oggi: sanità, EOC, case anziani, banche, uffici.`
        : `Scopri le offerte di lavoro in Ticino aggiornate ogni giorno: sanità, EOC, case anziani, banche, uffici.`;
      break;
    case 'en':
      base = n > 0
        ? `Discover ${n} jobs in Ticino, Switzerland updated today: healthcare, EOC, care homes, banks, offices.`
        : `Discover jobs in Ticino, Switzerland updated daily: healthcare, EOC, care homes, banks, offices.`;
      break;
    case 'de':
      base = n > 0
        ? `Entdecke ${n} Stellenangebote im Tessin, täglich aktualisiert: Pflege, EOC, Altersheime, Banken, Büros.`
        : `Entdecke Stellenangebote im Tessin, täglich aktualisiert: Pflege, EOC, Altersheime, Banken, Büros.`;
      break;
    case 'fr':
      base = n > 0
        ? `Découvrez ${n} offres d'emploi au Tessin mises à jour aujourd'hui : santé, EOC, EMS, banques, bureaux.`
        : `Découvrez les offres d'emploi au Tessin mises à jour chaque jour : santé, EOC, EMS, banques, bureaux.`;
      break;
  }
  return finalizeJobHubMeta(base, locale);
}

// ────────────────────────────────────────────────────────────────
// Per-city hub
// ────────────────────────────────────────────────────────────────

interface CityHubArgs {
  locale: JobPageLocale;
  cityDisplay: string;
  count: number;
  /**
   * Optional canton display label. When provided, non-IT meta descriptions
   * weave the actual canton in place of the legacy Ticino/Tessin fallback.
   * Omit for TI city hubs — keeps existing meta byte-identical.
   */
  cantonDisplay?: string;
}

export function buildCityHubMeta({ locale, cityDisplay, count, cantonDisplay }: CityHubArgs): string {
  const n = safeCount(count);
  const city = cityDisplay;
  const region = {
    en: cantonDisplay ?? 'Ticino',
    de: cantonDisplay ?? 'Tessin',
    fr: cantonDisplay ?? 'Tessin',
  };
  let base: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `Cerca tra ${n} offerte di lavoro a ${city} aggiornate oggi: sanità, banche, uffici, commercio.`
        : `Cerca offerte di lavoro a ${city} aggiornate ogni giorno: sanità, banche, uffici, commercio.`;
      break;
    case 'en':
      base = n > 0
        ? `Browse ${n} jobs in ${city}, ${region.en} Switzerland — updated today: healthcare, banking, offices, retail, hospitality.`
        : `Browse jobs in ${city}, ${region.en} Switzerland — updated daily: healthcare, banking, offices, retail, hospitality.`;
      break;
    case 'de':
      base = n > 0
        ? `Durchsuche ${n} Stellenangebote in ${city}, ${region.de} — täglich aktualisiert: Pflege, Banken, Büros, Handel.`
        : `Durchsuche Stellenangebote in ${city}, ${region.de} — täglich aktualisiert: Pflege, Banken, Büros, Handel.`;
      break;
    case 'fr':
      base = n > 0
        ? `Parcourez ${n} offres d'emploi à ${city}, ${region.fr} mises à jour aujourd'hui : santé, banques, bureaux, commerce.`
        : `Parcourez les offres d'emploi à ${city}, ${region.fr} mises à jour chaque jour : santé, banques, bureaux, commerce.`;
      break;
  }
  return finalizeJobHubMeta(base, locale);
}

// ────────────────────────────────────────────────────────────────
// Per-canton hub (cathedral canton landing /cerca-lavoro-<canton>/)
// ────────────────────────────────────────────────────────────────

interface CantonHubArgs {
  locale: JobPageLocale;
  /** Already-localized canton (or country) display name, e.g. "Argovia". */
  cantonDisplay: string;
  count: number;
  /**
   * True for the Switzerland-wide aggregator (`/cerca-lavoro-svizzera/`),
   * where `cantonDisplay` is the country name. Drops the ", Switzerland"
   * region suffix so the snippet doesn't read "Switzerland, Switzerland".
   */
  isAggregate?: boolean;
}

/**
 * 140-160 char meta description for the per-canton job-board landing pages
 * emitted by jobsSeoPagesPlugin. These previously shipped a ~50-char thin
 * lede ("Pagina indice del job board per il cantone X.") that GSC flagged as
 * "Description too short" (issue #2996). Mirrors {@link buildCityHubMeta}:
 * keyword + canton + live count + concrete CTA, validated by `finalizeJobHubMeta`.
 */
export function buildCantonHubMeta({ locale, cantonDisplay, count, isAggregate }: CantonHubArgs): string {
  const n = safeCount(count);
  const place = cantonDisplay;
  // Region suffix: cantons get ", <country>"; the aggregator already names
  // the country, so it stays bare.
  const region = isAggregate
    ? { en: place, de: place, fr: place }
    : { en: `${place}, Switzerland`, de: `${place}, Schweiz`, fr: `${place}, Suisse` };
  let base: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `Cerca lavoro in ${place}: ${n} offerte aggiornate ogni giorno per frontalieri e residenti.`
        : `Cerca lavoro in ${place}: offerte aggiornate ogni giorno per frontalieri e residenti.`;
      break;
    case 'en':
      base = n > 0
        ? `Find ${n} jobs in ${region.en} updated daily: healthcare, banking, offices, retail, engineering.`
        : `Find jobs in ${region.en} updated daily: healthcare, banking, offices, retail, engineering.`;
      break;
    case 'de':
      base = n > 0
        ? `${n} Stellenangebote in ${region.de}, täglich aktualisiert: Pflege, Banken, Büros, Handel, Technik.`
        : `Stellenangebote in ${region.de}, täglich aktualisiert: Pflege, Banken, Büros, Handel, Technik.`;
      break;
    case 'fr':
    default:
      base = n > 0
        ? `${n} offres d'emploi en ${region.fr} mises à jour chaque jour : santé, banques, bureaux, commerce, technique.`
        : `Offres d'emploi en ${region.fr} mises à jour chaque jour : santé, banques, bureaux, commerce, technique.`;
      break;
  }
  return finalizeJobHubMeta(base, locale);
}

// ────────────────────────────────────────────────────────────────
// Per-role hub (sector / role landing)
// ────────────────────────────────────────────────────────────────

interface RoleHubArgs {
  locale: JobPageLocale;
  roleDisplay: string;
  count: number;
}

export function buildRoleHubMeta({ locale, roleDisplay, count }: RoleHubArgs): string {
  const n = safeCount(count);
  const role = roleDisplay.toLowerCase();
  const roleC = roleDisplay;
  let base: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `Scopri ${n} offerte ${role} in Ticino aggiornate oggi. Aziende che assumono: EOC, cliniche, case anziani, privati.`
        : `Scopri le offerte ${role} in Ticino aggiornate ogni giorno da EOC, cliniche e case anziani.`;
      break;
    case 'en':
      base = n > 0
        ? `Discover ${n} ${role} jobs in Ticino, Switzerland updated today. Hiring employers: EOC, clinics, care homes, private.`
        : `Discover ${role} jobs in Ticino, Switzerland updated daily. Hiring employers: EOC, clinics, care homes, private firms.`;
      break;
    case 'de':
      base = n > 0
        ? `Entdecke ${n} ${roleC}-Stellen im Tessin, heute aktualisiert. Einstellende Arbeitgeber: EOC, Kliniken, Altersheime.`
        : `Entdecke ${roleC}-Stellen im Tessin, täglich aktualisiert. Einstellende Arbeitgeber: EOC, Kliniken, Altersheime.`;
      break;
    case 'fr':
      base = n > 0
        ? `Découvrez ${n} offres ${role} au Tessin, mises à jour aujourd'hui. Recruteurs : EOC, cliniques, EMS, entreprises privées.`
        : `Découvrez les offres ${role} au Tessin, mises à jour chaque jour. Recruteurs : EOC, cliniques, EMS.`;
      break;
  }
  return finalizeJobHubMeta(base, locale);
}

// ────────────────────────────────────────────────────────────────
// Employer hub
// ────────────────────────────────────────────────────────────────

interface EmployerHubArgs {
  locale: JobPageLocale;
  companyDisplay: string;
  count: number;
}

export function buildEmployerHubMeta({ locale, companyDisplay, count }: EmployerHubArgs): string {
  const n = safeCount(count);
  const co = companyDisplay;
  let base: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `Lavora con ${co} in Ticino: ${n} posizioni aperte oggi in sanità, amministrazione, tecnica, commercio.`
        : `Lavora con ${co} in Ticino: candidature aperte oggi in sanità, amministrazione, tecnica, commercio.`;
      break;
    case 'en':
      base = n > 0
        ? `Work with ${co} in Ticino, Switzerland: ${n} open roles today in healthcare, admin, tech, retail.`
        : `Work with ${co} in Ticino, Switzerland: open roles updated daily in healthcare, admin, tech, retail.`;
      break;
    case 'de':
      base = n > 0
        ? `Arbeite bei ${co} im Tessin, Schweiz: ${n} offene Stellen heute in Pflege, Verwaltung, Technik, Handel.`
        : `Arbeite bei ${co} im Tessin, Schweiz: offene Stellen täglich aktuell in Pflege, Verwaltung, Technik, Handel.`;
      break;
    case 'fr':
      base = n > 0
        ? `Travaillez chez ${co} au Tessin, Suisse : ${n} postes ouverts aujourd'hui en santé, administration, tech, commerce.`
        : `Travaillez chez ${co} au Tessin, Suisse : postes ouverts mis à jour chaque jour en santé, administration, tech, commerce.`;
      break;
  }
  return finalizeJobHubMeta(base, locale);
}

// ────────────────────────────────────────────────────────────────
// Recency hub
// ────────────────────────────────────────────────────────────────

interface RecencyHubArgs {
  locale: JobPageLocale;
  days: number;
  count: number;
  /** Current year. Defaults to `new Date().getUTCFullYear()`. Injected so the
   *  description always surfaces the year (SEO signal + test contract). */
  year?: number;
}

export function buildRecencyHubMeta({ locale, days, count, year }: RecencyHubArgs): string {
  const n = safeCount(count);
  const d = Math.max(1, Math.floor(days));
  const y = year ?? new Date().getUTCFullYear();
  // Mirror the title module: "since yesterday" idioms for d=1, "last N days"
  // idioms for d>=2. This keeps the description aligned with the title which
  // Google uses as a coherence signal.
  const windowLabel: Record<JobPageLocale, string> = d === 1
    ? { it: 'da ieri', en: 'since yesterday', de: 'seit gestern', fr: 'depuis hier' }
    : {
        it: `degli ultimi ${d} giorni`,
        en: `from the last ${d} days`,
        de: `der letzten ${d} Tage`,
        fr: `des ${d} derniers jours`,
      };
  const w = windowLabel[locale];
  let base: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `${n} nuove offerte di lavoro in Ticino ${w}, aggiornate oggi nel ${y}: sanità, banche, commercio.`
        : `Nuove offerte di lavoro in Ticino ${w}, aggiornate ogni giorno nel ${y}: sanità, banche, commercio.`;
      break;
    case 'en':
      base = n > 0
        ? `${n} new jobs in Ticino, Switzerland ${w}, updated today in ${y}: healthcare, banking, retail, offices.`
        : `New jobs in Ticino, Switzerland ${w}, updated daily in ${y}: healthcare, banking, retail, offices.`;
      break;
    case 'de':
      base = n > 0
        ? `${n} neue Stellen im Tessin, Schweiz ${w}, heute im ${y} aktualisiert: Pflege, Banken, Handel, Büros.`
        : `Neue Stellen im Tessin, Schweiz ${w}, täglich im ${y} aktualisiert: Pflege, Banken, Handel, Büros.`;
      break;
    case 'fr':
      base = n > 0
        ? `${n} nouvelles offres d'emploi au Tessin Suisse ${w}, à jour en ${y} : santé, banques, commerce, bureaux.`
        : `Nouvelles offres d'emploi au Tessin Suisse ${w}, mises à jour en ${y} : santé, banques, commerce, bureaux.`;
      break;
  }
  return finalizeJobHubMeta(base, locale);
}
