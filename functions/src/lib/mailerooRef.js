/**
 * mailerooRef.js — the lookup record Maileroo's engagement webhooks cannot work without.
 *
 * ── Why this file exists (misurato il 2026-08-20) ───────────────────────────
 *
 * Maileroo's `opened` / `clicked` webhook payloads carry NEITHER the recipient
 * NOR the tags — only `message_reference_id`. So the webhook
 * (functions/src/newsletterMailerooWebhookCore.js) can attribute an open to a
 * subscriber ONLY by reading back a record we wrote at send time, keyed by that
 * id. No record → `persistMailerooEvent` bails with `skipped: invalid_email`
 * and the engagement event is discarded, silently, forever.
 *
 * Until this module existed that record was written by exactly TWO senders —
 * send-job-alerts.mjs and send-newsletter.mjs — each with its own copy of the
 * write. Every other sender that reached Maileroo produced mail whose opens and
 * clicks were dropped on the floor. Measured over 1-20 August 2026: 7.876
 * messages with zero recorded engagement, against 44,50% open on the job alerts
 * the same provider delivered in the same window. The contrast that proves it
 * was a measurement gap and not indifference: `welcome` sent via Mailgun opened
 * at 46,43%, the same `welcome` via Maileroo at 0,00%.
 *
 * ── Why the writer lives here and not in the cascade ────────────────────────
 *
 * functions/src/emailCascade.js has no Firestore access on purpose: it is
 * imported both by Cloud Functions and by scripts/, which initialise the admin
 * SDK differently, and keeping it persistence-free is what makes it testable.
 * It exposes `onSent(item, result)` instead. So the invariant "every Maileroo
 * send has a ref" is enforced one level up, in scripts/lib/email-cascade.mjs's
 * wrapper — the same seam that already audits every sent body (#5682) — and,
 * for the two Cloud-Functions senders that bypass that wrapper by design, by an
 * explicit call. tests/maileroo-ref-coverage.test.ts fails when a new sender
 * appears without one of the two.
 *
 * Nothing here may throw: a defect in bookkeeping must never be able to break a
 * send that has already left.
 */

/** Subcollection under newsletter_subscribers/_meta_ holding the lookups. */
export const MAILEROO_REF_COLLECTION = 'maileroo_refs';

/**
 * Read a campaign id out of the `tags` a sender handed the cascade.
 *
 * Two shapes are in play and BOTH occur in production, which is why this is a
 * function and not a property read:
 *   - senders build `[{ name: 'campaign_id', value: 'onboarding_drip_step_1' }]`
 *   - functions/src/emailCascade.js flattens that to `{ campaign_id: '...' }`
 *     before handing it to Maileroo's v2 API
 * The webhook sees the flattened form echoed back in its own shape again, so
 * the same ambiguity bit `extractCampaignId` in the webhook — see the note there.
 *
 * Returns '' when there is no campaign tag, never null/undefined, so callers can
 * fall back on their channel id without a nullish dance.
 */
export function campaignIdFromTags(tags) {
  return tagValue(tags, 'campaign_id') || tagValue(tags, 'campaign');
}

/**
 * Read one tag BY NAME out of either shape.
 *
 * Extracted because reading a named tag is now done for two different names —
 * `campaign_id` here and `type` in newsletterMailerooWebhookCore's
 * isJobAlertEvent — and the first version of each got the array shape wrong in
 * the same way (`!Array.isArray` guards that answered "absent" for the shape
 * Maileroo actually sends). Two copies of that rule is exactly how the second
 * one stayed broken after the first was fixed.
 *
 * Returns '' rather than null/undefined so callers can use `||` without a
 * nullish dance.
 */
export function tagValue(tags, name) {
  if (!tags || !name) return '';
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (t && typeof t === 'object' && t.name === name) return String(t.value ?? '');
    }
    return '';
  }
  if (typeof tags === 'object' && tags[name]) return String(tags[name]);
  return '';
}

/**
 * Persist one lookup record. No-op for every provider except Maileroo — the
 * other four webhooks carry the recipient in their own payload and need nothing.
 *
 * The email is lowercased/trimmed because the webhook uses `meta.email` directly
 * as the `newsletter_subscribers/{email}` / `job_alert_subscribers/{email}` doc
 * id, and every other writer keys those collections by the normalized address:
 * a mixed-case ref would attribute engagement to an orphan document.
 *
 * @returns {Promise<boolean>} true when a record was written.
 */
export async function recordMailerooRef(db, { provider, messageId, email, campaignId, isJobAlert } = {}) {
  if (provider !== 'maileroo') return false;
  if (!db || !messageId) return false;
  const normalized = String(email || '').toLowerCase().trim();
  if (!normalized.includes('@')) return false;

  try {
    await db.collection('newsletter_subscribers').doc('_meta_')
      .collection(MAILEROO_REF_COLLECTION).doc(String(messageId)).set({
        email: normalized,
        campaign_id: campaignId || '',
        is_job_alert: !!isJobAlert,
        updated_at: new Date(),
      }, { merge: true });
    return true;
  } catch (e) {
    // Never throw: the message is already gone. A lost ref costs a metric,
    // a thrown error would cost the sender's own bookkeeping.
    console.warn('[mailerooRef] persist failed:', e?.message || e);
    return false;
  }
}

/**
 * Build an `onSent(item, sendResult)` callback that records the ref, then
 * delegates to whatever callback the caller already had.
 *
 * `getDb` is a thunk rather than a handle so that a sender which never reaches
 * Maileroo (or runs without credentials, like the preview scripts) never pays
 * for an admin-SDK init it does not need.
 *
 * @param {() => Promise<any>} getDb
 * @param {object} opts
 * @param {string} [opts.defaultCampaignId] used when the payload carries no campaign tag
 * @param {boolean} [opts.isJobAlert]
 * @param {Function|null} [opts.next] the caller's original onSent
 */
export function makeMailerooRefOnSent(getDb, { defaultCampaignId = '', isJobAlert = false, next = null } = {}) {
  return async function mailerooRefOnSent(item, sendResult) {
    if (sendResult?.provider === 'maileroo' && sendResult?.messageId) {
      try {
        const db = await getDb();
        await recordMailerooRef(db, {
          provider: sendResult.provider,
          messageId: sendResult.messageId,
          email: item?.recipient?.email || item?.payload?.to?.[0] || '',
          campaignId: campaignIdFromTags(item?.payload?.tags) || defaultCampaignId,
          isJobAlert,
        });
      } catch (e) {
        console.warn('[mailerooRef] onSent failed:', e?.message || e);
      }
    }
    if (next) await next(item, sendResult);
  };
}
