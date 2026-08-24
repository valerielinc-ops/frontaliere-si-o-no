/**
 * Single source of the LinkedIn channel's UTM identity — BOTH surfaces.
 *
 * Same rationale as scripts/lib/telegram-links.mjs: a link posted to a social
 * channel without UTM params lands in GA4 as Direct, so the channel reads as
 * ZERO sessions while it is in fact sending clicks. Measured 2026-08-24 on the
 * Telegram channel — daily posts, 0 sessions attributed. A *drifted*
 * `utm_source` is worse still: it splits one channel across two GA4 rows,
 * which looks like data instead of looking like a bug.
 *
 * Convention (matches scripts/send-job-alerts.mjs, scripts/newsletter-template.mjs,
 * build-plugins/jobsSeoPagesPlugin.ts and scripts/lib/telegram-links.mjs):
 *   utm_medium = channel CLASS      → 'social'
 *   utm_source = channel IDENTIFIER → 'linkedin'
 *
 * `utm_source` is deliberately `linkedin` and NOT `linkedin_member`: GA4 should
 * see one LinkedIn channel. The personal-profile vs Company-Page distinction is
 * carried by `utm_campaign` instead, so the two never split the source row.
 */

import { withUtm } from './social-post-utils.mjs';

export const LINKEDIN_UTM_SOURCE = 'linkedin';
export const LINKEDIN_UTM_MEDIUM = 'social';

/** Daily "most read article of yesterday" post, personal profile. */
export const LINKEDIN_MEMBER_CAMPAIGN_ARTICLE = 'linkedin_member_daily_article';
/** Daily "most clicked job of yesterday" post, personal profile. */
export const LINKEDIN_MEMBER_CAMPAIGN_JOB = 'linkedin_member_daily_job';
/** New-article announcement on the Company Page (scripts/post-to-linkedin.mjs). */
export const LINKEDIN_COMPANY_CAMPAIGN_ARTICLE = 'linkedin_company_article';

/**
 * Tag a site URL with this channel's identity.
 *
 * @param {string} url absolute site URL
 * @param {string} campaign one of the LINKEDIN_*_CAMPAIGN_* constants
 * @param {string} [content] free-form slot, used here for the slug
 * @returns {string} tagged URL (verbatim input if it cannot be parsed)
 */
export function linkedinUrl(url, campaign, content) {
  return withUtm(url, {
    source: LINKEDIN_UTM_SOURCE,
    medium: LINKEDIN_UTM_MEDIUM,
    campaign,
    content,
  });
}
