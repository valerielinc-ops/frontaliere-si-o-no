/**
 * Non-Italian script detector for model-output sanity checks.
 *
 * History — run 26446721285 (2026-05-26): the fallback chain rotated to
 * nvidia/llama-3.3-nemotron-super-49b-v1 which produced a 100%-Chinese
 * headline ("AVS超過2.6百万人领取老年金"). The validator rejected it as
 * "1 parola, range 2-22" but only AFTER consuming the entire headline-
 * retry budget — the run hard-failed with no article published.
 *
 * This helper catches the drift at the JSON-validation layer so the chain
 * rotates to a different model (via `recordModelContentFailure`) without
 * burning the outer headline-validation budget. The threshold is
 * deliberately permissive (10%): Italian editorial titles may legitimately
 * contain single CJK names (e.g. "北京") in quoted brand references, but
 * >10% means the body of the text is non-IT.
 */

// Non-Latin "letter" ranges that we treat as evidence the model has
// switched language. Covers Cyrillic, Armenian, Hebrew, Arabic, CJK
// punctuation/Hiragana/Katakana, CJK Ext-A, CJK Unified, and Hangul.
const NON_LATIN_SCRIPT_RE = /[Ѐ-ԯ԰-֏֐-׿؀-ۿ　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿가-힯]/gu;
// All Unicode letters — denominator for the ratio.
const ANY_LETTER_RE = /\p{L}/gu;

/**
 * Returns the fraction of "letter" characters in `text` that belong to a
 * non-Latin script (CJK / Cyrillic / Hebrew / Arabic / Hangul / Armenian).
 * Range 0..1. Returns 0 for non-strings, empty strings, or strings with
 * no letters at all.
 *
 * @param {string} text
 * @returns {number}
 */
export function nonItalianScriptRatio(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const letters = text.match(ANY_LETTER_RE) || [];
  if (letters.length === 0) return 0;
  const nonLatin = text.match(NON_LATIN_SCRIPT_RE) || [];
  return nonLatin.length / letters.length;
}

/**
 * `true` if more than `threshold` (default 10%) of the letters in `text`
 * belong to a non-Latin script. Use to gate fallback model output.
 *
 * @param {string} text
 * @param {number} [threshold=0.1]
 * @returns {boolean}
 */
export function isNonItalianScript(text, threshold = 0.1) {
  return nonItalianScriptRatio(text) > threshold;
}
