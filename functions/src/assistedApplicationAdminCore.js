/**
 * Admin-only operational queue for one-off assisted applications.
 *
 * GET lists paid orders in the manual-submission lifecycle. POST performs a
 * server-validated submission-status transition or issues a full Stripe refund.
 * Candidate PII stays behind the same verified owner-email gate used by the
 * other AdminPanel endpoints; CVs are returned only as short-lived signed URLs.
 */

import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { assertAdmin } from './adminEmployerInsights.js';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { resolveCvLink } from './publisherApplicationsCore.js';
import { getStripe } from './stripePublisherCore.js';
import { buildAssistedApplicationEvent } from './assistedApplicationAudit.js';
import {
  ASSISTED_APPLICATIONS_COLLECTION,
  ASSISTED_APPLICATION_ADMIN_STATUSES,
  ASSISTED_APPLICATION_ADMIN_STATUS_SET,
} from './assistedApplicationConstants.js';

export { ASSISTED_APPLICATION_ADMIN_STATUSES };

const ALL_SUBMISSION_STATUSES = new Set([
  'awaiting_payment',
  'awaiting_upload',
  ...ASSISTED_APPLICATION_ADMIN_STATUS_SET,
  'cancelled',
]);

// Refund is deliberately not a generic transition: it must call Stripe first.
const ALLOWED_TRANSITIONS = Object.freeze({
  awaiting_payment: new Set(),
  awaiting_upload: new Set(['ready_for_manual_submission', 'blocked']),
  ready_for_manual_submission: new Set(['in_progress', 'blocked', 'submitted']),
  in_progress: new Set(['submitted', 'blocked']),
  blocked: new Set(['in_progress']),
  submitted: new Set(),
  refunded: new Set(),
  cancelled: new Set(),
});

const EVENT_FOR_STATUS = Object.freeze({
  ready_for_manual_submission: 'manual_submission_queued',
  submitted: 'manual_submission_completed',
  blocked: 'manual_submission_blocked',
});

// A crashed process can leave a reservation behind after Stripe has accepted
// the idempotent refund request. Let a later owner retry reuse that same Stripe
// idempotency key while keeping concurrent admin actions serialized.
const REFUND_RESERVATION_TTL_MS = 15 * 60 * 1000;

class AssistedApplicationAdminError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'AssistedApplicationAdminError';
    this.code = code;
    this.status = status;
  }
}

function boundedString(value, max) {
  const result = String(value ?? '').trim();
  return result && result.length <= max ? result : '';
}

function optionalString(value, max) {
  if (value === undefined || value === null) return '';
  return boundedString(value, max);
}

function timestampToIso(value) {
  if (!value) return null;
  try {
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    if (typeof value.toMillis === 'function') return new Date(value.toMillis()).toISOString();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}

function timestampMillis(value) {
  const iso = timestampToIso(value);
  return iso ? Date.parse(iso) : 0;
}

function refundReservationIsStale(value) {
  const pendingAt = timestampMillis(value);
  return pendingAt > 0 && Date.now() - pendingAt >= REFUND_RESERVATION_TTL_MS;
}

function isAssistedApplicationStorageKey(orderId, value) {
  const key = boundedString(value, 600);
  const prefix = `assisted-application-uploads/${orderId}/`;
  if (!key.startsWith(prefix)) return false;
  const fileName = key.slice(prefix.length);
  return /^[A-Za-z0-9._-]+$/.test(fileName) && !fileName.includes('..');
}

function statusFor(order) {
  const status = boundedString(order?.submissionStatus, 80);
  return ALL_SUBMISSION_STATUSES.has(status) ? status : 'awaiting_payment';
}

function amountFor(order) {
  const amount = Number(order?.amountTotal);
  return Number.isFinite(amount) ? amount : null;
}

function serializeOrder(doc, cvUrl) {
  const data = doc.data() || {};
  return {
    orderId: doc.id,
    jobId: boundedString(data.jobId, 200),
    jobUrl: boundedString(data.jobUrl, 500),
    companyId: boundedString(data.companyId || data.companyName, 200),
    companyName: boundedString(data.companyName, 200),
    jobTitle: boundedString(data.jobTitle, 300),
    experimentVariant: boundedString(data.experimentVariant, 80),
    paymentStatus: boundedString(data.paymentStatus, 40),
    amountTotal: amountFor(data),
    currency: boundedString(data.currency || 'eur', 12).toUpperCase(),
    paidAt: timestampToIso(data.paidAt),
    applicantName: optionalString(data.applicantName, 200) || null,
    applicantEmail: optionalString(data.applicantEmail, 320) || null,
    applicantPhone: optionalString(data.applicantPhone, 80) || null,
    hasCv: Boolean(cvUrl),
    cvUrl: cvUrl || null,
    cvUploadedAt: timestampToIso(data.cvUploadedAt),
    consentVersion: optionalString(data.consentVersion, 120) || null,
    consentedAt: timestampToIso(data.consentedAt),
    submissionStatus: statusFor(data),
    submissionNotes: optionalString(data.submissionNotes, 2000) || null,
    submittedAt: timestampToIso(data.submittedAt),
    blockedAt: timestampToIso(data.blockedAt),
    refundedAt: timestampToIso(data.refundedAt),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

async function cvUrlForOrder(orderId, data) {
  const key = data?.cvStorageKey;
  if (!isAssistedApplicationStorageKey(orderId, key)) return null;
  return resolveCvLink(key);
}

function requestedStatus(req) {
  const raw = req.query?.status;
  const status = Array.isArray(raw) ? raw[0] : raw;
  if (status === undefined || status === null || String(status).trim() === '') return null;
  const normalized = boundedString(status, 80);
  if (!ASSISTED_APPLICATION_ADMIN_STATUSES.includes(normalized)) {
    throw new AssistedApplicationAdminError('invalid_status', 400);
  }
  return normalized;
}

/** GET → the operational queue, optionally narrowed to one visible status. */
export async function handleListAssistedApplications(db, status = null) {
  const snapshot = await db.collection(ASSISTED_APPLICATIONS_COLLECTION).get();
  const docs = (snapshot.docs || []).filter((doc) => {
    const data = doc.data() || {};
    const submissionStatus = statusFor(data);
    const isPaidOrder = data.paymentStatus === 'paid';
    const isRefundedOrder = submissionStatus === 'refunded' && data.paymentStatus === 'refunded';
    return (status ? submissionStatus === status : ASSISTED_APPLICATION_ADMIN_STATUSES.includes(submissionStatus))
      && (isPaidOrder || isRefundedOrder);
  });

  const orders = await Promise.all(docs.map(async (doc) => {
    const data = doc.data() || {};
    return serializeOrder(doc, await cvUrlForOrder(doc.id, data));
  }));
  orders.sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''));
  return { status: 200, body: { ok: true, orders } };
}

function transitionErrorResponse(error) {
  if (error instanceof AssistedApplicationAdminError) {
    return { status: error.status, body: { ok: false, error: error.code } };
  }
  throw error;
}

function transitionEventType(fromStatus, toStatus) {
  const eventType = EVENT_FOR_STATUS[toStatus];
  if (!eventType || fromStatus === toStatus) return null;
  return eventType;
}

function transitionPayload(fromStatus, toStatus, notes, adminEmail) {
  const timestamp = FieldValue.serverTimestamp();
  const payload = {
    submissionStatus: toStatus,
    statusChangedAt: timestamp,
    updatedAt: timestamp,
  };
  if (notes) payload.submissionNotes = notes;
  if (toStatus === 'submitted') payload.submittedAt = timestamp;
  if (toStatus === 'blocked') payload.blockedAt = timestamp;
  const eventType = transitionEventType(fromStatus, toStatus);
  return {
    payload,
    eventType,
    event: eventType
      ? buildAssistedApplicationEvent(eventType, {
        actorEmail: adminEmail,
        fromStatus,
        toStatus,
        ...(notes ? { submissionNotes: notes } : {}),
      })
      : null,
  };
}

async function handleTransition(db, raw, adminEmail) {
  const orderId = boundedString(raw.orderId, 200);
  const toStatus = boundedString(raw.submissionStatus || raw.status, 80);
  const notes = optionalString(raw.submissionNotes ?? raw.notes, 2000);
  if (!orderId || !ALL_SUBMISSION_STATUSES.has(toStatus)) {
    throw new AssistedApplicationAdminError('invalid_input', 400);
  }
  if (toStatus === 'blocked' && !notes) {
    throw new AssistedApplicationAdminError('blocked_reason_required', 400);
  }

  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  try {
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(orderRef);
      if (!snapshot.exists) throw new AssistedApplicationAdminError('order_not_found', 404);
      const current = snapshot.data() || {};
      const fromStatus = statusFor(current);
      if (current.paymentStatus !== 'paid') {
        throw new AssistedApplicationAdminError('payment_not_confirmed', 409);
      }
      if (current.refundStatus === 'pending') {
        throw new AssistedApplicationAdminError('refund_in_progress', 409);
      }
      if (!ALLOWED_TRANSITIONS[fromStatus]?.has(toStatus)) {
        throw new AssistedApplicationAdminError('invalid_transition', 409);
      }
      const { payload, event } = transitionPayload(fromStatus, toStatus, notes, adminEmail);
      transaction.set(orderRef, payload, { merge: true });
      if (event) {
        transaction.set(orderRef.collection('events').doc(), event);
      }
    });
  } catch (error) {
    return transitionErrorResponse(error);
  }
  return { status: 200, body: { ok: true, orderId, submissionStatus: toStatus } };
}

function paymentReferenceFromOrder(order) {
  const paymentIntent = boundedString(order?.stripePaymentIntentId || order?.paymentIntentId, 200);
  if (paymentIntent) return { type: 'payment_intent', id: paymentIntent };
  const charge = boundedString(order?.stripeChargeId || order?.chargeId, 200);
  return charge ? { type: 'charge', id: charge } : null;
}

async function resolvePaymentReference(order, stripe) {
  const direct = paymentReferenceFromOrder(order);
  if (direct) return direct;
  const sessionId = boundedString(order?.stripeCheckoutSessionId || order?.stripeSessionId, 200);
  if (!sessionId || !stripe.checkout?.sessions?.retrieve) return null;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paymentIntent = typeof session?.payment_intent === 'string'
      ? session.payment_intent
      : session?.payment_intent?.id;
    return paymentIntent ? { type: 'payment_intent', id: paymentIntent } : null;
  } catch (error) {
    console.error('[manageAssistedApplicationAdmin] payment reference lookup failed', error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function reserveRefund(db, orderRef) {
  const reservationId = randomUUID();
  let alreadyRefunded = false;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists) throw new AssistedApplicationAdminError('order_not_found', 404);
    const order = snapshot.data() || {};
    if (order.paymentStatus === 'refunded' || order.submissionStatus === 'refunded') {
      alreadyRefunded = true;
      return;
    }
    if (order.paymentStatus !== 'paid') {
      throw new AssistedApplicationAdminError('payment_not_refundable', 409);
    }
    if (order.submissionStatus === 'submitted') {
      throw new AssistedApplicationAdminError('already_submitted', 409);
    }
    if (order.refundStatus === 'pending' && !refundReservationIsStale(order.refundPendingAt)) {
      throw new AssistedApplicationAdminError('refund_in_progress', 409);
    }
    transaction.set(orderRef, {
      refundStatus: 'pending',
      refundReservationId: reservationId,
      refundPendingAt: new Date(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return { reservationId, alreadyRefunded };
}

async function releaseRefundReservation(db, orderRef, reservationId) {
  try {
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(orderRef);
      const order = snapshot.exists ? snapshot.data() || {} : null;
      if (!order || order.refundStatus !== 'pending' || order.refundReservationId !== reservationId) return;
      transaction.set(orderRef, {
        refundStatus: null,
        refundReservationId: null,
        refundPendingAt: null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  } catch (error) {
    console.error('[manageAssistedApplicationAdmin] refund reservation release failed', error instanceof Error ? error.message : String(error));
  }
}

async function handleRefund(db, raw, adminEmail) {
  const orderId = boundedString(raw.orderId, 200);
  const notes = optionalString(raw.submissionNotes ?? raw.notes, 2000);
  if (!orderId) throw new AssistedApplicationAdminError('invalid_input', 400);

  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  const snapshot = await orderRef.get();
  if (!snapshot.exists) throw new AssistedApplicationAdminError('order_not_found', 404);
  const order = snapshot.data() || {};
  if (order.paymentStatus === 'refunded' || order.submissionStatus === 'refunded') {
    return { status: 200, body: { ok: true, orderId, submissionStatus: 'refunded', alreadyRefunded: true } };
  }
  if (order.paymentStatus !== 'paid') {
    throw new AssistedApplicationAdminError('payment_not_refundable', 409);
  }
  if (order.submissionStatus === 'submitted') {
    throw new AssistedApplicationAdminError('already_submitted', 409);
  }

  const stripe = await getStripe();
  const reference = await resolvePaymentReference(order, stripe);
  if (!reference) throw new AssistedApplicationAdminError('payment_reference_missing', 409);

  const reservation = await reserveRefund(db, orderRef);
  if (reservation.alreadyRefunded) {
    return { status: 200, body: { ok: true, orderId, submissionStatus: 'refunded', alreadyRefunded: true } };
  }

  let refund;
  try {
    refund = await stripe.refunds.create(
      reference.type === 'charge' ? { charge: reference.id } : { payment_intent: reference.id },
      { idempotencyKey: `assisted-application-refund:${orderId}` },
    );
  } catch (error) {
    await releaseRefundReservation(db, orderRef, reservation.reservationId);
    console.error('[manageAssistedApplicationAdmin] Stripe refund failed', error instanceof Error ? error.message : String(error));
    return { status: 502, body: { ok: false, error: 'stripe_refund_failed' } };
  }

  if (refund?.status !== 'succeeded') {
    await releaseRefundReservation(db, orderRef, reservation.reservationId);
    console.error('[manageAssistedApplicationAdmin] Stripe refund did not succeed', refund?.status || 'missing_status');
    return { status: 502, body: { ok: false, error: 'stripe_refund_failed' } };
  }

  let alreadyRefunded = false;
  const timestamp = FieldValue.serverTimestamp();
  const refundId = boundedString(refund?.id, 200) || null;
  try {
    await db.runTransaction(async (transaction) => {
      const currentSnapshot = await transaction.get(orderRef);
      if (!currentSnapshot.exists) throw new AssistedApplicationAdminError('order_not_found', 404);
      const current = currentSnapshot.data() || {};
      if (current.paymentStatus === 'refunded' || current.submissionStatus === 'refunded') {
        alreadyRefunded = true;
        return;
      }
      // The reservation blocks ordinary admin transitions. Keep this check in
      // the final transaction too: an Admin-SDK writer outside this endpoint
      // must never be overwritten after Stripe has returned.
      if (current.refundStatus !== 'pending' || current.refundReservationId !== reservation.reservationId) {
        throw new AssistedApplicationAdminError('refund_state_changed', 409);
      }
      if (current.submissionStatus === 'submitted') {
        throw new AssistedApplicationAdminError('already_submitted', 409);
      }
      const update = {
        paymentStatus: 'refunded',
        submissionStatus: 'refunded',
        refundStatus: 'completed',
        stripeRefundId: refundId,
        refundedAt: timestamp,
        statusChangedAt: timestamp,
        updatedAt: timestamp,
        ...(notes ? { submissionNotes: notes } : {}),
      };
      const event = buildAssistedApplicationEvent('refund_issued', {
        actorEmail: adminEmail,
        refundId,
        fromStatus: statusFor(current),
        toStatus: 'refunded',
        ...(notes ? { submissionNotes: notes } : {}),
      });
      transaction.set(orderRef, update, { merge: true });
      transaction.set(orderRef.collection('events').doc(), event);
    });
  } catch (error) {
    return transitionErrorResponse(error);
  }
  if (alreadyRefunded) {
    return { status: 200, body: { ok: true, orderId, submissionStatus: 'refunded', alreadyRefunded: true } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      orderId,
      submissionStatus: 'refunded',
      refundId,
    },
  };
}

async function handleMutate(db, req, adminEmail) {
  const raw = req.body && typeof req.body === 'object' ? req.body : {};
  const action = boundedString(raw.action, 80);
  if (action === 'refund') return handleRefund(db, raw, adminEmail);
  if (action === 'transitionStatus' || action === 'updateStatus' || action === 'transition') {
    return handleTransition(db, raw, adminEmail);
  }
  throw new AssistedApplicationAdminError('invalid_input', 400);
}

/** Entry point. Both GET and POST require the verified owner admin. */
export async function handleAssistedApplicationAdmin(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }

  const auth = await assertAdmin(req);
  if (!auth.ok) return { status: auth.status, body: { ok: false, error: auth.error } };

  const db = getAdminDb();
  try {
    if (method === 'GET') return await handleListAssistedApplications(db, requestedStatus(req));
    return await handleMutate(db, req, auth.adminEmail);
  } catch (error) {
    return transitionErrorResponse(error);
  }
}
