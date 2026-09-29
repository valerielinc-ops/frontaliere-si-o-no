/**
 * The source-locale slot of a crawled job, shared by the dedicated runners
 * that build `titleByLocale` / `descriptionByLocale` themselves (#5253).
 *
 * The rule: the crawled text goes in the slot of the language it is WRITTEN
 * in, read from the body — a role title ("Solution Manager - Architect",
 * "Controller") says nothing about it — and nowhere else. The runners this
 * module serves used to key the text under a fixed `it` (or copy it into all
 * four slots) whatever its language: a new job then carried German, French
 * or English text in its Italian slot (the Italian page showed it and the
 * translation pipeline saw nothing to translate), and an existing job never
 * refreshed its real source slot, because the locale-preserving merge
 * (`mergeLocaleTextMap(prev, fresh, n, sourceLang)`) only lets the SOURCE
 * slot take fresh text.
 *
 * It complements `source-locale-description.mjs` (the description-only
 * variant used by runners that publish no title/slug maps of their own) and
 * reuses its language detection.
 */
import { detectLang } from './dedicated-crawler-common.mjs';
import { sourceLocaleDescription } from './source-locale-description.mjs';

export const SITE_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

/**
 * The language a posting is written in, read from its body. A title alone
 * ("Controller", "Solution Manager - Architect") is not evidence, so a
 * posting without a body gets the runner's `fallback` (its portal language).
 * Always one of the site locales.
 *
 * @param {string} body
 * @param {string} [fallback] locale used when there is no body
 * @returns {'it'|'en'|'de'|'fr'}
 */
export function sourceLangOfBody(body = '', fallback = 'it') {
  const safeFallback = SITE_LOCALES.includes(fallback) ? fallback : 'it';
  if (!String(body || '').trim()) return safeFallback;
  const { sourceLang } = sourceLocaleDescription(body, { defaultLang: safeFallback });
  return SITE_LOCALES.includes(sourceLang) ? sourceLang : safeFallback;
}

/**
 * The language of a posting whose platform declares one (Workable's
 * `language`): read from the body like any other, with the declared language
 * as the fallback when it is a site locale — `fallback` otherwise.
 *
 * @param {string} body
 * @param {string} [declared]
 * @param {string} [fallback]
 * @returns {'it'|'en'|'de'|'fr'}
 */
export function sourceLangOfPosting(body = '', declared = '', fallback = 'en') {
  const lang = String(declared || '').trim().toLowerCase().slice(0, 2);
  return sourceLangOfBody(body, SITE_LOCALES.includes(lang) ? lang : fallback);
}

// A description shorter than this is too short for language detection to
// overrule the slot it sits in.
const STALE_SLOT_MIN_CHARS = 200;

/**
 * Drop the non-source description slots that are not in their own language —
 * a verbatim copy of the source text, or text detected as another language
 * (what a fixed-`it` or copy-to-all builder left behind) — and flag the job
 * for retranslation so the pipeline refills them from the current source.
 * Titles are left alone: a role title kept in the source language in another
 * locale is normal, and too short to classify.
 *
 * @param {object} job merged job (mutated)
 * @returns {string[]} the locales dropped
 */
export function dropStaleLocaleDescriptions(job) {
  const sourceLang = String(job?.sourceLang || '');
  const byLocale = job?.descriptionByLocale;
  if (!sourceLang || !byLocale || typeof byLocale !== 'object') return [];
  const fold = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const sourceText = fold(byLocale[sourceLang] || job.description);
  const dropped = [];
  for (const [locale, text] of Object.entries(byLocale)) {
    if (locale === sourceLang || typeof text !== 'string') continue;
    const copy = sourceText && fold(text) === sourceText;
    const wrongLanguage = text.trim().length >= STALE_SLOT_MIN_CHARS && detectLang(text, locale) !== locale;
    if (!copy && !wrongLanguage) continue;
    delete byLocale[locale];
    dropped.push(locale);
  }
  if (dropped.length) job.needsRetranslation = true;
  return dropped;
}

/**
 * Title and slug of a posting under its source language only, for the
 * runners that filed them under a fixed key — `{ en: title }` and
 * `{ en: slug, it: slug }` whatever language the posting is written in. A
 * German or French vacancy then had no title or slug in its own slot, and its
 * `en`/`it` slots held the source text, which the translation pipeline took
 * for a translation. The pipeline fills the other slots; the
 * locale-preserving merge keeps every slug already published under another
 * key, so no published URL changes.
 *
 * @param {string} title
 * @param {string} slug
 * @param {string} sourceLang the job's `sourceLang`
 * @returns {{ titleByLocale: Record<string, string>, slugByLocale: Record<string, string> }}
 */
export function sourceSlotTitleAndSlug(title, slug, sourceLang) {
  return { titleByLocale: { [sourceLang]: title }, slugByLocale: { [sourceLang]: slug } };
}
