/**
 * GA4 event-name contract for the assisted-application copy experiment.
 * Variant attribution is encoded in dedicated, low-cardinality event names so
 * reports need no custom dimensions or persistent user properties.
 */
export const ASSISTED_APPLICATION_COPY_EXPERIMENT_ID = 'assisted-application-copy-v1';

export const ASSISTED_APPLICATION_COPY_VARIANTS = Object.freeze([
  'control',
  'time_saved',
  'portal_relief',
  'handled_for_you',
]);

export const ASSISTED_APPLICATION_COPY_PRIMARY_EVENTS = Object.freeze({
  exposure: 'assisted_application_offer_viewed',
  conversion: 'checkout_completed',
});

export const ASSISTED_APPLICATION_COPY_SECONDARY_EVENTS = Object.freeze([
  'assisted_application_choose_paid',
  'assisted_application_choose_external',
  'checkout_started',
  'checkout_failed',
  'consent_confirmed',
  'cv_upload_completed',
  'manual_submission_queued',
]);

const EVENT_PREFIXES = Object.freeze({
  [ASSISTED_APPLICATION_COPY_PRIMARY_EVENTS.exposure]: 'exposure',
  [ASSISTED_APPLICATION_COPY_PRIMARY_EVENTS.conversion]: 'completed',
  assisted_application_choose_paid: 'paid',
  assisted_application_choose_external: 'external',
  checkout_started: 'started',
  checkout_failed: 'failed',
  consent_confirmed: 'consent',
  cv_upload_completed: 'upload',
  manual_submission_queued: 'queued',
});

export const ASSISTED_APPLICATION_COPY_TRACKED_BASE_EVENTS = Object.freeze(Object.keys(EVENT_PREFIXES));

export function assistedApplicationCopyEventName(eventName, variant) {
  const prefix = EVENT_PREFIXES[eventName];
  if (!prefix || !ASSISTED_APPLICATION_COPY_VARIANTS.includes(variant)) return null;
  return `aa_copy_${prefix}_${variant}`;
}

export function parseAssistedApplicationCopyEventName(value) {
  for (const variant of ASSISTED_APPLICATION_COPY_VARIANTS) {
    for (const [eventName, prefix] of Object.entries(EVENT_PREFIXES)) {
      if (value === `aa_copy_${prefix}_${variant}`) return { eventName, variant };
    }
  }
  return null;
}

export const ASSISTED_APPLICATION_COPY_TRACKED_EVENT_NAMES = Object.freeze(
  Object.entries(EVENT_PREFIXES).flatMap(([eventName]) => ASSISTED_APPLICATION_COPY_VARIANTS
    .map((variant) => assistedApplicationCopyEventName(eventName, variant))),
);
