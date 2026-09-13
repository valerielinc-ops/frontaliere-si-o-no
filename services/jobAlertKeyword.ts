/**
 * Shared keyword normalisation for job-alert matching and eligibility.
 *
 * Keeping this helper independent from Firestore makes every CTA use the same
 * comparison without pulling the CRUD service into the board's entry chunk.
 */

/** Remove pictographs, variation selectors and ZWJ from a category label. */
export function stripKeywordEmoji(s: string): string {
  return (s || '')
    .replace(/[\p{Extended_Pictographic}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalise a free-form keyword/category string for stable comparison. */
export function normalizeKeyword(s: string): string {
  return stripKeywordEmoji(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}
