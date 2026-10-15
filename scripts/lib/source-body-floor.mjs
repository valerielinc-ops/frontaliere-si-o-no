/**
 * Word floor for a job body read from the SOURCE (audit-parser-quality issue
 * 5253, AGENTS Non-Negotiable #4: never publish indexable thin content under
 * 50 words).
 *
 * The dedicated crawlers used to gate the source body on CHARACTER counts
 * (100, 150, 200 …) and then pad a short body with text we wrote ourselves.
 * With the padding removed, a character gate lets a 20-49-word body through
 * as a thin page: the floor has to be measured in words, in one place, so the
 * crawlers cannot drift apart again.
 *
 * Only words count: HTML tags, markdown markers (`##`, `-`, `**`, `|`) and
 * bare punctuation are not words.
 */
export const MIN_SOURCE_BODY_WORDS = 50;

/**
 * @param {string} text  source body (plain text, markdown or HTML)
 * @returns {number} number of tokens that carry a letter or a digit
 */
export function sourceBodyWordCount(text = '') {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .length;
}

/**
 * True when the source body is long enough to be published on its own.
 *
 * @param {string} text
 * @param {number} [minWords]
 */
export function meetsSourceBodyFloor(text = '', minWords = MIN_SOURCE_BODY_WORDS) {
  return sourceBodyWordCount(text) >= minWords;
}
