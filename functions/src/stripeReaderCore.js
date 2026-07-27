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
 * Three HTTP entry points (wired in functions/index.js):
 *   - createReaderCheckout      : Stripe Checkout Session in `subscription`
 *                                 mode. Works both signed-in (uid known
 *                                 upfront, mirrors createConsultingCheckout's
 *                                 own "anonymous visitors shouldn't need an
 *                                 account to pay" precedent) and signed-out —
 *                                 the guest path lets Stripe collect the
 *                                 email itself; identity is resolved AFTER
 *                                 payment (see checkout.session.completed
 *                                 below) instead of gating checkout on a
 *                                 pre-existing Firebase session.
 *   - claimReaderCheckout       : post-payment reconciliation for the guest
 *                                 path. Exchanges a completed Checkout
 *                                 Session id for a Firebase custom auth
 *                                 token, same "resolve/create user by email →
 *                                 createCustomToken" shape already used by
 *                                 functions/src/newsletterSubscriptionManagement.js's
 *                                 autologin exchange.
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

// Claim-exhaustion ledger for handleClaimReaderCheckout (#4800): a paid
// Checkout Session stays retrievable via stripe.checkout.sessions.retrieve
// indefinitely (Stripe never expires already-paid sessions), and success_url
// carries session_id in the query string — a string that can leak via
// Referer headers, browser history, or shared screenshots long after the
// original purchase. Without a one-time-use ledger, anyone who later obtains
// that string could keep minting fresh sign-in tokens for the account
// forever. One doc per sessionId, created exactly once via a transaction so
// two concurrent claim calls for the same session can't both win.
const READER_CHECKOUT_CLAIMS_COLLECTION = 'reader_checkout_claims';

class SessionAlreadyClaimedError extends Error {}

// Deploy-boundary duplicate of services/posthog.ts's POSTHOG_KEY/POSTHOG_HOST —
// the functions bundle has no bundler and cannot import the SPA TS module
// (same convention as READER_NOADS_PLAN above). Both values are public/non-secret
// (a write-only project key and a first-party proxy host, not credentials).
const POSTHOG_KEY = 'phc_u8jsgXxFQNB6WcQt9JBcdj9tJrR4NsMws3nQoKdigjbT';
const POSTHOG_HOST = 'https://t.frontaliereticino.ch';

// Resolve a Firebase user by email, creating one if none exists yet. Shared
// by the guest-checkout webhook branch and claimReaderCheckout below — same
// "getUserByEmail → catch → createUser({email})" shape already used by
// functions/src/newsletterSubscriptionManagement.js's autologin exchange.
// Returns createdAtMs (from Firebase's own account metadata) instead of a
// runtime-computed isNew flag: webhook delivery and the browser's claim call
// race independently (no ordering guarantee), so "isNew relative to THIS
// call" is not a safe signal — if the webhook wins the race and creates the
// account first, the claim call would see isNew:false for a genuinely
// brand-new guest. createdAtMs lets the caller compare against the Stripe
// session's own creation time instead, which is race-proof — see
// handleClaimReaderCheckout.
async function resolveOrCreateReaderUid(email) {
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    return { uid: userRecord.uid, createdAtMs: Date.parse(userRecord.metadata.creationTime) };
  } catch (err) {
    if (err?.code !== 'auth/user-not-found') throw err;
    try {
      const newUser = await admin.auth().createUser({ email });
      return { uid: newUser.uid, createdAtMs: Date.parse(newUser.metadata.creationTime) };
    } catch (createErr) {
      // Lost a race with a concurrent create (e.g. duplicate webhook
      // delivery) — the user now exists, re-resolve instead of failing.
      if (createErr?.code !== 'auth/email-already-exists') throw createErr;
      const userRecord = await admin.auth().getUserByEmail(email);
      return { uid: userRecord.uid, createdAtMs: Date.parse(userRecord.metadata.creationTime) };
    }
  }
}

// ── createReaderCheckout ─────────────────────────────────────────────────

export async function handleCreateReaderCheckout(req) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

  const decoded = await verifyCaller(req);

  const body = req.body || {};
  const successUrl = String(body.successUrl || '');
  const cancelUrl = String(body.cancelUrl || '');
  if (!/^https?:\/\//.test(successUrl) || !/^https?:\/\//.test(cancelUrl)) {
    return { status: 400, body: { ok: false, error: 'invalid_redirect_urls' } };
  }
  // Carried through to session metadata so the checkout.session.completed
  // webhook can fire the conversion capture against the same PostHog Person
  // as the client-side ab_test/bucket_assigned + subscribe click events.
  // Bounded well under Stripe's 500-char metadata value cap — a malformed
  // or oversized client value must never fail checkout session creation.
  const posthogDistinctId =
    typeof body.posthogDistinctId === 'string' && body.posthogDistinctId && body.posthogDistinctId.length <= 200
      ? body.posthogDistinctId
      : null;

  const priceId = await getRemoteConfigValue('STRIPE_PRICE_READER_NOADS');
  if (!priceId) return { status: 500, body: { ok: false, error: 'reader_price_not_configured' } };

  const stripe = await getStripe();

  // Guest path: no Firebase session yet — mirrors createConsultingCheckout's
  // own precedent (anonymous visitors shouldn't need an account to pay).
  // Stripe Checkout collects the email itself; identity is resolved AFTER
  // payment from the webhook's `customer_details.email` (see
  // handleReaderWebhookEvent below) and claimed client-side via
  // claimReaderCheckout, instead of gating checkout on a pre-existing
  // sign-in. No Firestore write here — there is no uid yet to key it on.
  if (!decoded) {
    const separator = successUrl.includes('?') ? '&' : '?';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${successUrl}${separator}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      metadata: {
        plan: READER_NOADS_PLAN,
        ...(posthogDistinctId ? { posthogDistinctId } : {}),
      },
      subscription_data: { metadata: { plan: READER_NOADS_PLAN } },
    });
    return { status: 200, body: { ok: true, url: session.url } };
  }

  const uid = decoded.uid;
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

// ── claimReaderCheckout ──────────────────────────────────────────────────
// Post-payment reconciliation for the guest checkout path above: exchanges a
// completed Checkout Session id for a Firebase custom auth token so the SPA
// can sign the payer in without ever asking for a password — same
// services/authService.ts signInWithCustomAuthToken() call already used for
// the LinkedIn OAuth callback and the newsletter autologin exchange
// (App.tsx).
//
// SECURITY: the Stripe session id proves *payment*, not *email ownership* —
// Stripe Checkout's guest email field is free text the payer typed, never
// verified as an inbox they control. Only ever mint a sign-in token for an
// account that was created BY THIS PAYMENT: otherwise anyone could pay a few
// francs with their own card, type an existing reader's / publisher's /
// admin's email at checkout, and use the resulting session id to sign in as
// that person. If the email resolves to an account that already existed
// before this checkout session started, refuse — the webhook
// (handleReaderWebhookEvent) still attaches the reader_noads entitlement to
// that existing account via the same email match, so the payer only needs
// to sign in normally to see it.
//
// "Created by this payment" is checked via timestamp, not a runtime isNew
// flag: the webhook and this claim call both call resolveOrCreateReaderUid
// independently and race (no ordering guarantee between Stripe webhook
// delivery and the browser's redirect back to success_url). If the webhook
// wins, it creates the account first — a naive isNew check here would then
// see an "existing" account for a guest who is, in reality, brand new, and
// wrongly 409 them into a passwordless account they can't sign into. Instead,
// compare the resolved account's creationTime against this Stripe session's
// own `created` timestamp, with BOTH a lower and an upper bound:
//   - lower bound (ACCOUNT_RACE_GRACE_MS): absorbs clock skew between
//     Stripe's and Firebase's clocks — a legitimate account can never be
//     created meaningfully before the session that paid for it existed.
//   - upper bound (MAX_CLAIM_WINDOW_MS): without one, a paid guest session
//     stays retrievable via stripe.checkout.sessions.retrieve long after
//     creation (Stripe does not expire already-paid sessions the way it
//     expires unpaid ones), and other flows DO create Firebase users
//     unrelated to Stripe (e.g. services/authService.ts's signInWithGoogle
//     on first login) — so "created after the session" alone is not proof
//     of "created by the session". Without the upper bound an attacker
//     could pay a few francs for a guest session using a victim's
//     not-yet-registered email, sit on the paid session id, and claim it
//     whenever the victim later signs up for real through any unrelated
//     method — their brand-new account would trivially satisfy an
//     unbounded "after" check. The window only needs to cover the actual
//     guest-checkout round trip (session created → payment → webhook/claim),
//     which completes in seconds to low minutes in practice.
const ACCOUNT_RACE_GRACE_MS = 60 * 1000;
const MAX_CLAIM_WINDOW_MS = 30 * 60 * 1000;
export async function handleClaimReaderCheckout(req) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

  const sessionId = String((req.body || {}).sessionId || '');
  if (!/^cs_/.test(sessionId)) return { status: 400, body: { ok: false, error: 'invalid_session_id' } };

  const stripe = await getStripe();
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch {
    return { status: 404, body: { ok: false, error: 'session_not_found' } };
  }

  // Guest sessions only — an authenticated-flow session already has readerUid
  // in metadata and never needs claiming (the SPA already holds a live
  // Firebase session in that case).
  if (session.metadata?.plan !== READER_NOADS_PLAN || session.metadata?.readerUid) {
    return { status: 400, body: { ok: false, error: 'not_a_guest_session' } };
  }
  if (session.payment_status !== 'paid') {
    return { status: 400, body: { ok: false, error: 'not_paid' } };
  }

  const email = session.customer_details?.email;
  if (!email) return { status: 400, body: { ok: false, error: 'no_email_on_session' } };

  const { uid, createdAtMs } = await resolveOrCreateReaderUid(email);
  // Missing/non-numeric session.created fails closed (Infinity) rather than
  // open — Stripe always sets it, this only guards a malformed response.
  const sessionCreatedMs = typeof session.created === 'number' ? session.created * 1000 : Infinity;
  // A malformed/missing Auth creationTime (Date.parse → NaN) must also fail
  // closed. Without this, NaN - sessionCreatedMs = NaN, and BOTH bound
  // comparisons below evaluate to false for any NaN operand (JS spec, not a
  // typo) — the guard would silently never trigger and mint a token instead
  // of rejecting, the opposite of the session.created guard's fail-closed
  // intent right above it.
  if (!Number.isFinite(createdAtMs)) {
    return { status: 409, body: { ok: false, error: 'account_exists' } };
  }
  const accountCreatedDeltaMs = createdAtMs - sessionCreatedMs;
  if (accountCreatedDeltaMs < -ACCOUNT_RACE_GRACE_MS || accountCreatedDeltaMs > MAX_CLAIM_WINDOW_MS) {
    return { status: 409, body: { ok: false, error: 'account_exists' } };
  }

  // Claim-exhaustion guard (#4800): a paid session id must mint at most one
  // sign-in token, ever — otherwise it stays a standing credential for as
  // long as Stripe keeps the paid session retrievable. tx.get + tx.set inside
  // one transaction makes "does a claim doc exist yet" and "create it" atomic,
  // so two concurrent claim calls for the same sessionId can't both pass the
  // existence check before either writes.
  const claimRef = db().collection(READER_CHECKOUT_CLAIMS_COLLECTION).doc(sessionId);
  try {
    await db().runTransaction(async (tx) => {
      const claimSnap = await tx.get(claimRef);
      if (claimSnap.exists) throw new SessionAlreadyClaimedError();
      tx.set(claimRef, { uid, claimedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
  } catch (err) {
    if (err instanceof SessionAlreadyClaimedError) {
      return { status: 409, body: { ok: false, error: 'session_already_claimed' } };
    }
    throw err;
  }

  const authToken = await admin.auth().createCustomToken(uid);
  return { status: 200, body: { ok: true, authToken } };
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
      if (obj.metadata?.plan !== READER_NOADS_PLAN) return false;

      // Guest path (no readerUid in metadata — see handleCreateReaderCheckout):
      // identity wasn't known at checkout creation time, so resolve/create the
      // Firebase user from the email Stripe collected during checkout. Same
      // "getUserByEmail → catch → createUser({email})" shape already used by
      // functions/src/newsletterSubscriptionManagement.js's autologin exchange.
      let uid = obj.metadata?.readerUid || null;
      if (!uid) {
        const email = obj.customer_details?.email;
        if (!email) return true; // unrecoverable without an email — nothing to reconcile against
        ({ uid } = await resolveOrCreateReaderUid(email));
      }

      // Duplicate-subscription guard (#4790): the signed-in path in
      // handleCreateReaderCheckout already no-ops before creating a session
      // when the caller's own reader_subscriptions/{uid} doc is already
      // 'active' — but the GUEST path (no uid known upfront, Stripe collects
      // the email) has no such check, because there is nothing to check
      // against yet at session-creation time. If local entitlement state is
      // lost client-side (private browsing, cleared storage, a different
      // device) a reader can pay for a second guest subscription on an email
      // that resolves right back to an account that already has one active.
      // This webhook write is the first point where both facts are known
      // together (the resolved uid AND its current subscription status), and
      // it fires regardless of whether the client ever calls
      // claimReaderCheckout — so it's the only reliable place to catch this.
      // Blindly merging the new ids in would silently orphan the FIRST
      // subscription (still billing, no longer referenced by this doc, so
      // its future invoice.paid/failed events find no match via
      // readerByStripeRef and are dropped) while leaving two live Stripe
      // subscriptions charging the same payer. Cancel the newly-created
      // (duplicate) one instead and leave the tracked subscription alone.
      const existingSnap = await dbFn().collection(READER_SUBSCRIPTIONS_COLLECTION).doc(uid).get();
      const existingData = existingSnap.exists ? existingSnap.data() : null;
      if (
        existingData?.status === 'active' &&
        obj.subscription &&
        existingData.stripeSubscriptionId &&
        existingData.stripeSubscriptionId !== obj.subscription
      ) {
        try {
          const stripe = await getStripe();
          await stripe.subscriptions.cancel(obj.subscription);
        } catch {
          // Never let a cancellation failure fall through to the blind
          // merge below — that would overwrite the tracked subscription
          // and orphan the original. Worst case the duplicate needs a
          // manual cancel via the Stripe Dashboard; not blocking the
          // webhook ack (Stripe retries non-2xx responses) is preferable
          // to silently losing track of the original subscription.
        }
        return true;
      }

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
