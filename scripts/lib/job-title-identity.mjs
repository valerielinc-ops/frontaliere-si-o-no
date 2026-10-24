/**
 * Job title identity — the employer's own title, shown unchanged in every
 * locale variant of a job page.
 *
 * Decision (owner, SEO plan 2026-10-23): the language variants of a job page
 * (/en/, /de/, /fr/ and the Italian page of a non-Italian posting) translate
 * the INTERFACE, never the employer's job title. The machine-translated
 * `titleByLocale` slots stay in the data (search aliases and slug history read
 * them) but are no longer what a reader or a crawler sees as the title:
 *
 *   "Macchinista M1, M2,M3"      → EN/DE/FR slot "M1, M2"   (trade dropped)
 *   "Macchinista M1"             → EN "Knife M1", DE "Messer M1"
 *   "Collaboratore/trice dell'economia domestica"
 *                                → DE "Beitragszahler/Titel der Binnenwirtschaft"
 *
 * The repo's own audit (`scripts/audit-job-title-locale.mjs`) measured roughly
 * a third of the non-source title slots as wrong-language on 2026-08-11, and
 * the defects above are not wrong-language at all — they are wrong meaning,
 * which no lexical detector can see. The original title is the only value
 * that is right by construction.
 *
 * Dependency-free on purpose: imported by the SSG plugins, the SPA and the
 * Node slug writers (`scripts/regenerate-slugs-by-locale.mjs`).
 */

const SUPPORTED_LOCALES = ['it', 'de', 'fr', 'en'];

function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function wordKey(token) {
  return String(token || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * Collapse a word repeated back-to-back ("Legale Legale Servizio Legale" →
 * "Legale Servizio Legale"). Only exact adjacent repeats separated by
 * whitespace are removed: a repeat after a separator ("Legale, Legale") or
 * further along the title is left alone, because both can be intentional.
 *
 * @param {string} title
 * @returns {string}
 */
export function dedupeAdjacentTitleWords(title) {
  const tokens = clean(title).split(' ').filter(Boolean);
  const out = [];
  for (const token of tokens) {
    const prev = out[out.length - 1];
    if (prev !== undefined) {
      const key = wordKey(token);
      const prevEndsInWord = /[\p{L}\p{N}]$/u.test(prev);
      if (prevEndsInWord && key.length >= 2 && /\p{L}/u.test(key) && key === wordKey(prev)) {
        // Keep the trailing punctuation of the dropped twin ("Legale Legale," → "Legale,").
        const tail = token.match(/[^\p{L}\p{N}]+$/u)?.[0] || '';
        if (tail) out[out.length - 1] = `${prev}${tail}`;
        continue;
      }
    }
    out.push(token);
  }
  return out.join(' ');
}

/**
 * The title as the employer published it.
 *
 * `job.title` is what the crawler scraped from the employer's page; it is the
 * primary witness. `titleByLocale[sourceLang]` is the fallback for records
 * that carry no top-level title. A language variant never falls back to its
 * own translated slot, because that slot is exactly the value this module
 * exists to stop showing.
 *
 * Accepts any job-shaped record (raw dataset entry, locale-flattened slim
 * record, SPA `JobListing`, expired-job archive entry).
 *
 * @param {unknown} job
 * @returns {string}
 */
export function originalJobTitle(job) {
  if (!job || typeof job !== 'object') return '';
  const direct = clean(job.originalTitle) || clean(job.title);
  if (direct) return direct;
  const byLocale = job.titleByLocale && typeof job.titleByLocale === 'object' ? job.titleByLocale : {};
  const sourceLang = clean(job.sourceLang).toLowerCase().split(/[-_]/)[0];
  if (sourceLang && clean(byLocale[sourceLang])) return clean(byLocale[sourceLang]);
  for (const locale of SUPPORTED_LOCALES) {
    if (clean(byLocale[locale])) return clean(byLocale[locale]);
  }
  return '';
}

/**
 * The title every locale variant of a job page displays: the original title,
 * with back-to-back repeated words collapsed.
 *
 * @param {unknown} job
 * @returns {string}
 */
export function jobDisplayTitle(job) {
  return dedupeAdjacentTitleWords(originalJobTitle(job));
}

/**
 * Lower-case, diacritic-free alphanumeric tokens of a title, short tokens
 * included ("M1", "HF" carry meaning in job titles).
 *
 * @param {string} title
 * @returns {string[]}
 */
export function jobTitleTokens(title) {
  return String(title || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * True when a localized title is a TRUNCATION of the source title rather than
 * a translation: every one of its tokens already appears in the source, and at
 * least one real word of the source (four letters or more — the trade, not a
 * gender code such as `m/w/d`) is missing.
 *
 *   ("M1, M2", "Macchinista M1, M2,M3")                  → true
 *   ("Software Engineer", "Software Engineer (m/w/d)")    → false (only m/w/d lost)
 *   ("Optometrist/eye optic master", "Optometrist/Augenoptikermeister") → false
 *     (introduces new words: a translation, good or bad)
 *
 * A slug derived from such a title loses the trade from the URL
 * (`/de/jobs-im-tessin/m1-m2-pemsa-lugano/`), so slug writers derive from the
 * source title instead.
 *
 * @param {string} localeTitle
 * @param {string} sourceTitle
 * @returns {boolean}
 */
export function localeTitleDropsSourceWords(localeTitle, sourceTitle) {
  const localeTokens = new Set(jobTitleTokens(localeTitle));
  const sourceTokens = new Set(jobTitleTokens(sourceTitle));
  if (localeTokens.size === 0 || sourceTokens.size === 0) return false;
  for (const token of localeTokens) {
    if (!sourceTokens.has(token)) return false;
  }
  for (const token of sourceTokens) {
    if (!localeTokens.has(token) && /^[a-z]{4,}$/.test(token)) return true;
  }
  return false;
}

/**
 * The title a locale slug is derived from: the localized title, unless it is a
 * truncation of the source (`localeTitleDropsSourceWords`), in which case the
 * source title — a slug must never lose the trade the employer wrote.
 *
 * Every title→slug writer uses this one function (regenerate-slugs-by-locale,
 * hardenJobLocaleFields, ensureLocaleFields) so they derive the same slug and
 * cannot undo each other's repair.
 *
 * @param {string} localeTitle
 * @param {string} sourceTitle
 * @returns {string}
 */
export function losslessSlugTitle(localeTitle, sourceTitle) {
  return localeTitleDropsSourceWords(localeTitle, sourceTitle) ? clean(sourceTitle) : String(localeTitle || '');
}

/**
 * True when a locale slug (company/location tokens removed by the caller) is
 * a truncation of the source title — `m1-m2` for "Macchinista M1, M2,M3".
 *
 * @param {string} slugTitlePart  slug title tokens, any separator
 * @param {string} sourceTitle
 * @returns {boolean}
 */
export function slugDropsSourceWords(slugTitlePart, sourceTitle) {
  return localeTitleDropsSourceWords(String(slugTitlePart || '').replace(/-/g, ' '), sourceTitle);
}
