/**
 * Raw translation-observability bounds shared by producer and consumers.
 *
 * Keep these limits in one place: the shared crawler records the samples,
 * relocalize-pending-jobs merges them across companies, and the report layer
 * summarizes the same bounded population.
 */
export const TRANSLATION_RAW_OBSERVABILITY_LIMITS = Object.freeze({
  jobTimings: 4096,
  companies: 2048,
  rungs: 64,
});
