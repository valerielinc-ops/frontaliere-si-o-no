/**
 * newsletterSegments.js — SINGLE SOURCE of the newsletter segmentation engine
 * (#4299) and the drip-sequence interest→segment collapse (#4451), so the
 * regular weekly send, the onboarding drip, the win-back campaign, and the
 * welcome-email Cloud Function all classify a subscriber the exact same way
 * and can never disagree on the `drip_segment` value they persist.
 *
 * Canonical home is functions/src/lib/ (not services/) because the welcome
 * email is built inside a Cloud Function and firebase.json's `source:
 * "functions"` means functions/src/** can only import from within functions/
 * — no bundler, no reach into the repo-root services/ tree (same deploy
 * boundary documented in functions/src/lib/newsletterUrls.js). Previously
 * functions/src/newsletterWelcomeEmail.js kept a private, byte-identical
 * replica of inferInterest/resolveDripSegment for this reason; that replica
 * is now gone (AGENTS.md Non-Negotiable #6) — services/newsletter-segments.mjs
 * re-exports everything below so every scripts/ and services/ importer
 * (send-newsletter.mjs, send-onboarding-drip.mjs, newsletter-winback-campaign.mjs,
 * onboardingDrip.mjs, ...) keeps resolving to the exact same module, zero
 * edits required.
 *
 * Pure, dependency-free classifier that turns a projected subscriber (see
 * `scripts/lib/subscriberFromFirestoreRow.mjs`) into a content segment:
 *
 *   - hot/warm subscribers  → `novelty_interest` strategy, one segment per
 *     (engagement level × inferred interest), e.g. `hot_jobs`, `warm_articles`.
 *   - cool/cold/unknown     → `digest` strategy, a single best-of digest.
 *   - dormant               → `winback` strategy (handled by the separate
 *     win-back campaign, scripts/newsletter-winback-campaign.mjs).
 *
 * Deliberately has NO Firestore/fs access — everything here takes plain
 * objects/arrays in and returns plain objects/arrays out, so it can be
 * exercised with cheap fixtures under vitest (no mocking required) and
 * reused both by the regular weekly send (`scripts/send-newsletter.mjs`)
 * and by reporting/monitoring scripts.
 */

export const INTERESTS = Object.freeze({
  JOBS: 'jobs',
  ARTICLES: 'articles',
  UTILITY: 'utility',
  GENERAL: 'general',
});

export const CONTENT_STRATEGIES = Object.freeze({
  NOVELTY_INTEREST: 'novelty_interest',
  DIGEST: 'digest',
  WINBACK: 'winback',
});

// Route families captured on the subscriber doc by services/newsletterSubscribers.ts
// (`source_route_family`) and projected onto the subscriber by
// subscriberFromFirestoreRow.mjs as `sourceRouteFamily`.
const JOB_ROUTE_FAMILIES = new Set(['jobs_index', 'jobs_company', 'jobs_search', 'job_detail']);
const ARTICLE_ROUTE_FAMILIES = new Set(['article_detail', 'article_index']);
const UTILITY_ROUTE_FAMILIES = new Set([
  'calculator', 'comparison', 'guide', 'tax', 'life', 'glossary', 'stats_detail', 'stats_index',
]);
const JOB_COMPONENTS = new Set(['JobBoard', 'JobExpiredView', 'JobBridgeView', 'JobOrphanView']);
const UTILITY_COMPONENTS = new Set(['TaxCalendar']);

export function inferInterest(subscriber) {
  const component = subscriber?.sourceComponent || null;
  const routeFamily = subscriber?.sourceRouteFamily || null;
  if (component && JOB_COMPONENTS.has(component)) return INTERESTS.JOBS;
  if (component && UTILITY_COMPONENTS.has(component)) return INTERESTS.UTILITY;
  if (routeFamily && JOB_ROUTE_FAMILIES.has(routeFamily)) return INTERESTS.JOBS;
  if (routeFamily && ARTICLE_ROUTE_FAMILIES.has(routeFamily)) return INTERESTS.ARTICLES;
  if (routeFamily && UTILITY_ROUTE_FAMILIES.has(routeFamily)) return INTERESTS.UTILITY;
  if (subscriber?.job_slug || subscriber?.job_search_query || subscriber?.job_company) {
    return INTERESTS.JOBS;
  }
  return INTERESTS.GENERAL;
}

function normalizeLevel(level) {
  const l = String(level || '').toLowerCase();
  return ['hot', 'warm', 'cool', 'cold', 'dormant'].includes(l) ? l : 'dormant';
}

/**
 * Map an engagement level to the content strategy used to build the email.
 * @param {string} level
 * @returns {'novelty_interest'|'digest'|'winback'}
 */
export function contentStrategyForLevel(level) {
  const l = normalizeLevel(level);
  if (l === 'hot' || l === 'warm') return CONTENT_STRATEGIES.NOVELTY_INTEREST;
  if (l === 'dormant') return CONTENT_STRATEGIES.WINBACK;
  return CONTENT_STRATEGIES.DIGEST; // cool, cold
}

/**
 * Full segment description for a subscriber — single source of truth
 * consumed both by content assembly (send-newsletter.mjs) and by reporting
 * (segment sizing / per-segment metrics).
 *
 * @param {Record<string, any>} subscriber
 * @returns {{ segmentId: string, strategy: string, interest: string|null, level: string }}
 */
export function describeSegment(subscriber) {
  const level = normalizeLevel(subscriber?.engagementLevel);
  const strategy = contentStrategyForLevel(level);
  const interest = strategy === CONTENT_STRATEGIES.NOVELTY_INTEREST ? inferInterest(subscriber) : null;
  const segmentId =
    strategy === CONTENT_STRATEGIES.NOVELTY_INTEREST
      ? `${level}_${interest}`
      : strategy === CONTENT_STRATEGIES.WINBACK
        ? 'dormant'
        : 'digest';
  return { segmentId, strategy, interest, level };
}

/**
 * @param {Record<string, any>} subscriber
 * @returns {string} segment id, e.g. "hot_jobs", "digest", "dormant"
 */
export function resolveSegment(subscriber) {
  return describeSegment(subscriber).segmentId;
}

/**
 * @param {Array<Record<string, any>>} subscribers
 * @returns {Record<string, number>} segment id → count
 */
export function summarizeSegments(subscribers) {
  const counts = new Map();
  for (const subscriber of subscribers || []) {
    const id = resolveSegment(subscriber);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return Object.fromEntries(counts);
}

// Winner clusters (data/article-performance.json) preferred per interest —
// see the issue's own finding: pratico/fiscale/novita perform, generic doesn't.
const INTEREST_CLUSTER_PREFERENCE = Object.freeze({
  [INTERESTS.JOBS]: ['lavoro', 'pratico'],
  [INTERESTS.ARTICLES]: ['novita', 'mobilita'],
  [INTERESTS.UTILITY]: ['fiscale', 'pratico'],
  [INTERESTS.GENERAL]: [],
});

/**
 * Rank article-performance winners for a given interest, preferred-cluster
 * matches first (each internally sorted by score desc), then the remaining
 * non-excluded winners. Pure — takes the already-loaded `winners` array
 * (data/article-performance.json's `.winners`), never reads the filesystem.
 *
 * @param {string} interest one of INTERESTS
 * @param {Array<{slug:string, cluster:string, score:number}>} winners
 * @param {{ excludeClusters?: string[], limit?: number }} [opts]
 * @returns {string[]} ordered candidate slugs
 */
export function selectWinnerCandidates(interest, winners, opts = {}) {
  const { excludeClusters = ['generic'], limit = 5 } = opts;
  const pool = (winners || []).filter((w) => w?.slug && !excludeClusters.includes(w.cluster));
  const scored = [...pool].sort((a, b) => (b.score || 0) - (a.score || 0));
  const preferred = INTEREST_CLUSTER_PREFERENCE[interest] || [];
  const preferredSet = preferred.length ? scored.filter((w) => preferred.includes(w.cluster)) : [];
  const rest = scored.filter((w) => !preferredSet.includes(w));
  return [...preferredSet, ...rest].slice(0, limit).map((w) => w.slug);
}

/**
 * Resolve which article-performance slugs to offer a subscriber, and in
 * what shape ("single" novelty pick for hot/warm, "digest" best-of list for
 * cool/cold, "none" for the win-back strategy which has its own email).
 * The caller (send-newsletter.mjs) still has to localize each slug via its
 * own `localizeArticle()` — this only picks candidates, in preference
 * order, so the caller can fall back to the next slug if a locale/meta
 * lookup misses.
 *
 * @param {Record<string, any>|{strategy:string, interest:string|null}} subscriberOrSegment
 * @param {Array<{slug:string, cluster:string, score:number}>} winners
 * @param {{ limit?: number, digestLimit?: number }} [opts]
 * @returns {{ mode: 'single'|'digest'|'none', slugs: string[] }}
 */
export function selectArticleCandidates(subscriberOrSegment, winners, opts = {}) {
  const info = subscriberOrSegment?.strategy ? subscriberOrSegment : describeSegment(subscriberOrSegment);
  const { limit = 5, digestLimit = 3 } = opts;
  if (info.strategy === CONTENT_STRATEGIES.DIGEST) {
    return { mode: 'digest', slugs: selectWinnerCandidates(INTERESTS.GENERAL, winners, { limit: digestLimit }) };
  }
  if (info.strategy === CONTENT_STRATEGIES.NOVELTY_INTEREST) {
    return { mode: 'single', slugs: selectWinnerCandidates(info.interest, winners, { limit }) };
  }
  return { mode: 'none', slugs: [] };
}

/**
 * Onboarding-drip segment label — collapses the 4-value `interest` down to
 * the 2-value drip variant (day-3/day-7 card ordering, see
 * services/newsletter/onboardingDrip.mjs:resolveDripCards). Snapshotted on
 * the subscriber doc's `drip_segment` field for reporting/idempotency by
 * BOTH the welcome-email Cloud Function (on send) and the nightly
 * scripts/send-onboarding-drip.mjs runner (per step) — must stay the one
 * definition both read.
 * @param {string|null} interest one of 'jobs'|'utility'|'articles'|'general'|null
 * @returns {'jobs-first'|'utility-first'}
 */
export function resolveDripSegment(interest) {
  return interest === 'jobs' ? 'jobs-first' : 'utility-first';
}
