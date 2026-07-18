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
  AZIENDA_PLAN_CHF,
} from './publisherPricingMirror.js';
// Guarded revert of abandoned-checkout ads (shared with the daily reaper CF).
// Lives in the reap module so this file's `import('stripe')` never has to load
// when the reaper (or its unit test) runs.
import { revertPendingJobsToDraft } from './publisherPendingReapCore.js';
// Reused for attachPublisherJob's server-side reCAPTCHA check (PUBLISH_JOB
// action) — same mechanism handleRecaptchaVerification/createFeedbackIssue
// already use, so no new verification helper is introduced.
import { createAssessment } from './recaptchaVerification.js';
// Reused for attachPublisherJob's best-effort publisher-jobs-sync dispatch —
// same PAT + owner/repo resolution githubProxy.js already exports (single
// source, avoids duplicating the Remote Config read construct).
import { getRepoConfig, GITHUB_API } from './githubProxy.js';
import { githubApiHeaders } from './githubApiHeaders.js';
// Pragmatic email shape check (server-side) — single source of truth shared
// with adminEmployerInsights.js, journalistRoleCore.js and
// newsletterSubscriberAuthSync.js (AGENTS.md sibling-pattern rule: this
// literal regex was duplicated in 3 files already; consolidated here rather
// than adding a 4th copy for attachPublisherJob's apply.email validation).
import { EMAIL_RE } from './lib/emailValidation.js';

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

// Sum distinct-location billable units across a list of ad-like objects.
// LEGACY-ONLY since 2026-07-18: used by the per-jobIds checkout path below
// (in-flight sessions from before the pay-first rollout billed per
// location). The prepaid/pay-first funnel bills PER AD — see
// countBillableAds — per owner decision 2026-07-18 (unit = the ad,
// locations don't change the price).
function sumDistinctLocationUnits(items) {
  return items.reduce((total, item) => total + countDistinctLocations(item?.locations), 0);
}

// Billable units for the pay-first funnel: 1 per ad with at least one real
// location (mirrors countAdUnits in services/publisherPricing.ts — keep the
// two in sync across the deploy boundary).
function countBillableAds(items) {
  return items.reduce((total, item) => total + (countDistinctLocations(item?.locations) > 0 ? 1 : 0), 0);
}

// ── createPublisherCheckout ─────────────────────────────────────────────────

/**
 * Prepaid credits (pay-first funnel): buy N ad-unit credits, or the flat
 * Piano Azienda subscription, with NO jobIds yet — attachPublisherJob spends
 * the credits once the ad content exists. Mirrors the per-jobIds branches
 * below (same customer/coupon/tax-code plumbing, same order-doc shape) but
 * skips the ownership check (there are no jobs yet) and never touches
 * publisher_jobs — no ad exists to flip to 'pending_payment'.
 */
async function handlePrepaidCheckout(decoded, uid, body) {
  const successUrl = String(body.successUrl || '');
  const cancelUrl = String(body.cancelUrl || '');
  if (!/^https?:\/\//.test(successUrl) || !/^https?:\/\//.test(cancelUrl)) {
    return { status: 400, body: { ok: false, error: 'invalid_redirect_urls' } };
  }

  const stripe = await getStripe();
  const pubRef = db().collection('publishers').doc(uid);
  const pubSnap = await pubRef.get();
  let customerId = pubSnap.exists ? pubSnap.data().stripeCustomerId : undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: decoded.email || undefined, metadata: { publisherUid: uid } });
    customerId = customer.id;
    await pubRef.set({ stripeCustomerId: customerId, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }

  // ── Piano Azienda prepaid: flat AZIENDA_PLAN_CHF, illimitato (unitsPurchased: null). ──
  if (body.plan === 'azienda') {
    const aziendaPrice = await getRemoteConfigValue('STRIPE_PRICE_AZIENDA');
    if (!aziendaPrice) return { status: 500, body: { ok: false, error: 'azienda_price_not_configured' } };

    const orderRef = db().collection('orders').doc();
    await orderRef.set({
      publisherUid: uid, jobIds: [], plan: 'azienda', units: null,
      prepaid: true, unitsPurchased: null, unitsUsed: 0,
      amountChf: AZIENDA_PLAN_CHF, currency: 'CHF', status: 'created', stripeCustomerId: customerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription', customer: customerId,
      line_items: [{ price: aziendaPrice, quantity: 1 }],
      success_url: successUrl, cancel_url: cancelUrl,
      client_reference_id: orderRef.id,
      metadata: { orderId: orderRef.id, publisherUid: uid, plan: 'azienda', prepaid: '1' },
      subscription_data: { metadata: { orderId: orderRef.id, publisherUid: uid, plan: 'azienda', prepaid: '1' } },
    });
    await orderRef.update({ stripeCheckoutSessionId: session.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    return { status: 200, body: { ok: true, url: session.url, orderId: orderRef.id, plan: 'azienda', amountChf: AZIENDA_PLAN_CHF } };
  }

  // ── Prepaid ad-unit credits ──
  const units = Number(body.units);
  if (!Number.isInteger(units) || units < 1 || units > 50) {
    return { status: 400, body: { ok: false, error: 'invalid_units' } };
  }

  const rate = discountRateForUnits(units);
  const netChf = netChfForUnits(units);

  const priceId = await getRemoteConfigValue('STRIPE_PRICE_AD_UNIT');
  if (!priceId) return { status: 500, body: { ok: false, error: 'price_not_configured' } };

  await ensureProductTaxCode(stripe, priceId, 'txcd_20000000');
  const couponId = await ensureVolumeCoupon(stripe, rate);

  const orderRef = db().collection('orders').doc();
  await orderRef.set({
    publisherUid: uid,
    jobIds: [],
    units,
    prepaid: true,
    unitsPurchased: units,
    unitsUsed: 0,
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
    metadata: { orderId: orderRef.id, publisherUid: uid, units: String(units), prepaid: '1' },
    subscription_data: { metadata: { orderId: orderRef.id, publisherUid: uid, prepaid: '1' } },
  });

  await orderRef.update({
    stripeCheckoutSessionId: session.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { status: 200, body: { ok: true, url: session.url, orderId: orderRef.id, units, amountChf: netChf } };
}

export async function handleCreatePublisherCheckout(req) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

  const decoded = await verifyCaller(req);
  if (!decoded) return { status: 401, body: { ok: false, error: 'unauthenticated' } };
  const uid = decoded.uid;

  const body = req.body || {};

  // ── Prepaid credits (pay-first funnel) ── fully separate early branch, no
  // jobIds required. The legacy per-jobIds path below (still used by in-flight
  // sessions from before this rollout) is left completely untouched.
  if (body.prepaid === true) {
    return handlePrepaidCheckout(decoded, uid, body);
  }

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
      amountChf: AZIENDA_PLAN_CHF, currency: 'CHF', status: 'created', stripeCustomerId: customerIdA,
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

    return { status: 200, body: { ok: true, url: sessionA.url, orderId: orderRefA.id, plan: 'azienda', amountChf: AZIENDA_PLAN_CHF } };
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

// ── attachPublisherJob ──────────────────────────────────────────────────────
// Pay-first funnel: spend prepaid ad-unit credits (or the unlimited azienda
// plan) to create publisher_jobs docs directly as 'paid' — the Stripe
// checkout already happened via handlePrepaidCheckout above, so this endpoint
// only needs auth + an active prepaid order with enough residual units. The
// created docs use the SAME shape the client used to write via addDoc (see
// PublisherPublishPage.tsx handleSubmit) so the dashboard/edit/projection
// pipeline keeps working unchanged.

// Mirrors scripts/lib/publisherJobProjection.mjs' MIN_DESCRIPTION_WORDS /
// wordCount — duplicated here (not imported) for the same deploy-boundary
// reason publisherPricingMirror.js documents at the top of this file: the
// functions bundle is isolated and cannot import scripts/. Keep both ends of
// this gate at 50 words if either changes.
const ATTACH_MIN_DESCRIPTION_WORDS = 50;
const ATTACH_MAX_ADS = 10;
const ATTACH_RECAPTCHA_THRESHOLD = 0.5; // mirrors ACTION_THRESHOLDS.PUBLISH_JOB in recaptchaVerification.js

function attachWordCount(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

/** @returns {string|null} validation error message, or null if the ad is valid. */
function validateAttachAd(ad, index) {
  if (!ad || typeof ad !== 'object') return `ad[${index}]: invalid`;
  if (!String(ad.title || '').trim()) return `ad[${index}]: missing_title`;
  if (attachWordCount(ad.description) < ATTACH_MIN_DESCRIPTION_WORDS) return `ad[${index}]: description_too_short`;
  if (!String(ad.company?.name || '').trim()) return `ad[${index}]: missing_company_name`;
  if (countDistinctLocations(ad.locations) < 1) return `ad[${index}]: missing_location`;
  const apply = ad.apply || {};
  if (apply.mode === 'external_url') {
    if (!/^https?:\/\//.test(String(apply.url || ''))) return `ad[${index}]: invalid_apply_url`;
  } else if (apply.mode === 'forward_email' || apply.mode === 'in_house') {
    if (!EMAIL_RE.test(String(apply.email || '').trim())) return `ad[${index}]: invalid_apply_email`;
  } else {
    return `ad[${index}]: invalid_apply_mode`;
  }
  return null;
}

function validateAttachAds(ads) {
  for (let i = 0; i < ads.length; i += 1) {
    const err = validateAttachAd(ads[i], i);
    if (err) return err;
  }
  return null;
}

/**
 * Build a publisher_jobs doc from a submitted ad — same shape as the client's
 * addDoc call in PublisherPublishPage.tsx, plus the server-owned fields
 * (publisherUid, status, paidAt, orderId, stripeSubscriptionId). `tier` is
 * derived from the CLAIMED ORDER (never trusted from the ad body) — the same
 * "client amount/identity is never trusted" boundary this file already
 * applies to pricing and publisherUid.
 */
function buildAttachedJobDoc(ad, { uid, orderRef, order, tier, ts }) {
  const rawCompany = ad.company || {};
  const company = {
    name: String(rawCompany.name || '').trim(),
    legalForm: rawCompany.legalForm || 'ditta_individuale',
    ...(String(rawCompany.domain || '').trim() ? { domain: String(rawCompany.domain).trim() } : {}),
    ...(String(rawCompany.logoUrl || '').trim() ? { logoUrl: String(rawCompany.logoUrl).trim() } : {}),
  };
  const apply = ad.apply || {};
  // Description arrives already plain/markdown-split client-side for the
  // legacy addDoc path; here the client sends whatever it has — mirror the
  // same split so descriptionMd only persists a genuinely different markdown
  // source (tier is never 'free' on this path — prepaid credits are
  // sponsored/azienda only).
  const plainDesc = String(ad.description || '').trim();
  const mdDesc = String(ad.descriptionMd || '').trim() || null;

  return {
    publisherUid: uid,
    tier,
    status: 'paid',
    paidAt: ts,
    orderId: orderRef.id,
    ...(order.stripeSubscriptionId ? { stripeSubscriptionId: order.stripeSubscriptionId } : {}),
    title: String(ad.title || '').trim(),
    description: plainDesc,
    ...(mdDesc ? { descriptionMd: mdDesc } : {}),
    sourceLang: 'it',
    company,
    locations: Array.isArray(ad.locations) ? ad.locations : [],
    employmentType: ad.employmentType || 'FULL_TIME',
    ...(String(ad.category || '').trim() ? { category: String(ad.category).trim() } : {}),
    ...(String(ad.sector || '').trim() ? { sector: String(ad.sector).trim() } : {}),
    ...(String(ad.contractType || '').trim() ? { contractType: String(ad.contractType).trim() } : {}),
    ...(Number.isFinite(Number(ad.salaryMin)) ? { salaryMin: Number(ad.salaryMin) } : {}),
    ...(Number.isFinite(Number(ad.salaryMax)) ? { salaryMax: Number(ad.salaryMax) } : {}),
    // Featured is a sponsored-only benefit; azienda ads are always featured
    // via the projection (publisherJobToRecords), regardless of this flag.
    featured: Boolean(ad.featured),
    currency: 'CHF',
    apply: {
      mode: apply.mode,
      ...(apply.mode === 'external_url' ? { url: String(apply.url || '').trim() } : {}),
      ...(apply.mode === 'forward_email' || apply.mode === 'in_house' ? { email: String(apply.email || '').trim() } : {}),
      ...(String(apply.privacyPolicyUrl || '').trim() ? { privacyPolicyUrl: String(apply.privacyPolicyUrl).trim() } : {}),
    },
    createdAt: ts,
    updatedAt: ts,
  };
}

class AttachClaimError extends Error {
  constructor(code, remaining = null) {
    super(code);
    this.code = code;
    this.remaining = remaining;
  }
}

/**
 * Best-effort: nudge publisher-jobs-sync.yml to run immediately instead of
 * waiting for its 30-min cron, so a prepaid ad goes live faster. Reuses the
 * same GITHUB_PAT (+ owner/repo) Remote Config read as githubProxy.js — see
 * getRepoConfig import above. Throws on failure; the caller swallows it (the
 * cron is the safety net, this is pure latency reduction).
 */
async function dispatchPublisherSync() {
  const { pat, owner, repo } = await getRepoConfig();
  if (!pat) {
    throw new Error('github_pat_not_configured');
  }
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/publisher-jobs-sync.yml/dispatches`, {
    method: 'POST',
    headers: githubApiHeaders(pat, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ref: 'main' }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`dispatch_failed:${res.status}:${text.slice(0, 200)}`);
  }
}

// Best-effort "your ad is being published" email after attachPublisherJob
// spends prepaid credits. Mirrors sendPublisherConfirmation's mechanism (same
// email cascade, same publisher lookup); the copy differs because payment
// already happened at checkout — this confirms content intake instead.
async function sendPublisherAttachedConfirmation(publisherUid, jobCount) {
  try {
    const pubSnap = await db().collection('publishers').doc(String(publisherUid)).get();
    const to = pubSnap.exists ? pubSnap.data().email : null;
    if (!to) return;
    await bridgeEmailCascadeCredentialsToEnv();
    await sendEmailCascade([{
      payload: {
        from: 'Frontaliere Ticino <confirmation@frontaliereticino.ch>',
        to,
        subject: 'Il tuo annuncio è in pubblicazione',
        html:
          `<h2>Annuncio ricevuto</h2>` +
          `<p>${jobCount > 1 ? 'I tuoi annunci sono' : 'Il tuo annuncio è'} in pubblicazione, online di norma entro un'ora con pagina SEO dedicata.</p>` +
          `<p>Gestisci gli annunci e vedi le candidature dalla tua dashboard: ` +
          `<a href="https://frontaliereticino.ch/i-miei-annunci/">I miei annunci</a>.</p>`,
      },
      recipient: { email: to },
      meta: {},
    }]);
  } catch {
    // non-fatal
  }
}

export async function handleAttachPublisherJob(req) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

  const decoded = await verifyCaller(req);
  if (!decoded) return { status: 401, body: { ok: false, error: 'unauthenticated' } };
  const uid = decoded.uid;

  const body = req.body || {};
  const ads = Array.isArray(body.ads) ? body.ads : [];
  if (!ads.length || ads.length > ATTACH_MAX_ADS) {
    return { status: 400, body: { ok: false, error: 'validation', message: 'ads_count' } };
  }

  const validationError = validateAttachAds(ads);
  if (validationError) {
    return { status: 400, body: { ok: false, error: 'validation', message: validationError } };
  }

  // Server-side reCAPTCHA (reused mechanism — see createAssessment import
  // above). Security here is auth + an active paid order; the token check is
  // defense-in-depth against scripted abuse of already-purchased credits.
  const token = typeof body.recaptchaToken === 'string' ? body.recaptchaToken.trim() : '';
  if (!token) return { status: 400, body: { ok: false, error: 'missing_recaptcha' } };
  const siteKey = await getRemoteConfigValue('RECAPTCHA_SITE_KEY');
  if (siteKey) {
    const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino';
    const assessment = await createAssessment({ token, expectedAction: 'PUBLISH_JOB', projectId, siteKey });
    if (!assessment.valid || (assessment.score ?? 0) < ATTACH_RECAPTCHA_THRESHOLD) {
      return { status: 403, body: { ok: false, error: 'recaptcha_failed' } };
    }
  }

  // 1 unit = 1 ad (owner decision 2026-07-18) — locations don't affect the
  // spend, so validation already guarantees every ad has ≥1 location.
  const unitsNeeded = countBillableAds(ads);
  if (unitsNeeded <= 0) {
    return { status: 400, body: { ok: false, error: 'validation', message: 'no_billable_units' } };
  }

  // Find the publisher's active prepaid orders (plain equality filters — no
  // composite index required). Re-read + claimed atomically in the
  // transaction below, so a race against a concurrent attach call just fails
  // the transaction's residual check rather than double-spending units.
  const ordersSnap = await db().collection('orders')
    .where('publisherUid', '==', uid)
    .where('status', '==', 'active')
    .where('prepaid', '==', true)
    .get();

  if (ordersSnap.empty) {
    return { status: 402, body: { ok: false, error: 'no_credits' } };
  }

  // Prefer an unlimited azienda order; otherwise spend across ALL active
  // prepaid orders (the frontend sums residuals order-wide — sumRemainingUnits
  // in services/publisherPricing.ts — so a publisher who bought 2+3 credits in
  // two checkouts can attach a 5-ad cart). Each AD costs exactly 1 unit and is
  // assigned whole to ONE order, so every job doc keeps a single
  // orderId/stripeSubscriptionId and expireBySubscription stays unambiguous;
  // with unit=1 per ad, assignment can never fail when the total residual
  // suffices (no packing edge cases).
  const orderRefs = ordersSnap.docs.map((d) => d.ref);
  let newJobIds = [];
  let remainingUnitsAfter = null;

  try {
    await db().runTransaction(async (tx) => {
      // Re-read every candidate order inside the transaction (racing attach
      // calls fail the residual math here instead of double-spending).
      const orderTxSnaps = await Promise.all(orderRefs.map((ref) => tx.get(ref)));
      const liveOrders = orderTxSnaps
        .filter((s) => s.exists)
        .map((s) => ({ ref: s.ref, order: s.data() }))
        .filter(({ order }) => order.status === 'active' && order.prepaid === true);
      if (!liveOrders.length) throw new AttachClaimError('no_credits');

      const ts = admin.firestore.FieldValue.serverTimestamp();
      const unlimitedEntry = liveOrders.find(({ order }) => order.plan === 'azienda' && order.unitsPurchased == null);

      // Per-order mutable residuals + claim buckets for the assignment below.
      const buckets = liveOrders.map((entry) => ({
        ...entry,
        residual: (entry.order.unitsPurchased ?? 0) - (entry.order.unitsUsed ?? 0),
        jobIds: [],
        unitsClaimed: 0,
      }));

      if (!unlimitedEntry) {
        const totalResidual = buckets.reduce((sum, b) => sum + Math.max(0, b.residual), 0);
        if (totalResidual < unitsNeeded) throw new AttachClaimError('insufficient_units', totalResidual);

        // Each ad costs 1 unit: fill the fullest order first (fewer orders
        // touched → fewer subscriptions a given batch depends on).
        for (let i = 0; i < ads.length; i += 1) {
          const bucket = buckets
            .filter((b) => b.residual - b.unitsClaimed >= 1)
            .sort((a, b) => (b.residual - b.unitsClaimed) - (a.residual - a.unitsClaimed))[0];
          if (!bucket) {
            // Unreachable given the totalResidual check above (unit=1), kept
            // as a defensive guard against concurrent mutation mid-loop.
            throw new AttachClaimError('insufficient_units', 0);
          }
          bucket.adIndexes = bucket.adIndexes || [];
          bucket.adIndexes.push(i);
          bucket.unitsClaimed += 1;
        }
      } else {
        // Unlimited azienda plan: everything lands on that order.
        const bucket = buckets.find((b) => b.ref.path === unlimitedEntry.ref.path);
        bucket.adIndexes = ads.map((_, i) => i);
      }

      const jobIdsInAdOrder = new Array(ads.length);
      for (const bucket of buckets) {
        if (!bucket.adIndexes || !bucket.adIndexes.length) continue;
        const tier = bucket.order.plan === 'azienda' ? 'azienda' : 'sponsored';
        for (const i of bucket.adIndexes) {
          const jobRef = db().collection('publisher_jobs').doc();
          tx.set(jobRef, buildAttachedJobDoc(ads[i], { uid, orderRef: bucket.ref, order: bucket.order, tier, ts }));
          bucket.jobIds.push(jobRef.id);
          jobIdsInAdOrder[i] = jobRef.id;
        }
        const orderUpdate = { jobIds: admin.firestore.FieldValue.arrayUnion(...bucket.jobIds), updatedAt: ts };
        if (!unlimitedEntry && bucket.unitsClaimed > 0) {
          orderUpdate.unitsUsed = admin.firestore.FieldValue.increment(bucket.unitsClaimed);
        }
        tx.update(bucket.ref, orderUpdate);
      }

      newJobIds = jobIdsInAdOrder;
      remainingUnitsAfter = unlimitedEntry
        ? null
        : buckets.reduce((sum, b) => sum + Math.max(0, b.residual - b.unitsClaimed), 0);
    });
  } catch (error) {
    if (error instanceof AttachClaimError) {
      if (error.code === 'insufficient_units') {
        return { status: 409, body: { ok: false, error: 'insufficient_units', remainingUnits: error.remaining } };
      }
      return { status: 402, body: { ok: false, error: 'no_credits' } };
    }
    console.error('[attachPublisherJob] transaction failed', error instanceof Error ? error.message : String(error));
    return { status: 503, body: { ok: false, error: 'transaction_failed' } };
  }

  // Best-effort side-effects — never fail the response for these, but AWAITED
  // (not fire-and-forget): Cloud Functions gen2 can freeze the container's
  // CPU right after the HTTP response is flushed, killing any promise still
  // in flight — the same reason storeRenewal/sendPublisherConfirmation are
  // awaited inside handleStripeWebhook above. The 30-min publisher-jobs-sync
  // cron is the safety net if the dispatch still fails.
  try {
    await dispatchPublisherSync();
  } catch (error) {
    console.error('[attachPublisherJob] sync dispatch failed', error instanceof Error ? error.message : String(error));
  }
  await sendPublisherAttachedConfirmation(uid, newJobIds.length);

  return { status: 200, body: { ok: true, jobIds: newJobIds, remainingUnits: remainingUnitsAfter } };
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
          `<p>${jobCount > 1 ? 'I tuoi annunci saranno online' : 'Il tuo annuncio sarà online'} di norma entro un'ora con pagina SEO dedicata.</p>` +
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

// Best-effort "payment confirmed, now create your ad" confirmation for the
// pay-first (prepaid) funnel — handlePrepaidCheckout's order has no jobIds
// yet, so there's nothing to list; this just points the publisher at the
// publish form to spend the credits they just bought.
async function sendPublisherPrepaidConfirmation(publisherUid) {
  try {
    const pubSnap = await db().collection('publishers').doc(String(publisherUid)).get();
    const to = pubSnap.exists ? pubSnap.data().email : null;
    if (!to) return;
    await bridgeEmailCascadeCredentialsToEnv();
    await sendEmailCascade([{
      payload: {
        from: 'Frontaliere Ticino <confirmation@frontaliereticino.ch>',
        to,
        subject: 'Pagamento confermato — ora crea il tuo annuncio',
        html:
          `<h2>Grazie, pagamento confermato</h2>` +
          `<p>Ora puoi creare il tuo annuncio: sarà online di norma entro un'ora con pagina SEO dedicata.</p>` +
          `<p><a href="https://frontaliereticino.ch/pubblica-offerta/">Crea il tuo annuncio</a>.</p>` +
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
        // Pay-first (prepaid) orders have no jobIds at checkout time — the ad(s)
        // are created afterwards via attachPublisherJob, which stamps them
        // 'paid' directly. Falls back to session metadata in case the order
        // doc's own `prepaid` field somehow didn't persist (defensive; the
        // order is always written with `prepaid` by handlePrepaidCheckout).
        const isPrepaid = order.prepaid === true || obj.metadata?.prepaid === '1';
        await orderSnap.ref.update({
          status: 'active',
          stripeSubscriptionId: obj.subscription || null,
          updatedAt: ts,
        });
        if (isPrepaid) {
          // Nothing to flip — order.jobIds is [] until attachPublisherJob runs.
        } else {
          await setJobsStatus(order.jobIds, 'paid', { paidAt: ts, subscriptionId: obj.subscription || null });
        }
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
        if (isPrepaid) {
          await sendPublisherPrepaidConfirmation(order.publisherUid);
        } else {
          await sendPublisherConfirmation(order.publisherUid, (order.jobIds || []).length);
        }
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
