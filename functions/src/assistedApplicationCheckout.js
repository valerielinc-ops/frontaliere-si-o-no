/**
 * One-off payment checkout for the assisted-application funnel (#6405).
 *
 * The browser may request a session, but it never writes payment state. The
 * only transition to `paymentStatus: 'paid'` lives in
 * handleAssistedApplicationWebhookEvent, dispatched by the signed Stripe
 * webhook or the verified SumUp callback.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import { db, getStripe, verifyCaller } from './stripePublisherCore.js';
import {
  ASSISTED_APPLICATIONS_COLLECTION,
  ASSISTED_APPLICATION_PRICE_EUR_CENTS,
} from './assistedApplicationConstants.js';
import {
  createSumUpAssistedApplicationCheckout,
  getAssistedApplicationPaymentProvider,
  SUMUP_PAYMENT_PROVIDER,
} from './sumupAssistedApplicationCore.js';
import { isAutomationAgent, isCrawlerVisitorAgent } from './lib/returnVisit.js';
import { localeFromSiteUrl } from './assistedApplicationNotifications.js';

export const ASSISTED_APPLICATION_PRODUCT = 'assisted_application';
export const ASSISTED_APPLICATION_PRICE_CENTS = ASSISTED_APPLICATION_PRICE_EUR_CENTS;
export const ASSISTED_APPLICATION_CURRENCY = 'eur';
// v2 (2026-09-30): the mandate names the employer's terms accepted on the candidate's behalf.
export const ASSISTED_APPLICATION_CONSENT_VERSION = 'assisted-application-v2';

const ASSISTED_APPLICATION_CHECKOUT_REQUESTS_COLLECTION = 'assisted_application_checkout_requests';
// `offerwall_fallback`: the paid offer opened because the job-board Offerwall
// could not load (JobBoard handleRewardedApplicationUnavailable).
const VALID_VARIANTS = new Set(['control', 'assisted_application', 'offerwall_fallback']);
const VALID_COPY_VARIANTS = new Set(['control', 'time_saved', 'portal_relief', 'handled_for_you']);
const VALID_LOCALES = new Set(['it', 'en', 'de', 'fr']);
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

function requestUserAgent(req) {
  const value = typeof req?.get === 'function'
    ? req.get('user-agent')
    : req?.headers?.['user-agent'];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function isAutomatedCheckoutRequest(req) {
  const userAgent = requestUserAgent(req);
  return isCrawlerVisitorAgent(userAgent) || isAutomationAgent(userAgent);
}

function isFullChargeRefund(charge) {
  if (charge?.refunded === true) return true;
  const amount = Number(charge?.amount);
  const amountRefunded = Number(charge?.amount_refunded);
  return Number.isFinite(amount)
    && amount > 0
    && Number.isFinite(amountRefunded)
    && amountRefunded >= amount;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalCheckoutOrder(order) {
  // Copy attribution is presentation metadata, not checkout identity. Keeping
  // it out of this shape lets pre-experiment request keys resume safely.
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

function shouldIgnoreAssistedApplicationWebhook(currentOrder, sessionId, paymentProvider = 'stripe') {
  if (!currentOrder) return false;
  const currentProvider = currentOrder.paymentProvider || 'stripe';
  if (currentProvider !== paymentProvider) return true;
  const currentSessionId = boundedString(
    paymentProvider === SUMUP_PAYMENT_PROVIDER
      ? currentOrder.sumupCheckoutId
      : currentOrder.stripeCheckoutSessionId || currentOrder.stripeSessionId,
    200,
  );
  if (currentSessionId && sessionId && currentSessionId !== sessionId) return true;
  if (currentOrder.submissionStatus === 'ready_for_manual_submission') return true;
  // A hosted checkout can contain multiple payment attempts. A failed
  // attempt must remain upgradeable when a later callback for the same
  // checkout confirms payment.
  return ['paid', 'refunded'].includes(currentOrder.paymentStatus);
}

function metadataForOrder(order, userId) {
  return {
    product: ASSISTED_APPLICATION_PRODUCT,
    paymentProvider: order.paymentProvider || 'stripe',
    orderId: order.orderId,
    jobId: order.jobId,
    jobUrl: order.jobUrl,
    companyName: order.companyName,
    jobTitle: order.jobTitle,
    experimentVariant: order.experimentVariant,
    copyVariant: order.copyVariant || 'control',
    userId,
    locale: order.locale || 'it',
  };
}

function checkoutAttemptFor(value) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : 1;
}

function checkoutExpirySeconds(value) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function checkoutHasExpired(record) {
  const expiresAt = checkoutExpirySeconds(record?.checkoutExpiresAt);
  return expiresAt !== null && expiresAt * 1000 <= Date.now();
}

function checkoutIdForRecord(record) {
  return record?.paymentProvider === SUMUP_PAYMENT_PROVIDER
    ? boundedString(record?.sumupCheckoutId, 200)
    : boundedString(record?.stripeCheckoutSessionId, 200);
}

async function persistedStripeCheckoutExpired(record) {
  if (record?.paymentProvider !== 'stripe') return false;
  const sessionId = checkoutIdForRecord(record);
  if (!sessionId) return false;
  const persistedExpiresAt = checkoutExpirySeconds(record.checkoutExpiresAt);
  if (persistedExpiresAt !== null) {
    return persistedExpiresAt * 1000 <= Date.now();
  }

  try {
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session?.status === 'expired') return true;
    const expiresAt = checkoutExpirySeconds(session?.expires_at);
    return expiresAt !== null && expiresAt * 1000 <= Date.now();
  } catch (error) {
    console.warn(
      '[assistedApplicationCheckout] Stripe checkout expiry lookup failed',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

function isTerminalCheckoutOrder(order) {
  if (order?.paymentStatus === 'paid') return false;
  if (checkoutHasExpired(order)) return true;
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

function pendingOrderData(order, orderId, userId, requestKeyHash, checkoutAttempt, presentation, paymentProvider) {
  return {
    orderId,
    userId,
    paymentProvider,
    // Presentation only (not part of the checkout identity): the concierge
    // emails are written in this locale and link back to this page.
    locale: presentation.locale,
    orderPageUrl: appendOrderId(presentation.successUrl, orderId),
    checkoutRequestKeyHash: requestKeyHash,
    checkoutAttempt,
    checkoutSessionStatus: 'creating',
    ...order,
    paymentStatus: 'pending',
    submissionStatus: 'awaiting_payment',
    customerEmail: presentation.customerEmail || null,
    applicantName: null,
    applicantEmail: null,
    applicantPhone: null,
    cvStorageKey: null,
    cvUploadedAt: null,
    cvFileName: null,
    coverLetterStorageKey: null,
    consentVersion: null,
    consentedAt: null,
    submittedAt: null,
    refundedAt: null,
    stripePaymentIntentId: null,
    stripeChargeId: null,
    stripeRefundId: null,
    sumupCheckoutId: null,
    sumupTransactionId: null,
    sumupTransactionCode: null,
    checkoutExpiresAt: null,
    sumupRefundRequestId: null,
    sumupRefundRequestStatus: null,
    sumupRefundRequestedAt: null,
    sumupRefundAcceptedAt: null,
    sumupRefundId: null,
    retentionPurgedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/** Create a pending order and a fixed-price, one-time payment checkout. */
export async function handleCreateAssistedApplicationCheckout(req) {
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }
  if (isAutomatedCheckoutRequest(req)) {
    return { status: 403, body: { ok: false, error: 'automation_not_allowed' } };
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
    copyVariant: VALID_COPY_VARIANTS.has(body.copyVariant) ? body.copyVariant : 'control',
  };
  const successUrl = boundedString(body.successUrl, 1000);
  const cancelUrl = boundedString(body.cancelUrl, 1000);
  const locale = VALID_LOCALES.has(body.locale) ? body.locale : (localeFromSiteUrl(successUrl) || 'it');

  if (!order.jobId || !validHttpsUrl(order.jobUrl) || !order.companyId || !order.companyName || !order.jobTitle) {
    return { status: 400, body: { ok: false, error: 'invalid_job' } };
  }
  if (!validHttpsUrl(successUrl) || !validHttpsUrl(cancelUrl)) {
    return { status: 400, body: { ok: false, error: 'invalid_redirect_urls' } };
  }

  const payloadHash = payloadHashFor(order);
  const requestKeyHash = sha256(`${userId}:${requestKey}`);
  const customerEmail = boundedString(decoded.email, 320) || null;
  const configuredPaymentProvider = await getAssistedApplicationPaymentProvider();
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
  let staleCheckout = null;

  const existingRequestSnapshot = await requestRef.get();
  if (existingRequestSnapshot.exists) {
    const existingRecord = existingRequestSnapshot.data() || {};
    if (
      existingRecord.userId === userId
      && existingRecord.requestKeyHash === requestKeyHash
      && existingRecord.orderId
    ) {
      const existingOrderSnapshot = await orderCollection.doc(existingRecord.orderId).get();
      const existingOrder = existingOrderSnapshot.exists ? existingOrderSnapshot.data() || {} : null;
      if (
        existingOrder
        && sameCanonicalCheckoutOrder(existingOrder, order)
        && existingOrder.paymentStatus !== 'paid'
      ) {
        const checkoutRecord = { ...existingRecord, ...existingOrder };
        const checkoutExpired = checkoutHasExpired(checkoutRecord)
          || (!isTerminalCheckoutOrder(existingOrder)
            && await persistedStripeCheckoutExpired(checkoutRecord));
        if (checkoutExpired) {
          staleCheckout = {
            orderId: existingRecord.orderId,
            checkoutId: checkoutIdForRecord(checkoutRecord),
          };
        }
      }
    }
  }

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
        const stalePersistedCheckout = existingOrderSnapshot.exists
          && existingOrder.paymentStatus !== 'paid'
          && staleCheckout?.orderId === existingRecord.orderId
          && staleCheckout.checkoutId === checkoutIdForRecord(existingRecord);
        if (existingOrderSnapshot.exists && !isTerminalCheckoutOrder(existingOrder) && !stalePersistedCheckout) {
          requestRecord = { ...existingRecord, payloadHash };
          orderRef = existingOrderRef;
          checkoutAttempt = checkoutAttemptFor(existingRecord.checkoutAttempt);
          stripeRequestKey = stripeRequestKeyFor(existingRecord, requestKeyHash, checkoutAttempt);
          paidOrderResumeId = existingOrder.paymentStatus === 'paid' ? existingRecord.orderId : null;
          if (existingRecord.payloadHash !== payloadHash) {
            transaction.set(requestRef, {
              payloadHash,
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
          }
          if (customerEmail && !existingOrder.customerEmail) {
            transaction.set(existingOrderRef, {
              customerEmail,
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
          }
          return;
        }

        if (stalePersistedCheckout) {
          transaction.set(existingOrderRef, {
            paymentStatus: 'failed',
            submissionStatus: 'awaiting_payment',
            checkoutSessionStatus: 'expired',
            paymentFailureReason: 'checkout_session_expired',
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }

        checkoutAttempt = checkoutAttemptFor(existingRecord.checkoutAttempt) + 1;
        orderRef = orderCollection.doc();
        stripeRequestKey = stripeRequestKeyFor(null, requestKeyHash, checkoutAttempt);
        requestRecord = {
          ...existingRecord,
          payloadHash,
          orderId: orderRef.id,
          checkoutAttempt,
          paymentProvider: configuredPaymentProvider,
          stripeRequestKey,
          checkoutSessionStatus: 'creating',
          stripeCheckoutSessionId: null,
          sumupCheckoutId: null,
          checkoutExpiresAt: null,
          checkoutUrl: null,
          updatedAt: FieldValue.serverTimestamp(),
        };
        transaction.set(requestRef, requestRecord, { merge: true });
        transaction.set(
          orderRef,
          pendingOrderData(
            order,
            orderRef.id,
            userId,
            requestKeyHash,
            checkoutAttempt,
            { locale, successUrl, customerEmail },
            configuredPaymentProvider,
          ),
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
        paymentProvider: configuredPaymentProvider,
        orderId: orderRef.id,
        checkoutAttempt,
        stripeRequestKey,
        checkoutSessionStatus: 'creating',
        checkoutExpiresAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.set(requestRef, requestRecord);
      transaction.set(
        orderRef,
        pendingOrderData(
          order,
          orderRef.id,
          userId,
          requestKeyHash,
          checkoutAttempt,
          { locale, successUrl, customerEmail },
          configuredPaymentProvider,
        ),
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

  const savedCheckoutId = requestRecord?.paymentProvider === SUMUP_PAYMENT_PROVIDER
    ? requestRecord.sumupCheckoutId
    : requestRecord?.stripeCheckoutSessionId;
  const savedCheckoutCanBeReused = savedCheckoutId
    && requestRecord.checkoutSessionStatus !== 'expired'
    && (requestRecord.paymentProvider === SUMUP_PAYMENT_PROVIDER || requestRecord.checkoutUrl);
  if (savedCheckoutCanBeReused) {
    if (requestRecord.paymentProvider === SUMUP_PAYMENT_PROVIDER) {
      return {
        status: 200,
        body: {
          ok: true,
          paymentProvider: SUMUP_PAYMENT_PROVIDER,
          checkoutId: savedCheckoutId,
          orderId: requestRecord.orderId,
        },
      };
    }
    return {
      status: 200,
      body: { ok: true, url: requestRecord.checkoutUrl, orderId: requestRecord.orderId },
    };
  }

  const orderId = orderRef.id;
  const checkoutProvider = requestRecord?.paymentProvider || configuredPaymentProvider;
  const metadata = metadataForOrder({ ...order, orderId, locale, paymentProvider: checkoutProvider }, userId);

  let checkoutUrl;
  let checkoutId;
  if (checkoutProvider === SUMUP_PAYMENT_PROVIDER) {
    const checkout = await createSumUpAssistedApplicationCheckout({
      orderId,
      redirectUrl: appendOrderId(successUrl, orderId),
    });
    checkoutId = checkout.id;
    await orderRef.set({
      paymentProvider: SUMUP_PAYMENT_PROVIDER,
      sumupCheckoutId: checkout.id,
      checkoutExpiresAt: null,
      checkoutAttempt,
      checkoutSessionStatus: 'open',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await requestRef.set({
      checkoutAttempt,
      paymentProvider: SUMUP_PAYMENT_PROVIDER,
      sumupCheckoutId: checkout.id,
      checkoutExpiresAt: null,
      // The assisted flow uses the embedded Payment Widget. Keep the legacy
      // URL empty so a retry cannot send the customer back to Hosted Checkout.
      checkoutUrl: null,
      checkoutSessionStatus: 'open',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } else {
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
    checkoutUrl = session.url;
    await orderRef.set({
      paymentProvider: 'stripe',
      stripeCheckoutSessionId: session.id,
      checkoutExpiresAt: checkoutExpirySeconds(session.expires_at),
      checkoutAttempt,
      stripeRequestKey,
      checkoutSessionStatus: 'open',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await requestRef.set({
      checkoutAttempt,
      paymentProvider: 'stripe',
      stripeRequestKey,
      stripeCheckoutSessionId: session.id,
      checkoutExpiresAt: checkoutExpirySeconds(session.expires_at),
      checkoutUrl: session.url,
      checkoutSessionStatus: 'open',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  return {
    status: 200,
    body: checkoutProvider === SUMUP_PAYMENT_PROVIDER
      ? {
        ok: true,
        paymentProvider: SUMUP_PAYMENT_PROVIDER,
        checkoutId,
        orderId,
      }
      : { ok: true, url: checkoutUrl, orderId },
  };
}

/**
 * Dispatch target for the signed, project-wide Stripe webhook. Returns true
 * only for this product's payment/refund events, so publisher/reader handlers
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
    const hasAssistedMetadata = obj.metadata?.product === ASSISTED_APPLICATION_PRODUCT;
    let orderId = hasAssistedMetadata ? boundedString(obj.metadata?.orderId, 200) : '';
    let orderRef = orderId
      ? firestore.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId)
      : null;
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
    if (!isFullChargeRefund(obj)) {
      console.warn('[assistedApplicationWebhook] partial charge refund left in queue', orderId);
      return true;
    }

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

  const paymentProvider = obj.metadata?.paymentProvider === SUMUP_PAYMENT_PROVIDER
    ? SUMUP_PAYMENT_PROVIDER
    : 'stripe';

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

  const providerUpdate = paymentProvider === SUMUP_PAYMENT_PROVIDER
    ? {
      paymentProvider: SUMUP_PAYMENT_PROVIDER,
      sumupCheckoutId: obj.id || null,
      sumupTransactionId: boundedString(obj.sumupTransactionId, 200) || null,
      sumupTransactionCode: boundedString(obj.sumupTransactionCode, 200) || null,
    }
    : {
      paymentProvider: 'stripe',
      stripeSessionId: obj.id || null,
      stripePaymentIntentId: typeof obj.payment_intent === 'string'
        ? obj.payment_intent
        : obj.payment_intent?.id || null,
    };
  const checkoutCustomerEmail = boundedString(obj.customer_details?.email || obj.customer_email, 320);
  const update = {
    paymentStatus,
    submissionStatus: paymentStatus === 'paid' ? 'awaiting_upload' : 'awaiting_payment',
    checkoutSessionStatus,
    ...providerUpdate,
    amountTotal: typeof obj.amount_total === 'number' ? obj.amount_total : null,
    currency: obj.currency || ASSISTED_APPLICATION_CURRENCY,
    ...(checkoutCustomerEmail ? { customerEmail: checkoutCustomerEmail } : {}),
    updatedAt: ts,
    ...(paymentStatus === 'paid'
      ? { paidAt: ts, paymentFailureReason: null }
      : paymentFailureReason ? { paymentFailureReason } : {}),
  };

  const orderRef = firestore.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  await firestore.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(orderRef);
    const currentOrder = currentSnapshot.exists ? currentSnapshot.data() || {} : null;
    if (shouldIgnoreAssistedApplicationWebhook(currentOrder, obj.id, paymentProvider)) return;
    transaction.set(orderRef, update, { merge: true });
  });
  return true;
}
