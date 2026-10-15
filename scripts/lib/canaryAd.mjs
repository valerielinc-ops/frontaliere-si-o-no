/**
 * canaryAd — shared owner identity + canary-ad helpers for the broadcast
 * pipelines (newsletter, sponsor blast, job alerts).
 *
 * A "canary" publisher ad is a REAL sponsored ad that enters the normal on-site
 * funnel (listing, search, SEO page, in-page apply) but whose BROADCAST
 * distribution — sponsor blast, weekly newsletter, job alerts — is restricted to
 * the site owner only. This lets us exercise the entire paid-ad loop end-to-end
 * without emailing real users a test listing.
 *
 * The gate is keyed on a single `canary: true` flag that the publisher-job
 * projection copies from the Firestore doc into every job record, so it travels
 * through the slice → assembled dataset → the broadcast scripts.
 *
 * Single source of truth so the three gates can't drift (AGENTS §6). The owner
 * email mirrors the ADMIN_EMAIL_WHITELIST in the app and send-newsletter.mjs;
 * override per-run with CANARY_OWNER_EMAIL.
 */

export const OWNER_EMAIL = String(
  process.env.CANARY_OWNER_EMAIL || 'valerielinc@gmail.com',
).trim().toLowerCase();

/** True when `email` is the site owner (case-insensitive, trimmed). */
export function isOwnerEmail(email) {
  return String(email || '').trim().toLowerCase() === OWNER_EMAIL;
}

/** True when a job/ad record is a canary (broadcast-restricted) listing. */
export function isCanaryJob(job) {
  return Boolean(job) && job.canary === true;
}
