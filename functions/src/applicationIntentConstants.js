/**
 * Storage and reminder timing constants shared by the producer, cleanup job,
 * and read-only reminder candidate query. Keep this module free of Firebase
 * imports so query helpers and their fixtures can load it without Admin SDK.
 */

export const APPLICATION_INTENTS_COLLECTION = 'application_intents';
export const APPLICATION_INTENT_REMINDER_DELIVERIES_COLLECTION = 'application_intent_reminder_deliveries';
export const APPLICATION_INTENT_RETENTION_DAYS = 90;
export const APPLICATION_INTENT_REMINDER_DELAY_MS = 48 * 60 * 60 * 1000;
export const APPLICATION_INTENT_REMINDER_WRITE_SKEW_MS = 60 * 1000;
