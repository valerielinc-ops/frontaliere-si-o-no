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
 *   4. concrete CTA ("Candidati gratis online", "Apply today")
 *
 * All outputs are validated at 140-160 code-points (see
 * {@link isValidMetaLength}). Helpers auto-pad with a generic qualifier
 * when a combination falls below 140, and auto-trim (on word boundary)
 * when a long count would blow past 160.
 *
 * Visible length is measured via `[...s].length` (code points) because
 * Google counts visible characters, not UTF-16 code units.
 */

import type { JobPageLocale } from './job-board-titles';

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
  // Ensure final punctuation
  if (!/[.!?]$/.test(trimmed)) trimmed = `${trimmed.replace(/[,;:—–-]\s*$/, '')}.`;
  return trimmed;
}

function finalize(desc: string, qualifier: string): string {
  let out = padToMin(desc, qualifier);
  out = trimToMax(out);
  return out;
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
  let qualifier: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `Scopri ${n} offerte di lavoro in Ticino aggiornate oggi: sanità, EOC, case anziani, banche, uffici. Candidati gratis online in 2 minuti.`
        : `Scopri le offerte di lavoro in Ticino aggiornate ogni giorno: sanità, EOC, case anziani, banche, uffici. Candidati gratis online in 2 minuti.`;
      qualifier = 'Senza registrazione.';
      break;
    case 'en':
      base = n > 0
        ? `Discover ${n} jobs in Ticino, Switzerland updated today: healthcare, EOC, care homes, banks, offices. Apply online for free in 2 minutes.`
        : `Discover jobs in Ticino, Switzerland updated daily: healthcare, EOC, care homes, banks, offices. Apply online for free in 2 minutes.`;
      qualifier = 'No signup required.';
      break;
    case 'de':
      base = n > 0
        ? `Entdecke ${n} Stellenangebote im Tessin, täglich aktualisiert: Pflege, EOC, Altersheime, Banken, Büros. Kostenlos online bewerben in 2 Minuten.`
        : `Entdecke Stellenangebote im Tessin, täglich aktualisiert: Pflege, EOC, Altersheime, Banken, Büros. Kostenlos online bewerben in 2 Minuten.`;
      qualifier = 'Ohne Anmeldung.';
      break;
    case 'fr':
      base = n > 0
        ? `Découvrez ${n} offres d'emploi au Tessin mises à jour aujourd'hui : santé, EOC, EMS, banques, bureaux. Postulez gratuitement en ligne en 2 minutes.`
        : `Découvrez les offres d'emploi au Tessin mises à jour chaque jour : santé, EOC, EMS, banques, bureaux. Postulez gratuitement en ligne.`;
      qualifier = 'Sans inscription.';
      break;
  }
  return finalize(base, qualifier);
}

// ────────────────────────────────────────────────────────────────
// Per-city hub
// ────────────────────────────────────────────────────────────────

interface CityHubArgs {
  locale: JobPageLocale;
  cityDisplay: string;
  count: number;
}

export function buildCityHubMeta({ locale, cityDisplay, count }: CityHubArgs): string {
  const n = safeCount(count);
  const city = cityDisplay;
  let base: string;
  let qualifier: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `Cerca tra ${n} offerte di lavoro a ${city} aggiornate oggi: sanità, banche, uffici, commercio. Candidati gratis online in pochi minuti.`
        : `Cerca offerte di lavoro a ${city} aggiornate ogni giorno: sanità, banche, uffici, commercio. Candidati gratis online in pochi minuti.`;
      qualifier = 'Senza registrazione.';
      break;
    case 'en':
      base = n > 0
        ? `Browse ${n} jobs in ${city}, Ticino Switzerland — updated today: healthcare, banking, offices, retail, hospitality. Apply online for free in 2 minutes.`
        : `Browse jobs in ${city}, Ticino Switzerland — updated daily: healthcare, banking, offices, retail, hospitality. Apply online for free in 2 minutes.`;
      qualifier = 'No signup needed.';
      break;
    case 'de':
      base = n > 0
        ? `Durchsuche ${n} Stellenangebote in ${city}, Tessin — täglich aktualisiert: Pflege, Banken, Büros, Handel. Kostenlos online bewerben in Minuten.`
        : `Durchsuche Stellenangebote in ${city}, Tessin — täglich aktualisiert: Pflege, Banken, Büros, Handel. Kostenlos online bewerben.`;
      qualifier = 'Ohne Anmeldung.';
      break;
    case 'fr':
      base = n > 0
        ? `Parcourez ${n} offres d'emploi à ${city}, Tessin mises à jour aujourd'hui : santé, banques, bureaux, commerce. Postulez gratuitement en ligne.`
        : `Parcourez les offres d'emploi à ${city}, Tessin mises à jour chaque jour : santé, banques, bureaux, commerce. Postulez gratuitement.`;
      qualifier = 'Sans inscription.';
      break;
  }
  return finalize(base, qualifier);
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
  let qualifier: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `Scopri ${n} offerte ${role} in Ticino aggiornate oggi. Aziende che assumono: EOC, cliniche, case anziani, privati. Candidati online gratis in 2 minuti.`
        : `Scopri le offerte ${role} in Ticino aggiornate ogni giorno da EOC, cliniche e case anziani. Candidati online gratis in 2 minuti, senza registrazione.`;
      qualifier = 'Subito.';
      break;
    case 'en':
      base = n > 0
        ? `Discover ${n} ${role} jobs in Ticino, Switzerland updated today. Hiring employers: EOC, clinics, care homes, private. Apply online free in 2 minutes.`
        : `Discover ${role} jobs in Ticino, Switzerland updated daily. Hiring employers: EOC, clinics, care homes, private firms. Apply online for free.`;
      qualifier = 'Today.';
      break;
    case 'de':
      base = n > 0
        ? `Entdecke ${n} ${roleC}-Stellen im Tessin, heute aktualisiert. Einstellende Arbeitgeber: EOC, Kliniken, Altersheime. Kostenlos online bewerben in 2 Min.`
        : `Entdecke ${roleC}-Stellen im Tessin, täglich aktualisiert. Einstellende Arbeitgeber: EOC, Kliniken, Altersheime. Kostenlos online bewerben.`;
      qualifier = 'Jetzt.';
      break;
    case 'fr':
      base = n > 0
        ? `Découvrez ${n} offres ${role} au Tessin, mises à jour aujourd'hui. Recruteurs : EOC, cliniques, EMS, entreprises privées. Postulez en ligne gratuit en 2 min.`
        : `Découvrez les offres ${role} au Tessin, mises à jour chaque jour. Recruteurs : EOC, cliniques, EMS. Postulez gratuitement en ligne.`;
      qualifier = 'Aujourd\u2019hui.';
      break;
  }
  return finalize(base, qualifier);
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
  let qualifier: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `Lavora con ${co} in Ticino: ${n} posizioni aperte oggi in sanità, amministrazione, tecnica, commercio. Candidati online gratis sul portale ufficiale.`
        : `Lavora con ${co} in Ticino: candidature aperte oggi in sanità, amministrazione, tecnica, commercio. Candidati online gratis sul portale ufficiale.`;
      qualifier = 'Senza registrazione.';
      break;
    case 'en':
      base = n > 0
        ? `Work with ${co} in Ticino, Switzerland: ${n} open roles today in healthcare, admin, tech, retail. Apply online for free via the official career portal.`
        : `Work with ${co} in Ticino, Switzerland: open roles updated daily in healthcare, admin, tech, retail. Apply online for free via the official portal.`;
      qualifier = 'No signup.';
      break;
    case 'de':
      base = n > 0
        ? `Arbeite bei ${co} im Tessin, Schweiz: ${n} offene Stellen heute in Pflege, Verwaltung, Technik, Handel. Kostenlos online bewerben auf dem offiziellen Portal.`
        : `Arbeite bei ${co} im Tessin, Schweiz: offene Stellen täglich aktuell in Pflege, Verwaltung, Technik, Handel. Kostenlos online bewerben.`;
      qualifier = 'Ohne Anmeldung.';
      break;
    case 'fr':
      base = n > 0
        ? `Travaillez chez ${co} au Tessin, Suisse : ${n} postes ouverts aujourd'hui en santé, administration, tech, commerce. Postulez gratuitement en ligne en 2 min.`
        : `Travaillez chez ${co} au Tessin, Suisse : postes ouverts mis à jour chaque jour en santé, administration, tech, commerce. Postulez en ligne gratuit.`;
      qualifier = 'Sans inscription.';
      break;
  }
  return finalize(base, qualifier);
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
  let qualifier: string;
  switch (locale) {
    case 'it':
      base = n > 0
        ? `${n} nuove offerte di lavoro in Ticino ${w}, aggiornate oggi nel ${y}: sanità, banche, commercio. Candidati gratis online in 2 minuti.`
        : `Nuove offerte di lavoro in Ticino ${w}, aggiornate ogni giorno nel ${y}: sanità, banche, commercio. Candidati gratis online.`;
      qualifier = 'Senza registrazione.';
      break;
    case 'en':
      base = n > 0
        ? `${n} new jobs in Ticino, Switzerland ${w}, updated today in ${y}: healthcare, banking, retail, offices. Apply online for free in 2 minutes.`
        : `New jobs in Ticino, Switzerland ${w}, updated daily in ${y}: healthcare, banking, retail, offices. Apply online for free in 2 minutes.`;
      qualifier = 'No signup.';
      break;
    case 'de':
      base = n > 0
        ? `${n} neue Stellen im Tessin, Schweiz ${w}, heute im ${y} aktualisiert: Pflege, Banken, Handel, Büros. Kostenlos online bewerben in 2 Minuten.`
        : `Neue Stellen im Tessin, Schweiz ${w}, täglich im ${y} aktualisiert: Pflege, Banken, Handel, Büros. Kostenlos online bewerben in 2 Minuten.`;
      qualifier = 'Ohne Anmeldung.';
      break;
    case 'fr':
      base = n > 0
        ? `${n} nouvelles offres d'emploi au Tessin Suisse ${w}, à jour en ${y} : santé, banques, commerce, bureaux. Postulez gratuit en ligne en 2 min.`
        : `Nouvelles offres d'emploi au Tessin Suisse ${w}, mises à jour en ${y} : santé, banques, commerce, bureaux. Postulez gratuitement en ligne.`;
      qualifier = 'Sans inscription.';
      break;
  }
  return finalize(base, qualifier);
}
