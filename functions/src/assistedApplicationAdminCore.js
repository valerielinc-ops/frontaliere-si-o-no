/**
 * Admin-only operational queue for one-off assisted applications.
 *
 * GET lists paid orders in the manual-submission lifecycle. POST performs a
 * server-validated submission-status transition, issues a full Stripe refund,
 * or returns a read-only candidate-facing order snapshot. Candidate PII stays
 * behind the same verified owner-email gate used by the other AdminPanel
 * endpoints; CVs are returned only as short-lived signed URLs.
 */

import { randomUUID } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { assertAdmin } from './adminEmployerInsights.js';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { resolveCvLink } from './publisherApplicationsCore.js';
import { getStripe } from './stripePublisherCore.js';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';
import { buildAssistedApplicationEvent } from './assistedApplicationAudit.js';
import {
  AUTOMATION_ADMIN_ACTIONS,
  AutomationAdminError,
  handleAutomationAdminAction,
  loadAutomationForAdmin,
  recordOwnerSubmission,
} from './assistedApplicationAutomationAdmin.js';
import { runAutomationEffect } from './assistedApplicationAutomationEffects.js';
import { readRendererCheck } from './assistedApplicationRendererCheck.js';
import { ASSISTED_APPLICATION_STORAGE_BUCKET, detectCvFileType } from './assistedApplicationCvCheck.js';
import {
  ASSISTED_APPLICATIONS_COLLECTION,
  ASSISTED_APPLICATION_ADMIN_STATUSES,
  ASSISTED_APPLICATION_ADMIN_STATUS_SET,
  hasAssistedApplicationConsent,
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
  // Materials that arrive by email (reply to Valerie) move the order on
  // directly; the upload page keeps its own awaiting_upload → ready path.
  awaiting_upload: new Set(['ready_for_manual_submission', 'in_progress', 'submitted', 'blocked']),
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

/**
 * CV visibility policy (owner decision 2026-09-29): a paid order is never
 * hidden from the queue, whatever its CV state. The CV link is withheld only
 * when a scanner reported a problem or is still running; a file no scanner
 * has seen is shown with an explicit `unscanned` badge — the same exposure as
 * the CV attachments customers send by email. Uploads are type-checked by
 * magic bytes server-side (assistedApplicationUpload.js) before they land.
 */
const CV_LINK_WITHHELD_SCAN_STATUSES = new Set(['pending', 'infected', 'rejected', 'error']);

function cvScanStatusFor(data) {
  if (!data?.cvStorageKey) return null;
  return boundedString(data.cvScanStatus, 40).toLowerCase() || 'unscanned';
}

/** Server-side magic-byte verdict for the current CV (assistedApplicationCvCheck.js). */
function cvFileCheckFor(data) {
  const check = data?.cvFileCheck;
  if (!data?.cvStorageKey || !check || check.key !== data.cvStorageKey) return null;
  return boundedString(check.verdict, 40) || null;
}

function notificationStatus(data, key) {
  return boundedString(data?.notifications?.[key]?.status, 40) || null;
}

function eventCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * Every e-mail the candidate received, with what the providers reported back
 * (assistedApplicationEmailEvents.js): delivery, opens, clicks, bounces.
 */
function candidateEmailsFor(data) {
  const engagement = data?.emailEngagement && typeof data.emailEngagement === 'object' ? data.emailEngagement : {};
  const notifications = data?.notifications && typeof data.notifications === 'object' ? data.notifications : {};
  const keys = new Set([
    ...Object.keys(notifications).filter((key) => /^(customer_|auto_candidate_)/.test(key)),
    ...Object.keys(engagement),
  ]);
  return [...keys]
    .filter((key) => /^[a-z0-9_]{1,80}$/.test(key))
    .map((key) => {
      const events = engagement[key] || {};
      const sent = notifications[key] || {};
      return {
        key,
        status: boundedString(sent.status, 40) || null,
        sentAt: timestampToIso(sent.sentAt),
        delivered: eventCount(events.delivered),
        opens: eventCount(events.opens),
        clicks: eventCount(events.clicks),
        bounces: eventCount(events.bounces),
        complaints: eventCount(events.complaints),
        firstOpenAt: timestampToIso(events.firstOpenAt),
        lastOpenAt: timestampToIso(events.lastOpenAt),
        lastClickAt: timestampToIso(events.lastClickAt),
        lastClickUrl: optionalString(events.lastClickUrl, 300) || null,
      };
    })
    .sort((a, b) => String(a.sentAt || a.firstOpenAt || '').localeCompare(String(b.sentAt || b.firstOpenAt || '')))
    .slice(0, 40);
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
    customerEmail: optionalString(data.customerEmail, 320) || null,
    locale: boundedString(data.locale, 8) || null,
    hasCv: Boolean(data.cvStorageKey),
    cvUrl: cvUrl || null,
    cvScanStatus: cvScanStatusFor(data),
    cvFileCheck: cvFileCheckFor(data),
    emails: {
      intro: notificationStatus(data, 'customer_intro'),
      reminder: notificationStatus(data, 'customer_materials_reminder'),
      submitted: notificationStatus(data, 'customer_submitted'),
    },
    candidateEmails: candidateEmailsFor(data),
    cvUploadedAt: timestampToIso(data.cvUploadedAt),
    consentVersion: optionalString(data.consentVersion, 120) || null,
    consentedAt: timestampToIso(data.consentedAt),
    submissionStatus: statusFor(data),
    automationState: boundedString(data.automationState, 40) || null,
    submissionNotes: optionalString(data.submissionNotes, 2000) || null,
    submittedAt: timestampToIso(data.submittedAt),
    blockedAt: timestampToIso(data.blockedAt),
    refundedAt: timestampToIso(data.refundedAt),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

const CANDIDATE_SUBMITTED_STATUSES = new Set([
  'ready_for_manual_submission',
  'in_progress',
  'submitted',
  'blocked',
]);

/**
 * The state shown by AssistedApplicationUpload for this order. Keep the
 * precedence identical to the candidate page: a submission already taken in
 * charge wins over payment, then a confirmed payment wins over waiting/error.
 */
function candidatePageStateFor(order) {
  const submissionStatus = statusFor(order);
  if (CANDIDATE_SUBMITTED_STATUSES.has(submissionStatus)) return 'submitted';
  if (order?.paymentStatus === 'paid') return 'paid';
  if (order?.paymentStatus === 'failed' || order?.paymentStatus === 'refunded') return 'error';
  return 'pending';
}

function serializeCandidateView(doc) {
  const data = doc.data() || {};
  return {
    orderId: doc.id,
    jobTitle: boundedString(data.jobTitle, 300),
    companyName: boundedString(data.companyName, 200),
    pageState: candidatePageStateFor(data),
    paymentStatus: boundedString(data.paymentStatus, 40),
    submissionStatus: statusFor(data),
    hasCv: Boolean(data.cvStorageKey),
    hasConsent: hasAssistedApplicationConsent(data),
    updatedAt: timestampToIso(data.updatedAt || data.statusChangedAt || data.createdAt),
  };
}

/**
 * The admin endpoint is the only path that turns a private Storage key into a
 * client-visible signed URL; the browser can never self-attest a scan verdict
 * (`cvScanStatus` is outside the candidate's writable keys in firestore.rules).
 */
async function cvUrlForOrder(orderId, data) {
  const key = data?.cvStorageKey;
  if (!isAssistedApplicationStorageKey(orderId, key)) return null;
  if (CV_LINK_WITHHELD_SCAN_STATUSES.has(cvScanStatusFor(data))) return null;
  const fileCheck = cvFileCheckFor(data);
  if (fileCheck && fileCheck !== 'ok') return null;
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
    const order = serializeOrder(doc, await cvUrlForOrder(doc.id, data));
    order.automation = await loadAutomationForAdmin(db, doc.id, { signUrl: resolveCvLink }).catch((error) => {
      console.error('[manageAssistedApplicationAdmin] automation view failed', doc.id, error instanceof Error ? error.message : String(error));
      return null;
    });
    return order;
  }));
  orders.sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''));
  // The last self-check of the PDF renderer (assistedApplicationRendererCheck.js):
  // only read here, never rendered, and the queue does not fail on it.
  let pdfRenderer = null;
  try {
    pdfRenderer = await readRendererCheck(db);
  } catch (error) {
    console.error('[manageAssistedApplicationAdmin] renderer check not read', error instanceof Error ? error.message : String(error));
  }
  return { status: 200, body: { ok: true, orders, pdfRenderer } };
}

/** Read only the candidate-facing order state for the owner preview. */
async function handleCandidateView(db, raw) {
  const orderId = boundedString(raw.orderId, 200);
  if (!orderId || !/^[A-Za-z0-9_-]+$/.test(orderId)) {
    throw new AssistedApplicationAdminError('invalid_input', 400);
  }
  const doc = await db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId).get();
  if (!doc.exists) throw new AssistedApplicationAdminError('order_not_found', 404);
  return {
    status: 200,
    body: { ok: true, candidateView: serializeCandidateView(doc) },
  };
}

function transitionErrorResponse(error) {
  if (error instanceof AssistedApplicationAdminError) {
    return { status: error.status, body: { ok: false, error: error.code } };
  }
  throw error;
}

function transitionEventType(fromStatus, toStatus) {
  if (fromStatus === 'awaiting_upload' && toStatus === 'in_progress') return 'materials_received_by_email';
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
  let automated = false;
  try {
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(orderRef);
      if (!snapshot.exists) throw new AssistedApplicationAdminError('order_not_found', 404);
      const current = snapshot.data() || {};
      automated = Boolean(current.automationState);
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
  // An automated order Valerie marks sent from the queue closes its flow too
  // (owner_submitted), so the automation box agrees with the queue. Only a
  // flow the robot left to her moves; anything else is ignored.
  if (toStatus === 'submitted' && automated) {
    await recordOwnerSubmission({ db, orderId, adminEmail, via: 'owner', runEffect: runAutomationEffect }).catch((error) => console.error('[manageAssistedApplicationAdmin] flow not closed', orderId, error instanceof Error ? error.message : String(error)));
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

/**
 * Full Stripe refund of one order, used by the owner queue and by the
 * automated flow when the ad closes before sending (actor 'automation').
 */
export async function issueAssistedApplicationRefund(db, raw, adminEmail) {
  return handleRefund(db, raw, adminEmail);
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

const STORAGE_BUCKET = ASSISTED_APPLICATION_STORAGE_BUCKET;
const MAX_CV_BYTES = 5 * 1024 * 1024;
const CV_CONTENT_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const OWNER_UPLOAD_STATUSES = new Set(['awaiting_upload', 'ready_for_manual_submission', 'in_progress', 'blocked']);

/**
 * The CV arrived as an e-mail attachment: the owner uploads it for the
 * customer. Same folder, same magic-byte types and size cap as the customer
 * upload (storage.rules); the order-trigger then runs the usual type check,
 * which is what starts the automated flow.
 */
async function handleOwnerCvUpload(db, raw, adminEmail) {
  const orderId = boundedString(raw.orderId, 200);
  const content = String(raw.contentBase64 || '');
  if (!orderId || !content || content.length > Math.ceil(MAX_CV_BYTES / 3) * 4 + 8) {
    throw new AssistedApplicationAdminError('invalid_input', 400);
  }
  const buffer = Buffer.from(content, 'base64');
  const type = detectCvFileType(buffer.subarray(0, 8));
  if (!type || buffer.length === 0 || buffer.length > MAX_CV_BYTES) throw new AssistedApplicationAdminError('invalid_cv_file', 400);
  const stem = boundedString(raw.fileName, 120).replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'cv';
  const key = `assisted-application-uploads/${orderId}/${Date.now()}-${randomUUID()}-${stem}.${type}`;
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  const snapshot = await orderRef.get();
  if (!snapshot.exists) throw new AssistedApplicationAdminError('order_not_found', 404);
  const current = snapshot.data() || {};
  if (current.paymentStatus !== 'paid') throw new AssistedApplicationAdminError('payment_not_confirmed', 409);
  if (!OWNER_UPLOAD_STATUSES.has(statusFor(current))) throw new AssistedApplicationAdminError('invalid_transition', 409);
  const bucket = getStorage().bucket(STORAGE_BUCKET);
  await bucket.file(key).save(buffer, { contentType: CV_CONTENT_TYPES[type], resumable: false });
  const fromStatus = statusFor(current);
  const timestamp = FieldValue.serverTimestamp();
  await db.runTransaction(async (transaction) => {
    transaction.set(orderRef, {
      cvStorageKey: key,
      cvUploadedAt: Timestamp.now(),
      cvUploadedBy: 'owner',
      updatedAt: timestamp,
      ...(fromStatus === 'awaiting_upload' ? { submissionStatus: 'in_progress', statusChangedAt: timestamp } : {}),
    }, { merge: true });
    transaction.set(orderRef.collection('events').doc(), buildAssistedApplicationEvent('cv_uploaded_by_owner', {
      actorEmail: adminEmail,
      detectedType: type,
    }));
    if (fromStatus === 'awaiting_upload') {
      transaction.set(orderRef.collection('events').doc(), buildAssistedApplicationEvent('materials_received_by_email', {
        actorEmail: adminEmail,
        fromStatus,
        toStatus: 'in_progress',
      }));
    }
  });
  const previous = current.cvStorageKey;
  if (previous && previous !== key && isAssistedApplicationStorageKey(orderId, previous)) {
    await bucket.file(previous).delete({ ignoreNotFound: true }).catch(() => {});
  }
  return { status: 200, body: { ok: true, orderId, detectedType: type } };
}

async function handleMutate(db, req, adminEmail) {
  const raw = req.body && typeof req.body === 'object' ? req.body : {};
  const action = boundedString(raw.action, 80);
  if (action === 'candidateView') return handleCandidateView(db, raw);
  if (action === 'refund') return handleRefund(db, raw, adminEmail);
  if (action === 'uploadCv') return handleOwnerCvUpload(db, raw, adminEmail);
  if (AUTOMATION_ADMIN_ACTIONS.has(action)) {
    try {
      const body = await handleAutomationAdminAction(db, raw, adminEmail, {
        runEffect: runAutomationEffect,
        bucket: getStorage().bucket(STORAGE_BUCKET),
        // Read only by automationRevealAccount (portal accounts on the alias).
        runKey: () => getRemoteConfigValue('ASSISTED_APPLICATION_RUN_KEY'),
        // Read only by automationFillKit: the documents the fill extension attaches.
        signUrl: resolveCvLink,
        originalCvUrl: cvUrlForOrder,
      });
      return { status: 200, body };
    } catch (error) {
      if (error instanceof AutomationAdminError) throw new AssistedApplicationAdminError(error.code, error.status);
      throw error;
    }
  }
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
