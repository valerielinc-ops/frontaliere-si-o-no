/**
 * Shared contract constants for the job-alert sender and the read-only L4
 * outcome exporter. Keeping the window in one module prevents the producer's
 * refresh decision from drifting away from the exporter's validator.
 */
export const L4_DELIVERY_CONTRACT_VERSION = 1;
export const L4_DELIVERY_CONSENT_WINDOW_MS = 20 * 60_000;

// The sender-side refresh that makes the v1 proof enforceable shipped in
// #20076. Rows sent before that rollout may lack a safe per-delivery consent
// proof; those unknown rows must not be backfilled into the live cohort.
export const L4_DELIVERY_CONTRACT_EFFECTIVE_AT = '2026-11-26T12:54:57.000Z';
