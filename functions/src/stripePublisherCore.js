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
 *
 * Pricing is RECOMPUTED here server-side from the publisher_jobs the order references
 * — the client amount is never trusted. The unit price + discount tiers MUST stay in
 * sync with services/publisherPricing.ts (deploy-boundary duplication: the functions
 * bundle is isolated and cannot import the SPA TS module). See PUBLISHER-PORTAL-PLAN §6.2.
 */

import admin from 'firebase-admin';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';
import {
  discountRateForUnits,
  countDistinctLocations,
  netChfForUnits,
} from './publisherPricingMirror.js';

// ── Stripe client (lazy, cached) ────────────────────────────────────────────
let _stripe = null;
async function getStripe() {
  if (_stripe) return _stripe;
  const key = await getRemoteConfigValue('STRIPE_SECRET_KEY');
  if (!key) throw new Error('stripe_secret_key_missing');
  const { default: Stripe } = await import('stripe');
  _stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  return _stripe;
}

function db() {
  return admin.firestore();
}

async function verifyCaller(req) {
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

  // Authoritative unit count: read the publisher's own jobs, sum distinct locations.
  let units = 0;
  const verifiedJobIds = [];
  for (const jobId of jobIds) {
    const snap = await db().collection('publisher_jobs').doc(String(jobId)).get();
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

  // Mark the jobs as awaiting payment (still not public).
  const batch = db().batch();
  for (const jobId of verifiedJobIds) {
    batch.update(db().collection('publisher_jobs').doc(jobId), {
      status: 'pending_payment',
      orderId: orderRef.id,
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
    const resendApiKey = await getRemoteConfigValue('RESEND_API_KEY');
    if (!resendApiKey) return;
    const { Resend } = await import('resend');
    const resend = new Resend(resendApiKey);
    await resend.emails.send({
      from: 'Frontaliere Ticino <confirmation@frontaliereticino.ch>',
      to,
      subject: 'Pagamento confermato — il tuo annuncio sta per andare online',
      html:
        `<h2>Grazie, pagamento confermato</h2>` +
        `<p>${jobCount > 1 ? 'I tuoi annunci saranno online' : 'Il tuo annuncio sarà online'} entro 1–2 ore con pagina SEO dedicata.</p>` +
        `<p>Gestisci gli annunci e vedi le candidature dalla tua dashboard: ` +
        `<a href="https://frontaliereticino.ch/i-miei-annunci/">I miei annunci</a>.</p>` +
        `<p style="font-size:12px;color:#666">La ricevuta/fattura ti arriva separatamente da Stripe. Abbonamento rinnovato ogni 30 giorni; disdici quando vuoi dalla dashboard.</p>`,
    });
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

  // Sub-statuses that mean the ad must come down.
  const DEAD_SUB_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

  async function expireBySubscription(subscriptionId) {
    if (!subscriptionId) return;
    const orderSnap = await orderByStripeRef({ subscriptionId });
    if (orderSnap) {
      await orderSnap.ref.update({ status: 'canceled', updatedAt: ts });
      await setJobsStatus(orderSnap.data().jobIds, 'expired');
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
        try {
          await storeRenewal(stripe, obj.subscription, order.jobIds, orderSnap.id);
        } catch { /* non-fatal: renewal date is best-effort */ }
        await sendPublisherConfirmation(order.publisherUid, (order.jobIds || []).length);
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
