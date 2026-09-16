/**
 * Audit helpers for the assisted-application order lifecycle.
 *
 * The events subcollection is Admin-SDK-only. It keeps the operational history
 * beside the order without exposing candidate data or allowing a browser to
 * forge a status change.
 */

import { FieldValue } from 'firebase-admin/firestore';

export const ASSISTED_APPLICATION_EVENT_TYPES = Object.freeze([
  'manual_submission_queued',
  'manual_submission_completed',
  'manual_submission_blocked',
  'refund_issued',
]);

export function buildAssistedApplicationEvent(eventType, details = {}) {
  if (!ASSISTED_APPLICATION_EVENT_TYPES.includes(eventType)) {
    throw new Error('invalid_assisted_application_event');
  }
  return {
    eventType,
    ...details,
    createdAt: FieldValue.serverTimestamp(),
  };
}

/** Append one lifecycle event from a trusted server-side caller. */
export async function appendAssistedApplicationEvent(db, orderId, eventType, details = {}) {
  const eventRef = db
    .collection('assisted_applications')
    .doc(String(orderId))
    .collection('events')
    .doc();
  await eventRef.set(buildAssistedApplicationEvent(eventType, details));
  return eventRef.id;
}
