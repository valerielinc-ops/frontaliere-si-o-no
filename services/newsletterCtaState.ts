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

/**
 * Returns whether a local dismissal timestamp is still inside its cooldown.
 * The value is untrusted browser state: numeric prefixes, unsafe integers and
 * future timestamps must never turn into an active dismissal. ISO strings are
 * accepted for the calculator paywall's legacy storage format.
 */
export function isDismissalActive(
  rawTimestamp: string | null,
  cooldownDays: number,
  now = Date.now(),
): boolean {
  if (!rawTimestamp) return false;
  const dismissedAt = NEWSLETTER_CTA_DISMISS_TIMESTAMP_RE.test(rawTimestamp)
    ? Number(rawTimestamp)
    : Date.parse(rawTimestamp);
  const ageMs = now - dismissedAt;
  return Number.isSafeInteger(dismissedAt)
    && Number.isFinite(cooldownDays)
    && cooldownDays >= 0
    && ageMs >= 0
    && ageMs < cooldownDays * 24 * 60 * 60 * 1000;
}

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
    if (isDismissalActive(dismissed, NEWSLETTER_CTA_DISMISS_DAYS)) return false;
    return true;
  } catch {
    // localStorage unavailable (privacy mode / SSR) — don't reserve space.
    return false;
  }
}
