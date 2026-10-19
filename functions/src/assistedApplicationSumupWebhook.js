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
import {
  ASSISTED_APPLICATIONS_COLLECTION,
  ASSISTED_APPLICATION_PRICE_EUR_CENTS,
} from './assistedApplicationConstants.js';
import {
  APPLICATION_CONCIERGE_PRODUCT,
  APPLICATION_CONCIERGE_SERVICES_COLLECTION,
} from './applicationConciergeConstants.js';
import { handleApplicationConciergeWebhookEvent } from './applicationConciergeCheckout.js';
import {
  latestSumUpTransaction,
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

function recordTimestampMillis(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value && typeof value.toDate === 'function') return value.toDate().getTime();
  if (value && Number.isFinite(Number(value._seconds))) return Number(value._seconds) * 1000;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveFirestore(dbOption) {
  return typeof dbOption === 'function' ? dbOption() : dbOption;
}

function paymentEventForCheckout(checkout, orderId, customerEmail, product) {
  const status = String(checkout.status || '').toUpperCase();
  const transaction = latestSumUpTransaction(checkout);
  const transactionId = boundedString(transaction?.id || checkout.transaction_id, 200) || null;
  const transactionCode = boundedString(transaction?.transaction_code || checkout.transaction_code, 200) || null;
  const metadata = product === APPLICATION_CONCIERGE_PRODUCT
    ? {
      product,
      paymentProvider: SUMUP_PAYMENT_PROVIDER,
      serviceId: orderId,
    }
    : {
      product: ASSISTED_APPLICATION_PRODUCT,
      paymentProvider: SUMUP_PAYMENT_PROVIDER,
      orderId,
    };
  return {
    type: statusEventType(status),
    data: {
      object: {
        id: boundedString(checkout.id, 200),
        amount_total: amountInCents(checkout.amount),
        currency: String(checkout.currency || '').toLowerCase(),
        payment_status: status === 'PAID' ? 'paid' : 'unpaid',
        client_reference_id: orderId,
        ...(customerEmail ? { customer_email: customerEmail } : {}),
        sumupTransactionId: transactionId,
        sumupTransactionCode: transactionCode,
        metadata,
      },
    },
  };
}

/**
 * Apply one provider-verified checkout to the matching ledger.
 *
 * The checkout reference and id are checked against the existing document
 * before any state handler runs. This helper is shared by the webhook and the
 * periodic backstop, so a missed callback cannot leave a paid checkout locked.
 */
export async function applyAssistedApplicationSumUpCheckout(
  checkout,
  { db: dbFn = db, ts = FieldValue.serverTimestamp() } = {},
) {
  const checkoutId = boundedString(checkout?.id, 200);
  const orderId = boundedString(checkout?.checkout_reference, 200);
  if (!checkoutId || !orderId) {
    return { handled: false, reason: 'checkout_reference_mismatch' };
  }

  // The concierge uses the same SumUp merchant but a different parent ledger
  // and amount. Resolve it before the legacy €0.99 order path so a service id
  // can never be interpreted as an old one-job order.
  const firestore = resolveFirestore(dbFn);
  const dbFactory = () => firestore;
  const serviceRef = firestore.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(orderId);
  const serviceSnapshot = await serviceRef.get();
  const service = serviceSnapshot.exists ? serviceSnapshot.data() || {} : null;
  if (
    service
    && service.paymentProvider === SUMUP_PAYMENT_PROVIDER
    && service.sumupCheckoutId === checkoutId
  ) {
    await handleApplicationConciergeWebhookEvent(
      paymentEventForCheckout(checkout, orderId, '', APPLICATION_CONCIERGE_PRODUCT),
      { db: dbFactory, ts },
    );
    return {
      handled: true,
      target: 'application_concierge',
      paymentStatus: String(checkout.status || '').toUpperCase() === 'PAID' ? 'paid' : 'unpaid',
    };
  }

  // The reference is only accepted for an order that our own checkout path
  // already assigned to SumUp. This prevents a valid but unrelated merchant
  // checkout from creating or mutating an assisted-application order.
  const orderRef = firestore.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  const orderSnapshot = await orderRef.get();
  const order = orderSnapshot.exists ? orderSnapshot.data() || {} : null;
  if (
    !order
    || order.paymentProvider !== SUMUP_PAYMENT_PROVIDER
    || order.sumupCheckoutId !== checkoutId
  ) {
    return { handled: false, reason: 'order_reference_mismatch' };
  }

  const event = paymentEventForCheckout(
    checkout,
    orderId,
    boundedString(order.customerEmail, 320),
    ASSISTED_APPLICATION_PRODUCT,
  );
  const result = await handleAssistedApplicationWebhookEvent(event, { db: dbFactory, ts });
  const paymentObject = event.data.object;
  return {
    handled: result,
    target: 'assisted_application',
    paymentStatus: paymentObject.payment_status === 'paid'
      && paymentObject.amount_total === ASSISTED_APPLICATION_PRICE_EUR_CENTS
      && paymentObject.currency === 'eur'
      ? 'paid'
      : 'unpaid',
  };
}

export async function handleAssistedApplicationSumUpWebhook(
  req,
  { db: dbFn = db, retrieve = retrieveSumUpCheckout, ts = FieldValue.serverTimestamp() } = {},
) {
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

  const checkout = await retrieve(checkoutId);
  const result = await applyAssistedApplicationSumUpCheckout(checkout, {
    db: dbFn,
    ts,
  });
  return {
    status: 200,
    body: { received: true, ...(result.handled ? {} : { ignored: true }) },
  };
}

const SUMUP_RECONCILIATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SUMUP_RECONCILIATION_PAGE_SIZE = 100;

function isRecentUnpaidSumUpDocument(doc, nowMs, maxAgeMs) {
  const order = doc.data() || {};
  if (['paid', 'refunded'].includes(order.paymentStatus)) return false;
  const createdAt = recordTimestampMillis(order.createdAt);
  return createdAt === null || nowMs - createdAt <= maxAgeMs;
}

async function readSumUpReconciliationCandidates(
  firestore,
  collectionName,
  { nowMs, maxAgeMs, pageSize },
) {
  const candidates = [];
  let lastDoc = null;
  while (true) {
    let query = firestore.collection(collectionName)
      .where('paymentProvider', '==', SUMUP_PAYMENT_PROVIDER)
      .orderBy('__name__')
      .limit(pageSize);
    if (lastDoc) query = query.startAfter(lastDoc);
    const page = await query.get();
    const docs = Array.isArray(page.docs) ? page.docs : [];
    candidates.push(...docs.filter((doc) => isRecentUnpaidSumUpDocument(doc, nowMs, maxAgeMs)));
    if (docs.length < pageSize) break;
    lastDoc = docs[docs.length - 1];
  }
  return candidates;
}

/**
 * Backstop for a callback that was acknowledged while SumUp was still
 * processing the last attempt. Only provider-confirmed PAID checkouts are
 * written, and the common transaction guard keeps retries idempotent.
 */
export async function runAssistedApplicationSumUpReconciliation({
  db: dbFn = db,
  retrieve = retrieveSumUpCheckout,
  nowMs = Date.now(),
  maxAgeMs = SUMUP_RECONCILIATION_MAX_AGE_MS,
  pageSize = SUMUP_RECONCILIATION_PAGE_SIZE,
  ts = FieldValue.serverTimestamp(),
} = {}) {
  const firestore = resolveFirestore(dbFn);
  const candidates = [];
  for (const collectionName of [
    ASSISTED_APPLICATIONS_COLLECTION,
    APPLICATION_CONCIERGE_SERVICES_COLLECTION,
  ]) {
    candidates.push(...await readSumUpReconciliationCandidates(
      firestore,
      collectionName,
      { nowMs, maxAgeMs, pageSize },
    ));
  }
  const summary = {
    candidates: candidates.length,
    inspected: 0,
    promoted: 0,
    skipped: 0,
    errors: 0,
  };

  for (const doc of candidates) {
    const order = doc.data() || {};
    const checkoutId = boundedString(order.sumupCheckoutId, 200);
    if (!checkoutId) {
      summary.skipped += 1;
      continue;
    }
    summary.inspected += 1;
    try {
      const checkout = await retrieve(checkoutId);
      if (
        boundedString(checkout.id, 200) !== checkoutId
        || boundedString(checkout.checkout_reference, 200) !== doc.id
        || String(checkout.status || '').toUpperCase() !== 'PAID'
      ) {
        summary.skipped += 1;
        continue;
      }
      const result = await applyAssistedApplicationSumUpCheckout(checkout, { db: firestore, ts });
      if (result.paymentStatus === 'paid') summary.promoted += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.errors += 1;
      console.error(
        '[assistedApplicationSumUpReconciliation] checkout lookup failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return summary;
}
