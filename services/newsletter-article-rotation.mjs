/**
 * Pure selection logic for the newsletter's "Most read" featured article.
 *
 * Kept standalone (no Firestore / fs imports) so it can be unit-tested and
 * called from a dry-run script without booting the full send-newsletter CLI.
 */

/**
 * @param {Array<{id:string,views:number,lastViewed:Date|null}>} topArticles
 *   Firestore article_views docs, sorted by views desc upstream.
 * @param {string[]} recentlyFeatured  Article IDs to exclude (rotation history),
 *   most-recent first.
 * @param {(id:string)=>boolean} hasMeta  Whether a blog post exists for the ID.
 * @param {number} [now=Date.now()]  Injected for deterministic tests.
 * @param {string[]} [recentlyPublished=[]]  Second-tier pool: article IDs sorted
 *   by publish date descending. Used when the views-based pool is exhausted
 *   (every top-viewed article is in the exclude list). Promotes new content
 *   instead of ruminating evergreen winners.
 * @returns {{id: string|null, reason: string}}
 */
export function selectFeaturedArticleId(
  topArticles,
  recentlyFeatured,
  hasMeta,
  now = Date.now(),
  recentlyPublished = [],
) {
  const byViewsThenRecency = (a, b) =>
    b.views - a.views || (b.lastViewed || 0) - (a.lastViewed || 0);
  const allSorted = [...(topArticles || [])].sort(byViewsThenRecency);
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const recentTop = allSorted.filter((a) => a.lastViewed && a.lastViewed > weekAgo);

  // 1. Recently viewed AND not in exclude list AND has meta.
  // 2. Any all-time top not in exclude list AND has meta.
  const fresh =
    recentTop.find((a) => !recentlyFeatured.includes(a.id) && hasMeta(a.id)) ||
    allSorted.find((a) => !recentlyFeatured.includes(a.id) && hasMeta(a.id));
  if (fresh) return { id: fresh.id, reason: 'fresh' };

  // 3. Second-tier pool: recently-published article that hasn't been featured
  //    yet. Promotes new content when the views-based pool is exhausted.
  const freshlyPublished = recentlyPublished.find(
    (id) => !recentlyFeatured.includes(id) && hasMeta(id),
  );
  if (freshlyPublished) return { id: freshlyPublished, reason: 'recent-publication' };

  // 4. Rotation truly exhausted — reuse the LEAST recently featured among the
  //    top-viewed (recentlyFeatured is most-recent first, so a higher index
  //    means "featured longer ago"). Avoids picking the all-time #1 every week.
  if (allSorted.length === 0) return { id: null, reason: 'no-top-articles' };
  const eligible = allSorted.filter((a) => hasMeta(a.id));
  if (eligible.length === 0) return { id: null, reason: 'no-meta-for-any-top' };
  const stalenessRank = (id) => {
    const idx = recentlyFeatured.indexOf(id);
    // Never featured → most "stale" → highest rank.
    return idx === -1 ? Number.POSITIVE_INFINITY : idx;
  };
  eligible.sort((a, b) => stalenessRank(b.id) - stalenessRank(a.id) || b.views - a.views);
  return { id: eligible[0].id, reason: 'rotation-exhausted' };
}
