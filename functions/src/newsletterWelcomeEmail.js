/**
 * newsletterWelcomeEmail.js — post-signup welcome email (replaces the
 * generic "you're confirmed" email that used to only go out via the nightly
 * cron, up to 24h late). Sent within seconds of double opt-in confirmation.
 *
 * Idempotency: a Firestore transaction claims `welcome_sent_at` on the
 * subscriber doc BEFORE the provider call, so two racing triggers (e.g. the
 * confirm-action hook firing at the same moment a presigned-link resend
 * lands) can never both send. The loser sees the winner's claim and skips.
 *
 * Kill switch: Remote Config key WELCOME_EMAIL_ENABLED. Fails OPEN — any RC
 * read failure or missing key is treated as enabled, only an exact '0' /
 * 'false' / 'off' value disables (mirrors the fail-open posture of the rest
 * of the RC-gated email surface; a flaky Remote Config read must never
 * silently stop welcome emails from going out).
 */

import admin from 'firebase-admin';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { sendEmailCascade, PROVIDERS, isProviderConfigured } from './emailCascade.js';
import { getRemoteConfigValue, getNewsletterSecrets, bridgeEmailCascadeCredentialsToEnv } from './remoteConfigSecrets.js';
import { isNewsletterExcluded } from './lib/emailSuppression.js';
import { resolveWelcomeContext } from './lib/welcomeSegment.js';
import { buildWelcomeEmail } from './lib/welcomeEmailTemplate.js';
import { buildLifecycleEmailHeaders } from './lib/lifecycleEmailHeaders.js';
import { makeOneClickUnsubscribeUrl, makePreferencesUrl } from './lib/newsletterUrls.js';
import { inferInterest, resolveDripSegment } from './lib/newsletterSegments.js';

const FROM_EMAIL = 'Frontaliere Ticino <newsletter@frontaliereticino.ch>';
const RECENCY_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h
const KILL_SWITCH_DISABLED_VALUES = new Set(['0', 'false', 'off']);

/**
 * inferInterest (./lib/newsletterSegments.js) expects a subscriber projected
 * the way scripts/lib/subscriberFromFirestoreRow.mjs shapes it for the
 * scripts/ side — camelCase `sourceComponent`/`sourceRouteFamily`, but
 * snake_case `job_slug`/`job_search_query`/`job_company` passed straight
 * through. This function's `data` is instead the RAW Firestore doc
 * (snake_case throughout) — adapt just the two renamed fields.
 * @param {Record<string, any>} doc
 * @returns {{sourceComponent: string|null, sourceRouteFamily: string|null, job_slug: string|null, job_search_query: string|null, job_company: string|null}}
 */
function toInterestSubscriber(doc) {
  return {
    sourceComponent: doc?.source_component || null,
    sourceRouteFamily: doc?.source_route_family || null,
    job_slug: doc?.job_slug || null,
    job_search_query: doc?.job_search_query || null,
    job_company: doc?.job_company || null,
  };
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Sentinel error used to abort the idempotency-claim transaction when a
// concurrent caller already won the claim — never leaks past this module.
class WelcomeAlreadySentError extends Error {}

/**
 * @param {{email: string, locale?: string, db?: unknown, trigger: 'confirm'|'presigned'|'preview'}} params
 * @returns {Promise<{success: boolean, error?: string, skipped?: string, messageId?: string, segment?: string}>}
 */
export async function sendNewsletterWelcomeEmail({ email, locale, db: injectedDb, trigger }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return { success: false, error: 'invalid_email' };
  }

  const isPreview = trigger === 'preview';

  // Kill switch — fail OPEN on RC-throw/absence/anything but an explicit
  // disable value.
  try {
    const raw = await getRemoteConfigValue('WELCOME_EMAIL_ENABLED');
    const normalized = String(raw || '').trim().toLowerCase();
    if (KILL_SWITCH_DISABLED_VALUES.has(normalized)) {
      return { success: false, skipped: 'disabled' };
    }
  } catch (rcErr) {
    console.warn('[newsletterWelcomeEmail] Remote Config kill-switch read failed, defaulting to enabled:', rcErr?.message || rcErr);
  }

  // Bridge RC credentials into process.env BEFORE the sync cascade check
  // (order mandatory — mirrors newsletterConfirmationEmail.js).
  await bridgeEmailCascadeCredentialsToEnv();
  if (!PROVIDERS.some((p) => isProviderConfigured(p.id))) {
    return { success: false, error: 'no_provider_configured' };
  }

  const db = injectedDb || getAdminDb();
  const subscriberRef = db.collection('newsletter_subscribers').doc(normalizedEmail);
  const subscriberDoc = await subscriberRef.get();
  if (!subscriberDoc.exists) {
    return { success: false, error: 'subscriber_not_found' };
  }
  const data = subscriberDoc.data() || {};

  if (isNewsletterExcluded(data.status)) {
    return { success: false, skipped: 'suppressed' };
  }

  const isConfirmed = data.status === 'confirmed' || data.isActive === true || data.active === true;
  if (!isConfirmed) {
    return { success: false, skipped: 'not_confirmed' };
  }

  if (!isPreview) {
    const anchor = toDate(data.confirmed_at) || toDate(data.created_at) || toDate(data.createdAt);
    if (!anchor || Date.now() - anchor.getTime() > RECENCY_WINDOW_MS) {
      return { success: false, skipped: 'too_old' };
    }
  }

  // Unsubscribe/preferences links are HMAC-signed with this secret — a
  // missing secret makes makeOneClickUnsubscribeUrl/makePreferencesUrl
  // degrade to a token-LESS link, which verifyHmacToken()
  // (newsletterSubscriptionManagement.js) then REJECTS. A bulk lifecycle
  // email must never go out with a dead unsubscribe link, so resolve AND
  // validate the secret BEFORE the idempotency transaction below claims
  // welcome_sent_at — a transient Remote Config outage then just delays the
  // welcome email instead of permanently burning the subscriber's one shot
  // at it (a later run, once the secret is available, can still deliver).
  let newsletterSecret = '';
  try {
    const secrets = await getNewsletterSecrets();
    newsletterSecret = secrets?.newsletterSecret || '';
  } catch (secretErr) {
    console.warn('[newsletterWelcomeEmail] Failed to read NEWSLETTER_SECRET:', secretErr?.message || secretErr);
  }
  if (!newsletterSecret) {
    console.error('[newsletterWelcomeEmail] Aborting send: NEWSLETTER_SECRET unavailable — would produce an unsubscribe link verifyHmacToken rejects.');
    return { success: false, error: 'missing_newsletter_secret' };
  }

  // Idempotency claim — re-read inside the transaction and stamp
  // welcome_sent_at/welcome_trigger BEFORE calling the provider, so a
  // concurrent caller loses the race instead of double-sending.
  // trigger==='preview' bypasses the claim entirely and writes no state.
  if (!isPreview) {
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(subscriberRef);
        if (snap.exists && snap.data()?.welcome_sent_at) {
          throw new WelcomeAlreadySentError('already_sent');
        }
        tx.set(subscriberRef, {
          welcome_sent_at: admin.firestore.FieldValue.serverTimestamp(),
          welcome_trigger: trigger || null,
        }, { merge: true });
      });
    } catch (txErr) {
      if (txErr instanceof WelcomeAlreadySentError) {
        return { success: false, skipped: 'already_sent' };
      }
      throw txErr;
    }
  }

  const ctx = resolveWelcomeContext(data);
  const resolvedLocale = locale || data.preferred_locale || data.signup_locale || data.locale || 'it';

  const unsubscribeUrl = makeOneClickUnsubscribeUrl(normalizedEmail, { secret: newsletterSecret });
  const preferencesUrl = makePreferencesUrl(normalizedEmail, resolvedLocale, { secret: newsletterSecret });

  const { subject, html } = buildWelcomeEmail({
    ...ctx,
    locale: resolvedLocale,
    unsubscribeUrl,
    preferencesUrl,
  });

  const campaignId = `welcome_${ctx.segment}`;

  const { sent, failed } = await sendEmailCascade([{
    payload: {
      from: FROM_EMAIL,
      to: normalizedEmail,
      subject,
      html,
      tags: [
        { name: 'campaign_id', value: campaignId },
        { name: 'type', value: 'lifecycle' },
        { name: 'locale', value: resolvedLocale },
      ],
      headers: buildLifecycleEmailHeaders({
        email: normalizedEmail,
        campaignId,
        oneClickUnsubscribeUrl: unsubscribeUrl,
      }),
    },
    recipient: { email: normalizedEmail },
    meta: {},
  }]);

  if (failed.length > 0) {
    console.error('[newsletterWelcomeEmail] send error:', failed[0].error);
    // Roll back the claim so a later retry (e.g. the nightly cron fallback,
    // or a resend of the presigned link) can still send — a provider outage
    // must not permanently burn a subscriber's one welcome email.
    if (!isPreview) {
      try {
        await subscriberRef.set({
          welcome_sent_at: admin.firestore.FieldValue.delete(),
          welcome_trigger: admin.firestore.FieldValue.delete(),
        }, { merge: true });
      } catch (rollbackErr) {
        console.error('[newsletterWelcomeEmail] Rollback of claim failed:', rollbackErr?.message || rollbackErr);
      }
    }
    return { success: false, error: 'email_send_failed' };
  }

  const messageId = sent[0]?.messageId || null;

  if (!isPreview) {
    const interest = inferInterest(toInterestSubscriber(data));
    const dripSegment = resolveDripSegment(interest);
    try {
      await subscriberRef.set({
        welcome_message_id: messageId,
        welcome_segment: ctx.segment,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
        drip_started_at: admin.firestore.FieldValue.serverTimestamp(),
        drip_last_step: 0,
        drip_segment: dripSegment,
      }, { merge: true });
    } catch (persistErr) {
      // Send already succeeded — a bookkeeping write failure here must never
      // turn into a false failure response.
      console.error('[newsletterWelcomeEmail] Post-send state write failed:', persistErr?.message || persistErr);
    }

    try {
      await subscriberRef.collection('events').add({
        email: normalizedEmail,
        event_type: 'welcome_email_sent',
        source_channel: 'welcome_email',
        segment: ctx.segment,
        message_id: messageId,
        locale: resolvedLocale,
        trigger: trigger || null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        occurred_at: new Date().toISOString(),
      });
    } catch (eventErr) {
      console.warn('[newsletterWelcomeEmail] Non-fatal: event log write failed:', eventErr?.message || eventErr);
    }
  }

  return { success: true, messageId, segment: ctx.segment };
}
