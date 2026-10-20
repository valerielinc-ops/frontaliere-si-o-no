/**
 * Publish-boundary slug exclusions mirrored from the corpus sitemap builder.
 * Keep this predicate in one plain-Node module so the API pull and its tests
 * judge the same reserved/service slugs as the publisher.
 */
const RESERVED_PUBLISHED_SLUGS = new Set(['null', 'undefined']);

const ARTICLE_SERVICE_MARKER_RULES = Object.freeze([
  /^abort(?:-|$)/i,
  /^(?:topical[-_]relevance|abort[-_]topical[-_]relevance)(?:-|$)/i,
  /^abort[-_]topical[-_]relevance(?:-|$)/i,
  /(?:^|-)reason(?:$|-(?:for-)?(?:reject(?:ion)?|abort|off-topic))/i,
]);

export function isReservedPublishedSlug(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/_/g, '-');
  if (!normalized) return false;
  if (RESERVED_PUBLISHED_SLUGS.has(normalized.toLowerCase())) return true;
  return ARTICLE_SERVICE_MARKER_RULES.some((pattern) => pattern.test(normalized));
}
