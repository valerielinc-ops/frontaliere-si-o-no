/**
 * Shared translation-quality gate for free-cascade / provider output before it
 * is written to the indexed `descriptionByLocale` dataset.
 *
 * Single source of truth for the "hard char floor accepts clips" anti-pattern:
 * the free cascade (DeepL / Google Translate / SimplyTranslate) can return a
 * string cut to a provider-dependent length cap. A char floor alone accepts
 * those clips, so a faithful translation must also stay within
 * MIN_TRANSLATION_RATIO of the source length. When the source length is unknown
 * (empty/falsy), only the char floor applies.
 */

// A faithful translation stays within a reasonable band of the source length.
export const MIN_TRANSLATION_RATIO = 0.6;
// Absolute character floor: anything shorter is too thin to be a real
// translation regardless of the source length.
export const MIN_TRANSLATION_CHARS = 100;

/**
 * @param {string} source - original (source-language) text being translated
 * @param {string} translated - candidate translation to validate
 * @returns {boolean} true if the candidate is acceptable to persist
 */
export function isAcceptableTranslation(source, translated) {
  if (typeof translated !== 'string') return false;
  const candidate = translated.trim();
  if (candidate.length < MIN_TRANSLATION_CHARS) return false;
  const srcLen = (typeof source === 'string' ? source.trim() : '').length;
  if (srcLen > 0 && candidate.length < srcLen * MIN_TRANSLATION_RATIO) return false;
  return true;
}
