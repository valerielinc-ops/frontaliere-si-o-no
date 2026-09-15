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

  const payloadHash = sha256(JSON.stringify({ order, successUrl, cancelUrl }));
  const requestKeyHash = sha256(`${userId}:${requestKey}`);
  const firestore = db();
  const requestRef = firestore
    .collection(ASSISTED_APPLICATION_CHECKOUT_REQUESTS_COLLECTION)
    .doc(requestKeyHash);
  const orderCollection = firestore.collection(ASSISTED_APPLICATIONS_COLLECTION);
  let requestRecord = null;
  let orderRef = null;

  try {
    await firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(requestRef);
      if (existing.exists) {
        requestRecord = existing.data() || {};
        if (
          requestRecord.userId !== userId
          || requestRecord.requestKeyHash !== requestKeyHash
          || requestRecord.payloadHash !== payloadHash
          || !requestRecord.orderId
        ) {
          throw new AssistedApplicationRequestConflictError();
        }
        orderRef = orderCollection.doc(requestRecord.orderId);
        return;
      }

      orderRef = orderCollection.doc();
      requestRecord = {
        requestKeyHash,
        payloadHash,
        userId,
        orderId: orderRef.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      transaction.set(requestRef, requestRecord);
      transaction.set(orderRef, {
        orderId: orderRef.id,
        userId,
        checkoutRequestKeyHash: requestKeyHash,
        ...order,
        paymentStatus: 'pending',
        submissionStatus: 'awaiting_payment',
        applicantName: null,
        applicantEmail: null,
        applicantPhone: null,
        cvStorageKey: null,
        coverLetterStorageKey: null,
        consentVersion: null,
        consentedAt: null,
        submittedAt: null,
        refundedAt: null,
        retentionPurgedAt: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (error) {
    if (error instanceof AssistedApplicationRequestConflictError) {
      return { status: 409, body: { ok: false, error: 'assisted_application_request_conflict' } };
    }
    throw error;
  }

  if (requestRecord?.checkoutUrl && requestRecord.stripeCheckoutSessionId) {
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
    idempotencyKey: `assisted-application:${requestKeyHash}`,
  });

  await orderRef.set({
    stripeCheckoutSessionId: session.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await requestRef.set({
    stripeCheckoutSessionId: session.id,
    checkoutUrl: session.url,
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
  if (!isCompleted && !isAsyncSucceeded && !isAsyncFailed && !isExpired) return false;
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

  const update = {
    paymentStatus,
    submissionStatus: paymentStatus === 'paid' ? 'awaiting_upload' : 'awaiting_payment',
    stripeSessionId: obj.id || null,
    amountTotal: typeof obj.amount_total === 'number' ? obj.amount_total : null,
    currency: obj.currency || ASSISTED_APPLICATION_CURRENCY,
    customerEmail: obj.customer_details?.email || obj.customer_email || null,
    updatedAt: ts,
    ...(paymentStatus === 'paid' ? { paidAt: ts } : {}),
    ...(paymentFailureReason ? { paymentFailureReason } : {}),
  };

  await dbFn().collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId).set(update, { merge: true });
  return true;
}
