/**
 * Audit helpers for the assisted-application order lifecycle.
 *
 * The events subcollection is Admin-SDK-only. It keeps the operational history
 * beside the order without exposing candidate data or allowing a browser to
 * forge a status change.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { ASSISTED_APPLICATION_EVENT_TYPES } from './assistedApplicationConstants.js';

export { ASSISTED_APPLICATION_EVENT_TYPES };

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
