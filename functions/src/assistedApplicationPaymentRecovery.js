/**
 * Automated recovery of assisted-application checkouts left in `pending`.
 *
 * This is an operational workflow, not a newsletter campaign. It reads the
 * pending ledger server-side, groups eligible orders by Firebase user, checks
 * the payment provider and the public job before every send, renews an
 * explicitly expired checkout, then sends one idempotent digest per user.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import { db as defaultDb, getStripe, verifyCaller } from './stripePublisherCore.js';
import {
  ASSISTED_APPLICATIONS_COLLECTION,
  ASSISTED_APPLICATION_PAYMENT_RECOVERY_COLLECTION,
  ASSISTED_APPLICATION_PRICE_EUR_CENTS,
} from './assistedApplicationConstants.js';
import {
  ASSISTED_APPLICATION_CURRENCY,
  ASSISTED_APPLICATION_PRODUCT,
  handleAssistedApplicationWebhookEvent,
} from './assistedApplicationCheckout.js';
import {
  createSumUpAssistedApplicationCheckout,
  retrieveSumUpCheckout,
  SUMUP_PAYMENT_PROVIDER,
} from './sumupAssistedApplicationCore.js';
import { applyAssistedApplicationSumUpCheckout } from './assistedApplicationSumupWebhook.js';
import { postingClosedForOrder } from './assistedApplicationAutomation.js';
import { isCrossChannelStop } from './lib/emailSuppression.js';
import {
  buildOrderPageUrl,
  customerEmailFor,
  paymentRecoveryDigestId,
  sendPendingPaymentDigest,
} from './assistedApplicationNotifications.js';

export const PAYMENT_RECOVERY_INITIAL_DELAY_MS = 2 * 60 * 60 * 1000;
export const PAYMENT_RECOVERY_FOLLOWUP_DELAY_MS = 48 * 60 * 60 * 1000;
export const PAYMENT_RECOVERY_CLAIM_TTL_MS = 10 * 60 * 1000;
const PAYMENT_RECOVERY_MAX_CONCURRENCY = 4;
const CHECKOUT_CREATING_TTL_MS = PAYMENT_RECOVERY_CLAIM_TTL_MS;
const VALID_PAYMENT_FAILURES = new Set([
  'checkout_session_expired',
  'payment_not_confirmed',
  'checkout_session_regeneration_failed',
]);

function boundedString(value, max) {
  const result = String(value ?? '').trim();
  return result && result.length <= max ? result : '';
}
function timestampMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return Number(value.toMillis()) || null;
  if (typeof value.toDate === 'function') return Number(value.toDate().getTime()) || null;
  if (value instanceof Date) return Number(value.getTime()) || null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function orderAgeMs(order, nowMs) {
  const createdAt = timestampMillis(order?.createdAt);
  return createdAt === null ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - createdAt);
}

function paymentProviderFor(order) {
  if (order?.paymentProvider === SUMUP_PAYMENT_PROVIDER) return SUMUP_PAYMENT_PROVIDER;
  if (order?.paymentProvider === 'stripe') return 'stripe';
  if (order?.sumupCheckoutId) return SUMUP_PAYMENT_PROVIDER;
  if (order?.stripeCheckoutSessionId || order?.stripeSessionId) return 'stripe';
  return '';
}

function isPendingPaymentOrder(order) {
  if (!order || order.billingMode === 'application_concierge') return false;
  const paymentFailureReason = String(order.paymentFailureReason || '');
  const recoverablePaymentState = order.paymentStatus === 'pending'
    || VALID_PAYMENT_FAILURES.has(paymentFailureReason);
  if (!recoverablePaymentState) return false;
  return !order.submissionStatus || order.submissionStatus === 'awaiting_payment';
}

function recoveryStateIdFor(userId) {
  return createHash('sha256').update(String(userId || '')).digest('hex').slice(0, 40);
}

export function paymentRecoveryStateRefFor(db, userId) {
  return db.collection(ASSISTED_APPLICATION_PAYMENT_RECOVERY_COLLECTION).doc(recoveryStateIdFor(userId));
}

function recoveryOrderState(state, orderId) {
  const value = state?.orders?.[String(orderId)] || {};
  return {
    reminderCount: Math.max(0, Math.min(2, Number(value.reminderCount) || 0)),
    lastSentAt: timestampMillis(value.lastSentAt),
  };
}

function recoveryOrdersEligibleForDigest(state, orders) {
  const ambiguousOrderIds = state?.status === 'ambiguous'
    ? new Set((Array.isArray(state.orderIds) ? state.orderIds : []).map(String))
    : new Set();
  return (Array.isArray(orders) ? orders : []).filter((order) => {
    const orderId = String(order?.orderId || '');
    const entry = recoveryOrderState(state, orderId);
    return orderId
      && entry.reminderCount < 2
      && !ambiguousOrderIds.has(orderId);
  });
}

/**
 * Decide whether a user group is due for its first message or its one follow-up.
 * A count is per order even though the send is per user, which prevents a new
 * order from causing an old order to receive unlimited reminders.
 */
export function pendingPaymentRecoveryDueStage(
  state,
  orders,
  {
    nowMs = Date.now(),
    initialDelayMs = PAYMENT_RECOVERY_INITIAL_DELAY_MS,
    followupDelayMs = PAYMENT_RECOVERY_FOLLOWUP_DELAY_MS,
  } = {},
) {
  if (!Array.isArray(orders) || orders.length === 0) return 0;
  const claimedAt = timestampMillis(state?.claimedAt);
  if (state?.status === 'sending' && claimedAt !== null && nowMs - claimedAt < PAYMENT_RECOVERY_CLAIM_TTL_MS) return 0;

  const initialDue = orders.some((order) => {
    const entry = recoveryOrderState(state, order.orderId);
    return entry.reminderCount === 0 && orderAgeMs(order, nowMs) >= initialDelayMs;
  });
  if (initialDue) return 1;

  const followupDue = orders.some((order) => {
    const entry = recoveryOrderState(state, order.orderId);
    return entry.reminderCount === 1
      && entry.lastSentAt !== null
      && nowMs - entry.lastSentAt >= followupDelayMs;
  });
  return followupDue ? 2 : 0;
}

/** Group pending orders by account, retaining one recipient per user. */
export function groupPendingPaymentOrders(orders) {
  const groups = new Map();
  for (const rawOrder of Array.isArray(orders) ? orders : []) {
    const orderId = boundedString(rawOrder?.orderId, 200);
    const userId = boundedString(rawOrder?.userId, 200);
    const email = customerEmailFor(rawOrder);
    if (!orderId || !userId || !email || !isPendingPaymentOrder(rawOrder)) continue;
    const order = { ...rawOrder, orderId };
    const existing = groups.get(userId);
    if (!existing) {
      groups.set(userId, { userId, to: email, orders: [order], latestCreatedAt: timestampMillis(order.createdAt) || 0 });
      continue;
    }
    existing.orders.push(order);
    const createdAt = timestampMillis(order.createdAt) || 0;
    if (createdAt >= existing.latestCreatedAt) {
      existing.latestCreatedAt = createdAt;
      existing.to = email;
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    orders: group.orders.sort((left, right) => (
      (timestampMillis(right.createdAt) || 0) - (timestampMillis(left.createdAt) || 0)
    )),
  }));
}

function validJobForRecovery(order) {
  try {
    return Boolean(
      boundedString(order?.jobId, 200)
      && new URL(String(order?.jobUrl || '')).protocol === 'https:',
    );
  } catch {
    return false;
  }
}

function checkoutIdFor(order) {
  return paymentProviderFor(order) === SUMUP_PAYMENT_PROVIDER
    ? boundedString(order?.sumupCheckoutId, 200)
    : boundedString(order?.stripeCheckoutSessionId || order?.stripeSessionId, 200);
}

function stripeSessionHasPaidAmount(session, orderId) {
  const metadataProduct = boundedString(session?.metadata?.product, 100);
  const metadataOrderId = boundedString(session?.metadata?.orderId, 200);
  const clientReference = boundedString(session?.client_reference_id, 200);
  const currency = String(session?.currency || '').toLowerCase();
  return session?.payment_status === 'paid'
    // Stripe exposes Checkout Session `amount_total` already in minor units.
    && Number(session?.amount_total) === ASSISTED_APPLICATION_PRICE_EUR_CENTS
    && currency === ASSISTED_APPLICATION_CURRENCY
    && (!metadataProduct || metadataProduct === ASSISTED_APPLICATION_PRODUCT)
    && (!metadataOrderId || metadataOrderId === orderId)
    && (!clientReference || clientReference === orderId);
}

function stripeEventObject(session, orderId, order) {
  return {
    ...session,
    client_reference_id: session?.client_reference_id || orderId,
    metadata: {
      ...(session?.metadata || {}),
      product: ASSISTED_APPLICATION_PRODUCT,
      paymentProvider: 'stripe',
      orderId,
      userId: order?.userId || '',
    },
  };
}

async function reconcileStripePaid({ db, orderId, order, session, applyStripe = handleAssistedApplicationWebhookEvent }) {
  await applyStripe({
    type: 'checkout.session.completed',
    data: { object: stripeEventObject(session, orderId, order) },
  }, { db: () => db, ts: FieldValue.serverTimestamp() });
  return { status: 'paid' };
}

async function reserveCheckoutRenewal({ db, orderId, order, nowMs }) {
  const ref = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return { status: 'missing' };
    const current = snapshot.data() || {};
    if (current.paymentStatus === 'paid') return { status: 'paid' };
    const updatedAt = timestampMillis(current.updatedAt);
    if (current.checkoutSessionStatus === 'creating' && updatedAt !== null && nowMs - updatedAt < CHECKOUT_CREATING_TTL_MS) {
      return { status: 'in_progress' };
    }
    const currentAttempt = Math.max(1, Number(current.checkoutAttempt) || 1);
    const reuseAttempt = current.checkoutSessionStatus === 'creating'
      && (updatedAt === null || nowMs - updatedAt >= CHECKOUT_CREATING_TTL_MS);
    const checkoutAttempt = reuseAttempt ? currentAttempt : currentAttempt + 1;
    // A normal renewal must never reuse the original checkout's idempotency
    // key: Stripe would return the expired session instead of creating the
    // replacement. Only a stale `creating` claim reuses its key, so a crashed
    // creator remains idempotent.
    const stripeRequestKey = current.checkoutSessionStatus === 'creating'
      ? boundedString(current.stripeRequestKey, 200) || `assisted-application:recovery:${orderId}:${checkoutAttempt}`
      : `assisted-application:recovery:${orderId}:${checkoutAttempt}`;
    transaction.set(ref, {
      checkoutAttempt,
      stripeRequestKey,
      checkoutSessionStatus: 'creating',
      updatedAt: new Date(nowMs),
    }, { merge: true });
    return { status: 'reserved', checkoutAttempt, stripeRequestKey };
  });
}

async function renewStripeCheckout({ db, orderId, order, stripe, nowMs }) {
  const reservation = await reserveCheckoutRenewal({ db, orderId, order, nowMs });
  if (reservation.status !== 'reserved') return reservation;
  const pageUrl = buildOrderPageUrl(order, orderId);
  const email = customerEmailFor(order);
  const metadata = {
    product: ASSISTED_APPLICATION_PRODUCT,
    paymentProvider: 'stripe',
    orderId,
    jobId: boundedString(order.jobId, 200),
    jobUrl: boundedString(order.jobUrl, 500),
    companyName: boundedString(order.companyName, 200),
    jobTitle: boundedString(order.jobTitle, 300),
    experimentVariant: boundedString(order.experimentVariant, 80) || 'control',
    copyVariant: boundedString(order.copyVariant, 80) || 'control',
    layoutVariant: boundedString(order.layoutVariant, 80) || 'control',
    userId: boundedString(order.userId, 200),
    locale: boundedString(order.locale, 10) || 'it',
  };
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: ASSISTED_APPLICATION_CURRENCY,
          unit_amount: ASSISTED_APPLICATION_PRICE_EUR_CENTS,
          product_data: { name: 'Candidatura assistita' },
        },
        quantity: 1,
      }],
      success_url: pageUrl,
      cancel_url: pageUrl,
      client_reference_id: orderId,
      customer_email: email || undefined,
      metadata,
      payment_intent_data: { metadata },
    }, { idempotencyKey: reservation.stripeRequestKey });
    const sessionId = boundedString(session?.id, 200);
    if (!sessionId) throw new Error('stripe_recovery_session_missing');
    await db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId).set({
      paymentProvider: 'stripe',
      paymentStatus: 'pending',
      submissionStatus: 'awaiting_payment',
      stripeCheckoutSessionId: sessionId,
      stripeRequestKey: reservation.stripeRequestKey,
      checkoutAttempt: reservation.checkoutAttempt,
      checkoutExpiresAt: Number.isSafeInteger(Number(session.expires_at)) ? Number(session.expires_at) : null,
      checkoutSessionStatus: 'open',
      paymentFailureReason: null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { status: 'renewed', session };
  } catch (error) {
    console.error('[assistedApplicationPaymentRecovery] Stripe renewal failed', orderId, error instanceof Error ? error.message : String(error));
    return { status: 'error', reason: 'stripe_session_creation_failed' };
  }
}

async function renewSumUpCheckout({ db, orderId, order, nowMs, createSumUp = createSumUpAssistedApplicationCheckout }) {
  const reservation = await reserveCheckoutRenewal({ db, orderId, order, nowMs });
  if (reservation.status !== 'reserved') return reservation;
  try {
    const checkout = await createSumUp({ orderId, redirectUrl: buildOrderPageUrl(order, orderId) });
    const checkoutId = boundedString(checkout?.id, 200);
    if (!checkoutId) throw new Error('sumup_recovery_checkout_missing');
    await db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId).set({
      paymentProvider: SUMUP_PAYMENT_PROVIDER,
      paymentStatus: 'pending',
      submissionStatus: 'awaiting_payment',
      sumupCheckoutId: checkoutId,
      checkoutAttempt: reservation.checkoutAttempt,
      checkoutExpiresAt: null,
      checkoutSessionStatus: 'open',
      paymentFailureReason: null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { status: 'renewed', checkoutId };
  } catch (error) {
    console.error('[assistedApplicationPaymentRecovery] SumUp renewal failed', orderId, error instanceof Error ? error.message : String(error));
    return { status: 'error', reason: 'sumup_session_creation_failed' };
  }
}

/** Verify the provider and, only for an explicit expiry/failure, renew it. */
export async function inspectPendingAssistedApplicationPayment({
  db = defaultDb(),
  orderId,
  order,
  nowMs = Date.now(),
  stripe = null,
  getStripeClient = getStripe,
  retrieveStripe = (client, id) => client.checkout.sessions.retrieve(id),
  retrieveSumUp = retrieveSumUpCheckout,
  createSumUp = createSumUpAssistedApplicationCheckout,
  applySumUp = applyAssistedApplicationSumUpCheckout,
  applyStripe = handleAssistedApplicationWebhookEvent,
} = {}) {
  const provider = paymentProviderFor(order);
  if (!provider) return { status: 'error', reason: 'payment_provider_missing' };
  const checkoutId = checkoutIdFor(order);
  if (!checkoutId) return { status: 'error', reason: 'checkout_id_missing' };

  if (provider === SUMUP_PAYMENT_PROVIDER) {
    const checkout = await retrieveSumUp(checkoutId);
    if (boundedString(checkout?.id, 200) !== checkoutId || boundedString(checkout?.checkout_reference, 200) !== orderId) {
      return { status: 'error', reason: 'sumup_checkout_mismatch' };
    }
    const status = String(checkout?.status || '').toUpperCase();
    if (status === 'PAID') {
      const result = await applySumUp(checkout, { db: () => db, ts: FieldValue.serverTimestamp() });
      return result?.paymentStatus === 'paid' ? { status: 'paid' } : { status: 'error', reason: 'sumup_paid_amount_mismatch' };
    }
    if (status === 'PENDING' || status === 'OPEN') return { status: 'open' };
    if (status === 'EXPIRED' || status === 'FAILED' || status === 'CANCELLED') {
      return renewSumUpCheckout({ db, orderId, order, nowMs, createSumUp });
    }
    return { status: 'waiting_provider', reason: `sumup_status_${status.toLowerCase() || 'unknown'}` };
  }

  const stripeClient = stripe || await getStripeClient();
  const session = await retrieveStripe(stripeClient, checkoutId);
  if (boundedString(session?.id, 200) !== checkoutId) return { status: 'error', reason: 'stripe_checkout_mismatch' };
  if (stripeSessionHasPaidAmount(session, orderId)) {
    return reconcileStripePaid({ db, orderId, order, session, applyStripe });
  }
  const expiresAt = Number(session?.expires_at);
  const expired = session?.status === 'expired'
    || (Number.isSafeInteger(expiresAt) && expiresAt * 1000 <= nowMs);
  if (session?.status === 'open' && !expired && session?.payment_status !== 'paid') return { status: 'open', session };
  if (expired) return renewStripeCheckout({ db, orderId, order, stripe: stripeClient, nowMs });
  if (session?.status === 'complete' || session?.payment_status === 'processing') {
    return { status: 'waiting_provider', reason: 'stripe_payment_processing' };
  }
  return { status: 'waiting_provider', reason: 'stripe_payment_not_confirmed' };
}

async function readSubscriber(db, email) {
  const snapshot = await db.collection('newsletter_subscribers').doc(email).get();
  return snapshot.exists ? snapshot.data() || {} : null;
}

async function claimPaymentRecoveryDigest({ db, group, nowMs }) {
  const stateRef = paymentRecoveryStateRefFor(db, group.userId);
  const claimId = createHash('sha256')
    .update(`${group.userId}|${nowMs}|${Math.random()}`)
    .digest('hex')
    .slice(0, 40);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(stateRef);
    const state = snapshot.exists ? snapshot.data() || {} : {};
    const eligibleOrders = recoveryOrdersEligibleForDigest(state, group.orders);
    const stage = pendingPaymentRecoveryDueStage(state, eligibleOrders, { nowMs });
    if (!stage) return { ok: false, reason: state.status === 'ambiguous' ? 'ambiguous' : 'not_due' };
    transaction.set(stateRef, {
      userId: group.userId,
      email: group.to,
      orderIds: eligibleOrders.map((order) => order.orderId),
      status: 'sending',
      claimedAt: new Date(nowMs),
      claimId,
      claimedStage: stage,
      attempts: (Number(state.attempts) || 0) + 1,
      updatedAt: new Date(nowMs),
    }, { merge: true });
    return { ok: true, state, stage, stateRef, claimId, orders: eligibleOrders };
  });
}

async function finishPaymentRecoveryDigest({ db, group, claim, result, nowMs }) {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(claim.stateRef);
    const state = snapshot.exists ? snapshot.data() || {} : {};
    if (state.claimId !== claim.claimId || state.status !== 'sending') return { ok: false, reason: 'claim_lost' };
    const ambiguous = Boolean(result?.ambiguous);
    if (!result?.ok || ambiguous) {
      transaction.set(claim.stateRef, {
        status: ambiguous ? 'ambiguous' : 'failed',
        lastError: String(result?.reason || 'send_failed').slice(0, 300),
        lastFailedAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      }, { merge: true });
      return { ok: true, status: ambiguous ? 'ambiguous' : 'failed' };
    }

    const orderStates = { ...(state.orders || {}) };
    for (const order of group.orders) {
      const previous = recoveryOrderState(state, order.orderId);
      if (previous.reminderCount >= 2) continue;
      orderStates[order.orderId] = {
        reminderCount: previous.reminderCount + 1,
        lastSentAt: new Date(nowMs),
      };
    }
    const nextReminderAt = Object.values(orderStates)
      .map((entry) => {
        const count = Number(entry?.reminderCount) || 0;
        const sentAt = timestampMillis(entry?.lastSentAt);
        return count === 1 && sentAt !== null ? sentAt + PAYMENT_RECOVERY_FOLLOWUP_DELAY_MS : null;
      })
      .filter((value) => value !== null)
      .sort((left, right) => left - right)[0] || null;
    transaction.set(claim.stateRef, {
      status: 'sent',
      orders: orderStates,
      lastSentAt: new Date(nowMs),
      lastOrderIds: group.orders.map((order) => order.orderId),
      lastReminderStage: claim.stage,
      nextReminderAt: nextReminderAt === null ? null : new Date(nextReminderAt),
      provider: result.provider || null,
      messageId: result.messageId || null,
      lastError: null,
      updatedAt: new Date(nowMs),
    }, { merge: true });
    return { ok: true, status: 'sent', ambiguous: false };
  });
}

async function sendClaimedPaymentRecoveryDigest({ db, group, nowMs }) {
  const claim = await claimPaymentRecoveryDigest({ db, group, nowMs });
  if (!claim.ok) return { ok: true, skipped: claim.reason };
  const orders = claim.orders || group.orders;
  const digestId = paymentRecoveryDigestId(
    group.userId,
    orders.map((order) => order.orderId),
    claim.stage,
  );
  const result = await sendPendingPaymentDigest({
    db,
    orders,
    to: group.to,
    userId: group.userId,
    digestId,
    reminderStage: claim.stage,
    nowMs,
  });
  const finished = await finishPaymentRecoveryDigest({ db, group: { ...group, orders }, claim, result, nowMs });
  return { ...result, ...finished, stage: claim.stage };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = [];
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

/**
 * Hourly workflow. It is deliberately conservative: one uncertain provider
 * result suppresses the digest for that user, while a closed posting is simply
 * removed from that user's current email.
 */
export async function runAssistedApplicationPaymentRecoverySweep({
  db = defaultDb(),
  nowMs = Date.now(),
  getStripeClient = getStripe,
  postingClosed = postingClosedForOrder,
  inspectPayment = inspectPendingAssistedApplicationPayment,
} = {}) {
  const [pendingSnapshot, expiredSnapshot] = await Promise.all([
    db.collection(ASSISTED_APPLICATIONS_COLLECTION)
      .where('paymentStatus', '==', 'pending')
      .get(),
    db.collection(ASSISTED_APPLICATIONS_COLLECTION)
      .where('paymentFailureReason', '==', 'checkout_session_expired')
      .get(),
  ]);
  const orderDocs = new Map();
  for (const doc of [...(pendingSnapshot.docs || []), ...(expiredSnapshot.docs || [])]) orderDocs.set(doc.id, doc);
  const groups = groupPendingPaymentOrders([...orderDocs.values()].map((doc) => ({
    ...(doc.data() || {}),
    orderId: doc.id,
  })));
  const summary = {
    candidates: groups.reduce((total, group) => total + group.orders.length, 0),
    groups: groups.length,
    dueGroups: 0,
    inspected: 0,
    regenerated: 0,
    promoted: 0,
    sent: 0,
    followups: 0,
    suppressed: 0,
    closed: 0,
    skipped: 0,
    errors: 0,
  };

  const dueGroups = [];
  await mapWithConcurrency(groups, PAYMENT_RECOVERY_MAX_CONCURRENCY, async (group) => {
    const subscriber = await readSubscriber(db, group.to);
    if (subscriber && isCrossChannelStop(subscriber)) {
      summary.suppressed += 1;
      return null;
    }
    const stateSnapshot = await paymentRecoveryStateRefFor(db, group.userId).get();
    const state = stateSnapshot.exists ? stateSnapshot.data() || {} : {};
    const eligibleOrders = recoveryOrdersEligibleForDigest(state, group.orders);
    const stage = pendingPaymentRecoveryDueStage(state, eligibleOrders, { nowMs });
    if (!stage) {
      summary.skipped += 1;
      return null;
    }
    dueGroups.push({ ...group, orders: eligibleOrders, state, stage });
    return null;
  });
  summary.dueGroups = dueGroups.length;

  const results = await mapWithConcurrency(dueGroups, PAYMENT_RECOVERY_MAX_CONCURRENCY, async (group) => {
    const verifiedOrders = [];
    let unsafe = false;
    let stripe = null;
    for (const order of group.orders) {
      if (!validJobForRecovery(order)) {
        unsafe = true;
        break;
      }
      if (await postingClosed({ db, orderId: order.orderId, order })) {
        summary.closed += 1;
        continue;
      }
      const provider = paymentProviderFor(order);
      if (provider === 'stripe' && !stripe) stripe = await getStripeClient();
      const result = await inspectPayment({
        db,
        orderId: order.orderId,
        order,
        nowMs,
        stripe,
        getStripeClient,
      });
      summary.inspected += 1;
      if (result.status === 'paid') {
        summary.promoted += 1;
        continue;
      }
      if (result.status === 'renewed') {
        summary.regenerated += 1;
        verifiedOrders.push({ ...order, paymentRecoverySessionRefreshed: true });
        continue;
      }
      if (result.status === 'open') {
        verifiedOrders.push(order);
        continue;
      }
      unsafe = true;
      break;
    }
    if (unsafe || verifiedOrders.length === 0) {
      summary.skipped += 1;
      return { ok: false, skipped: unsafe ? 'provider_not_verified' : 'no_active_orders' };
    }

    const send = await sendClaimedPaymentRecoveryDigest({
      db,
      group: { ...group, orders: verifiedOrders },
      nowMs,
    });
    if (send.ok && send.status === 'sent') {
      summary.sent += 1;
      if (send.stage >= 2) summary.followups += 1;
    } else if (!send.skipped) {
      summary.errors += 1;
    } else {
      summary.skipped += 1;
    }
    return send;
  });
  for (const result of results) {
    if (result?.error) summary.errors += 1;
  }
  return summary;
}

/** Authenticated order-page endpoint used by the email CTA and the UI. */
export async function handleResumeAssistedApplicationPayment(
  req,
  {
    db = defaultDb(),
    nowMs = Date.now(),
    postingClosed = postingClosedForOrder,
    inspectPayment = inspectPendingAssistedApplicationPayment,
  } = {},
) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const decoded = await verifyCaller(req);
  if (!decoded) return { status: 401, body: { ok: false, error: 'unauthenticated' } };
  const orderId = boundedString(req.body?.orderId, 200);
  if (!orderId) return { status: 400, body: { ok: false, error: 'order_id_missing' } };
  const ref = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return { status: 404, body: { ok: false, error: 'order_not_found' } };
  const order = snapshot.data() || {};
  if (String(order.userId || '') !== String(decoded.uid || '')) {
    return { status: 403, body: { ok: false, error: 'forbidden' } };
  }
  if (order.paymentStatus === 'paid') {
    return { status: 200, body: { ok: true, status: 'paid', orderId, url: buildOrderPageUrl(order, orderId) } };
  }
  if (!isPendingPaymentOrder(order) && !VALID_PAYMENT_FAILURES.has(String(order.paymentFailureReason || ''))) {
    return { status: 409, body: { ok: false, error: 'payment_not_resumable' } };
  }
  if (!validJobForRecovery(order)) return { status: 409, body: { ok: false, error: 'invalid_job' } };
  if (await postingClosed({ db, orderId, order })) {
    return { status: 409, body: { ok: false, error: 'job_unavailable' } };
  }

  const result = await inspectPayment({ db, orderId, order, nowMs });
  if (result.status === 'paid') {
    return { status: 200, body: { ok: true, status: 'paid', orderId, url: buildOrderPageUrl(order, orderId) } };
  }
  if (result.status === 'open') {
    const provider = paymentProviderFor(order);
    if (provider === SUMUP_PAYMENT_PROVIDER) {
      return { status: 200, body: { ok: true, status: 'open', paymentProvider: SUMUP_PAYMENT_PROVIDER, checkoutId: checkoutIdFor(order), orderId } };
    }
    if (result.session?.url) return { status: 200, body: { ok: true, status: 'open', paymentProvider: 'stripe', url: result.session.url, orderId } };
  }
  if (result.status === 'renewed') {
    if (paymentProviderFor(order) === SUMUP_PAYMENT_PROVIDER) {
      return { status: 200, body: { ok: true, status: 'open', paymentProvider: SUMUP_PAYMENT_PROVIDER, checkoutId: result.checkoutId, orderId } };
    }
    if (result.session?.url) return { status: 200, body: { ok: true, status: 'open', paymentProvider: 'stripe', url: result.session.url, orderId } };
  }
  if (result.status === 'in_progress') return { status: 409, body: { ok: false, error: 'payment_session_in_progress' } };
  if (result.status === 'waiting_provider') return { status: 409, body: { ok: false, error: 'payment_processing' } };
  return { status: 502, body: { ok: false, error: result.reason || 'payment_session_unavailable' } };
}
