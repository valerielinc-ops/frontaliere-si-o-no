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
import { getRemoteConfigValue, getNewsletterSecrets, bridgeEmailCascadeCredentialsToEnv, getAutologinPolicyConfig } from './remoteConfigSecrets.js';
import { resolveAutologinPolicy } from './lib/autologinCode.js';
import { isNewsletterExcluded } from './lib/emailSuppression.js';
import { resolveWelcomeContext } from './lib/welcomeSegment.js';
import { buildWelcomeEmail } from './lib/welcomeEmailTemplate.js';
import { buildLifecycleEmailHeaders } from './lib/lifecycleEmailHeaders.js';
import { makeOneClickUnsubscribeUrl, makePreferencesUrl, wrapAuthenticatedHrefs } from './lib/newsletterUrls.js';
import { shouldSkipSubscriber } from './jobAlertBackfillCore.js';
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
 * Whether the subscriber already receives job alerts, or is about to.
 *
 * Ground truth is an active doc under job_alert_subscribers/{email}/alerts.
 * That doc is written by the backfillJobAlertOnNewsletterSignup Firestore
 * trigger, which races this send, so an absent doc is not proof of absence —
 * fall back to `shouldSkipSubscriber`, the very predicate the trigger uses to
 * decide. Sharing the predicate is what stops the email and the trigger from
 * disagreeing. Never throws: on any read error, claim nothing (false), because
 * promising alerts that do not exist is worse than offering to create ones that
 * already do.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} email normalized
 * @param {Record<string, unknown>} data subscriber doc data
 * @returns {Promise<boolean>}
 */
async function hasOrWillHaveJobAlert(db, email, data) {
  try {
    const snap = await db.collection('job_alert_subscribers').doc(email).collection('alerts').get();
    if (snap && !snap.empty) {
      const anyActive = snap.docs.some((d) => (d.data() || {}).active !== false);
      if (anyActive) return true;
      // Every alert explicitly deactivated = the user opted out. Respect that
      // and do not re-offer, but do not claim they are receiving alerts either.
      return false;
    }
  } catch (err) {
    console.warn('[newsletterWelcomeEmail] job alert lookup failed:', err?.message || err);
    return false;
  }
  try {
    return shouldSkipSubscriber(email, data) === null;
  } catch {
    return false;
  }
}

/** Carries the skip reason out of the idempotency transaction. */
class WelcomeNotEligibleError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Eligibility for a welcome send, from a subscriber doc's data.
 *
 * Evaluated twice on purpose: once before the transaction as a cheap early
 * exit, and again INSIDE it against the freshly-read snapshot. Reading the
 * state outside and claiming inside would leave a window where an unsubscribe
 * or a bounce landing between the two still gets a welcome email.
 *
 * @param {object} data subscriber doc data
 * @param {boolean} isPreview preview sends skip the recency window
 * @returns {{ ok: true } | { ok: false, skipped: string }}
 */
function evaluateWelcomeEligibility(data, isPreview) {
  if (isNewsletterExcluded(data?.status)) {
    return { ok: false, skipped: 'suppressed' };
  }
  const isConfirmed = data?.status === 'confirmed' || data?.isActive === true || data?.active === true;
  if (!isConfirmed) {
    return { ok: false, skipped: 'not_confirmed' };
  }
  if (!isPreview) {
    const anchor = toDate(data?.confirmed_at) || toDate(data?.created_at) || toDate(data?.createdAt);
    if (!anchor || Date.now() - anchor.getTime() > RECENCY_WINDOW_MS) {
      return { ok: false, skipped: 'too_old' };
    }
  }
  return { ok: true };
}

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

  // Cheap early exit. The authoritative check runs again inside the
  // transaction below, against the snapshot read there.
  const preCheck = evaluateWelcomeEligibility(data, isPreview);
  if (!preCheck.ok) {
    return { success: false, skipped: preCheck.skipped };
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
        const fresh = snap.exists ? (snap.data() || {}) : {};
        if (fresh.welcome_sent_at) {
          throw new WelcomeAlreadySentError('already_sent');
        }
        // Re-verify against the snapshot read in THIS transaction: an
        // unsubscribe, bounce or complaint landing between the pre-check and
        // here must still stop the send.
        const eligible = evaluateWelcomeEligibility(fresh, isPreview);
        if (!eligible.ok) {
          throw new WelcomeNotEligibleError(eligible.skipped);
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
      if (txErr instanceof WelcomeNotEligibleError) {
        return { success: false, skipped: txErr.reason };
      }
      throw txErr;
    }
  }

  const ctx = resolveWelcomeContext(data);
  const resolvedLocale = locale || data.preferred_locale || data.signup_locale || data.locale || 'it';

  // Job alerts are created automatically by the backfillJobAlertOnNewsletterSignup
  // Firestore trigger, so by the time this email lands most subscribers already
  // have one. Telling them to "create a job alert" would ask for something already
  // done. Prefer the alert doc as ground truth; when the trigger has not fired yet
  // (it races this send) fall back to the SAME predicate the trigger uses, so the
  // two can't disagree.
  // Only the `job` segment branches on this, so the sub-collection read is
  // skipped for the other four — no point paying a Firestore round-trip per
  // send for a value nothing downstream reads.
  const jobAlertActive = ctx.segment === 'job'
    ? await hasOrWillHaveJobAlert(db, normalizedEmail, data)
    : false;

  const unsubscribeUrl = makeOneClickUnsubscribeUrl(normalizedEmail, { secret: newsletterSecret });
  const preferencesUrl = makePreferencesUrl(normalizedEmail, resolvedLocale, { secret: newsletterSecret });

  const built = buildWelcomeEmail({
    ...ctx,
    locale: resolvedLocale,
    jobAlertActive,
    unsubscribeUrl,
    preferencesUrl,
  });
  const { subject } = built;
  // Autologin on every internal link: the recipient lands already signed in, so
  // "refine your alerts" or "back to the job" is one click, not a login wall.
  // The unsubscribe/preferences URLs carry their own HMAC token and are left
  // alone by shouldWrapAuthenticatedHref's asset/host rules only insofar as they
  // are on-site — wrapping them is harmless (extra ne/ac params) and keeps a
  // single rule for the whole body.
  //
  // The `ac` SCHEME has to be passed explicitly here (#5685). This is the only
  // minter that runs inside Cloud Functions, and the policy lives in Remote
  // Config, not process.env: NEWSLETTER_AC_* is not in EMAIL_CASCADE_RC_KEYS and
  // functions/ has no .env, which is the same reason newsletterSecret above is
  // resolved with getNewsletterSecrets() instead of being read from the
  // environment. Without this argument generateAutologinCode reads an empty env,
  // resolves `legacy`, and keeps minting legacy after
  // NEWSLETTER_AC_LEGACY_SUNSET — at which point the verifier refuses the codes
  // in the ONE email most subscribers ever receive, silently and permanently,
  // with nothing red anywhere. Same Remote Config template cache the secret read
  // uses, so this costs no extra round-trip in the warm path.
  let mintScheme;
  try {
    mintScheme = resolveAutologinPolicy(await getAutologinPolicyConfig()).mintScheme;
  } catch (policyErr) {
    // Fail towards today's behaviour: an unreadable policy mints legacy, which
    // is what an absent policy means anyway. Never block a welcome email on it.
    console.warn('[newsletterWelcomeEmail] Autologin policy read failed:', policyErr?.message || policyErr);
    mintScheme = undefined;
  }
  const html = wrapAuthenticatedHrefs(built.html, normalizedEmail, {
    secret: newsletterSecret,
    utmCampaign: `welcome_${ctx.segment}`,
    scheme: mintScheme,
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
