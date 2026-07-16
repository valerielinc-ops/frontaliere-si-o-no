/**
 * Stripe — publisher paid job postings (subscription model).
 *
 * Two HTTP entry points (wired in functions/index.js):
 *   - createPublisherCheckout : authenticated publisher → Stripe Checkout Session
 *                               in `subscription` mode (auto-renews every 30 days).
 *   - stripeWebhook           : Stripe → flips order + publisher_jobs status via
 *                               the Admin SDK (bypasses Firestore rules; this is the
 *                               ONLY path that may set a job to 'paid').
 *
 * Secrets (Firebase Remote Config, read via getRemoteConfigValue — same store as the
 * newsletter ESP keys, no Cloud Secret Manager needed):
 *   STRIPE_SECRET_KEY      — sk_live_… / sk_test_…
 *   STRIPE_WEBHOOK_SECRET  — whsec_…
 *   STRIPE_PRICE_AD_UNIT   — id of a RECURRING (monthly) Price = CHF 49 / ad-unit.
 *   STRIPE_PRICE_AZIENDA   — id of a RECURRING Price = CHF 299 / 30 days for the
 *                            flat "Piano Azienda" plan (unlimited ads). Created +
 *                            published to RC; checkout wiring is the remaining #7 work.
 *
 * Pricing is RECOMPUTED here server-side from the publisher_jobs the order references
 * — the client amount is never trusted. The unit price + discount tiers MUST stay in
 * sync with services/publisherPricing.ts (deploy-boundary duplication: the functions
 * bundle is isolated and cannot import the SPA TS module). See PUBLISHER-PORTAL-PLAN §6.2.
 *
 * handleStripeWebhook also dispatches reader no-ads subscription events (a fully
 * separate domain, #3655 part 2/2 of #2961) to ./stripeReaderCore.js before its
 * own publisher-order switch runs — see that file for details. verifyCaller,
 * getStripe and db are exported so stripeReaderCore.js can reuse them instead
 * of duplicating (same functions bundle, no deploy boundary between the two).
 */

import admin from 'firebase-admin';
import { getRemoteConfigValue, bridgeEmailCascadeCredentialsToEnv } from './remoteConfigSecrets.js';
import { sendEmailCascade } from './emailCascade.js';
import {
  discountRateForUnits,
  countDistinctLocations,
  netChfForUnits,
} from './publisherPricingMirror.js';
// Guarded revert of abandoned-checkout ads (shared with the daily reaper CF).
// Lives in the reap module so this file's `import('stripe')` never has to load
// when the reaper (or its unit test) runs.
import { revertPendingJobsToDraft } from './publisherPendingReapCore.js';

// ── Stripe client (lazy, cached) ────────────────────────────────────────────
let _stripe = null;
const _productTaxCodeEnsured = new Set();
export async function getStripe() {
  if (_stripe) return _stripe;
  const key = await getRemoteConfigValue('STRIPE_SECRET_KEY');
  if (!key) throw new Error('stripe_secret_key_missing');
  const { default: Stripe } = await import('stripe');
  _stripe = new Stripe(key, { apiVersion: '2025-03-31.basil' });
  return _stripe;
}

export function db() {
  return admin.firestore();
}

export async function verifyCaller(req) {
  const header = req.get('Authorization') || req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  try {
    return await admin.auth().verifyIdToken(match[1]);
  } catch {
    return null;
  }
}

/**
 * Idempotent percent-off coupon, one per discount tier (id `vol-10`, `vol-15`, …).
 * Returns null when rate is 0 (no discount → no coupon).
 */
async function ensureVolumeCoupon(stripe, rate) {
  if (!rate || rate <= 0) return null;
  const pct = Math.round(rate * 100);
  const id = `vol-${pct}`;
  try {
    await stripe.coupons.retrieve(id);
  } catch {
    await stripe.coupons.create({
      id,
      percent_off: pct,
      duration: 'forever', // applies to every renewal of the subscription
      name: `Volume ${pct}%`,
    });
  }
  return id;
}

/**
 * Idempotent: assigns taxCode to the Stripe product linked to priceId if it
 * has no tax_code yet. Required for managed_payments. Cached per instance.
 */
async function ensureProductTaxCode(stripe, priceId, taxCode) {
  if (_productTaxCodeEnsured.has(priceId)) return;
  const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
  const product = price.product;
  if (product && !product.tax_code) {
    await stripe.products.update(product.id, { tax_code: taxCode });
  }
  _productTaxCodeEnsured.add(priceId);
}

// ── createPublisherCheckout ─────────────────────────────────────────────────

export async function handleCreatePublisherCheckout(req) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

  const decoded = await verifyCaller(req);
  if (!decoded) return { status: 401, body: { ok: false, error: 'unauthenticated' } };
  const uid = decoded.uid;

  const body = req.body || {};
  const jobIds = Array.isArray(body.jobIds) ? body.jobIds.filter(Boolean) : [];
  const successUrl = String(body.successUrl || '');
  const cancelUrl = String(body.cancelUrl || '');
  if (!jobIds.length) return { status: 400, body: { ok: false, error: 'no_jobs' } };
  if (!/^https?:\/\//.test(successUrl) || !/^https?:\/\//.test(cancelUrl)) {
    return { status: 400, body: { ok: false, error: 'invalid_redirect_urls' } };
  }

  // ── Piano Azienda: flat per-publisher subscription (CHF 299), ruoli illimitati ──
  // A single recurring price (no per-unit/discount math). On payment the webhook
  // marks the publisher tier='azienda' and flips their ads to tier='azienda'
  // (the projection then features them all). Kept fully separate from the per-ad
  // path below so that proven flow is untouched.
  if (body.plan === 'azienda') {
    const aziendaPrice = await getRemoteConfigValue('STRIPE_PRICE_AZIENDA');
    if (!aziendaPrice) return { status: 500, body: { ok: false, error: 'azienda_price_not_configured' } };

    // Verify ownership of the jobs being published under the plan.
    const ownedJobIds = [];
    let aziendaJobSnaps;
    try {
      const aziendaRefs = jobIds.map(jobId => db().collection('publisher_jobs').doc(String(jobId)));
      aziendaJobSnaps = await db().getAll(...aziendaRefs);
    } catch (err) {
      console.error('[createPublisherCheckout/azienda] batch job lookup failed', err instanceof Error ? err.message : String(err));
      return { status: 503, body: { ok: false, error: 'job_lookup_failed' } };
    }
    for (const snap of aziendaJobSnaps) {
      if (!snap.exists) continue;
      if (snap.data().publisherUid !== uid) return { status: 403, body: { ok: false, error: 'not_owner' } };
      ownedJobIds.push(snap.id);
    }
    if (!ownedJobIds.length) return { status: 400, body: { ok: false, error: 'no_jobs' } };

    const stripeA = await getStripe();
    const pubRefA = db().collection('publishers').doc(uid);
    const pubSnapA = await pubRefA.get();
    let customerIdA = pubSnapA.exists ? pubSnapA.data().stripeCustomerId : undefined;
    if (!customerIdA) {
      const customer = await stripeA.customers.create({ email: decoded.email || undefined, metadata: { publisherUid: uid } });
      customerIdA = customer.id;
      await pubRefA.set({ stripeCustomerId: customerIdA, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }

    const orderRefA = db().collection('orders').doc();
    await orderRefA.set({
      publisherUid: uid, jobIds: ownedJobIds, plan: 'azienda', units: null,
      amountChf: 299, currency: 'CHF', status: 'created', stripeCustomerId: customerIdA,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const sessionA = await stripeA.checkout.sessions.create({
      mode: 'subscription', customer: customerIdA,
      line_items: [{ price: aziendaPrice, quantity: 1 }],
      success_url: successUrl, cancel_url: cancelUrl,
      client_reference_id: orderRefA.id,
      metadata: { orderId: orderRefA.id, publisherUid: uid, plan: 'azienda' },
      subscription_data: { metadata: { orderId: orderRefA.id, publisherUid: uid, plan: 'azienda' } },
    });
    await orderRefA.update({ stripeCheckoutSessionId: sessionA.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    const batchA = db().batch();
    for (const jobId of ownedJobIds) {
      batchA.update(db().collection('publisher_jobs').doc(jobId), {
        status: 'pending_payment', tier: 'azienda', orderId: orderRefA.id,
        pendingPaymentAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batchA.commit();

    return { status: 200, body: { ok: true, url: sessionA.url, orderId: orderRefA.id, plan: 'azienda', amountChf: 299 } };
  }

  // Authoritative unit count: read the publisher's own jobs, sum distinct locations.
  let units = 0;
  const verifiedJobIds = [];
  let jobSnaps;
  try {
    const jobRefs = jobIds.map(jobId => db().collection('publisher_jobs').doc(String(jobId)));
    jobSnaps = await db().getAll(...jobRefs);
  } catch (err) {
    console.error('[createPublisherCheckout] batch job lookup failed', err instanceof Error ? err.message : String(err));
    return { status: 503, body: { ok: false, error: 'job_lookup_failed' } };
  }
  for (const snap of jobSnaps) {
    if (!snap.exists) continue;
    const job = snap.data();
    if (job.publisherUid !== uid) {
      return { status: 403, body: { ok: false, error: 'not_owner' } };
    }
    units += countDistinctLocations(job.locations);
    verifiedJobIds.push(snap.id);
  }
  if (units <= 0) return { status: 400, body: { ok: false, error: 'no_billable_units' } };

  const rate = discountRateForUnits(units);
  const netChf = netChfForUnits(units);

  const priceId = await getRemoteConfigValue('STRIPE_PRICE_AD_UNIT');
  if (!priceId) return { status: 500, body: { ok: false, error: 'price_not_configured' } };

  const stripe = await getStripe();
  await ensureProductTaxCode(stripe, priceId, 'txcd_20000000');

  // Reuse the publisher's Stripe customer if we have one.
  const pubRef = db().collection('publishers').doc(uid);
  const pubSnap = await pubRef.get();
  let customerId = pubSnap.exists ? pubSnap.data().stripeCustomerId : undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: decoded.email || undefined,
      metadata: { publisherUid: uid },
    });
    customerId = customer.id;
    await pubRef.set({ stripeCustomerId: customerId, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }

  const couponId = await ensureVolumeCoupon(stripe, rate);

  // Order doc first (status created) so the webhook can correlate by session id.
  const orderRef = db().collection('orders').doc();
  await orderRef.set({
    publisherUid: uid,
    jobIds: verifiedJobIds,
    units,
    amountChf: netChf,
    discountRate: rate,
    currency: 'CHF',
    status: 'created',
    stripeCustomerId: customerId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: units }],
    discounts: couponId ? [{ coupon: couponId }] : undefined,
    managed_payments: { enabled: true },
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: orderRef.id,
    metadata: { orderId: orderRef.id, publisherUid: uid, units: String(units) },
    subscription_data: { metadata: { orderId: orderRef.id, publisherUid: uid } },
  });

  await orderRef.update({
    stripeCheckoutSessionId: session.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Mark the jobs as awaiting payment (still not public). `pendingPaymentAt`
  // anchors the stale-checkout reaper (reapStalePendingPayments): if the publisher
  // abandons Stripe, the ad is reverted to 'draft' instead of being stuck forever.
  const batch = db().batch();
  for (const jobId of verifiedJobIds) {
    batch.update(db().collection('publisher_jobs').doc(jobId), {
      status: 'pending_payment',
      orderId: orderRef.id,
      pendingPaymentAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();

  return { status: 200, body: { ok: true, url: session.url, orderId: orderRef.id, units, amountChf: netChf } };
}

// ── createBillingPortal ─────────────────────────────────────────────────────
// Self-serve subscription management (cancel, update payment method, invoices)
// via Stripe's hosted Billing Portal. Authenticated; uses the publisher's
// stored Stripe customer.
export async function handleCreateBillingPortal(req) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const decoded = await verifyCaller(req);
  if (!decoded) return { status: 401, body: { ok: false, error: 'unauthenticated' } };

  const returnUrl = String((req.body || {}).returnUrl || '');
  if (!/^https?:\/\//.test(returnUrl)) return { status: 400, body: { ok: false, error: 'invalid_return_url' } };

  const pubSnap = await db().collection('publishers').doc(decoded.uid).get();
  const customerId = pubSnap.exists ? pubSnap.data().stripeCustomerId : null;
  if (!customerId) return { status: 400, body: { ok: false, error: 'no_customer' } };

  const stripe = await getStripe();
  const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  return { status: 200, body: { ok: true, url: session.url } };
}

// ── archivePublisherAd ──────────────────────────────────────────────────────
// Publisher-initiated archive of one of their own ads. The ad leaves the live
// slice (status → 'archived', which is NOT in LIVE_JOB_STATUSES) but the Stripe
// subscription is intentionally LEFT ACTIVE: the publisher paid for a slot and
// can reuse it for a new ad. We detach the ad from its order's `jobIds` so the
// renewal webhook (`invoice.paid` → setJobsStatus(order.jobIds, 'paid')) can
// never resurrect an archived ad. Stripe is never touched here.
export async function handleArchivePublisherAd(req) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const decoded = await verifyCaller(req);
  if (!decoded) return { status: 401, body: { ok: false, error: 'unauthenticated' } };

  const jobId = String((req.body || {}).jobId || '');
  if (!jobId) return { status: 400, body: { ok: false, error: 'no_job' } };

  const jobRef = db().collection('publisher_jobs').doc(jobId);
  const snap = await jobRef.get();
  if (!snap.exists) return { status: 404, body: { ok: false, error: 'not_found' } };
  const job = snap.data();
  if (job.publisherUid !== decoded.uid) return { status: 403, body: { ok: false, error: 'not_owner' } };

  const ts = admin.firestore.FieldValue.serverTimestamp();
  await jobRef.set({ status: 'archived', archivedAt: ts, updatedAt: ts }, { merge: true });

  // Detach from the order so renewal never re-flips it to 'paid'. Best-effort:
  // free-tier ads have no order; a missing order is not an error.
  const orderId = job.orderId ? String(job.orderId) : null;
  if (orderId) {
    try {
      await db().collection('orders').doc(orderId).update({
        jobIds: admin.firestore.FieldValue.arrayRemove(jobId),
        updatedAt: ts,
      });
    } catch (error) {
      console.error('[archivePublisherAd] order detach failed', error instanceof Error ? error.message : String(error));
    }
  }

  return { status: 200, body: { ok: true } };
}

// ── restorePublisherAd ──────────────────────────────────────────────────────
// Inverse of archive: bring an archived ad back. The destination status depends
// on whether the publisher still has a live billing relationship:
//   free                      → 'published' (re-enters the slice, no payment)
//   sponsored + active sub    → 'paid'  (re-attached to the order; no new charge —
//                               reuses the slot the publisher kept paying for)
//   sponsored + dead/no sub   → 'draft' (must run a fresh checkout to go live)
// Symmetric to handleArchivePublisherAd (which detached the ad from order.jobIds).
const LIVE_SUB_STATUSES = new Set(['active', 'trialing', 'past_due']);

export async function handleRestorePublisherAd(req) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const decoded = await verifyCaller(req);
  if (!decoded) return { status: 401, body: { ok: false, error: 'unauthenticated' } };

  const jobId = String((req.body || {}).jobId || '');
  if (!jobId) return { status: 400, body: { ok: false, error: 'no_job' } };

  const jobRef = db().collection('publisher_jobs').doc(jobId);
  const snap = await jobRef.get();
  if (!snap.exists) return { status: 404, body: { ok: false, error: 'not_found' } };
  const job = snap.data();
  if (job.publisherUid !== decoded.uid) return { status: 403, body: { ok: false, error: 'not_owner' } };
  if (job.status !== 'archived') return { status: 409, body: { ok: false, error: 'not_archived' } };

  const ts = admin.firestore.FieldValue.serverTimestamp();

  // Free tier: no billing — just re-list it. (Anti-spam cap is a create-time
  // trigger; a restore is an update, so an already-known ad is not re-capped.)
  if (job.tier === 'free') {
    await jobRef.set({ status: 'published', archivedAt: null, updatedAt: ts }, { merge: true });
    return { status: 200, body: { ok: true, status: 'published' } };
  }

  // Sponsored: re-list under the still-active subscription if there is one.
  const orderId = job.orderId ? String(job.orderId) : null;
  let subscriptionId = null;
  let orderRef = null;
  if (orderId) {
    orderRef = db().collection('orders').doc(orderId);
    const orderSnap = await orderRef.get();
    if (orderSnap.exists) subscriptionId = orderSnap.data().stripeSubscriptionId || null;
  }

  let subLive = false;
  if (subscriptionId) {
    try {
      const stripe = await getStripe();
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      subLive = LIVE_SUB_STATUSES.has(sub?.status);
    } catch (error) {
      // Best-effort: if Stripe is unreachable, fall back to the safe 'draft' path
      // (publisher can re-checkout) rather than resurrecting an unverified ad.
      console.error('[restorePublisherAd] subscription lookup failed', error instanceof Error ? error.message : String(error));
    }
  }

  if (subLive) {
    // Re-attach to the order so renewals keep it live, then flip back to paid.
    if (orderRef) {
      try {
        await orderRef.update({ jobIds: admin.firestore.FieldValue.arrayUnion(jobId), updatedAt: ts });
      } catch (error) {
        console.error('[restorePublisherAd] order re-attach failed', error instanceof Error ? error.message : String(error));
      }
    }
    await jobRef.set({ status: 'paid', paidAt: ts, archivedAt: null, subscriptionId, updatedAt: ts }, { merge: true });
    try {
      await storeRenewal(await getStripe(), subscriptionId, [jobId], orderId);
    } catch { /* non-fatal: renewal date is best-effort */ }
    return { status: 200, body: { ok: true, status: 'paid' } };
  }

  // No live subscription → back to draft; the publisher must run a new checkout.
  await jobRef.set({ status: 'draft', archivedAt: null, updatedAt: ts }, { merge: true });
  return { status: 200, body: { ok: true, status: 'draft' } };
}

// ── stripeWebhook ───────────────────────────────────────────────────────────

async function setJobsStatus(jobIds, status, extra = {}) {
  if (!Array.isArray(jobIds) || !jobIds.length) return;
  const batch = db().batch();
  for (const jobId of jobIds) {
    batch.set(
      db().collection('publisher_jobs').doc(String(jobId)),
      { status, updatedAt: admin.firestore.FieldValue.serverTimestamp(), ...extra },
      { merge: true },
    );
  }
  await batch.commit();
}

// Best-effort "your ad is live" confirmation to the publisher after payment.
// The Stripe receipt/invoice is sent separately by Stripe.
async function sendPublisherConfirmation(publisherUid, jobCount) {
  try {
    const pubSnap = await db().collection('publishers').doc(String(publisherUid)).get();
    const to = pubSnap.exists ? pubSnap.data().email : null;
    if (!to) return;
    // Cascade-routed (2026-07-16, was a direct Resend client) — pacing +
    // fallback if Resend alone is exhausted. Cloud Functions source secrets
    // async via Remote Config; the cascade reads sync process.env.*, so the
    // bridge must run first. Stays inside this function's own try/catch —
    // never gates the Stripe webhook's 200 response.
    await bridgeEmailCascadeCredentialsToEnv();
    await sendEmailCascade([{
      payload: {
        from: 'Frontaliere Ticino <confirmation@frontaliereticino.ch>',
        to,
        subject: 'Pagamento confermato — il tuo annuncio sta per andare online',
        html:
          `<h2>Grazie, pagamento confermato</h2>` +
          `<p>${jobCount > 1 ? 'I tuoi annunci saranno online' : 'Il tuo annuncio sarà online'} entro 1–2 ore con pagina SEO dedicata.</p>` +
          `<p>Gestisci gli annunci e vedi le candidature dalla tua dashboard: ` +
          `<a href="https://frontaliereticino.ch/i-miei-annunci/">I miei annunci</a>.</p>` +
          `<p style="font-size:12px;color:#666">La ricevuta/fattura ti arriva separatamente da Stripe. Abbonamento rinnovato ogni 30 giorni; disdici quando vuoi dalla dashboard.</p>`,
      },
      recipient: { email: to },
      meta: {},
    }]);
  } catch {
    // non-fatal
  }
}

/**
 * Persist the subscription's next renewal date onto the order + each job, so the
 * dashboard can surface "renews in N days" and the daily reminder CF can query it.
 * Non-fatal: any failure (Stripe lookup, missing period) is swallowed by the caller.
 *
 * @param {import('stripe').Stripe} stripe
 * @param {string} subscriptionId  Stripe subscription id
 * @param {string[]} jobIds        publisher_jobs ids on the order
 * @param {string} orderRef        order doc id
 */
async function storeRenewal(stripe, subscriptionId, jobIds, orderRef) {
  if (!subscriptionId) return;
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const periodEnd = sub?.current_period_end; // unix seconds
  if (!periodEnd) return;
  const renewsAt = admin.firestore.Timestamp.fromMillis(periodEnd * 1000);
  const ts = admin.firestore.FieldValue.serverTimestamp();
  if (orderRef) {
    await db().collection('orders').doc(String(orderRef)).set({ renewsAt, updatedAt: ts }, { merge: true });
  }
  if (Array.isArray(jobIds) && jobIds.length) {
    const batch = db().batch();
    for (const jobId of jobIds) {
      batch.set(
        db().collection('publisher_jobs').doc(String(jobId)),
        { renewsAt, updatedAt: ts },
        { merge: true },
      );
    }
    await batch.commit();
  }
}

async function orderByStripeRef({ sessionId, subscriptionId, orderId }) {
  const col = db().collection('orders');
  if (orderId) {
    const s = await col.doc(orderId).get();
    if (s.exists) return s;
  }
  if (sessionId) {
    const q = await col.where('stripeCheckoutSessionId', '==', sessionId).limit(1).get();
    if (!q.empty) return q.docs[0];
  }
  if (subscriptionId) {
    const q = await col.where('stripeSubscriptionId', '==', subscriptionId).limit(1).get();
    if (!q.empty) return q.docs[0];
  }
  return null;
}

export async function handleStripeWebhook(req) {
  const secret = await getRemoteConfigValue('STRIPE_WEBHOOK_SECRET');
  if (!secret) return { status: 500, body: { ok: false, error: 'webhook_secret_missing' } };

  const stripe = await getStripe();
  const sig = req.get('stripe-signature');
  let event;
  try {
    // req.rawBody is provided by Firebase Functions; required for signature checks.
    event = stripe.webhooks.constructEvent(req.rawBody, sig, secret);
  } catch (err) {
    return { status: 400, body: { ok: false, error: `signature_verification_failed` } };
  }

  // Idempotency: Stripe redelivers events. Record-then-skip on the event id so a
  // replay can't double-apply (e.g. re-flip an expired ad back to paid).
  const eventRef = db().collection('stripe_events').doc(event.id);
  const seen = await eventRef.get();
  if (seen.exists) return { status: 200, body: { received: true, duplicate: true } };

  const obj = event.data?.object || {};
  const ts = admin.firestore.FieldValue.serverTimestamp();

  // Reader no-ads subscription events (#3655, part 2/2 of #2961) are a fully
  // separate domain (reader_subscriptions collection, no publisher_jobs/orders
  // involvement), dispatched from its own sibling module. Dynamic import keeps
  // this a lazy load (matching the `await import('stripe')` convention above)
  // and avoids a static circular import — stripeReaderCore.js imports
  // verifyCaller/getStripe/db back from THIS file. Short-circuits (returns
  // early) so the publisher switch below never double-processes the same event.
  const { handleReaderWebhookEvent } = await import('./stripeReaderCore.js');
  if (await handleReaderWebhookEvent(event, { db, ts })) {
    await eventRef.set({ type: event.type, processedAt: ts });
    return { status: 200, body: { received: true } };
  }

  // Sub-statuses that mean the ad must come down.
  const DEAD_SUB_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

  async function expireBySubscription(subscriptionId) {
    if (!subscriptionId) return;
    const orderSnap = await orderByStripeRef({ subscriptionId });
    if (orderSnap) {
      const o = orderSnap.data();
      await orderSnap.ref.update({ status: 'canceled', updatedAt: ts });
      await setJobsStatus(o.jobIds, 'expired');
      if (o.plan === 'azienda') {
        // Subscription gone → publisher is no longer on the azienda plan. Revert
        // to 'free' (safe default: never grants paid placement without an active
        // sub). Per-ad sponsored ads keep their own job-level tier, untouched;
        // expired ads stay expired.
        await db().collection('publishers').doc(o.publisherUid).set(
          { tier: 'free', updatedAt: ts }, { merge: true },
        );
      }
    }
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const orderId = obj.metadata?.orderId || obj.client_reference_id;
      const orderSnap = await orderByStripeRef({ sessionId: obj.id, orderId });
      if (orderSnap) {
        const order = orderSnap.data();
        await orderSnap.ref.update({
          status: 'active',
          stripeSubscriptionId: obj.subscription || null,
          updatedAt: ts,
        });
        await setJobsStatus(order.jobIds, 'paid', { paidAt: ts, subscriptionId: obj.subscription || null });
        if (order.plan === 'azienda') {
          // Flag the publisher as azienda — the dashboard reflects the active plan
          // and future ads can inherit the tier. The ads themselves already carry
          // tier='azienda' (set at checkout); the projection features them all.
          await db().collection('publishers').doc(order.publisherUid).set(
            { tier: 'azienda', updatedAt: ts }, { merge: true },
          );
        }
        try {
          await storeRenewal(stripe, obj.subscription, order.jobIds, orderSnap.id);
        } catch { /* non-fatal: renewal date is best-effort */ }
        await sendPublisherConfirmation(order.publisherUid, (order.jobIds || []).length);
      }
      break;
    }
    case 'checkout.session.expired': {
      // The publisher opened checkout but never paid; Stripe expired the session
      // (default 24h). Cancel the dangling order and free the ad from the dead-end
      // 'pending_payment' state so it can be edited / re-submitted. Guarded: only
      // jobs still pending are touched (a completed/archived one is left alone).
      const orderId = obj.metadata?.orderId || obj.client_reference_id;
      const orderSnap = await orderByStripeRef({ sessionId: obj.id, orderId });
      if (orderSnap) {
        await orderSnap.ref.update({ status: 'canceled', updatedAt: ts });
        await revertPendingJobsToDraft(orderSnap.data().jobIds);
      }
      break;
    }
    case 'invoice.paid': {
      // Renewal succeeded — keep jobs paid (idempotent).
      const orderSnap = await orderByStripeRef({ subscriptionId: obj.subscription });
      if (orderSnap) {
        await orderSnap.ref.update({ status: 'active', updatedAt: ts });
        await setJobsStatus(orderSnap.data().jobIds, 'paid');
        try {
          await storeRenewal(stripe, obj.subscription, orderSnap.data().jobIds, orderSnap.id);
        } catch { /* non-fatal: renewal date is best-effort */ }
      }
      break;
    }
    case 'invoice.payment_failed': {
      const orderSnap = await orderByStripeRef({ subscriptionId: obj.subscription });
      if (orderSnap) await orderSnap.ref.update({ status: 'past_due', updatedAt: ts });
      break;
    }
    case 'customer.subscription.updated': {
      // Stripe cancels a non-paying subscription after dunning → status flips to
      // canceled/unpaid here (no separate 'deleted' for some configs).
      if (DEAD_SUB_STATUSES.has(obj.status)) await expireBySubscription(obj.id);
      break;
    }
    case 'customer.subscription.deleted':
    case 'customer.subscription.canceled': {
      await expireBySubscription(obj.id);
      break;
    }
    case 'charge.refunded': {
      // A refunded charge → bring the ad down. Resolve subscription via the invoice.
      let subscriptionId = null;
      if (obj.invoice) {
        try {
          const inv = await stripe.invoices.retrieve(obj.invoice);
          subscriptionId = inv.subscription || null;
        } catch { /* best-effort */ }
      }
      await expireBySubscription(subscriptionId);
      break;
    }
    default:
      break; // ignore unrelated events
  }

  // Mark processed (after handling, so a crash mid-handle re-runs rather than silently skips).
  await eventRef.set({ type: event.type, processedAt: ts });
  return { status: 200, body: { received: true } };
}
