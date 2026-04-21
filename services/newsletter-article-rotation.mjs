/**
 * Pure selection logic for the newsletter's "Most read" featured article.
 *
 * Kept standalone (no Firestore / fs imports) so it can be unit-tested and
 * called from a dry-run script without booting the full send-newsletter CLI.
 */

/**
 * @param {Array<{id:string,views:number,lastViewed:Date|null}>} topArticles
 *   Firestore article_views docs, sorted by views desc upstream.
 * @param {string[]} recentlyFeatured  Article IDs to exclude (rotation history).
 * @param {(id:string)=>boolean} hasMeta  Whether a blog post exists for the ID.
 * @param {number} [now=Date.now()]  Injected for deterministic tests.
 * @returns {{id: string|null, reason: string}}
 */
export function selectFeaturedArticleId(topArticles, recentlyFeatured, hasMeta, now = Date.now()) {
  if (!topArticles || topArticles.length === 0) return { id: null, reason: 'no-top-articles' };
  const byViewsThenRecency = (a, b) =>
    b.views - a.views || (b.lastViewed || 0) - (a.lastViewed || 0);
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const recentTop = topArticles
    .filter((a) => a.lastViewed && a.lastViewed > weekAgo)
    .sort(byViewsThenRecency);
  const allSorted = [...topArticles].sort(byViewsThenRecency);

  // Prefer a recently-viewed article that isn't in the rotation-exclude list.
  // Fall back to all-time top if no recent article qualifies — otherwise a
  // single fresh view on the currently-featured article would collapse the
  // candidate pool to one and defeat rotation.
  const fresh =
    recentTop.find((a) => !recentlyFeatured.includes(a.id) && hasMeta(a.id)) ||
    allSorted.find((a) => !recentlyFeatured.includes(a.id) && hasMeta(a.id));
  if (fresh) return { id: fresh.id, reason: 'fresh' };
  const reused = allSorted.find((a) => hasMeta(a.id));
  if (reused) return { id: reused.id, reason: 'rotation-exhausted' };
  return { id: null, reason: 'no-meta-for-any-top' };
}
