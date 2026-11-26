/**
 * Shared contract constants for the job-alert sender and the read-only L4
 * outcome exporter. Keeping the window in one module prevents the producer's
 * refresh decision from drifting away from the exporter's validator.
 */
export const L4_DELIVERY_CONTRACT_VERSION = 1;
export const L4_DELIVERY_CONSENT_WINDOW_MS = 20 * 60_000;
