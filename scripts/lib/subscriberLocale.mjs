/**
 * Resolve a newsletter subscriber's locale from the common Firestore field
 * spellings. Shared by every sender/runner that emails a raw
 * newsletter_subscribers doc directly (scripts/newsletter-sunset.mjs,
 * scripts/newsletter-winback-campaign.mjs) so the fallback chain can't drift
 * between them.
 *
 * @param {object} sub Firestore newsletter_subscribers doc fields
 * @returns {string} 2-letter locale code, defaults to 'it'
 */
export function localeOf(sub) {
  return String(sub?.preferred_locale || sub?.locale || sub?.lang || 'it').split(/[-_]/)[0] || 'it';
}
