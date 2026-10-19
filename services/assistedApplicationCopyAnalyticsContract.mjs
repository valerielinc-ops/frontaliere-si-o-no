/**
 * Non-PII GA4 contract for the assisted-application copy experiment.
 * Keep the property names short (GA4 limit: 24 chars) and values low-cardinality.
 */
export const ASSISTED_APPLICATION_COPY_EXPERIMENT_ID = 'assisted-application-copy-v1';

export const ASSISTED_APPLICATION_COPY_USER_PROPERTIES = Object.freeze({
  experiment: 'aa_copy_experiment',
  variant: 'aa_copy_variant',
});

export const ASSISTED_APPLICATION_COPY_GA4_DIMENSIONS = Object.freeze([
  Object.freeze({
    parameterName: ASSISTED_APPLICATION_COPY_USER_PROPERTIES.experiment,
    displayName: 'Assisted App Copy Experiment',
    description: 'Fixed id of the assisted-application copy experiment; contains no personal data.',
    scope: 'USER',
  }),
  Object.freeze({
    parameterName: ASSISTED_APPLICATION_COPY_USER_PROPERTIES.variant,
    displayName: 'Assisted App Copy Variant',
    description: 'Low-cardinality copy variant: control, time_saved, portal_relief, or handled_for_you.',
    scope: 'USER',
  }),
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
