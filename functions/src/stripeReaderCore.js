/**
 * Stripe — reader no-ads subscription (#3655, part 2/2 of #2961).
 *
 * Fully separate domain from stripePublisherCore.js's publisher job-posting
 * flow: a different Stripe Price (CHF 2.99/month, flat, no volume tiers), a
 * different Firestore collection (`reader_subscriptions`, doc id = uid — no
 * `orders` / `publisher_jobs` involvement), and a different entitlement
 * (disables Auto Ads client-side for that one paying reader; NEVER a
 * global/per-route toggle, see AGENTS.md Non-Negotiable #7).
 *
 * Two HTTP entry points (wired in functions/index.js):
 *   - createReaderCheckout      : authenticated reader → Stripe Checkout
 *                                 Session in `subscription` mode.
 *   - createReaderBillingPortal : self-serve cancel/manage via Stripe's
 *                                 hosted Billing Portal.
 *
 * Webhook events are NOT wired to their own Cloud Function endpoint — Stripe
 * has exactly ONE webhook endpoint/secret for the whole project. Instead,
 * handleReaderWebhookEvent(event, {db, ts}) is dispatched from INSIDE
 * stripePublisherCore.js's handleStripeWebhook, near the top of its switch,
 * and short-circuits (returns true) when the event belongs to this domain so
 * the publisher-order switch never double-processes it. Reader vs publisher
 * events of the same Stripe event `type` (checkout.session.completed,
 * invoice.paid, invoice.payment_failed, customer.subscription.deleted) are
 * told apart by `metadata.plan === READER_NOADS_PLAN`, set at checkout
 * creation on both the Checkout Session and the Subscription
 * (`subscription_data.metadata`) — never by collection existence guessing.
 *
 * Secret (Firebase Remote Config, via getRemoteConfigValue):
 *   STRIPE_PRICE_READER_NOADS — id of a RECURRING (monthly) Price = CHF 2.99.
 *   Added via scripts/set-stripe-rc.mjs. Until the owner creates the real
 * Price in the Stripe Dashboard and sets this key, createReaderCheckout
 * safe-fails with a 500 `reader_price_not_configured` — never a silent
 * misconfiguration.
 *
 * verifyCaller / getStripe / db are reused from stripePublisherCore.js (same
 * functions bundle, no deploy boundary between the two files) rather than
 * duplicated.
 */

import admin from 'firebase-admin';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';
import { verifyCaller, getStripe, db } from './stripePublisherCore.js';

/**
 * Stable plan identifier stored in Stripe checkout/subscription metadata and
 * in reader_subscriptions docs. Must match services/readerSubscriptionPricing.ts's
 * READER_NOADS_PLAN (deploy-boundary duplicate — the functions bundle is
 * isolated and cannot import the SPA TS module, same convention as
 * functions/src/publisherPricingMirror.js). Drift is guarded by
 * tests/stripe-reader-core.test.ts.
 */
export const READER_NOADS_PLAN = 'reader_noads';

const READER_SUBSCRIPTIONS_COLLECTION = 'reader_subscriptions';

// Deploy-boundary duplicate of services/posthog.ts's POSTHOG_KEY/POSTHOG_HOST —
// the functions bundle has no bundler and cannot import the SPA TS module
// (same convention as READER_NOADS_PLAN above). Both values are public/non-secret
// (a write-only project key and a first-party proxy host, not credentials).
const POSTHOG_KEY = 'phc_u8jsgXxFQNB6WcQt9JBcdj9tJrR4NsMws3nQoKdigjbT';
const POSTHOG_HOST = 'https://t.frontaliereticino.ch';

// ── createReaderCheckout ─────────────────────────────────────────────────

export async function handleCreateReaderCheckout(req) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

  const decoded = await verifyCaller(req);
  if (!decoded) return { status: 401, body: { ok: false, error: 'unauthenticated' } };
  const uid = decoded.uid;

  const body = req.body || {};
  const successUrl = String(body.successUrl || '');
  const cancelUrl = String(body.cancelUrl || '');
  if (!/^https?:\/\//.test(successUrl) || !/^https?:\/\//.test(cancelUrl)) {
    return { status: 400, body: { ok: false, error: 'invalid_redirect_urls' } };
  }
  // Carried through to session metadata so the checkout.session.completed
  // webhook can fire the conversion capture against the same PostHog Person
  // as the client-side ab_test/bucket_assigned + subscribe click events.
  const posthogDistinctId =
    typeof body.posthogDistinctId === 'string' && body.posthogDistinctId ? body.posthogDistinctId : null;

  const priceId = await getRemoteConfigValue('STRIPE_PRICE_READER_NOADS');
  if (!priceId) return { status: 500, body: { ok: false, error: 'reader_price_not_configured' } };

  const readerRef = db().collection(READER_SUBSCRIPTIONS_COLLECTION).doc(uid);
  const readerSnap = await readerRef.get();
  const existing = readerSnap.exists ? readerSnap.data() : null;

  // Idempotent guard: an already-active subscriber hitting this endpoint again
  // (e.g. stale UI state / double click) gets a no-op instead of a second
  // subscription. The SPA itself already swaps the button for "manage
  // subscription" once entitlement is active — this is a defensive backstop.
  if (existing && existing.status === 'active') {
    return { status: 200, body: { ok: true, alreadyActive: true } };
  }

  const stripe = await getStripe();
  let customerId = existing ? existing.stripeCustomerId : undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: decoded.email || undefined,
      metadata: { readerUid: uid },
    });
    customerId = customer.id;
    await readerRef.set(
      { stripeCustomerId: customerId, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: uid,
    metadata: {
      plan: READER_NOADS_PLAN,
      readerUid: uid,
      ...(posthogDistinctId ? { posthogDistinctId } : {}),
    },
    subscription_data: { metadata: { plan: READER_NOADS_PLAN, readerUid: uid } },
  });

  await readerRef.set(
    {
      stripeCheckoutSessionId: session.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { status: 200, body: { ok: true, url: session.url } };
}

// ── createReaderBillingPortal ────────────────────────────────────────────
// Self-serve subscription management (cancel, update payment method, invoices)
// via Stripe's hosted Billing Portal, mirroring handleCreateBillingPortal.
export async function handleCreateReaderBillingPortal(req) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const decoded = await verifyCaller(req);
  if (!decoded) return { status: 401, body: { ok: false, error: 'unauthenticated' } };

  const returnUrl = String((req.body || {}).returnUrl || '');
  if (!/^https?:\/\//.test(returnUrl)) return { status: 400, body: { ok: false, error: 'invalid_return_url' } };

  const readerSnap = await db().collection(READER_SUBSCRIPTIONS_COLLECTION).doc(decoded.uid).get();
  const customerId = readerSnap.exists ? readerSnap.data().stripeCustomerId : null;
  if (!customerId) return { status: 400, body: { ok: false, error: 'no_customer' } };

  const stripe = await getStripe();
  const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  return { status: 200, body: { ok: true, url: session.url } };
}

// ── reader_subscriptions lookup by Stripe ref ────────────────────────────
// Mirrors stripePublisherCore.js's orderByStripeRef, scoped to this collection.
async function readerByStripeRef(dbFn, { customerId, subscriptionId }) {
  const col = dbFn().collection(READER_SUBSCRIPTIONS_COLLECTION);
  if (subscriptionId) {
    const q = await col.where('stripeSubscriptionId', '==', subscriptionId).limit(1).get();
    if (!q.empty) return q.docs[0];
  }
  if (customerId) {
    const q = await col.where('stripeCustomerId', '==', customerId).limit(1).get();
    if (!q.empty) return q.docs[0];
  }
  return null;
}

// ── handleReaderWebhookEvent ──────────────────────────────────────────────
/**
 * Dispatched from stripePublisherCore.js's handleStripeWebhook. Returns
 * `true` when this event belongs to the reader no-ads domain (and has been
 * fully handled — short-circuits the publisher switch), `false` when it
 * does not (falls through to the existing publisher-order handling,
 * unchanged).
 *
 * @param {import('stripe').Event} event
 * @param {{ db: () => FirebaseFirestore.Firestore, ts: unknown }} ctx
 *   `ts` is the already-created FieldValue.serverTimestamp() sentinel from
 *   the caller (reused rather than re-created per Firestore write, matching
 *   the rest of this Cloud Functions bundle's convention).
 */
// Sub-statuses that mean the ad-free entitlement must come down. Mirrors
// stripePublisherCore.js's own DEAD_SUB_STATUSES (not exported — small enough
// to keep in sync manually, guarded by tests/stripe-reader-core.test.ts).
const DEAD_SUB_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

// Fire-and-forget server-side conversion capture. Mirrors the client-side
// `ui_interaction` event shape from services/analytics.ts so this lands in the
// same PostHog funnel as the AdBlockGate's ab_test/bucket_assigned and
// subscribe_page/checkout events. Uses the checkout session's posthogDistinctId
// (threaded through from handleCreateReaderCheckout) so the conversion joins
// the same Person as those earlier client-side events; falls back to the
// Firebase uid when the client didn't have PostHog loaded — still counted,
// just uncorrelated to the A/B bucket. A capture failure must never affect
// webhook processing or the entitlement grant, hence the swallowed catch.
async function captureReaderConversion(uid, posthogDistinctId) {
  try {
    await fetch(`${POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event: 'ui_interaction',
        distinct_id: posthogDistinctId || uid,
        properties: {
          page: 'reader_subscription',
          section: 'subscribe_page',
          component: 'checkout',
          action: 'converted',
          plan: READER_NOADS_PLAN,
        },
      }),
    });
  } catch {
    // PostHog unreachable or blocked — never let analytics break the webhook.
  }
}

export async function handleReaderWebhookEvent(event, { db: dbFn, ts }) {
  const obj = event.data?.object || {};

  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.metadata?.plan !== READER_NOADS_PLAN || !obj.metadata?.readerUid) return false;
      const uid = obj.metadata.readerUid;
      await dbFn().collection(READER_SUBSCRIPTIONS_COLLECTION).doc(uid).set(
        {
          stripeCustomerId: obj.customer || null,
          stripeSubscriptionId: obj.subscription || null,
          stripeCheckoutSessionId: obj.id || null,
          status: 'active',
          updatedAt: ts,
        },
        { merge: true },
      );
      await captureReaderConversion(uid, obj.metadata.posthogDistinctId);
      return true;
    }
    case 'invoice.paid': {
      const snap = await readerByStripeRef(dbFn, { customerId: obj.customer, subscriptionId: obj.subscription });
      if (!snap) return false;
      await snap.ref.set({ status: 'active', updatedAt: ts }, { merge: true });
      return true;
    }
    case 'invoice.payment_failed': {
      const snap = await readerByStripeRef(dbFn, { customerId: obj.customer, subscriptionId: obj.subscription });
      if (!snap) return false;
      await snap.ref.set({ status: 'past_due', updatedAt: ts }, { merge: true });
      return true;
    }
    case 'customer.subscription.updated': {
      // Stripe's dunning config can flip a subscription straight to
      // canceled/unpaid/incomplete_expired via `.updated` without ever
      // emitting a separate `.deleted` (mirrors stripePublisherCore.js's own
      // DEAD_SUB_STATUSES handling for the same reason). Without this case,
      // a lapsed reader's `status` stays 'past_due' forever — and
      // readerEntitlement.ts's ACTIVE_ENTITLEMENT_STATUSES treats 'past_due'
      // as still ad-free, so Auto Ads would never come back on.
      if (obj.metadata?.plan !== READER_NOADS_PLAN || !DEAD_SUB_STATUSES.has(obj.status)) return false;
      const snap = await readerByStripeRef(dbFn, { customerId: obj.customer, subscriptionId: obj.id });
      if (!snap) return false;
      await snap.ref.set({ status: 'canceled', updatedAt: ts }, { merge: true });
      return true;
    }
    case 'customer.subscription.deleted':
    case 'customer.subscription.canceled': {
      if (obj.metadata?.plan !== READER_NOADS_PLAN) return false;
      const snap = await readerByStripeRef(dbFn, { customerId: obj.customer, subscriptionId: obj.id });
      if (!snap) return false;
      await snap.ref.set({ status: 'canceled', updatedAt: ts }, { merge: true });
      return true;
    }
    default:
      return false;
  }
}
