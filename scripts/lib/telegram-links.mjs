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
 * The generic query-string mechanics live in `withUtm()` in social-post-utils.mjs
 * and are REUSED here — this module only pins the Telegram identity and the
 * campaign names.
 *
 * Naming convention, shared with scripts/send-job-alerts.mjs,
 * scripts/newsletter-template.mjs and build-plugins/jobsSeoPagesPlugin.ts:
 * `utm_medium` is the channel CLASS, `utm_source` the specific IDENTIFIER.
 */

import { withUtm } from './social-post-utils.mjs';

/** Identifier of this specific channel. Matches the `t.me` referrer host. */
export const TELEGRAM_UTM_SOURCE = 'telegram';

/** Channel class. `social` groups Telegram with the other social posters. */
export const TELEGRAM_UTM_MEDIUM = 'social';

/** Campaign per broadcast mode — one per cron in telegram-channel-broadcast.yml. */
export const TELEGRAM_CAMPAIGN_JOBS = 'jobs_digest';
export const TELEGRAM_CAMPAIGN_BORDER = 'border_ranking';

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
  return withUtm(url, {
    source: TELEGRAM_UTM_SOURCE,
    medium: TELEGRAM_UTM_MEDIUM,
    campaign,
    content,
  });
}
