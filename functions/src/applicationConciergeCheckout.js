/**
 * One-off checkout for the 30-day application concierge.
 *
 * This is intentionally a separate ledger from assisted_applications: one
 * payment grants a parent entitlement, while each child application is
 * created only after the candidate accepts a proposal.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import { matchesSumUpCheckoutReference } from './sumupCheckoutReference.js';
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
  retrieveSumUpCheckout,
  getAssistedApplicationPaymentProvider,
  SUMUP_PAYMENT_PROVIDER,
} from './sumupAssistedApplicationCore.js';

export const APPLICATION_CONCIERGE_CHECKOUT_REQUESTS_COLLECTION = 'application_concierge_checkout_requests';

const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const VALID_LOCALES = new Set(['it', 'en', 'de', 'fr']);
const CHECKOUT_CLAIM_TTL_MS = 10 * 60 * 1000;

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

function normalizedEmail(value) {
  const result = boundedString(value, 320).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result) ? result : '';
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

function checkoutIdForService(service) {
  return boundedString(paymentProviderForOrder(service) === SUMUP_PAYMENT_PROVIDER
    ? service?.sumupCheckoutId : service?.stripeCheckoutSessionId, 200);
}

function isRecoverableCheckout(service) {
  const checkoutSessionStatus = String(service?.checkoutSessionStatus || '').toLowerCase();
  return (service?.paymentStatus === 'pending'
      && service?.serviceStatus === 'awaiting_payment'
      && !['pending', 'completed'].includes(checkoutSessionStatus))
    || (service?.paymentStatus === 'failed'
      && service?.serviceStatus === 'payment_failed'
      && (service?.checkoutSessionStatus === 'expired'
        || (service?.paymentProvider === SUMUP_PAYMENT_PROVIDER && service?.checkoutSessionStatus === 'failed')));
}

function timestampMillis(value) {
  if (value == null) return 0;
  if (typeof value.toMillis === 'function') return Number(value.toMillis()) || 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime() || 0;
  if (value instanceof Date) return value.getTime() || 0;
  return Number(value) || 0;
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
    checkoutAttempt: 1,
    checkoutClaimedAt: FieldValue.serverTimestamp(),
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
  let resumeServiceId = boundedString(body.serviceId, 200);
  let customerEmail = normalizedEmail(body.customerEmail) || normalizedEmail(decoded.email);
  const locale = VALID_LOCALES.has(body.locale) ? body.locale : 'it';
  if (!userId || !requestKey) return { status: 400, body: { ok: false, error: 'invalid_request_key' } };
  if (body.serviceId && !/^[A-Za-z0-9_-]{1,200}$/.test(resumeServiceId)) {
    return { status: 400, body: { ok: false, error: 'invalid_service_id' } };
  }
  if (!validHttpsUrl(successUrl) || !validHttpsUrl(cancelUrl)) {
    return { status: 400, body: { ok: false, error: 'invalid_redirect_urls' } };
  }
  if (!customerEmail && !resumeServiceId) {
    return { status: 400, body: { ok: false, error: 'application_concierge_email_required' } };
  }

  const configuredPaymentProvider = await getAssistedApplicationPaymentProvider();
  const firestore = db();
  const requestKeyHash = sha256(`${userId}:${requestKey}`);
  const requestRef = firestore.collection(APPLICATION_CONCIERGE_CHECKOUT_REQUESTS_COLLECTION).doc(requestKeyHash);
  const serviceCollection = firestore.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION);
  // A cached landing-page request must receive the same provider verification
  // as an explicit payment-reminder service link.
  if (!resumeServiceId) {
    const existing = await requestRef.get();
    if (existing.exists) {
      const record = existing.data() || {};
      if (record.userId !== userId || !/^[A-Za-z0-9_-]{1,200}$/.test(String(record.serviceId || ''))) {
        return { status: 409, body: { ok: false, error: 'application_concierge_checkout_conflict' } };
      }
      resumeServiceId = record.serviceId;
    }
  }
  let observedResumeService = null;
  let requestRecord = null;
  let serviceRef = null;
  let checkoutAttempt = 1;
  let resumePaidServiceId = null;
  let terminalSumUpCheckoutId = null;
  const publishCheckout = async (serviceUpdate, requestUpdate) => firestore.runTransaction(async (transaction) => {
    const [serviceSnapshot, requestSnapshot] = await Promise.all([
      transaction.get(serviceRef), transaction.get(requestRef),
    ]);
    const current = serviceSnapshot.exists ? serviceSnapshot.data() || {} : null;
    const currentRequest = requestSnapshot.exists ? requestSnapshot.data() || {} : null;
    if (!current || current.userId !== userId) return 'conflict';
    if (current.paymentStatus === 'paid') return 'paid';
    const previousId = observedResumeService ? checkoutIdForService(observedResumeService) : '';
    if (current.paymentStatus !== 'pending' || current.checkoutSessionStatus !== 'creating'
      || Number(current.checkoutAttempt) !== checkoutAttempt
      || paymentProviderForOrder(current) !== requestRecord.paymentProvider
      || checkoutIdForService(current) !== previousId
      || !currentRequest || currentRequest.userId !== userId || currentRequest.serviceId !== serviceRef.id
      || currentRequest.checkoutSessionStatus !== 'creating' || Number(currentRequest.checkoutAttempt) !== checkoutAttempt) {
      return 'conflict';
    }
    transaction.set(serviceRef, { ...serviceUpdate, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    transaction.set(requestRef, { ...requestUpdate, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return 'published';
  });

  if (resumeServiceId) {
    const resumeServiceRef = serviceCollection.doc(resumeServiceId);
    const resumeSnapshot = await resumeServiceRef.get();
    const resumeService = resumeSnapshot.exists ? resumeSnapshot.data() || {} : null;
    observedResumeService = resumeService;
    if (!resumeService || resumeService.userId !== userId) {
      return { status: 404, body: { ok: false, error: 'application_concierge_service_not_found' } };
    }
    if (resumeService.paymentStatus === 'paid') {
      return {
        status: 200,
        body: { ok: true, url: appendServiceId(successUrl, resumeServiceId), serviceId: resumeServiceId },
      };
    }
    if (!isRecoverableCheckout(resumeService)) {
      return { status: 409, body: { ok: false, error: 'application_concierge_checkout_conflict' } };
    }
    customerEmail ||= normalizedEmail(resumeService.customerEmail) || normalizedEmail(resumeService.applicantEmail);
    if (!customerEmail) {
      return { status: 400, body: { ok: false, error: 'application_concierge_email_required' } };
    }
    if (resumeService.customerEmail !== customerEmail) {
      await resumeServiceRef.set({ customerEmail, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }

    if (String(resumeService.checkoutSessionStatus || '').toLowerCase() === 'open'
      || (resumeService.paymentProvider === SUMUP_PAYMENT_PROVIDER && resumeService.checkoutSessionStatus === 'failed')) {
      if (resumeService.paymentProvider === SUMUP_PAYMENT_PROVIDER && resumeService.sumupCheckoutId) {
        try {
          const checkout = await retrieveSumUpCheckout(resumeService.sumupCheckoutId);
          if (checkout.id !== resumeService.sumupCheckoutId || !matchesSumUpCheckoutReference(checkout.checkout_reference, resumeServiceId)
            || Math.round(Number(checkout.amount) * 100) !== APPLICATION_CONCIERGE_PRICE_EUR_CENTS
            || String(checkout.currency || '').toLowerCase() !== APPLICATION_CONCIERGE_CURRENCY) {
            return { status: 502, body: { ok: false, error: 'application_concierge_checkout_unavailable' } };
          }
          const status = String(checkout.status || '').toUpperCase();
          if (status === 'PENDING' || status === 'OPEN' || status === 'FAILED') {
            return { status: 200, body: {
              ok: true, paymentProvider: SUMUP_PAYMENT_PROVIDER,
              checkoutId: checkout.id, serviceId: resumeServiceId,
            } };
          }
          if (status === 'PAID') {
            const { applyAssistedApplicationSumUpCheckout } = await import('./assistedApplicationSumupWebhook.js');
            await applyAssistedApplicationSumUpCheckout(checkout, { db: () => firestore, ts: FieldValue.serverTimestamp() });
            const fresh = await resumeServiceRef.get();
            if (fresh.data()?.paymentStatus === 'paid') {
              return { status: 200, body: { ok: true, url: appendServiceId(successUrl, resumeServiceId), serviceId: resumeServiceId } };
            }
            return { status: 409, body: { ok: false, error: 'application_concierge_checkout_conflict' } };
          }
          if (status !== 'EXPIRED') {
            return { status: 409, body: { ok: false, error: 'application_concierge_checkout_conflict' } };
          }
          terminalSumUpCheckoutId = checkout.id;
          // Explicit terminal provider state falls through to the existing
          // transaction-backed renewal; unknown or paid state never does.
        } catch {
          return { status: 502, body: { ok: false, error: 'application_concierge_checkout_unavailable' } };
        }
      }
      if (resumeService.paymentProvider !== SUMUP_PAYMENT_PROVIDER && resumeService.stripeCheckoutSessionId) {
        try {
          const stripe = await getStripe();
          const session = await stripe.checkout.sessions.retrieve(resumeService.stripeCheckoutSessionId);
          if (session.id !== resumeService.stripeCheckoutSessionId
            || (session.metadata?.serviceId && session.metadata.serviceId !== resumeServiceId)
            || (session.metadata?.product && session.metadata.product !== APPLICATION_CONCIERGE_PRODUCT)) {
            return { status: 502, body: { ok: false, error: 'application_concierge_checkout_unavailable' } };
          }
          if (session.status === 'open' && session.payment_status !== 'paid' && session.url) {
            return { status: 200, body: { ok: true, url: session.url, serviceId: resumeServiceId } };
          }
          if (session.status === 'complete' || session.payment_status === 'paid') {
            if (Number(session.amount_total) !== APPLICATION_CONCIERGE_PRICE_EUR_CENTS
              || String(session.currency || '').toLowerCase() !== APPLICATION_CONCIERGE_CURRENCY) {
              return { status: 502, body: { ok: false, error: 'application_concierge_checkout_unavailable' } };
            }
            await handleApplicationConciergeWebhookEvent({
              type: 'checkout.session.completed', data: { object: session },
            }, { db: () => firestore, ts: FieldValue.serverTimestamp() });
            const fresh = (await resumeServiceRef.get()).data() || {};
            if (fresh.paymentStatus === 'paid' || fresh.checkoutSessionStatus === 'pending') {
              return { status: 200, body: { ok: true, url: appendServiceId(successUrl, resumeServiceId), serviceId: resumeServiceId } };
            }
            return { status: 409, body: { ok: false, error: 'application_concierge_checkout_conflict' } };
          }
          if (session.status !== 'expired') {
            return { status: 409, body: { ok: false, error: 'application_concierge_checkout_conflict' } };
          }
        } catch {
          return { status: 502, body: { ok: false, error: 'application_concierge_checkout_unavailable' } };
        }
      }
    }
  }

  try {
    await firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(requestRef);
      if (resumeServiceId) {
        const existingRecord = existing.exists ? existing.data() || {} : {};
        if (existing.exists && (existingRecord.userId !== userId || existingRecord.serviceId !== resumeServiceId)) {
          throw new ApplicationConciergeCheckoutConflictError();
        }
        serviceRef = serviceCollection.doc(resumeServiceId);
        const existingServiceSnapshot = await transaction.get(serviceRef);
        const existingService = existingServiceSnapshot.exists ? existingServiceSnapshot.data() || {} : null;
        if (!existingServiceSnapshot.exists || existingService.userId !== userId) {
          throw new ApplicationConciergeCheckoutConflictError();
        }
        if (existingService.paymentStatus === 'paid') {
          requestRecord = existingRecord;
          resumePaidServiceId = resumeServiceId;
          return;
        }
        if (paymentProviderForOrder(existingService) !== paymentProviderForOrder(observedResumeService)
          || checkoutIdForService(existingService) !== checkoutIdForService(observedResumeService)) {
          throw new ApplicationConciergeCheckoutConflictError();
        }
        if (!isRecoverableCheckout(existingService)) {
          throw new ApplicationConciergeCheckoutConflictError();
        }
        if (
          String(existingService.checkoutSessionStatus || '').toLowerCase() === 'creating'
          && Date.now() - timestampMillis(existingService.checkoutClaimedAt) < CHECKOUT_CLAIM_TTL_MS
        ) {
          throw new ApplicationConciergeCheckoutConflictError();
        }
        checkoutAttempt = Math.max(
          Number(existingService.checkoutAttempt) || 0,
          Number(existingRecord.checkoutAttempt) || 0,
        ) + 1;
        const paymentProvider = existingService.paymentProvider === SUMUP_PAYMENT_PROVIDER
          ? SUMUP_PAYMENT_PROVIDER
          : 'stripe';
        requestRecord = {
          requestKeyHash,
          userId,
          serviceId: resumeServiceId,
          paymentProvider,
          checkoutAttempt,
          checkoutSessionStatus: 'creating',
          createdAt: existingRecord.createdAt || FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        transaction.set(requestRef, {
          ...requestRecord,
          checkoutUrl: FieldValue.delete(),
          stripeCheckoutSessionId: FieldValue.delete(),
          sumupCheckoutId: FieldValue.delete(),
        }, { merge: true });
        transaction.update(serviceRef, {
          paymentStatus: 'pending',
          serviceStatus: 'awaiting_payment',
          customerEmail,
          paymentFailureReason: null,
          checkoutSessionStatus: 'creating',
          checkoutAttempt,
          checkoutClaimedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return;
      }

      if (existing.exists) {
        // Another initial request won after preflight. Retry through the
        // provider-verification path rather than exposing an unverified cache.
        throw new ApplicationConciergeCheckoutConflictError();
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
          customerEmail,
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
  const serviceId = serviceRef.id;
  const paymentProvider = requestRecord?.paymentProvider || configuredPaymentProvider;
  const successRedirect = appendServiceId(successUrl, serviceId);
  let checkoutUrl;
  if (paymentProvider === SUMUP_PAYMENT_PROVIDER) {
    const checkout = await createSumUpApplicationConciergeCheckout({
      serviceId,
      redirectUrl: successRedirect,
      checkoutAttempt,
    });
    if (terminalSumUpCheckoutId && checkout.id === terminalSumUpCheckoutId) {
      // A duplicate-reference recovery must not hand a terminal checkout to the widget.
      return { status: 502, body: { ok: false, error: 'application_concierge_checkout_unavailable' } };
    }
    const publication = await publishCheckout({
      paymentProvider: SUMUP_PAYMENT_PROVIDER, sumupCheckoutId: checkout.id,
      checkoutSessionStatus: 'open', checkoutAttempt, checkoutClaimedAt: null,
    }, {
      paymentProvider: SUMUP_PAYMENT_PROVIDER, sumupCheckoutId: checkout.id, checkoutSessionStatus: 'open',
    });
    if (publication === 'paid') return { status: 200, body: { ok: true, url: successRedirect, serviceId } };
    if (publication !== 'published') return { status: 409, body: { ok: false, error: 'application_concierge_checkout_conflict' } };
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
    const publication = await publishCheckout({
      paymentProvider: 'stripe', stripeCheckoutSessionId: session.id,
      checkoutSessionStatus: 'open', checkoutAttempt, checkoutClaimedAt: null,
    }, {
      paymentProvider: 'stripe', stripeCheckoutSessionId: session.id, checkoutUrl, checkoutSessionStatus: 'open',
    });
    if (publication === 'paid') return { status: 200, body: { ok: true, url: successRedirect, serviceId } };
    if (publication !== 'published') return { status: 409, body: { ok: false, error: 'application_concierge_checkout_conflict' } };
  }

  return { status: 200, body: { ok: true, url: checkoutUrl, serviceId } };
}

function isFullChargeRefund(charge) {
  if (charge?.refunded === true) return true;
  const amount = Number(charge?.amount);
  const refunded = Number(charge?.amount_refunded);
  return Number.isFinite(amount) && amount > 0 && Number.isFinite(refunded) && refunded >= amount;
}

function shouldIgnoreWebhook(service, sessionId, paymentProvider, eventType = '') {
  if (!service) return false;
  const expectedProvider = paymentProviderForOrder(service);
  if (expectedProvider !== paymentProvider) return true;
  const currentId = boundedString(
    paymentProvider === SUMUP_PAYMENT_PROVIDER ? service.sumupCheckoutId : service.stripeCheckoutSessionId,
    200,
  );
  if (currentId && sessionId && currentId !== sessionId) return true;
  const replacingExpiredCheckout = String(service.checkoutSessionStatus || '').toLowerCase() === 'creating'
    && Date.now() - timestampMillis(service.checkoutClaimedAt) < CHECKOUT_CLAIM_TTL_MS;
  if (
    replacingExpiredCheckout
    && ['checkout.session.expired', 'checkout.session.async_payment_failed'].includes(eventType)
  ) return true;
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
    if (!snapshot.exists || shouldIgnoreWebhook(service, obj.id, paymentProvider, event.type)) return;
    // Check again inside the transaction: a replacement may have been
    // reserved after the SumUp callback's initial read, even with a stale TTL.
    if (paymentProvider === SUMUP_PAYMENT_PROVIDER
      && String(service.checkoutSessionStatus || '').toLowerCase() === 'creating'
      && paymentStatus !== 'paid') return;
    transaction.set(serviceRef, update, { merge: true });
  });
  return true;
}
