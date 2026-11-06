/**
 * Source-locale description fields for crawler runners, and removal of the
 * crawler-fabricated description text that the locale-preserving merge would
 * otherwise keep forever.
 *
 * Several Workday/HTML runners (mikron, bracco, fnz, ist, capri-holdings) used
 * to write a company blurb of their own into `descriptionByLocale.it` of every
 * job ("Posizione aperta presso <azienda> a <città>. Ruolo: <titolo>. <blurb>"),
 * to key the source text as `en` whatever its language, and (bracco/fnz/ist)
 * to append an English company paragraph to the source text. A runner now
 * publishes only the source text, keyed by its own language
 * (`sourceLocaleDescription`). But `mergeLocaleTextMap` keeps every existing
 * NON-source translation of a job whose source did not drift, so the
 * fabricated Italian slot — and the translations derived from the
 * blurb-appended source — would survive every later crawl: the two `drop…`
 * helpers remove them from the STORED jobs before the merge, and the
 * localization step then translates the real posting. They return true when
 * the job was changed, so a runner can log the repair.
 */
import { detectLang } from './dedicated-crawler-common.mjs';

/**
 * `{ description, descriptionByLocale, sourceLang }` for a posting's own text.
 * `fallback` is used only when the source has no text at all, and is keyed by
 * the language it is written in like any other source text.
 *
 * @param {string} text
 * @param {{ fallback?: string, defaultLang?: string }} [options]
 */
export function sourceLocaleDescription(text, { fallback = '', defaultLang = 'en' } = {}) {
  const description = String(text || '').trim() || String(fallback || '').trim();
  const sourceLang = detectLang(description, defaultLang);
  return { description, descriptionByLocale: { [sourceLang]: description }, sourceLang };
}

/**
 * Drop `descriptionByLocale[locale]` when it is the runner's own template
 * (`pattern` is tested on the trimmed slot) and flag the job for
 * retranslation.
 *
 * @param {object} job
 * @param {string} locale
 * @param {RegExp} pattern
 * @returns {boolean}
 */
export function dropFabricatedLocaleText(job, locale, pattern) {
  const value = job?.descriptionByLocale?.[locale];
  if (typeof value !== 'string' || !pattern.test(value.trim())) return false;
  delete job.descriptionByLocale[locale];
  job.needsRetranslation = true;
  return true;
}

/**
 * When the stored source-locale description carries a paragraph the runner
 * appended itself (`pattern`), every other locale was translated FROM that
 * fabricated text: drop those translations too and flag the job for
 * retranslation. The source slot itself is left alone — the fresh crawl
 * replaces it with the clean source text during the merge.
 *
 * @param {object} job
 * @param {RegExp} pattern
 * @returns {boolean}
 */
export function dropTranslationsOfFabricatedSource(job, pattern) {
  const byLocale = job?.descriptionByLocale;
  if (!byLocale || typeof byLocale !== 'object') return false;
  const sourceLang = job.sourceLang;
  const sourceText = String((sourceLang && byLocale[sourceLang]) || job.description || '');
  if (!pattern.test(sourceText)) return false;
  let changed = false;
  for (const locale of Object.keys(byLocale)) {
    if (locale === sourceLang) continue;
    delete byLocale[locale];
    changed = true;
  }
  if (changed) job.needsRetranslation = true;
  return changed;
}
