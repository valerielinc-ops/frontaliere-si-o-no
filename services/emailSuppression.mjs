/**
 * Shim — canonical module now lives at `functions/src/lib/emailSuppression.js`
 * because Cloud Functions have no bundler and cannot import anything outside
 * `functions/` (see `jobAlertBackfillTrigger.js`, which needs this at runtime).
 * Re-exported here so every existing `scripts/`/test importer keeps resolving
 * to the exact same module — no drift between the two call sites.
 */
export {
  ADDRESS_SUPPRESSED_STATUSES,
  NEWSLETTER_EXCLUDED_STATUSES,
  JOB_ALERT_EXCLUDED_STATUSES,
  CROSS_CHANNEL_STOP_STATUSES,
  isAddressSuppressed,
  isNewsletterExcluded,
  isJobAlertExcluded,
  isCrossChannelStop,
  isTransactionalHardBlock,
} from '../functions/src/lib/emailSuppression.js';
