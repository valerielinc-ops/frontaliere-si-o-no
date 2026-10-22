/**
 * Isolated SumUp sandbox checkout used to validate the Google Pay widget.
 *
 * This flow deliberately uses its own Firestore collection and webhook. A
 * successful sandbox payment can therefore never create an assisted
 * application, send an email, start automation, or unlock a candidate portal.
 */

import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './stripePublisherCore.js';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';
import { ASSISTED_APPLICATION_PRICE_EUR_CENTS } from './assistedApplicationConstants.js';
import {
  createSumUpPaymentTestCheckout,
  retrieveSumUpCheckout,
  SUMUP_ENVIRONMENTS,
} from './sumupAssistedApplicationCore.js';

export const SUMUP_PAYMENT_TESTS_COLLECTION = 'sumup_payment_tests';
export const SUMUP_PAYMENT_TEST_ORIGINS = Object.freeze([
  'https://frontaliereticino.ch',
  'https://frontaliere-ticino.web.app',
  'https://frontaliere-ticino.firebaseapp.com',
]);

const TEST_REFERENCE_PREFIX = 'google-pay-test-';
const TEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function boundedString(value, max) {
  const result = String(value ?? '').trim();
  return result && result.length <= max ? result : '';
}

function requestOrigin(req) {
  const value = typeof req?.get === 'function'
    ? req.get('origin')
    : req?.headers?.origin;
  return boundedString(Array.isArray(value) ? value[0] : value, 300);
}

export function isAllowedSumUpPaymentTestOrigin(origin) {
  return SUMUP_PAYMENT_TEST_ORIGINS.includes(String(origin || '').trim().replace(/\/$/, ''));
}

function testIdFromReference(value) {
  const reference = boundedString(value, 64);
  if (!reference.startsWith(TEST_REFERENCE_PREFIX)) return '';
  const testId = reference.slice(TEST_REFERENCE_PREFIX.length);
  return TEST_ID_RE.test(testId) ? testId : '';
}

function testReferenceFor(testId) {
  return `${TEST_REFERENCE_PREFIX}${testId}`;
}

function paymentStateForCheckout(checkout) {
  const status = String(checkout?.status || '').toUpperCase();
  if (status === 'PAID') return 'paid';
  if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(status)) return 'failed';
  return 'pending';
}

function transactionIdForCheckout(checkout) {
  const transaction = Array.isArray(checkout?.transactions)
    ? checkout.transactions.find((item) => item && typeof item === 'object')
    : null;
  return boundedString(transaction?.id || checkout?.transaction_id, 200) || null;
}

function publicStatus(testId, data = {}) {
  return {
    ok: true,
    testId,
    checkoutStatus: boundedString(data.checkoutStatus, 40) || 'CREATING',
    paymentStatus: boundedString(data.paymentStatus, 40) || 'pending',
    transactionId: boundedString(data.transactionId, 200) || null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || null,
  };
}

function firestoreFor(dbOption) {
  return typeof dbOption === 'function' ? dbOption() : dbOption;
}

function requestTestId(req) {
  const value = req?.method === 'GET' ? req.query?.testId : req.body?.testId;
  const testId = boundedString(Array.isArray(value) ? value[0] : value, 80);
  return TEST_ID_RE.test(testId) ? testId : '';
}

export async function handleCreateSumUpPaymentTestCheckout(
  req,
  {
    db: dbOption = db,
    createCheckout = createSumUpPaymentTestCheckout,
    now = Date.now,
  } = {},
) {
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }
  const origin = requestOrigin(req);
  if (!isAllowedSumUpPaymentTestOrigin(origin)) {
    return { status: 403, body: { ok: false, error: 'test_origin_not_allowed' } };
  }

  const testId = randomUUID();
  const reference = testReferenceFor(testId);
  const firestore = firestoreFor(dbOption);
  const testRef = firestore.collection(SUMUP_PAYMENT_TESTS_COLLECTION).doc(testId);
  await testRef.set({
    testId,
    checkoutReference: reference,
    checkoutStatus: 'CREATING',
    paymentStatus: 'pending',
    amountTotal: ASSISTED_APPLICATION_PRICE_EUR_CENTS,
    currency: 'EUR',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  try {
    const checkout = await createCheckout({
      testId,
      redirectUrl: `${origin}/google-pay-sumup-test.html?test_id=${encodeURIComponent(testId)}`,
    }, getRemoteConfigValue);
    await testRef.set({
      checkoutId: checkout.id,
      checkoutStatus: 'PENDING',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return {
      status: 200,
      body: {
        ok: true,
        testId,
        checkoutId: checkout.id,
        amountCents: ASSISTED_APPLICATION_PRICE_EUR_CENTS,
        currency: 'EUR',
      },
    };
  } catch (error) {
    await testRef.set({
      checkoutStatus: 'FAILED',
      paymentStatus: 'failed',
      failureReason: error instanceof Error ? error.message : 'checkout_creation_failed',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    throw error;
  }
}

export async function handleGetSumUpPaymentTestStatus(
  req,
  { db: dbOption = db } = {},
) {
  if (req.method !== 'GET') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }
  const origin = requestOrigin(req);
  if (!isAllowedSumUpPaymentTestOrigin(origin)) {
    return { status: 403, body: { ok: false, error: 'test_origin_not_allowed' } };
  }
  const testId = requestTestId(req);
  if (!testId) return { status: 400, body: { ok: false, error: 'test_id_invalid' } };
  const snapshot = await firestoreFor(dbOption)
    .collection(SUMUP_PAYMENT_TESTS_COLLECTION)
    .doc(testId)
    .get();
  if (!snapshot.exists) return { status: 404, body: { ok: false, error: 'test_not_found' } };
  return { status: 200, body: publicStatus(testId, snapshot.data()) };
}

export async function handleSumUpPaymentTestWebhook(
  req,
  {
    db: dbOption = db,
    retrieve = retrieveSumUpCheckout,
  } = {},
) {
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }
  const body = req.body || {};
  if (body.event_type !== 'CHECKOUT_STATUS_CHANGED') {
    return { status: 200, body: { received: true, ignored: true } };
  }
  const checkoutId = boundedString(body.id, 200);
  if (!checkoutId) return { status: 400, body: { ok: false, error: 'checkout_id_missing' } };

  const checkout = await retrieve(
    checkoutId,
    getRemoteConfigValue,
    { environment: SUMUP_ENVIRONMENTS.SANDBOX },
  );
  const testId = testIdFromReference(checkout?.checkout_reference);
  if (!testId) return { status: 200, body: { received: true, ignored: true } };

  const firestore = firestoreFor(dbOption);
  const testRef = firestore.collection(SUMUP_PAYMENT_TESTS_COLLECTION).doc(testId);
  const testSnapshot = await testRef.get();
  if (!testSnapshot.exists || testSnapshot.data()?.checkoutId !== checkoutId) {
    return { status: 200, body: { received: true, ignored: true } };
  }

  const providerStatus = String(checkout.status || '').toUpperCase() || 'UNKNOWN';
  const amountValid = Math.round(Number(checkout.amount) * 100) === ASSISTED_APPLICATION_PRICE_EUR_CENTS;
  const currencyValid = String(checkout.currency || '').toUpperCase() === 'EUR';
  const paymentStatus = paymentStateForCheckout(checkout);
  await testRef.set({
    providerStatus,
    checkoutStatus: providerStatus,
    paymentStatus: paymentStatus === 'paid' && amountValid && currencyValid ? 'paid' : paymentStatus,
    transactionId: transactionIdForCheckout(checkout),
    amountValid,
    currencyValid,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return {
    status: 200,
    body: { received: true, paymentStatus },
  };
}
