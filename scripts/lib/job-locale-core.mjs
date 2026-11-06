/**
 * Dependency-free locale primitives shared by job-locale-utils and readers
 * that must load without npm packages (for example social post confirmation).
 */
export const DEFAULT_JOB_LOCALES = ['it', 'en', 'de', 'fr'];

/**
 * Normalize a stored locale without inventing a supported one.
 *
 * Crawlers occasionally persist regional spellings (`de-CH`, `it_CH`) while
 * the locale maps use the base ISO-639 code. Callers that need to accept only
 * supported locales still validate the returned value against
 * DEFAULT_JOB_LOCALES; this helper only performs the mechanical normalization.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeJobLocale(value = '') {
  return String(value ?? '').trim().toLowerCase().split(/[-_]/)[0];
}

/**
 * Case- and punctuation-insensitive, but diacritic-sensitive on purpose:
 * "CSV Requirements Ingenieur" and its correct French slot
 * "CSV Requirements Ingénieur" differ only by the accent.
 */
const normalizeTitleForCompare = (value) =>
  String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The one source-copy predicate used by title queueing and title writers.
 * Punctuation/whitespace-only changes are still a copy; diacritics remain
 * significant so a real translation such as `Ingénieur` is not discarded.
 */
export function isTitleSourceCopy(title, sourceTitle) {
  const clean = String(title || '').trim();
  const source = String(sourceTitle || '').trim();
  return !!clean && !!source
    && normalizeTitleForCompare(clean) === normalizeTitleForCompare(source);
}

// A failed LLM call can return its instruction/reasoning as the title. This is
// not a source-copy and therefore needs its own narrow, phrase-based predicate.
const LLM_REASONING_TITLE_RE = /\b(?:i\s+need\s+to\s+translate|translate\s+(?:this|the)\s+(?:job\s+)?title|the\s+translated\s+(?:job\s+)?title|here\s+is\s+the\s+translation|as\s+an\s+ai|target\s+language\s*:\s*|source\s+language\s*:)/iu;

export function titleContainsLlmReasoning(title = '') {
  return LLM_REASONING_TITLE_RE.test(String(title || '').trim());
}
