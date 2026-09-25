/**
 * Pure selection logic for the newsletter's "Most read" featured article.
 *
 * Kept standalone (no Firestore / fs imports) so it can be unit-tested and
 * called from a dry-run script without booting the full send-newsletter CLI.
 */

const EVERGREEN_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

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
 * @param {(id:string)=>(Date|null)} [getPublishedAt]  Returns the publish date
 *   for an article ID, or null if unknown. Articles older than 1 year (or with
 *   unknown publish date) are treated as "evergreen" and de-prioritized: they
 *   still surface, but only after fresh-by-views and recently-published pools
 *   are exhausted. Pass an explicit getter to enable this behaviour; the
 *   default of `() => null` is a no-op for back-compat with existing tests.
 * @returns {{id: string|null, reason: string}}
 */
export function selectFeaturedArticleId(
  topArticles,
  recentlyFeatured,
  hasMeta,
  now = Date.now(),
  recentlyPublished = [],
  getPublishedAt = null,
) {
  const byViewsThenRecency = (a, b) =>
    b.views - a.views || (b.lastViewed || 0) - (a.lastViewed || 0);
  const allSorted = [...(topArticles || [])].sort(byViewsThenRecency);
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const recentTop = allSorted.filter((a) => a.lastViewed && a.lastViewed > weekAgo);

  // Evergreen test: opt-in via `getPublishedAt`. When the caller doesn't pass
  // a getter, behaviour is identical to pre-2026-05-19 (no penalty).
  const isEvergreen = (id) => {
    if (typeof getPublishedAt !== 'function') return false;
    const pub = getPublishedAt(id);
    if (!pub) return true; // unknown publish date → likely a legacy evergreen
    return now - pub.getTime() > EVERGREEN_AGE_MS;
  };
  const passesEvergreen = (a) => !isEvergreen(a.id);

  // 1. Recently viewed AND not in exclude list AND has meta AND not evergreen.
  // 2. Any all-time top not in exclude list AND has meta AND not evergreen.
  const fresh =
    recentTop.find((a) => !recentlyFeatured.includes(a.id) && hasMeta(a.id) && passesEvergreen(a)) ||
    allSorted.find((a) => !recentlyFeatured.includes(a.id) && hasMeta(a.id) && passesEvergreen(a));
  if (fresh) return { id: fresh.id, reason: 'fresh' };

  // 3. Recently-published pool — promote fresh content before falling through
  //    to evergreen reuse. This is what keeps `comuni-migliori-frontalieri`
  //    (and other ancient high-view evergreens) from coming back every 3
  //    months purely on the strength of their accumulated views.
  const freshlyPublished = recentlyPublished.find(
    (id) => !recentlyFeatured.includes(id) && hasMeta(id),
  );
  if (freshlyPublished) return { id: freshlyPublished, reason: 'recent-publication' };

  // 4. Evergreen fallback: an old high-view article is still better than
  //    re-using one we shipped last week. Only used when no fresh article
  //    qualifies under steps 1-3.
  const evergreenFresh =
    recentTop.find((a) => !recentlyFeatured.includes(a.id) && hasMeta(a.id)) ||
    allSorted.find((a) => !recentlyFeatured.includes(a.id) && hasMeta(a.id));
  if (evergreenFresh) return { id: evergreenFresh.id, reason: 'fresh-evergreen' };

  // 5. Rotation truly exhausted — reuse the LEAST recently featured among the
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
