/**
 * Verdicts of the human audit of a canton's duty source (`audit` in
 * `data/pharmacy-sources-registry.json`, #8705). Plain ESM with no imports so
 * both the registry validator (`types.ts`) and the dependency-free health
 * monitor (`scripts/check-pharmacy-data-health.mjs`) read the same list.
 * The meaning of each verdict is documented on `PharmacySourceAuditVerdict`
 * in `types.ts`.
 */
export const PHARMACY_SOURCE_AUDIT_VERDICTS = Object.freeze(
  /** @type {const} */ (['complete-feed', 'partial-or-proximity', 'no-machine-readable']),
);
