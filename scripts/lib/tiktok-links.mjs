/**
 * Single source of the TikTok channel's UTM identity.
 *
 * Same rationale as scripts/lib/instagram-links.mjs / linkedin-links.mjs: a
 * link posted to a social channel without UTM params lands in GA4 as Direct.
 * TikTok's photo-post captions have no clickable link either — this exists
 * for the bio link and any API field that does accept a URL, for the same
 * reason the Instagram equivalent exists.
 *
 * Convention (matches instagram-links.mjs / linkedin-links.mjs):
 *   utm_medium = channel CLASS      → 'social'
 *   utm_source = channel IDENTIFIER → 'tiktok'
 */

import { withUtm } from './social-post-utils.mjs';

export const TIKTOK_UTM_SOURCE = 'tiktok';
export const TIKTOK_UTM_MEDIUM = 'social';

/** Daily "most read articles" carousel. */
export const TIKTOK_CAMPAIGN_ARTICLE = 'tiktok_daily_article';
/** Daily "most clicked jobs" carousel. */
export const TIKTOK_CAMPAIGN_JOB = 'tiktok_daily_job';
/** Weekly "fastest dogane" carousel. */
export const TIKTOK_CAMPAIGN_BORDER = 'tiktok_weekly_border';

/**
 * Tag a site URL with this channel's identity.
 *
 * @param {string} url absolute site URL
 * @param {string} campaign one of the TIKTOK_CAMPAIGN_* constants
 * @param {string} [content] free-form slot, used here for the slug
 * @returns {string} tagged URL (verbatim input if it cannot be parsed)
 */
export function tiktokUrl(url, campaign, content) {
  return withUtm(url, {
    source: TIKTOK_UTM_SOURCE,
    medium: TIKTOK_UTM_MEDIUM,
    campaign,
    content,
  });
}
