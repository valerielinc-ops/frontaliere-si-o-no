/**
 * Dependency-free title-source locale resolution.
 *
 * The social confirmation workflow and the follow-up drainer run without
 * `npm ci`. They need the stored title source locale, but must not load the
 * full locale utility because it uses the optional HTML entity decoder.
 *
 * This reader is intentionally conservative: explicit source metadata wins;
 * a unique locale-map copy is accepted as evidence; otherwise the caller's
 * fallback is used. Heuristic title detection belongs to the full crawler
 * path and is not needed to decide whether an agency title is publishable.
 */
import { DEFAULT_JOB_LOCALES, normalizeJobLocale } from './job-locale-core.mjs';

export function jobTitleSourceLang(job, fallback = '') {
  const fallbackLang = normalizeJobLocale(fallback);
  const storedLang = normalizeJobLocale(job?.sourceLang);
  const originalLang = normalizeJobLocale(job?.sourceLangOriginal);

  // Publisher-authored jobs carry an explicit source-language pin, including
  // an intentionally unsupported original locale such as Romansh.
  if (
    job?.source === 'publisher-submitted'
    && originalLang
    && originalLang === storedLang
    && !DEFAULT_JOB_LOCALES.includes(originalLang)
  ) return originalLang;
  if (job?.source === 'publisher-submitted' && DEFAULT_JOB_LOCALES.includes(storedLang)) return storedLang;
  if (DEFAULT_JOB_LOCALES.includes(storedLang)) return storedLang;

  const title = String(job?.title || '').trim().replace(/\s+/gu, ' ').toLowerCase();
  const titleByLocale = job?.titleByLocale && typeof job.titleByLocale === 'object'
    ? job.titleByLocale
    : {};
  if (title) {
    const matches = [...new Set(Object.entries(titleByLocale)
      .filter(([, value]) => String(value || '').trim().replace(/\s+/gu, ' ').toLowerCase() === title)
      .map(([locale]) => normalizeJobLocale(locale))
      .filter((locale) => DEFAULT_JOB_LOCALES.includes(locale)))];
    if (matches.length === 1) return matches[0];
  }

  return DEFAULT_JOB_LOCALES.includes(fallbackLang) ? fallbackLang : 'it';
}
