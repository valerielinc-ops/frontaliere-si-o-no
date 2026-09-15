/**
 * The one shape that satisfies `hasAffirmativeJobAlertConsent`
 * (functions/src/jobAlertBackfillCore.js), shared by every test that needs to
 * get PAST the #5705 consent gate instead of asserting it.
 *
 * It lives in one file on purpose: three test files needed it, and three
 * hand-copied literals would let the gate be weakened in the core while two of
 * them kept passing against a stale idea of what consent looks like.
 *
 * The production unified email writer records the same category preference on
 * the central subscriber document. Keeping it here is important: this helper
 * represents consent that covers the JobAlert channel, not merely a text that
 * mentions it, so the predicate requires `preferences.jobs` as well as the
 * displayed formula and affirmative act.
 */
export const JOB_ALERT_CONSENT = {
  consent_given: true,
  consent_text: 'Chiedo di ricevere gli avvisi di lavoro quotidiani di Frontaliere Ticino.',
  consent_text_displayed: true,
  consent_act: 'typed_email_submit',
  preferences: { jobs: true },
} as const;

/** `newsletter_subscribers` doc data with the consent above spread onto it. */
export const withJobAlertConsent = <T extends Record<string, unknown>>(data: T) => ({
  ...data,
  ...JOB_ALERT_CONSENT,
});
