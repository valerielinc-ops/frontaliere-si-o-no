/**
 * SumUp callback for assisted-application Hosted Checkout.
 *
 * SumUp's callback contains only a checkout id. The callback is never treated
 * as proof of payment: the checkout is fetched server-side and its current
 * status, amount, currency and order reference are checked before the common
 * assisted-application payment state handler is invoked.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { db } from './stripePublisherCore.js';
import {
  ASSISTED_APPLICATION_PRODUCT,
  handleAssistedApplicationWebhookEvent,
} from './assistedApplicationCheckout.js';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import {
  retrieveSumUpCheckout,
  SUMUP_PAYMENT_PROVIDER,
} from './sumupAssistedApplicationCore.js';

function boundedString(value, max) {
  const result = String(value ?? '').trim();
  return result && result.length <= max ? result : '';
}
function statusEventType(status) {
  if (status === 'EXPIRED') return 'checkout.session.expired';
  if (status === 'FAILED' || status === 'CANCELLED') return 'checkout.session.async_payment_failed';
  return 'checkout.session.completed';
}

function amountInCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}

function latestTransaction(checkout) {
  if (!Array.isArray(checkout?.transactions)) return null;
  return checkout.transactions[checkout.transactions.length - 1] || null;
}

export async function handleAssistedApplicationSumUpWebhook(req) {
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }

  const body = req.body || {};
  if (body.event_type !== 'CHECKOUT_STATUS_CHANGED') {
    // SumUp may add event types later; acknowledge them without guessing.
    return { status: 200, body: { received: true, ignored: true } };
  }
  const checkoutId = boundedString(body.id, 200);
  if (!checkoutId) {
    return { status: 400, body: { ok: false, error: 'checkout_id_missing' } };
  }

  const checkout = await retrieveSumUpCheckout(checkoutId);
  const orderId = boundedString(checkout.checkout_reference, 200);
  if (!orderId || boundedString(checkout.id, 200) !== checkoutId) {
    return { status: 200, body: { received: true, ignored: true } };
  }

  // The reference is only accepted for an order that our own checkout path
  // already assigned to SumUp. This prevents a valid but unrelated merchant
  // checkout from creating or mutating an assisted-application order.
  const orderRef = db().collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  const orderSnapshot = await orderRef.get();
  const order = orderSnapshot.exists ? orderSnapshot.data() || {} : null;
  if (
    !order
    || order.paymentProvider !== SUMUP_PAYMENT_PROVIDER
    || order.sumupCheckoutId !== checkoutId
  ) {
    return { status: 200, body: { received: true, ignored: true } };
  }

  const transaction = latestTransaction(checkout);
  const transactionId = boundedString(transaction?.id || checkout.transaction_id, 200) || null;
  const transactionCode = boundedString(transaction?.transaction_code || checkout.transaction_code, 200) || null;
  const event = {
    type: statusEventType(String(checkout.status || '').toUpperCase()),
    data: {
      object: {
        id: checkoutId,
        amount_total: amountInCents(checkout.amount),
        currency: String(checkout.currency || '').toLowerCase(),
        payment_status: String(checkout.status || '').toUpperCase() === 'PAID' ? 'paid' : 'unpaid',
        client_reference_id: orderId,
        sumupTransactionId: transactionId,
        sumupTransactionCode: transactionCode,
        metadata: {
          product: ASSISTED_APPLICATION_PRODUCT,
          paymentProvider: SUMUP_PAYMENT_PROVIDER,
          orderId,
        },
      },
    },
  };
  await handleAssistedApplicationWebhookEvent(event, {
    db,
    ts: FieldValue.serverTimestamp(),
  });
  return { status: 200, body: { received: true } };
}
