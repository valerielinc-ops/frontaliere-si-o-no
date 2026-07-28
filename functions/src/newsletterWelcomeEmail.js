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

import { createHmac } from 'node:crypto';
import admin from 'firebase-admin';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { sendEmailCascade, PROVIDERS, isProviderConfigured } from './emailCascade.js';
import { getRemoteConfigValue, getNewsletterSecrets, bridgeEmailCascadeCredentialsToEnv } from './remoteConfigSecrets.js';
import { isNewsletterExcluded } from './lib/emailSuppression.js';
import { resolveWelcomeContext } from './lib/welcomeSegment.js';
import { buildWelcomeEmail } from './lib/welcomeEmailTemplate.js';
import { buildLifecycleEmailHeaders } from './lib/lifecycleEmailHeaders.js';

const BASE_URL = 'https://frontaliereticino.ch';
const FROM_EMAIL = 'Frontaliere Ticino <newsletter@frontaliereticino.ch>';
const RECENCY_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h
const KILL_SWITCH_DISABLED_VALUES = new Set(['0', 'false', 'off']);

// ── Unsubscribe / preferences URL — must byte-match the scheme services/
// newsletterUrls.mjs and scripts/send-newsletter.mjs's makePreferencesUrl
// use, or the link this function signs won't verify via
// newsletterSubscriptionManagement.js's verifyHmacToken. functions/ can't
// import services/ (Cloud Functions deploy boundary — firebase.json's
// `source: "functions"` uploads only that directory; see
// docs/AGENTS-HISTORY.md shared-module pattern), so the HMAC scheme and the
// per-locale preferences slug table are duplicated here. Keep both in sync
// with services/newsletterUrls.mjs / services/routeSlugs.data.ts.

// Duplicated from services/routeSlugs.data.ts's `newsletterPreferences` slug
// per locale.
const PREFERENCES_SLUG = {
  it: 'preferenze-newsletter',
  en: 'newsletter-preferences',
  de: 'newsletter-einstellungen',
  fr: 'preferences-newsletter',
};
const localePathPrefix = (locale) => (locale === 'it' ? '' : `/${locale}`);

function signEmailToken(email, secret) {
  if (!secret) return null;
  return createHmac('sha256', secret).update(String(email).toLowerCase()).digest('hex');
}

// Duplicated from services/newsletterUrls.mjs's makeOneClickUnsubscribeUrl.
function buildOneClickUnsubscribeUrl(email, secret) {
  const token = signEmailToken(email, secret);
  const base = `${BASE_URL}/disiscrivi-newsletter/?action=unsubscribe&email=${encodeURIComponent(email)}`;
  return token ? `${base}&token=${token}` : base;
}

// Duplicated from scripts/send-newsletter.mjs's makePreferencesUrl. Returns
// null (template omits the preferences link entirely) when there's no
// secret to sign a valid token with, instead of shipping an unverifiable link.
function buildPreferencesUrl(email, secret, locale) {
  const token = signEmailToken(email, secret);
  if (!token) return null;
  const slug = PREFERENCES_SLUG[locale] || PREFERENCES_SLUG.it;
  const prefix = localePathPrefix(locale);
  const base = `${BASE_URL}${prefix}/${slug}?email=${encodeURIComponent(email)}`;
  return `${base}&token=${token}`;
}

// ── Drip handoff — interest → segment. Duplicated from
// services/newsletter-segments.mjs's inferInterest (same rule set, reading
// the RAW Firestore doc fields — source_component / source_route_family /
// job_slug / job_search_query / job_company — directly instead of the
// sourceComponent/sourceRouteFamily camelCase projection
// scripts/lib/subscriberFromFirestoreRow.mjs produces for the scripts/ side)
// and services/newsletter/onboardingDrip.mjs's resolveDripSegment (trivial
// 2-value collapse). functions/ can't import services/ — keep both in sync
// if either rule set changes.
const JOB_COMPONENTS = new Set(['JobBoard', 'JobExpiredView', 'JobBridgeView', 'JobOrphanView']);
const UTILITY_COMPONENTS = new Set(['TaxCalendar']);
const JOB_ROUTE_FAMILIES = new Set(['jobs_index', 'jobs_company', 'jobs_search', 'job_detail']);
const ARTICLE_ROUTE_FAMILIES = new Set(['article_detail', 'article_index']);
const UTILITY_ROUTE_FAMILIES = new Set([
  'calculator', 'comparison', 'guide', 'tax', 'life', 'glossary', 'stats_detail', 'stats_index',
]);

function inferWelcomeInterest(doc) {
  const component = doc?.source_component || null;
  const routeFamily = doc?.source_route_family || null;
  if (component && JOB_COMPONENTS.has(component)) return 'jobs';
  if (component && UTILITY_COMPONENTS.has(component)) return 'utility';
  if (routeFamily && JOB_ROUTE_FAMILIES.has(routeFamily)) return 'jobs';
  if (routeFamily && ARTICLE_ROUTE_FAMILIES.has(routeFamily)) return 'articles';
  if (routeFamily && UTILITY_ROUTE_FAMILIES.has(routeFamily)) return 'utility';
  if (doc?.job_slug || doc?.job_search_query || doc?.job_company) return 'jobs';
  return 'general';
}

function resolveWelcomeDripSegment(interest) {
  return interest === 'jobs' ? 'jobs-first' : 'utility-first';
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

  let newsletterSecret = '';
  try {
    const secrets = await getNewsletterSecrets();
    newsletterSecret = secrets?.newsletterSecret || '';
  } catch (secretErr) {
    console.warn('[newsletterWelcomeEmail] Failed to read NEWSLETTER_SECRET:', secretErr?.message || secretErr);
  }

  const unsubscribeUrl = buildOneClickUnsubscribeUrl(normalizedEmail, newsletterSecret);
  const preferencesUrl = buildPreferencesUrl(normalizedEmail, newsletterSecret, resolvedLocale);

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
    const interest = inferWelcomeInterest(data);
    const dripSegment = resolveWelcomeDripSegment(interest);
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
