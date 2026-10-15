/**
 * Campaign-aware article selection shared by the real weekly sender and its
 * pre-send QA renderer.
 *
 * The campaign id is stable across resume runs. We derive a weekly numeric
 * index from it and pass that into the pure segment selector, so a resumed
 * campaign keeps its article while the next weekly campaign advances through
 * the leading performance winners. No subscriber-specific randomness or
 * Firestore write is needed.
 */
import {
  CONTENT_STRATEGIES,
  describeSegment,
  INTERESTS,
  selectArticleCandidates,
} from '../../services/newsletter-segments.mjs';
import { getSeasonalUtilityContent } from '../../services/newsletter-seasonal.mjs';
import { loadArticlePerformanceWinners, localizeArticle } from './articleContent.mjs';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEKLY_CAMPAIGN_PREFIX = 'weekly_';

/**
 * Convert a weekly campaign id into a monotonic weekly index.
 * Invalid/non-weekly ids intentionally return null so callers preserve the
 * original score order instead of inventing a rotation for an ad-hoc send.
 *
 * @param {string} campaignId
 * @returns {number|null}
 */
export function campaignRotationIndex(campaignId) {
  const raw = String(campaignId || '');
  if (!raw.startsWith(WEEKLY_CAMPAIGN_PREFIX)) return null;
  const datePart = raw.slice(WEEKLY_CAMPAIGN_PREFIX.length);
  if (datePart.length !== 10) return null;
  const timestamp = Date.parse(`${datePart}T00:00:00Z`);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / WEEK_MS) : null;
}

/**
 * Resolve one article for the live newsletter template.
 *
 * @param {object} options
 * @param {Record<string, any>} options.subscriber
 * @param {string} options.locale
 * @param {string} options.campaignId
 * @param {(locale: string) => object|null} options.featuredArticleFn
 * @param {Date} [options.now]
 * @param {Array<{slug:string, cluster:string, score:number}>} [options.winners]
 * @param {(slug:string, locale:string) => object|null} [options.localizeArticleFn]
 * @param {(date:Date, locale:string) => object|null} [options.seasonalContentFn]
 * @returns {{ segment: string, article: object|null }}
 */
export function resolveNewsletterArticle({
  subscriber,
  locale,
  campaignId,
  featuredArticleFn,
  now = new Date(),
  winners = loadArticlePerformanceWinners(),
  localizeArticleFn = localizeArticle,
  seasonalContentFn = getSeasonalUtilityContent,
}) {
  const segmentInfo = describeSegment(subscriber);
  // Dormant subscribers still receive the regular weekly newsletter. Their
  // separate win-back sequence is additional, not a replacement for this
  // send, so use the digest ranking while retaining the dormant tag.
  const contentInfo = segmentInfo.strategy === CONTENT_STRATEGIES.WINBACK
    ? { strategy: CONTENT_STRATEGIES.DIGEST, interest: null }
    : segmentInfo;

  // Utility cohorts intentionally receive the time-of-year-relevant tool or
  // guide first. This is a product rule, not a performance-winner rotation.
  if (contentInfo.interest === INTERESTS.UTILITY) {
    const seasonal = seasonalContentFn(now, locale);
    if (seasonal) return { segment: segmentInfo.segmentId, article: seasonal };
  }

  const selection = selectArticleCandidates(contentInfo, winners, {
    rotationIndex: campaignRotationIndex(campaignId),
  });
  let article = null;
  if (selection.mode !== 'none') {
    for (const slug of selection.slugs) {
      const localized = localizeArticleFn(slug, locale);
      if (localized) {
        article = localized;
        break;
      }
    }
  }
  if (!article && typeof featuredArticleFn === 'function') article = featuredArticleFn(locale);

  return { segment: segmentInfo.segmentId, article };
}
