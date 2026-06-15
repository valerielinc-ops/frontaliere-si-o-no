/**
 * deliveryDocId.js — canonical id for a per-subscriber campaign delivery doc.
 *
 * Single source of truth for the SEND-path delivery doc id
 * (`newsletter_subscribers/{email}/campaign_deliveries/{id}`). The send pipeline
 * and the Resend webhook write here; the A/B report + lookupSentVariant read it.
 * Centralized so the format can't drift across the 3+ places that built it by
 * hand (a drift would make lookups silently return null).
 *
 * Note: the non-Resend ESP webhooks write their OWN delivery doc with a
 * DIFFERENT, single-underscore id (`${campaignId}_${email}`); only the
 * send-path / Resend docs use this double-underscore form. The report uses this
 * builder to keep only the canonical send docs (dropping the webhook duplicates).
 */

/** Lowercase+trim — must match scripts/send-newsletter.mjs normalizeEmail. */
function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

/**
 * @param {string} campaignId e.g. "weekly_2026-06-15"
 * @param {string} email
 * @returns {string} sanitized canonical send-doc id
 */
export function buildDeliveryDocId(campaignId, email) {
  return `${campaignId}__${normalizeEmail(email)}`.replace(/[^a-z0-9@._-]+/gi, '-');
}
