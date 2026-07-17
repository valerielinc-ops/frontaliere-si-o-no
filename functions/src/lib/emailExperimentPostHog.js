/**
 * emailExperimentPostHog.js — server-side PostHog capture for the subject-line
 * A/B experiment.
 *
 * The variant is assigned by our own deterministic hash (see
 * services/newsletter-subject-variants.mjs) — NOT by a PostHog feature flag — so
 * assignment stays robust even if PostHog is down/over-quota. PostHog is used
 * ONLY for measurement: we emit two events per subscriber and read the result
 * as a funnel `email_sent → email_opened` broken down by `subject_variant` and
 * `email_provider`.
 *
 * Quota-conscious by design (PostHog free tier is tight — see the posthog quota
 * outage history): it emits ONLY these two events, and is a NO-OP unless
 * POSTHOG_EMAIL_EXPERIMENT is explicitly enabled. The free Firestore report
 * (scripts/newsletter-ab-report.mjs) keeps working regardless.
 *
 * Lives under functions/src/lib so BOTH the Cloud Functions webhooks AND the
 * send-newsletter script (which already imports from here, e.g.
 * engagementScore.js) can share it without a cross-runtime import. Uses the
 * PostHog capture HTTP API via global fetch — no posthog-node dependency.
 *
 * Config resolution (env first, then Remote Config) — BOTH the flag and the key
 * must resolve, else it is a no-op:
 *   POSTHOG_EMAIL_EXPERIMENT / RC SERVER_POSTHOG_EMAIL_EXPERIMENT  '1'|'true'
 *   POSTHOG_PROJECT_KEY      / RC SERVER_POSTHOG_PROJECT_KEY       phc_… (public)
 *   POSTHOG_HOST             / RC SERVER_POSTHOG_HOST              ingest host
 *
 * The send-newsletter CI run hydrates process.env from Remote Config via
 * load-rc-env.mjs, so it never touches RC here. The Cloud Functions runtime has
 * no such env, so it falls back to reading Remote Config directly — the same
 * idiom as recaptchaVerification.js. The project key is public (already shipped
 * client-side), so storing it in RC is not a secret leak and keeps a single
 * source of truth (no hardcoded copy in this file).
 */

import { getRemoteConfigValue } from '../remoteConfigSecrets.js';
import { buildDeliveryDocId } from './deliveryDocId.js';

/** Canonical event names — single source of truth for emit + analysis. */
export const EMAIL_EXPERIMENT_EVENTS = Object.freeze({
  SENT: 'email_sent',     // exposure: subscriber entered the experiment with a variant
  OPENED: 'email_opened', // conversion: subscriber opened the email
});

/**
 * Providers excluded from the A/B experiment. `mailtrap` is a sandbox/testing
 * ESP that reports ~0 opens (it doesn't track real opens / may not deliver), so
 * its data would pollute the open-rate comparison. Excluded both from event
 * capture (no email_sent/email_opened) and from the Firestore winner resolution
 * (see scripts/lib/newsletter-ab-data.mjs). Single source of truth.
 */
export const EXPERIMENT_EXCLUDED_PROVIDERS = new Set(['mailtrap']);

/**
 * Read the variant persisted on the SEND doc for (email, campaignId). The send
 * pipeline writes it at `${campaignId}__${email}` (double underscore); the ESP
 * webhooks write their own delivery doc at a different id, so non-Resend opens
 * have no variant of their own — look it up here so email_opened carries it.
 * Never throws.
 * @param {FirebaseFirestore.DocumentReference} subscriberRef  newsletter_subscribers/{email}
 * @returns {Promise<string|null>}
 */
export async function lookupSentVariant(subscriberRef, campaignId, email) {
  try {
    if (!subscriberRef || !campaignId || !email) return null;
    const docId = buildDeliveryDocId(campaignId, email);
    const snap = await subscriberRef.collection('campaign_deliveries').doc(docId).get();
    return snap.exists ? (snap.data()?.variant || null) : null;
  } catch {
    return null;
  }
}

const truthy = (v) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());

let _configPromise = null;
/**
 * Resolve { enabled, key, host }. env wins; missing pieces fall back to Remote
 * Config (Cloud Functions runtime). Cached after the first resolution.
 */
async function resolveConfig() {
  if (_configPromise) return _configPromise;
  _configPromise = (async () => {
    let flag = process.env.POSTHOG_EMAIL_EXPERIMENT || '';
    let key = process.env.POSTHOG_PROJECT_KEY || '';
    let host = process.env.POSTHOG_HOST || '';
    if (!flag || !key) {
      // Functions runtime: no env → read Remote Config (recaptcha idiom).
      try {
        if (!flag) flag = await getRemoteConfigValue('SERVER_POSTHOG_EMAIL_EXPERIMENT').catch(() => '');
        if (!key) key = await getRemoteConfigValue('SERVER_POSTHOG_PROJECT_KEY').catch(() => '');
        if (!host) host = await getRemoteConfigValue('SERVER_POSTHOG_HOST').catch(() => '');
      } catch {
        // RC unavailable → stay disabled.
      }
    }
    return {
      enabled: truthy(flag) && !!key,
      key,
      host: (host || 'https://eu.i.posthog.com').replace(/\/$/, ''),
    };
  })();
  return _configPromise;
}

/** Reset the cached config (tests only). */
export function _resetEmailExperimentConfig() {
  _configPromise = null;
}

/** @returns {Promise<boolean>} whether capture is active (env or Remote Config). */
export async function isEmailExperimentEnabled() {
  return (await resolveConfig()).enabled;
}

/**
 * Capture one experiment event in PostHog. Fire-and-forget safe: never throws,
 * returns false on any failure so callers can ignore the result. No-op unless
 * the experiment is enabled and an email (the distinct_id) is present.
 *
 * @param {string} event  one of EMAIL_EXPERIMENT_EVENTS
 * @param {object} props  { email, variant?, provider?, campaignId?, locale?, segment? }
 * @returns {Promise<boolean>} true if PostHog accepted the event
 */
export async function captureEmailEvent(event, props = {}) {
  const { email, variant, provider, campaignId, locale, segment } = props;
  if (!email) return false;
  if (provider && EXPERIMENT_EXCLUDED_PROVIDERS.has(provider)) return false; // e.g. mailtrap sandbox
  const { enabled, key, host } = await resolveConfig();
  if (!enabled) return false;
  try {
    const res = await fetch(`${host}/capture/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        event,
        distinct_id: String(email).toLowerCase(),
        properties: {
          // distinct_id ties sent↔open; breakdown keys for the funnel readout.
          subject_variant: variant || null,
          email_provider: provider || null,
          campaign_id: campaignId || null,
          locale: locale || null,
          segment: segment || null,
          $lib: 'email-ab-server',
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
