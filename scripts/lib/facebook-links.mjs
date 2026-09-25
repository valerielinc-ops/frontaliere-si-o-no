/**
 * Single source of the Facebook Page channel's UTM identity.
 *
 * Same rationale as scripts/lib/telegram-links.mjs and
 * scripts/lib/linkedin-links.mjs: a link posted to a social channel without UTM
 * params lands in GA4 as Direct, so the channel reads as ZERO sessions while it
 * is in fact sending clicks — invisible, not absent. Measured 2026-08-24 on the
 * Telegram channel; `scripts/post-to-facebook.mjs` had the identical defect,
 * posting a bare `articleUrl` as the Graph API `link`.
 *
 * Convention (matches send-job-alerts.mjs, newsletter-template.mjs,
 * jobsSeoPagesPlugin.ts, telegram-links.mjs and linkedin-links.mjs):
 *   utm_medium = channel CLASS      → 'social'
 *   utm_source = channel IDENTIFIER → 'facebook'
 */

import { withUtm } from './social-post-utils.mjs';

export const FACEBOOK_UTM_SOURCE = 'facebook';
export const FACEBOOK_UTM_MEDIUM = 'social';

/**
 * One campaign per posting surface. They are distinct so GA4 can answer "which
 * of the three daily Facebook crons actually sends traffic" — collapsed into a
 * single campaign that question has no answer, and the answer is what decides
 * which cron is worth keeping.
 */
/** New-article announcement (manual post-to-facebook.mjs + schedule-fb-articles-daily.mjs). */
export const FACEBOOK_CAMPAIGN_ARTICLE = 'facebook_article';
/** Daily events digest (schedule-fb-events-daily.mjs). */
export const FACEBOOK_CAMPAIGN_EVENT = 'facebook_event';
/** Daily jobs digest (schedule-fb-jobs-daily.mjs). */
export const FACEBOOK_CAMPAIGN_JOB = 'facebook_job';

/**
 * Tag a site URL with this channel's identity.
 *
 * @param {string} url absolute site URL
 * @param {string} campaign one of the FACEBOOK_CAMPAIGN_* constants
 * @param {string} [content] free-form slot, used here for the article id
 * @returns {string} tagged URL (verbatim input if it cannot be parsed)
 */
export function facebookUrl(url, campaign, content) {
  return withUtm(url, {
    source: FACEBOOK_UTM_SOURCE,
    medium: FACEBOOK_UTM_MEDIUM,
    campaign,
    content,
  });
}
