/**
 * Shim — canonical module lives at `functions/src/jobAlertBackfillCore.js`
 * because the real-time `onDocumentWritten` trigger needs it inside
 * `functions/` (no bundler, cannot import outside that dir). Re-exported
 * here so the batch backfill script resolves to the exact same logic —
 * no drift between the one-off backfill and the ongoing trigger.
 */
export {
  MAX_ALERTS_PER_USER,
  ALERT_ID,
  AFFIRMATIVE_CONSENT_ACTS,
  normalizeEmail,
  shouldSkipSubscriber,
  consentNamesJobAlerts,
  hasAffirmativeJobAlertConsent,
  buildAlertPayload,
  getSignalTier,
  signalTierChanged,
  resolveSignalTier,
} from '../../functions/src/jobAlertBackfillCore.js';
