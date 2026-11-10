/**
 * Job title identity and presentation.
 *
 * Two different questions, two functions:
 *
 *   - IDENTITY — `originalJobTitle` / `jobDisplayTitle` (no locale): the title
 *     as the employer published it. Dedup, matching, slug repair, search
 *     aliases and the non-localized channels (emails, chatbot) key on this
 *     value; it never changes with the reader's language.
 *   - PRESENTATION — `localizedJobDisplayTitle(job, locale)`: the title a page
 *     in `locale` shows (<title>, og/twitter, H1, breadcrumb, meta
 *     description, JobPosting.title, hub ItemList names, SPA view).
 *
 * Decision (owner, 2026-11-10 — supersedes the SEO-plan decision of
 * 2026-10-23 that showed the employer's original title in every locale): a
 * job page shows its title IN THE LANGUAGE OF THE PAGE, i.e. the translated
 * `titleByLocale[locale]` slot — the same slot the locale slug is derived
 * from. The original title is the fallback ONLY when the locale has no usable
 * translation:
 *
 *   - `missing`   — no `titleByLocale[locale]` slot (or an empty one);
 *   - `truncated` — the slot is a TRUNCATION of the source title rather than a
 *     translation ("M1, M2" for "Macchinista M1, M2,M3",
 *     `localeTitleDropsSourceWords`): the slug writers already refuse that
 *     slot (`losslessSlugTitle`), so the page title follows the slug.
 *
 * Locale-flattened records (slim index, SPA seed) carry no `titleByLocale`:
 * their `title` IS the localized title written by `buildLocaleJob`, so the
 * presentation function returns it as is.
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
      if (prevEndsInWord && /^[\p{L}\p{N}]/u.test(token) && key.length >= 2 && /\p{L}/u.test(key) && key === wordKey(prev)) {
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
 * The employer's original title with back-to-back repeated words collapsed.
 * Locale-independent: use it for identity and for channels that have no page
 * language. A page in a locale displays `localizedJobDisplayTitle` instead.
 *
 * @param {unknown} job
 * @returns {string}
 */
export function jobDisplayTitle(job) {
  return dedupeAdjacentTitleWords(originalJobTitle(job));
}

function shortLocale(locale) {
  return clean(locale).toLowerCase().split(/[-_]/)[0];
}

/**
 * A machine translation sometimes closes the title with a sentence period
 * ("Carpentiere per lavori di assistenza e manutenzione.") that the employer's
 * title does not have. Drop that one period; an abbreviation ("… Dipl.",
 * "… dott.") or a period the source also ends with is kept.
 */
function dropTranslationPeriod(translated, sourceTitle) {
  if (!/[\p{L}\p{N})]{5,}\.$/u.test(translated)) return translated;
  if (clean(sourceTitle).endsWith('.')) return translated;
  return translated.slice(0, -1).trimEnd();
}

/**
 * Which title a page in `locale` shows, and why.
 *
 * @param {unknown} job
 * @param {string} locale  page locale (`it`, `en`, `de`, `fr`; `de-CH` accepted)
 * @returns {{ title: string, source: 'translation' | 'original', reason: 'translated' | 'flattened' | 'missing' | 'truncated' }}
 */
export function localizedJobTitleResolution(job, locale) {
  const original = jobDisplayTitle(job);
  if (!job || typeof job !== 'object') return { title: original, source: 'original', reason: 'missing' };
  const byLocale = job.titleByLocale && typeof job.titleByLocale === 'object' ? job.titleByLocale : null;
  if (!byLocale) {
    // Locale-flattened record: `title` already is the locale's title.
    const flattened = dedupeAdjacentTitleWords(clean(job.title));
    return flattened
      ? { title: flattened, source: 'translation', reason: 'flattened' }
      : { title: original, source: 'original', reason: 'missing' };
  }
  const translated = clean(byLocale[shortLocale(locale)]);
  if (!translated) return { title: original, source: 'original', reason: 'missing' };
  const sourceTitle = originalJobTitle(job);
  if (localeTitleDropsSourceWords(translated, sourceTitle)) {
    return { title: original, source: 'original', reason: 'truncated' };
  }
  const title = dedupeAdjacentTitleWords(dropTranslationPeriod(translated, sourceTitle));
  return title
    ? { title, source: 'translation', reason: 'translated' }
    : { title: original, source: 'original', reason: 'missing' };
}

/**
 * The title a job page (or any job surface) in `locale` displays: the
 * translated title, falling back to the employer's original only when the
 * locale has no usable translation (see `localizedJobTitleResolution`).
 *
 * @param {unknown} job
 * @param {string} locale
 * @returns {string}
 */
export function localizedJobDisplayTitle(job, locale) {
  return localizedJobTitleResolution(job, locale).title;
}

/**
 * Search text for a job title: the employer's original title plus every
 * localized slot as a search alias, so a query in any language finds the job
 * whichever title the page displays.
 *
 * @param {unknown} job
 * @returns {string}
 */
export function jobSearchTitleText(job) {
  const display = jobDisplayTitle(job);
  if (!job || typeof job !== 'object') return display;
  const byLocale = job.titleByLocale && typeof job.titleByLocale === 'object' ? job.titleByLocale : {};
  const aliases = Object.values(byLocale).filter((value) => typeof value === 'string' && value.trim());
  return [display, ...aliases].filter(Boolean).join(' ');
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
