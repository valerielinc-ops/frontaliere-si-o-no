/**
 * Explicit producer/validator contract for intentional deep-pagination pages.
 *
 * A pagination page may be deliberately noindex because it is below the
 * archive's indexability floor, but the deploy validator must be able to
 * distinguish that documented decision from an accidental noindex directive.
 * Keep this marker owned by the generator side of the site/corpus boundary so
 * every producer can emit the same contract without importing validator code.
 */
export const PAGINATION_NOINDEX_TARGET_MARKER = '<!--PAGINATION_NOINDEX_TARGET-->';
