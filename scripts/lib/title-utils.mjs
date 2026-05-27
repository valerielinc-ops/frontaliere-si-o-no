/**
 * Shared title utilities for dedicated crawlers.
 *
 * These are used by multiple job parsers that need to compare or validate
 * job title strings extracted from different sources (page link text,
 * meta tags, h1 elements, PDF headings, etc.).
 */

/** Minimum Jaccard overlap to consider two title strings as referring to the same role. */
export const MIN_TITLE_OVERLAP = 0.7;

/**
 * Word-level Jaccard similarity between two title strings.
 *
 * - Hyphens and underscores are treated as word separators.
 * - Comparison is case-insensitive.
 * - Returns 1 if both strings are empty, 0 if only one is empty.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} value in [0, 1]
 */
export function titleOverlap(a = '', b = '') {
  const words = (s) =>
    new Set(
      String(s || '')
        .toLowerCase()
        .replace(/[-_]/g, ' ')
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(Boolean)
    );
  const setA = words(a);
  const setB = words(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  return intersection / new Set([...setA, ...setB]).size;
}
