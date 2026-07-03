/**
 * Shim — canonical module now lives at
 * `functions/src/lib/subscriberPersonalization.js` because the real-time
 * `onDocumentWritten` trigger on the `private/personalization` subcollection
 * (`functions/src/jobAlertBackfillTrigger.js`, via `functions/index.js` →
 * `backfillJobAlertOnPersonalizationSync`) needs it inside `functions/` (no
 * bundler, cannot import anything outside that dir). Re-exported here so
 * every existing `scripts/`/test importer keeps resolving to the exact same
 * module — no drift between the batch enrichment path and the real-time one.
 */
export {
  PERSONALIZATION_FIELDS,
  derivePersonalizationPatch,
} from '../../functions/src/lib/subscriberPersonalization.js';
