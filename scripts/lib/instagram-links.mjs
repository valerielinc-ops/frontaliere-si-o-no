/**
 * Single source of the Instagram channel's UTM identity.
 *
 * Same rationale as scripts/lib/linkedin-links.mjs / telegram-links.mjs: a
 * link posted to a social channel without UTM params lands in GA4 as Direct,
 * so the channel reads as ZERO sessions while it is in fact sending clicks.
 *
 * Instagram itself never carries the link as a clickable URL in the post body
 * (feed posts have no clickable link in the caption) — these tagged URLs are
 * for the bio link and any Graph API fields that do accept one. The UTM
 * convention still matters there for the same reason.
 *
 * Convention (matches linkedin-links.mjs / telegram-links.mjs):
 *   utm_medium = channel CLASS      → 'social'
 *   utm_source = channel IDENTIFIER → 'instagram'
 */

import { withUtm } from './social-post-utils.mjs';

export const INSTAGRAM_UTM_SOURCE = 'instagram';
export const INSTAGRAM_UTM_MEDIUM = 'social';

/** Daily "most read articles" carousel. */
export const INSTAGRAM_CAMPAIGN_ARTICLE = 'instagram_daily_article';
/** Daily "most clicked jobs" carousel. */
export const INSTAGRAM_CAMPAIGN_JOB = 'instagram_daily_job';
/** Weekly "fastest dogane" carousel. */
export const INSTAGRAM_CAMPAIGN_BORDER = 'instagram_weekly_border';

/**
 * Tag a site URL with this channel's identity.
 *
 * @param {string} url absolute site URL
 * @param {string} campaign one of the INSTAGRAM_CAMPAIGN_* constants
 * @param {string} [content] free-form slot, used here for the slug
 * @returns {string} tagged URL (verbatim input if it cannot be parsed)
 */
export function instagramUrl(url, campaign, content) {
  return withUtm(url, {
    source: INSTAGRAM_UTM_SOURCE,
    medium: INSTAGRAM_UTM_MEDIUM,
    campaign,
    content,
  });
}
