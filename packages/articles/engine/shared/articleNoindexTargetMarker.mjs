/**
 * Producer/validator contract for article bodies that still contain the
 * corpus translation placeholder. Such pages remain reachable and followable
 * but are deliberately withheld from the index until the body is complete.
 */
export const ARTICLE_NOINDEX_TARGET_MARKER = '<!--ARTICLE_NOINDEX_TARGET-->';
