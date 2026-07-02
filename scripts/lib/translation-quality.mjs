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

// Locales where a single run of MIN_LEN+ letters with no internal space is a
// reliable "source words got glued together" signal (a known free-cascade
// title-translation failure — e.g. "Direttore di filiale" -> "Direttoredifiliale").
// German is deliberately excluded: legitimate compound nouns (e.g.
// "Geschäftsführerin", "Sachbearbeiterin") routinely clear 15+ letters with no
// space, so the same length-only heuristic would false-positive on healthy
// German titles instead of catching a translation defect.
const CONCATENATED_WORD_MIN_LEN = { it: 15, fr: 16, en: 16 };
const LETTER_TOKEN_RE = /^[a-zà-öø-ÿ]+$/i;

/**
 * Detects a title where 2+ source words were fused into one unspaced token
 * by a translation pass, instead of translating each word and keeping the
 * spaces. Only checked for locales in CONCATENATED_WORD_MIN_LEN — there is
 * no reliable length/charset split between this defect and a genuine long
 * compound word for other locales (notably German).
 *
 * @param {string} text - candidate title in the target locale
 * @param {string} locale - target locale of `text`
 * @returns {boolean} true if `text` looks like it has glued-together words
 */
export function hasConcatenatedWords(text, locale) {
  const minLen = CONCATENATED_WORD_MIN_LEN[locale];
  if (!minLen) return false;
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Split on hyphens too: hyphenated compounds (e.g. "Sous-directeur-adjoint",
  // "Employe-e") are legitimate multi-word titles, not glued-together output —
  // each hyphen-joined part must independently clear the length floor.
  return trimmed.split(/\s+/).some((rawToken) => rawToken.split(/[-–—]/).some((part) => {
    const token = part.replace(/[.,;:!?'’"()/]/g, '');
    return token.length >= minLen && LETTER_TOKEN_RE.test(token);
  }));
}
