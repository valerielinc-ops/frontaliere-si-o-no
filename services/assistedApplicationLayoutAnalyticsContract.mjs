/**
 * GA4 event-name contract for the assisted-application layout experiment.
 * The layout arm is encoded in low-cardinality event names so the funnel can
 * be read without a custom dimension or a user-property timing dependency.
 */
export const ASSISTED_APPLICATION_LAYOUT_EXPERIMENT_ID = 'assisted-application-layout-v1';

export const ASSISTED_APPLICATION_LAYOUT_VARIANTS = Object.freeze([
  'control',
  'variant_7',
  'proposal_5',
  'proposal_b',
]);

export const ASSISTED_APPLICATION_LAYOUT_PRIMARY_EVENTS = Object.freeze({
  exposure: 'assisted_application_offer_viewed',
  conversion: 'checkout_completed',
});

const EVENT_PREFIXES = Object.freeze({
  experiment_assigned: 'assigned',
  [ASSISTED_APPLICATION_LAYOUT_PRIMARY_EVENTS.exposure]: 'exposure',
  [ASSISTED_APPLICATION_LAYOUT_PRIMARY_EVENTS.conversion]: 'completed',
  assisted_application_choose_paid: 'paid',
  assisted_application_choose_external: 'external',
  checkout_started: 'started',
  checkout_failed: 'failed',
  consent_confirmed: 'consent',
  cv_upload_completed: 'upload',
  manual_submission_queued: 'queued',
  manual_submission_completed: 'submitted',
});

export const ASSISTED_APPLICATION_LAYOUT_TRACKED_BASE_EVENTS = Object.freeze(Object.keys(EVENT_PREFIXES));

export function assistedApplicationLayoutEventName(eventName, variant) {
  const prefix = EVENT_PREFIXES[eventName];
  if (!prefix || !ASSISTED_APPLICATION_LAYOUT_VARIANTS.includes(variant)) return null;
  return `aa_layout_${prefix}_${variant}`;
}

export function parseAssistedApplicationLayoutEventName(value) {
  for (const variant of ASSISTED_APPLICATION_LAYOUT_VARIANTS) {
    for (const [eventName, prefix] of Object.entries(EVENT_PREFIXES)) {
      if (value === `aa_layout_${prefix}_${variant}`) return { eventName, variant };
    }
  }
  return null;
}

export const ASSISTED_APPLICATION_LAYOUT_TRACKED_EVENT_NAMES = Object.freeze(
  Object.entries(EVENT_PREFIXES).flatMap(([eventName]) => ASSISTED_APPLICATION_LAYOUT_VARIANTS
    .map((variant) => assistedApplicationLayoutEventName(eventName, variant))),
);
