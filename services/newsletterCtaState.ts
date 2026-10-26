/**
 * newsletterCtaState — synchronous eligibility check for the inline
 * post-calculation newsletter CTA (SubscriptionCTA).
 *
 * Extracted so layout code (MobileCalcLayout, Skeletons) can decide
 * SYNCHRONOUSLY at render time whether to reserve vertical space for the
 * CTA banner. Deciding it in an effect (previous SubscriptionCTA behavior)
 * meant the banner mounted one commit later, growing the page ~700px
 * mid-flow — a Cumulative Layout Shift source on the homepage (#3529).
 *
 * Deliberately dependency-free (no firebase, no analytics) so importing it
 * eagerly does not bloat the mobile-calc chunk.
 */

export const NEWSLETTER_CTA_DISMISSED_KEY = 'newsletter_cta_dismissed';
export const NEWSLETTER_SUBSCRIBED_KEY = 'newsletter_subscribed';
export const NEWSLETTER_CTA_DISMISS_DAYS = 14;
const NEWSLETTER_CTA_DISMISS_TIMESTAMP_RE = /^\d+$/;
const NEWSLETTER_CTA_DISMISS_WINDOW_MS = NEWSLETTER_CTA_DISMISS_DAYS * 24 * 60 * 60 * 1000;

/**
 * True when the inline newsletter CTA would be shown to this visitor:
 * not already subscribed and not dismissed within the last 14 days.
 * (Auth state is NOT considered here — it resolves asynchronously; the
 * signed-in cohort on the calculator is negligible and the CTA itself
 * still nulls out for signed-in users.)
 */
export function isNewsletterCtaEligible(): boolean {
  try {
    if (localStorage.getItem(NEWSLETTER_SUBSCRIBED_KEY) === 'true') return false;
    const dismissed = localStorage.getItem(NEWSLETTER_CTA_DISMISSED_KEY);
    if (dismissed) {
      // localStorage is user-controlled: parseInt() would accept a numeric
      // prefix and a future timestamp would suppress the CTA indefinitely.
      // Only a safe, complete timestamp in the past can be an active dismissal.
      const dismissedAt = NEWSLETTER_CTA_DISMISS_TIMESTAMP_RE.test(dismissed)
        ? Number(dismissed)
        : Number.NaN;
      const ageMs = Date.now() - dismissedAt;
      if (Number.isSafeInteger(dismissedAt) && ageMs >= 0 && ageMs < NEWSLETTER_CTA_DISMISS_WINDOW_MS) return false;
    }
    return true;
  } catch {
    // localStorage unavailable (privacy mode / SSR) — don't reserve space.
    return false;
  }
}
