/**
 * Single source of truth for the authenticated CV-download Cloud Function URL.
 * Consumed by both the publisher dashboard (CV button) and the canonical CV
 * deep-link interceptor — keep the literal in one place so the two callers can
 * never drift (region/name change touches only here).
 */
export const CV_URL_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/getPublisherApplicationCvUrl';
