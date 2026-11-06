/**
 * The ONE place that owns how a Telegram broadcast link is tagged for GA4.
 *
 * WHY a dedicated module: both message builders — telegram-templates.mjs (daily
 * jobs digest) and telegram-border-digest.mjs (weekly dogane ranking) — need the
 * same `utm_source`/`utm_medium` identity. Copying the two literals into both
 * files is exactly the duplication that drifts (project rule: a constant
 * repeated in >=2 files lives in one shared module), and a drifted `utm_source`
 * splits one channel into two rows in GA4, which is worse than no tagging at
 * all because it looks like data.
 *
 * Clickable first-party destinations use the shared redirect route; external
 * destinations retain direct UTM parameters via social-post-utils.mjs.
 *
 * Naming convention, shared with scripts/send-job-alerts.mjs,
 * scripts/newsletter-template.mjs and build-plugins/jobsSeoPagesPlugin.ts:
 * `utm_medium` is the channel CLASS, `utm_source` the specific IDENTIFIER.
 */

import { SOCIAL_UTM_MEDIUM, SOCIAL_UTM_SOURCE_BY_CHANNEL } from './social-channel-attribution.mjs';
import { attributedSocialLink } from './social-redirect-links.mjs';

/** Identifier of this specific channel. Matches the `t.me` referrer host. */
export const TELEGRAM_UTM_SOURCE = SOCIAL_UTM_SOURCE_BY_CHANNEL.telegram;

/** Channel class. `social` groups Telegram with the other social posters. */
export const TELEGRAM_UTM_MEDIUM = SOCIAL_UTM_MEDIUM;

/** Campaign per broadcast mode — one per cron in telegram-channel-broadcast.yml. */
export const TELEGRAM_CAMPAIGN_JOBS = 'jobs_digest';
export const TELEGRAM_CAMPAIGN_BORDER = 'border_ranking';
// One-off announcement (not a cron), dispatched manually — see
// buildPreferredSourceAnnouncement() in telegram-templates.mjs.
export const TELEGRAM_CAMPAIGN_PREFERRED_SOURCE = 'preferred_source_announcement';

/**
 * Tag an absolute site URL as coming from the Telegram broadcast channel.
 *
 * Never throws and never drops the link: an unparseable URL comes back
 * verbatim (see `withUtm`), so a broadcast can lose its attribution but can
 * never lose its destination.
 *
 * @param {string} url — absolute site URL (canonical, trailing slash).
 * @param {string} campaign — TELEGRAM_CAMPAIGN_JOBS | TELEGRAM_CAMPAIGN_BORDER.
 * @param {string} [content] — optional slot discriminator (job slug, `hub`, …).
 * @returns {string}
 */
export function telegramUrl(url, campaign, content) {
  return attributedSocialLink(url, {
    source: TELEGRAM_UTM_SOURCE,
    medium: TELEGRAM_UTM_MEDIUM,
    campaign,
    content,
  });
}
