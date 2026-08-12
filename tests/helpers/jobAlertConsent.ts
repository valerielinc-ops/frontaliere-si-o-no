/**
 * The one shape that satisfies `hasAffirmativeJobAlertConsent`
 * (functions/src/jobAlertBackfillCore.js), shared by every test that needs to
 * get PAST the #5705 consent gate instead of asserting it.
 *
 * It lives in one file on purpose: three test files needed it, and three
 * hand-copied literals would let the gate be weakened in the core while two of
 * them kept passing against a stale idea of what consent looks like.
 *
 * No production path writes this shape today — that is the finding of #5705,
 * not an oversight here. `createAlert` (services/jobAlertService.ts), the
 * voluntary path behind the 578 real alerts, records no consent field at all:
 * its proof is that a person operated the form, which is not something the
 * subscriber document carries.
 */
export const JOB_ALERT_CONSENT = {
  consent_given: true,
  consent_text: 'Chiedo di ricevere gli avvisi di lavoro quotidiani di Frontaliere Ticino.',
  consent_text_displayed: true,
  consent_act: 'typed_email_submit',
} as const;

/** `newsletter_subscribers` doc data with the consent above spread onto it. */
export const withJobAlertConsent = <T extends Record<string, unknown>>(data: T) => ({
  ...data,
  ...JOB_ALERT_CONSENT,
});
