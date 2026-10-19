/**
 * One-off checkout for the 30-day application concierge.
 *
 * This is intentionally a separate ledger from assisted_applications: one
 * payment grants a parent entitlement, while each child application is
 * created only after the candidate accepts a proposal.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import { db, getStripe, verifyCaller } from './stripePublisherCore.js';
import {
  APPLICATION_CONCIERGE_CURRENCY,
  APPLICATION_CONCIERGE_DURATION_DAYS,
  APPLICATION_CONCIERGE_MAX_POSITIONS,
  APPLICATION_CONCIERGE_PRICE_EUR_CENTS,
  APPLICATION_CONCIERGE_PRODUCT,
  APPLICATION_CONCIERGE_SERVICES_COLLECTION,
} from './applicationConciergeConstants.js';
import {
  createSumUpApplicationConciergeCheckout,
  getAssistedApplicationPaymentProvider,
  SUMUP_PAYMENT_PROVIDER,
} from './sumupAssistedApplicationCore.js';

export const APPLICATION_CONCIERGE_CHECKOUT_REQUESTS_COLLECTION = 'application_concierge_checkout_requests';

const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const VALID_LOCALES = new Set(['it', 'en', 'de', 'fr']);

class ApplicationConciergeCheckoutConflictError extends Error {
  constructor() {
    super('application_concierge_checkout_conflict');
    this.name = 'ApplicationConciergeCheckoutConflictError';
  }
}

function boundedString(value, max) {
  const result = String(value ?? '').trim();
  return result && result.length <= max ? result : '';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

function appendServiceId(url, serviceId) {
  const parsed = new URL(url);
  parsed.searchParams.set('application_concierge_service_id', serviceId);
  return parsed.toString();
}

function requestUserAgent(req) {
  const value = typeof req?.get === 'function'
    ? req.get('user-agent')
    : req?.headers?.['user-agent'];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function isAutomatedCheckoutRequest(req) {
  return /bot|crawler|spider|headless|selenium|playwright/i.test(requestUserAgent(req));
}

function paymentProviderForOrder(service) {
  return service?.paymentProvider === SUMUP_PAYMENT_PROVIDER ? SUMUP_PAYMENT_PROVIDER : 'stripe';
}

function isResumeableService(service) {
  return service?.paymentStatus === 'pending'
    && !['expired', 'failed'].includes(String(service?.checkoutSessionStatus || '').toLowerCase());
}

function serviceData({ serviceId, userId, paymentProvider, locale, successUrl, customerEmail }) {
  return {
    serviceId,
    serviceType: APPLICATION_CONCIERGE_PRODUCT,
    plan: '30d-10-positions',
    userId,
    paymentProvider,
    paymentStatus: 'pending',
    serviceStatus: 'awaiting_payment',
    checkoutSessionStatus: 'creating',
    renewal: false,
    maxPositions: APPLICATION_CONCIERGE_MAX_POSITIONS,
    acceptedPositionsCount: 0,
    locale,
    servicePageUrl: appendServiceId(successUrl, serviceId),
    customerEmail: customerEmail || null,
    applicantName: null,
    applicantEmail: null,
    applicantPhone: null,
    consentVersion: null,
    consentedAt: null,
    cvStorageKey: null,
    cvUploadedAt: null,
    paidAt: null,
    expiresAt: null,
    amountTotal: APPLICATION_CONCIERGE_PRICE_EUR_CENTS,
    currency: APPLICATION_CONCIERGE_CURRENCY,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function metadataForService(serviceId, userId, locale, paymentProvider) {
  return {
    product: APPLICATION_CONCIERGE_PRODUCT,
    serviceId,
    userId,
    locale,
    paymentProvider,
  };
}

/** Create or resume the fixed-price, non-renewing concierge checkout. */
export async function handleCreateApplicationConciergeCheckout(req) {
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }
  if (isAutomatedCheckoutRequest(req)) {
    return { status: 403, body: { ok: false, error: 'automation_not_allowed' } };
  }

  const decoded = await verifyCaller(req);
  if (!decoded) return { status: 401, body: { ok: false, error: 'unauthenticated' } };

  const body = req.body || {};
  const userId = boundedString(decoded.uid, 200);
  const requestKey = validRequestKey(body.requestKey);
  const successUrl = boundedString(body.successUrl, 1000);
  const cancelUrl = boundedString(body.cancelUrl, 1000);
  const locale = VALID_LOCALES.has(body.locale) ? body.locale : 'it';
  if (!userId || !requestKey) return { status: 400, body: { ok: false, error: 'invalid_request_key' } };
  if (!validHttpsUrl(successUrl) || !validHttpsUrl(cancelUrl)) {
    return { status: 400, body: { ok: false, error: 'invalid_redirect_urls' } };
  }

  const configuredPaymentProvider = await getAssistedApplicationPaymentProvider();
  const firestore = db();
  const requestKeyHash = sha256(`${userId}:${requestKey}`);
  const requestRef = firestore.collection(APPLICATION_CONCIERGE_CHECKOUT_REQUESTS_COLLECTION).doc(requestKeyHash);
  const serviceCollection = firestore.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION);
  let requestRecord = null;
  let serviceRef = null;
  let checkoutAttempt = 1;
  let resumePaidServiceId = null;

  try {
    await firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(requestRef);
      if (existing.exists) {
        const existingRecord = existing.data() || {};
        if (existingRecord.userId !== userId || !existingRecord.serviceId) {
          throw new ApplicationConciergeCheckoutConflictError();
        }
        const existingServiceRef = serviceCollection.doc(existingRecord.serviceId);
        const existingServiceSnapshot = await transaction.get(existingServiceRef);
        const existingService = existingServiceSnapshot.exists ? existingServiceSnapshot.data() || {} : null;
        if (!existingServiceSnapshot.exists || existingService.userId !== userId) {
          throw new ApplicationConciergeCheckoutConflictError();
        }
        if (existingService.paymentStatus === 'paid') {
          requestRecord = existingRecord;
          serviceRef = existingServiceRef;
          resumePaidServiceId = existingRecord.serviceId;
          return;
        }
        const canResumeSumUpCheckout = existingRecord.paymentProvider === SUMUP_PAYMENT_PROVIDER
          && boundedString(existingRecord.sumupCheckoutId, 200);
        if (isResumeableService(existingService) && (existingRecord.checkoutUrl || canResumeSumUpCheckout)) {
          requestRecord = existingRecord;
          serviceRef = existingServiceRef;
          checkoutAttempt = Number(existingRecord.checkoutAttempt) || 1;
          return;
        }
        checkoutAttempt = (Number(existingRecord.checkoutAttempt) || 1) + 1;
      }

      serviceRef = serviceCollection.doc();
      requestRecord = {
        requestKeyHash,
        userId,
        serviceId: serviceRef.id,
        paymentProvider: configuredPaymentProvider,
        checkoutAttempt,
        checkoutSessionStatus: 'creating',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.set(requestRef, requestRecord, { merge: true });
      transaction.set(
        serviceRef,
        serviceData({
          serviceId: serviceRef.id,
          userId,
          paymentProvider: configuredPaymentProvider,
          locale,
          successUrl,
          customerEmail: boundedString(decoded.email, 320),
        }),
      );
    });
  } catch (error) {
    if (error instanceof ApplicationConciergeCheckoutConflictError) {
      return { status: 409, body: { ok: false, error: 'application_concierge_checkout_conflict' } };
    }
    throw error;
  }

  if (resumePaidServiceId) {
    return {
      status: 200,
      body: { ok: true, url: appendServiceId(successUrl, resumePaidServiceId), serviceId: resumePaidServiceId },
    };
  }
  if (
    requestRecord?.paymentProvider === SUMUP_PAYMENT_PROVIDER
    && requestRecord.sumupCheckoutId
    && isResumeableService({
      paymentStatus: 'pending',
      checkoutSessionStatus: requestRecord.checkoutSessionStatus,
    })
  ) {
    return {
      status: 200,
      body: {
        ok: true,
        paymentProvider: SUMUP_PAYMENT_PROVIDER,
        checkoutId: requestRecord.sumupCheckoutId,
        serviceId: requestRecord.serviceId,
      },
    };
  }
  if (requestRecord?.checkoutUrl && isResumeableService({
    paymentStatus: 'pending',
    checkoutSessionStatus: requestRecord.checkoutSessionStatus,
  })) {
    return { status: 200, body: { ok: true, url: requestRecord.checkoutUrl, serviceId: requestRecord.serviceId } };
  }

  const serviceId = serviceRef.id;
  const paymentProvider = requestRecord?.paymentProvider || configuredPaymentProvider;
  const customerEmail = boundedString(decoded.email, 320) || undefined;
  const successRedirect = appendServiceId(successUrl, serviceId);
  let checkoutUrl;
  if (paymentProvider === SUMUP_PAYMENT_PROVIDER) {
    const checkout = await createSumUpApplicationConciergeCheckout({
      serviceId,
      redirectUrl: successRedirect,
    });
    await serviceRef.set({
      paymentProvider: SUMUP_PAYMENT_PROVIDER,
      sumupCheckoutId: checkout.id,
      checkoutSessionStatus: 'open',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await requestRef.set({
      paymentProvider: SUMUP_PAYMENT_PROVIDER,
      sumupCheckoutId: checkout.id,
      checkoutSessionStatus: 'open',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return {
      status: 200,
      body: {
        ok: true,
        paymentProvider: SUMUP_PAYMENT_PROVIDER,
        checkoutId: checkout.id,
        serviceId,
      },
    };
  } else {
    const stripe = await getStripe();
    const metadata = metadataForService(serviceId, userId, locale, 'stripe');
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: APPLICATION_CONCIERGE_CURRENCY,
          unit_amount: APPLICATION_CONCIERGE_PRICE_EUR_CENTS,
          product_data: { name: 'Servizio candidature assistite' },
        },
        quantity: 1,
      }],
      success_url: successRedirect,
      cancel_url: cancelUrl,
      client_reference_id: serviceId,
      customer_email: customerEmail,
      metadata,
      payment_intent_data: { metadata },
    }, { idempotencyKey: `application-concierge:${requestKeyHash}:${checkoutAttempt}` });
    checkoutUrl = session.url;
    await serviceRef.set({
      paymentProvider: 'stripe',
      stripeCheckoutSessionId: session.id,
      checkoutSessionStatus: 'open',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await requestRef.set({
      paymentProvider: 'stripe',
      stripeCheckoutSessionId: session.id,
      checkoutUrl,
      checkoutSessionStatus: 'open',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  return { status: 200, body: { ok: true, url: checkoutUrl, serviceId } };
}

function isFullChargeRefund(charge) {
  if (charge?.refunded === true) return true;
  const amount = Number(charge?.amount);
  const refunded = Number(charge?.amount_refunded);
  return Number.isFinite(amount) && amount > 0 && Number.isFinite(refunded) && refunded >= amount;
}

function shouldIgnoreWebhook(service, sessionId, paymentProvider) {
  if (!service) return false;
  const expectedProvider = paymentProviderForOrder(service);
  if (expectedProvider !== paymentProvider) return true;
  const currentId = boundedString(
    paymentProvider === SUMUP_PAYMENT_PROVIDER ? service.sumupCheckoutId : service.stripeCheckoutSessionId,
    200,
  );
  if (currentId && sessionId && currentId !== sessionId) return true;
  // A hosted checkout can contain multiple attempts. Keep paid/refunded
  // terminal, but allow a later successful retry to upgrade a failed attempt.
  return ['paid', 'refunded'].includes(String(service.paymentStatus || ''));
}

/** Signed Stripe or verified SumUp payment transition for this product. */
export async function handleApplicationConciergeWebhookEvent(
  event,
  { db: dbFn, ts, nowMs = Date.now } = {},
) {
  const obj = event.data?.object || {};
  const isCompleted = event.type === 'checkout.session.completed';
  const isAsyncSucceeded = event.type === 'checkout.session.async_payment_succeeded';
  const isAsyncFailed = event.type === 'checkout.session.async_payment_failed';
  const isExpired = event.type === 'checkout.session.expired';
  const isChargeRefunded = event.type === 'charge.refunded';
  if (!isCompleted && !isAsyncSucceeded && !isAsyncFailed && !isExpired && !isChargeRefunded) return false;

  const firestore = dbFn();
  if (isChargeRefunded) {
    if (obj.metadata?.product !== APPLICATION_CONCIERGE_PRODUCT) return false;
    const serviceId = boundedString(obj.metadata?.serviceId, 200);
    if (!serviceId || !isFullChargeRefund(obj)) return true;
    const serviceRef = firestore.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
    await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(serviceRef);
      const service = snapshot.exists ? snapshot.data() || {} : null;
      if (!snapshot.exists || service.paymentStatus === 'refunded') return;
      transaction.set(serviceRef, {
        paymentStatus: 'refunded',
        serviceStatus: 'refunded',
        stripePaymentIntentId: boundedString(obj.payment_intent, 200) || null,
        stripeChargeId: boundedString(obj.id, 200) || null,
        refundedAt: ts,
        updatedAt: ts,
      }, { merge: true });
    });
    return true;
  }

  if (obj.metadata?.product !== APPLICATION_CONCIERGE_PRODUCT) return false;
  const paymentProvider = obj.metadata?.paymentProvider === SUMUP_PAYMENT_PROVIDER
    ? SUMUP_PAYMENT_PROVIDER
    : 'stripe';
  const serviceId = boundedString(obj.metadata?.serviceId || obj.client_reference_id, 200);
  if (!serviceId) return true;

  const amountValid = Number(obj.amount_total) === APPLICATION_CONCIERGE_PRICE_EUR_CENTS;
  const currencyValid = String(obj.currency || '').toLowerCase() === APPLICATION_CONCIERGE_CURRENCY;
  const paymentConfirmed = (isAsyncSucceeded || obj.payment_status === 'paid') && amountValid && currencyValid;
  const paymentStatus = isExpired || isAsyncFailed || !amountValid || !currencyValid
    ? 'failed'
    : paymentConfirmed ? 'paid' : 'pending';
  const failureReason = isExpired
    ? 'checkout_session_expired'
    : isAsyncFailed
      ? 'payment_not_confirmed'
      : !amountValid || !currencyValid
        ? 'amount_or_currency_missing_or_mismatch'
        : null;
  const checkoutSessionStatus = isExpired
    ? 'expired'
    : isAsyncFailed || !amountValid || !currencyValid
      ? 'failed'
      : paymentConfirmed ? 'completed' : 'pending';
  const now = typeof nowMs === 'function' ? nowMs() : Number(nowMs);
  const paidAt = Timestamp.fromMillis(Number.isFinite(now) ? now : Date.now());
  const update = {
    paymentStatus,
    serviceStatus: paymentStatus === 'paid' ? 'active' : paymentStatus === 'failed' ? 'payment_failed' : 'awaiting_payment',
    checkoutSessionStatus,
    paymentProvider,
    amountTotal: Number.isFinite(Number(obj.amount_total)) ? Number(obj.amount_total) : null,
    currency: String(obj.currency || APPLICATION_CONCIERGE_CURRENCY).toLowerCase(),
    updatedAt: ts,
    ...(paymentStatus === 'paid' ? {
      paidAt,
      paymentFailureReason: null,
      expiresAt: Timestamp.fromMillis(paidAt.toMillis() + APPLICATION_CONCIERGE_DURATION_DAYS * 24 * 60 * 60 * 1000),
    } : {}),
    ...(failureReason ? { paymentFailureReason: failureReason } : {}),
    ...(paymentProvider === SUMUP_PAYMENT_PROVIDER
      ? { sumupCheckoutId: boundedString(obj.id, 200) || null }
      : {
        stripeCheckoutSessionId: boundedString(obj.id, 200) || null,
        stripePaymentIntentId: typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id || null,
      }),
  };
  const serviceRef = firestore.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(serviceRef);
    const service = snapshot.exists ? snapshot.data() || {} : null;
    if (!snapshot.exists || shouldIgnoreWebhook(service, obj.id, paymentProvider)) return;
    transaction.set(serviceRef, update, { merge: true });
  });
  return true;
}
