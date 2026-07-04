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
      const daysSince = (Date.now() - parseInt(dismissed, 10)) / (1000 * 60 * 60 * 24);
      if (daysSince < NEWSLETTER_CTA_DISMISS_DAYS) return false;
    }
    return true;
  } catch {
    // localStorage unavailable (privacy mode / SSR) — don't reserve space.
    return false;
  }
}
