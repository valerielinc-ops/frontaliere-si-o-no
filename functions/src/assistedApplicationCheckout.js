/**
 * One-off Stripe checkout for the assisted-application funnel (#6405).
 *
 * The browser may request a session, but it never writes payment state. The
 * only transition to `paymentStatus: 'paid'` lives in
 * handleAssistedApplicationWebhookEvent, dispatched by the single signed
 * Stripe webhook in stripePublisherCore.js.
 */

import admin from 'firebase-admin';
import { createHash } from 'node:crypto';
import { db, getStripe, verifyCaller } from './stripePublisherCore.js';

export const ASSISTED_APPLICATION_PRODUCT = 'assisted_application';
export const ASSISTED_APPLICATION_PRICE_CENTS = 99;
export const ASSISTED_APPLICATION_CURRENCY = 'eur';
export const ASSISTED_APPLICATION_CONSENT_VERSION = 'assisted-application-v1';

const ASSISTED_APPLICATIONS_COLLECTION = 'assisted_applications';
const ASSISTED_APPLICATION_CHECKOUT_REQUESTS_COLLECTION = 'assisted_application_checkout_requests';
const VALID_VARIANTS = new Set(['control', 'assisted_application']);
const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

class AssistedApplicationRequestConflictError extends Error {
  constructor() {
    super('assisted_application_request_conflict');
    this.name = 'AssistedApplicationRequestConflictError';
  }
}

function boundedString(value, max) {
  const result = String(value ?? '').trim();
  return result && result.length <= max ? result : '';
}

function appendOrderId(url, orderId) {
  const parsed = new URL(url);
  parsed.searchParams.set('assisted_application_order_id', orderId);
  return parsed.toString();
}

function validHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function validRequestKey(value) {
  const result = boundedString(value, 128);
  return REQUEST_KEY_RE.test(result) ? result : '';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalCheckoutOrder(order) {
  return {
    jobId: order.jobId,
    companyId: order.companyId,
    jobUrl: order.jobUrl,
    companyName: order.companyName,
    experimentVariant: order.experimentVariant,
  };
}

function payloadHashFor(order) {
  return sha256(JSON.stringify({
    version: 2,
    order: canonicalCheckoutOrder(order),
  }));
}

function sameCanonicalCheckoutOrder(left, right) {
  return JSON.stringify(canonicalCheckoutOrder(left))
    === JSON.stringify(canonicalCheckoutOrder(right));
}

function shouldIgnoreAssistedApplicationWebhook(currentOrder, sessionId) {
  if (!currentOrder) return false;
  const currentSessionId = boundedString(
    currentOrder.stripeCheckoutSessionId || currentOrder.stripeSessionId,
    200,
  );
  if (currentSessionId && sessionId && currentSessionId !== sessionId) return true;
  if (currentOrder.submissionStatus === 'ready_for_manual_submission') return true;
  return ['paid', 'failed', 'refunded'].includes(currentOrder.paymentStatus);
}

function metadataForOrder(order, userId) {
  return {
    product: ASSISTED_APPLICATION_PRODUCT,
    orderId: order.orderId,
    jobId: order.jobId,
    jobUrl: order.jobUrl,
    companyName: order.companyName,
    jobTitle: order.jobTitle,
    experimentVariant: order.experimentVariant,
    userId,
  };
}

function checkoutAttemptFor(value) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : 1;
}

function isTerminalCheckoutOrder(order) {
  if (order?.paymentStatus === 'paid') return false;
  return order?.checkoutSessionStatus === 'expired'
    || order?.checkoutSessionStatus === 'failed'
    || order?.paymentStatus === 'failed'
    || order?.paymentFailureReason === 'checkout_session_expired'
    || order?.paymentFailureReason === 'payment_not_confirmed'
    || order?.paymentFailureReason === 'amount_or_currency_missing_or_mismatch';
}

function stripeRequestKeyFor(requestRecord, requestKeyHash, checkoutAttempt) {
  const stored = boundedString(requestRecord?.stripeRequestKey, 128);
  if (stored) return stored;
  // Keep the pre-rotation key for ledgers written by the previous version.
  return checkoutAttempt === 1 ? requestKeyHash : requestKeyHash + ':' + checkoutAttempt;
}

function pendingOrderData(order, orderId, userId, requestKeyHash, checkoutAttempt) {
  return {
    orderId,
    userId,
    checkoutRequestKeyHash: requestKeyHash,
    checkoutAttempt,
    checkoutSessionStatus: 'creating',
    ...order,
    paymentStatus: 'pending',
    submissionStatus: 'awaiting_payment',
    applicantName: null,
    applicantEmail: null,
    applicantPhone: null,
    cvStorageKey: null,
    cvUploadedAt: null,
    coverLetterStorageKey: null,
    consentVersion: null,
    consentedAt: null,
    submittedAt: null,
    refundedAt: null,
    stripePaymentIntentId: null,
    stripeChargeId: null,
    stripeRefundId: null,
    retentionPurgedAt: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

/** Create a pending order and a fixed-price, one-time Stripe Checkout Session. */
export async function handleCreateAssistedApplicationCheckout(req) {
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }

  const decoded = await verifyCaller(req);
  if (!decoded) return { status: 401, body: { ok: false, error: 'unauthenticated' } };

  const body = req.body || {};
  const userId = String(decoded.uid || '');
  const requestKey = validRequestKey(body.requestKey);
  if (!userId || !requestKey) {
    return { status: 400, body: { ok: false, error: 'invalid_request_key' } };
  }
  const order = {
    jobId: boundedString(body.jobId, 200),
    companyId: boundedString(body.companyId || body.companyName, 200),
    jobUrl: boundedString(body.jobUrl, 500),
    companyName: boundedString(body.companyName, 200),
    jobTitle: boundedString(body.jobTitle, 300),
    experimentVariant: VALID_VARIANTS.has(body.experimentVariant) ? body.experimentVariant : 'control',
  };
  const successUrl = boundedString(body.successUrl, 1000);
  const cancelUrl = boundedString(body.cancelUrl, 1000);

  if (!order.jobId || !validHttpsUrl(order.jobUrl) || !order.companyId || !order.companyName || !order.jobTitle) {
    return { status: 400, body: { ok: false, error: 'invalid_job' } };
  }
  if (!validHttpsUrl(successUrl) || !validHttpsUrl(cancelUrl)) {
    return { status: 400, body: { ok: false, error: 'invalid_redirect_urls' } };
  }

  const payloadHash = payloadHashFor(order);
  const requestKeyHash = sha256(`${userId}:${requestKey}`);
  const firestore = db();
  const requestRef = firestore
    .collection(ASSISTED_APPLICATION_CHECKOUT_REQUESTS_COLLECTION)
    .doc(requestKeyHash);
  const orderCollection = firestore.collection(ASSISTED_APPLICATIONS_COLLECTION);
  let requestRecord = null;
  let orderRef = null;
  let checkoutAttempt = 1;
  let stripeRequestKey = requestKeyHash;
  let paidOrderResumeId = null;

  try {
    await firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(requestRef);
      if (existing.exists) {
        const existingRecord = existing.data() || {};
        if (
          existingRecord.userId !== userId
          || existingRecord.requestKeyHash !== requestKeyHash
          || !existingRecord.orderId
        ) {
          throw new AssistedApplicationRequestConflictError();
        }
        const existingOrderRef = orderCollection.doc(existingRecord.orderId);
        const existingOrderSnapshot = await transaction.get(existingOrderRef);
        const existingOrder = existingOrderSnapshot.exists ? existingOrderSnapshot.data() || {} : null;
        if (
          !existingOrderSnapshot.exists
          || !sameCanonicalCheckoutOrder(existingOrder, order)
        ) {
          throw new AssistedApplicationRequestConflictError();
        }
        if (existingOrderSnapshot.exists && !isTerminalCheckoutOrder(existingOrder)) {
          requestRecord = { ...existingRecord, payloadHash };
          orderRef = existingOrderRef;
          checkoutAttempt = checkoutAttemptFor(existingRecord.checkoutAttempt);
          stripeRequestKey = stripeRequestKeyFor(existingRecord, requestKeyHash, checkoutAttempt);
          paidOrderResumeId = existingOrder.paymentStatus === 'paid' ? existingRecord.orderId : null;
          if (existingRecord.payloadHash !== payloadHash) {
            transaction.set(requestRef, {
              payloadHash,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
          }
          return;
        }

        checkoutAttempt = checkoutAttemptFor(existingRecord.checkoutAttempt) + 1;
        orderRef = orderCollection.doc();
        stripeRequestKey = stripeRequestKeyFor(null, requestKeyHash, checkoutAttempt);
        requestRecord = {
          ...existingRecord,
          payloadHash,
          orderId: orderRef.id,
          checkoutAttempt,
          stripeRequestKey,
          checkoutSessionStatus: 'creating',
          stripeCheckoutSessionId: null,
          checkoutUrl: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        transaction.set(requestRef, requestRecord, { merge: true });
        transaction.set(
          orderRef,
          pendingOrderData(order, orderRef.id, userId, requestKeyHash, checkoutAttempt),
        );
        return;
      }

      orderRef = orderCollection.doc();
      checkoutAttempt = 1;
      stripeRequestKey = requestKeyHash;
      requestRecord = {
        requestKeyHash,
        payloadHash,
        userId,
        orderId: orderRef.id,
        checkoutAttempt,
        stripeRequestKey,
        checkoutSessionStatus: 'creating',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      transaction.set(requestRef, requestRecord);
      transaction.set(
        orderRef,
        pendingOrderData(order, orderRef.id, userId, requestKeyHash, checkoutAttempt),
      );
    });
  } catch (error) {
    if (error instanceof AssistedApplicationRequestConflictError) {
      return { status: 409, body: { ok: false, error: 'assisted_application_request_conflict' } };
    }
    throw error;
  }

  if (paidOrderResumeId) {
    return {
      status: 200,
      body: {
        ok: true,
        url: appendOrderId(successUrl, paidOrderResumeId),
        orderId: paidOrderResumeId,
      },
    };
  }

  if (
    requestRecord?.checkoutUrl
    && requestRecord.stripeCheckoutSessionId
    && requestRecord.checkoutSessionStatus !== 'expired'
  ) {
    return {
      status: 200,
      body: { ok: true, url: requestRecord.checkoutUrl, orderId: requestRecord.orderId },
    };
  }

  const orderId = orderRef.id;
  const metadata = metadataForOrder({ ...order, orderId }, userId);

  const stripe = await getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: ASSISTED_APPLICATION_CURRENCY,
        unit_amount: ASSISTED_APPLICATION_PRICE_CENTS,
        product_data: { name: 'Candidatura assistita' },
      },
      quantity: 1,
    }],
    success_url: appendOrderId(successUrl, orderId),
    cancel_url: cancelUrl,
    client_reference_id: orderId,
    customer_email: typeof decoded.email === 'string' && decoded.email ? decoded.email : undefined,
    metadata,
    payment_intent_data: { metadata },
  }, {
    idempotencyKey: 'assisted-application:' + stripeRequestKey,
  });

  await orderRef.set({
    stripeCheckoutSessionId: session.id,
    checkoutAttempt,
    stripeRequestKey,
    checkoutSessionStatus: 'open',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await requestRef.set({
    checkoutAttempt,
    stripeRequestKey,
    stripeCheckoutSessionId: session.id,
    checkoutUrl: session.url,
    checkoutSessionStatus: 'open',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return {
    status: 200,
    body: { ok: true, url: session.url, orderId },
  };
}

/**
 * Dispatch target for the signed, project-wide Stripe webhook. Returns true
 * only for this product's Checkout completion, so publisher/reader handlers
 * never see or reinterpret the event.
 */
export async function handleAssistedApplicationWebhookEvent(event, { db: dbFn, ts }) {
  const obj = event.data?.object || {};
  const isCompleted = event.type === 'checkout.session.completed';
  const isAsyncSucceeded = event.type === 'checkout.session.async_payment_succeeded';
  const isAsyncFailed = event.type === 'checkout.session.async_payment_failed';
  const isExpired = event.type === 'checkout.session.expired';
  const isChargeRefunded = event.type === 'charge.refunded';
  if (!isCompleted && !isAsyncSucceeded && !isAsyncFailed && !isExpired && !isChargeRefunded) return false;

  const firestore = dbFn();

  // A one-off assisted payment can also be refunded from the Stripe dashboard.
  // Stripe normally carries the PaymentIntent metadata onto the charge; the
  // lookup fallback keeps older orders reachable when only payment_intent is
  // present on the charge payload.
  if (isChargeRefunded) {
    let orderId = boundedString(obj.metadata?.orderId, 200);
    let orderRef = orderId
      ? firestore.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId)
      : null;
    if (obj.metadata?.product && obj.metadata.product !== ASSISTED_APPLICATION_PRODUCT) return false;
    if (!orderRef) {
      const paymentIntentId = boundedString(obj.payment_intent, 200);
      const collection = firestore.collection(ASSISTED_APPLICATIONS_COLLECTION);
      if (!paymentIntentId || typeof collection.where !== 'function') return false;
      const matches = await collection.where('stripePaymentIntentId', '==', paymentIntentId).limit(1).get();
      const match = matches.docs?.[0];
      if (!match) return false;
      orderId = match.id;
      orderRef = match.ref;
    }
    if (!orderRef) return true;

    await firestore.runTransaction(async (transaction) => {
      const currentSnapshot = await transaction.get(orderRef);
      const currentOrder = currentSnapshot.exists ? currentSnapshot.data() || {} : null;
      if (!currentSnapshot.exists || currentOrder.submissionStatus === 'refunded') return;
      const refundId = boundedString(obj.refunds?.data?.[0]?.id, 200);
      transaction.set(orderRef, {
        paymentStatus: 'refunded',
        submissionStatus: 'refunded',
        stripePaymentIntentId: boundedString(obj.payment_intent, 200) || null,
        stripeChargeId: boundedString(obj.id, 200) || null,
        stripeRefundId: refundId || null,
        refundedAt: ts,
        statusChangedAt: ts,
        updatedAt: ts,
      }, { merge: true });
      transaction.set(orderRef.collection('events').doc(`refund-${refundId || obj.id || orderId}`), {
        eventType: 'refund_issued',
        actor: 'stripe_webhook',
        refundId: refundId || null,
        fromStatus: boundedString(currentOrder.submissionStatus, 80) || null,
        toStatus: 'refunded',
        createdAt: ts,
      });
    });
    return true;
  }

  if (obj.metadata?.product !== ASSISTED_APPLICATION_PRODUCT) return false;

  const orderId = boundedString(obj.metadata?.orderId || obj.client_reference_id, 200);
  if (!orderId) return true;

  const amountValid = obj.amount_total === ASSISTED_APPLICATION_PRICE_CENTS;
  const currencyValid = typeof obj.currency === 'string'
    && obj.currency.toLowerCase() === ASSISTED_APPLICATION_CURRENCY;
  const amountMismatch = !amountValid;
  const currencyMismatch = !currencyValid;
  const paymentConfirmed = (isAsyncSucceeded || obj.payment_status === 'paid')
    && amountValid
    && currencyValid;
  let paymentStatus = 'pending';
  if (isExpired || isAsyncFailed || amountMismatch || currencyMismatch) {
    paymentStatus = 'failed';
  } else if (paymentConfirmed) {
    paymentStatus = 'paid';
  }
  const paymentFailureReason = isExpired
    ? 'checkout_session_expired'
    : isAsyncFailed
      ? 'payment_not_confirmed'
      : amountMismatch || currencyMismatch
        ? 'amount_or_currency_missing_or_mismatch'
        : null;
  const checkoutSessionStatus = isExpired
    ? 'expired'
    : isAsyncFailed || amountMismatch || currencyMismatch
      ? 'failed'
      : paymentConfirmed
        ? 'completed'
        : 'pending';

  const update = {
    paymentStatus,
    submissionStatus: paymentStatus === 'paid' ? 'awaiting_upload' : 'awaiting_payment',
    checkoutSessionStatus,
    stripeSessionId: obj.id || null,
    stripePaymentIntentId: typeof obj.payment_intent === 'string'
      ? obj.payment_intent
      : obj.payment_intent?.id || null,
    amountTotal: typeof obj.amount_total === 'number' ? obj.amount_total : null,
    currency: obj.currency || ASSISTED_APPLICATION_CURRENCY,
    customerEmail: obj.customer_details?.email || obj.customer_email || null,
    updatedAt: ts,
    ...(paymentStatus === 'paid' ? { paidAt: ts } : {}),
    ...(paymentFailureReason ? { paymentFailureReason } : {}),
  };

  const orderRef = firestore.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  await firestore.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(orderRef);
    const currentOrder = currentSnapshot.exists ? currentSnapshot.data() || {} : null;
    if (shouldIgnoreAssistedApplicationWebhook(currentOrder, obj.id)) return;
    transaction.set(orderRef, update, { merge: true });
  });
  return true;
}
