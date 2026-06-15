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
 * Env (BOTH required to activate; absent → no-op):
 *   POSTHOG_EMAIL_EXPERIMENT  '1'|'true' to enable
 *   POSTHOG_PROJECT_KEY       PostHog project write key (phc_…); no hardcoded
 *                             default (avoids a 3rd copy of the key in the repo)
 *   POSTHOG_HOST              ingestion host (default EU cloud ingest).
 */

// The project key is read from POSTHOG_PROJECT_KEY only — we deliberately do NOT
// hardcode a default copy here. The same phc_ key already lives in
// services/posthog.ts and build-plugins/constants.ts; a third copy would make a
// key rotation a 3-file manual edit. Since the experiment is off by default and
// enabling it is an explicit ops action, requiring the env var alongside
// POSTHOG_EMAIL_EXPERIMENT is no extra burden and removes the duplication.
const POSTHOG_HOST = (process.env.POSTHOG_HOST || 'https://eu.i.posthog.com').replace(/\/$/, '');
const POSTHOG_KEY = process.env.POSTHOG_PROJECT_KEY || '';
const ENABLED = ['1', 'true', 'yes'].includes(String(process.env.POSTHOG_EMAIL_EXPERIMENT || '').toLowerCase());

/** Canonical event names — single source of truth for emit + analysis. */
export const EMAIL_EXPERIMENT_EVENTS = Object.freeze({
  SENT: 'email_sent',     // exposure: subscriber entered the experiment with a variant
  OPENED: 'email_opened', // conversion: subscriber opened the email
});

/** @returns {boolean} whether server-side experiment capture is active. */
export function isEmailExperimentEnabled() {
  return ENABLED && !!POSTHOG_KEY;
}

/**
 * Capture one experiment event in PostHog. Fire-and-forget safe: never throws,
 * returns false on any failure so callers can ignore the result. No-op unless
 * the experiment is enabled and an email (the distinct_id) is present.
 *
 * @param {string} event  one of EMAIL_EXPERIMENT_EVENTS
 * @param {object} props  { email, variant?, provider?, campaignId?, locale? }
 * @returns {Promise<boolean>} true if PostHog accepted the event
 */
export async function captureEmailEvent(event, props = {}) {
  const { email, variant, provider, campaignId, locale } = props;
  if (!isEmailExperimentEnabled() || !email) return false;
  try {
    const res = await fetch(`${POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event,
        distinct_id: String(email).toLowerCase(),
        properties: {
          // distinct_id ties sent↔open; breakdown keys for the funnel readout.
          subject_variant: variant || null,
          email_provider: provider || null,
          campaign_id: campaignId || null,
          locale: locale || null,
          $lib: 'email-ab-server',
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
