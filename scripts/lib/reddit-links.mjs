/**
 * Single source of the Reddit channel's UTM identity.
 *
 * Same rationale as scripts/lib/telegram-links.mjs and
 * scripts/lib/linkedin-links.mjs: a link posted to a social channel without UTM
 * params lands in GA4 as Direct, so the channel reads as ZERO sessions while it
 * is in fact sending clicks — invisible, not absent. Measured 2026-08-24 on the
 * Telegram channel; `scripts/post-to-reddit.mjs` had the identical defect,
 * submitting a bare `articleUrl` as the link post's `url`.
 *
 * Convention (matches send-job-alerts.mjs, newsletter-template.mjs,
 * jobsSeoPagesPlugin.ts, telegram-links.mjs and linkedin-links.mjs):
 *   utm_medium = channel CLASS      → 'social'
 *   utm_source = channel IDENTIFIER → 'reddit'
 *
 * `utm_content` carries the SUBREDDIT, not the article id: one article is
 * submitted to several subreddits in the same run, and without that the rows
 * collapse into one and there is no way to see which community actually sends
 * traffic — which is the only number that decides where to keep posting.
 */

import { withUtm } from './social-post-utils.mjs';

export const REDDIT_UTM_SOURCE = 'reddit';
export const REDDIT_UTM_MEDIUM = 'social';

/** New-article link post. */
export const REDDIT_CAMPAIGN_ARTICLE = 'reddit_article';

/**
 * Tag a site URL with this channel's identity.
 *
 * @param {string} url absolute site URL
 * @param {string} campaign one of the REDDIT_CAMPAIGN_* constants
 * @param {string} [content] free-form slot, used here for the subreddit name
 * @returns {string} tagged URL (verbatim input if it cannot be parsed)
 */
export function redditUrl(url, campaign, content) {
  return withUtm(url, {
    source: REDDIT_UTM_SOURCE,
    medium: REDDIT_UTM_MEDIUM,
    campaign,
    content,
  });
}
