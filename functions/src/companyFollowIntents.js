/**
 * Server-side CompanyAlert follow intents ("Segui azienda" for anonymous
 * visitors).
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * An anonymous visitor who follows an employer leaves an email, confirms it
 * through the double opt-in link and only THEN may the alert exist. Until this
 * module the intent lived only in that browser's localStorage
 * (services/companyFollowIntent.ts), so a confirmation opened on another
 * device, in a mail app's in-app browser or after the 7-day local TTL created
 * nothing: the visitor had to go back to the company page and click again.
 * Measured on production 2026-10-05: 84 emails from this funnel since August,
 * ~28 company alerts; 35 subscribers still carrying
 * `company_follow_followup_pending`, 32 of them with no company alert at all.
 *
 * The browser now also records the intent on the server, in
 * `newsletter_subscribers/{email}/company_follow_intents/{autoId}` (create-only
 * for clients, see firestore.rules), and the confirmation endpoint turns it
 * into the alert the moment the mailbox owner clicks the link.
 *
 * ── CONSENT ───────────────────────────────────────────────────────────────
 * The follow is an explicit request by the visitor (the click on "Segui"), and
 * the link click proves control of the mailbox; together they are the same two
 * facts the browser replay relied on. Nothing here runs without the click: an
 * intent written by somebody else for an address they do not own stays an
 * inert document. The TTL is the browser queue's (a stale click is not
 * consent), and the address-level stops (unsubscribe, stop-all, hard bounce,
 * complaint) always win over an intent.
 *
 * ── NO DUPLICATES ─────────────────────────────────────────────────────────
 * The alert document mirrors what `subscribeCompanyAlert` → `createAlert`
 * (services/jobAlertService.ts) writes, including the deterministic id
 * `intent_<idempotency key>` computed with the SAME function, so the browser
 * replay that may still run after the confirmation finds this document and
 * returns it instead of writing a second one. An alert already present for the
 * same `specificCompanyKey` — or for another member of the same follow group
 * (build-plugins/shared/companyFollowGroups.mjs, e.g. `coop` and
 * `coop-genossenschaft`) — satisfies the intent without a write, exactly like
 * `createAlert` and the `create_alert` action.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { isCrossChannelStop, isTransactionalHardBlock } from './lib/emailSuppression.js';

export const COMPANY_FOLLOW_INTENTS_SUBCOLLECTION = 'company_follow_intents';

/** Same TTL as PENDING_FOLLOW_TTL_MS in services/companyFollowIntent.ts. */
export const COMPANY_FOLLOW_INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Mirrors MAX_COMPANY_ALERTS_PER_USER (services/jobAlertService.ts). */
export const MAX_COMPANY_ALERTS_PER_USER = 20;

/** Upper bound on intents read per fulfilment: clients can only append. */
export const MAX_INTENTS_PER_FULFILLMENT = 50;

const LOCALES = new Set(['it', 'en', 'de', 'fr']);

function normalizeLocale(value) {
  const raw = String(value || '').trim().toLowerCase().slice(0, 2);
  return LOCALES.has(raw) ? raw : 'it';
}

function cleanString(value, max) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? raw.slice(0, max) : null;
}

export function toMillis(value) {
  if (value == null) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  return null;
}

/**
 * Byte-for-byte mirror of `stableAlertIdempotencyKey` in
 * services/jobAlertService.ts for the CompanyAlert config built by
 * `subscribeCompanyAlert`. The Functions bundle cannot import the browser
 * service, so parity is pinned by tests/company-follow-server-intent.test.ts.
 * Key order inside the JSON material is part of the contract.
 */
export function companyFollowAlertIdempotencyKey({ userId, email, locale, companyKey }) {
  const material = JSON.stringify({
    version: 1,
    userId,
    email,
    keywords: [],
    locations: [],
    contractTypes: [],
    sectors: [],
    cantonFilter: null,
    frequency: 'immediate',
    frequencyOverride: true,
    locale: locale || 'it',
    specificJobId: null,
    specificCompanyKey: companyKey,
    minNetMonthlyCHF: null,
  });
  let hash = 2166136261;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `v1_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Whether the newsletter row forbids turning a follow intent into an alert.
 *
 * The legacy company-follow-only confirmation deliberately parks the row on
 * `status: 'suppressed'` "until the explicit company action creates the
 * CompanyAlert" (newsletterSubscriptionManagement.js): that one shape is the
 * hold this module exists to release, not a provider suppression, so it is
 * the only suppressed state let through — and never with a hard bounce.
 */
export function companyFollowBlockReason(subscriber) {
  if (!subscriber || typeof subscriber !== 'object') return 'no_subscriber';
  if (isTransactionalHardBlock({ status: subscriber.status, bounceSeverity: subscriber.bounce_severity })) {
    return 'address_suppressed';
  }
  const status = String(subscriber.status || '').trim().toLowerCase();
  const companyOnlyHold = status === 'suppressed'
    && subscriber.company_follow_only === true
    && !subscriber.bounce_severity;
  if (companyOnlyHold) {
    const { status: _ignored, ...rest } = subscriber;
    return isCrossChannelStop({ ...rest, status: 'confirmed' }) ? 'opted_out' : null;
  }
  if (isCrossChannelStop(subscriber)) {
    return status === 'bounced' || status === 'complained' || status === 'suppressed'
      ? 'address_suppressed'
      : 'opted_out';
  }
  return null;
}

/** The alert document `createAlert` writes for `subscribeCompanyAlert`. */
export function buildCompanyFollowAlertDoc({ email, userId, intent, companyKey, idempotencyKey }) {
  return {
    email,
    userId,
    keywords: [],
    locations: [],
    contractTypes: [],
    sectors: [],
    cantonFilter: null,
    frequency: 'immediate',
    frequencyOverride: true,
    locale: normalizeLocale(intent.locale),
    sourceJobSlug: cleanString(intent.source_job_slug, 300),
    sourceJobUrl: cleanString(intent.source_job_url, 500),
    sourceJobTitle: cleanString(intent.source_job_title, 300),
    specificJobId: null,
    specificCompanyKey: companyKey,
    idempotency_key: idempotencyKey,
    consent_purpose: 'companyFollow',
    consent_act: 'company_follow_activation',
    consent_recorded_at: FieldValue.serverTimestamp(),
    minNetMonthlyCHF: null,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
    lastMatchedAt: null,
    matchCount: 0,
    // Provenance only: which writer materialised the follow.
    created_via: 'company_follow_intent',
  };
}

/**
 * Turn every live follow intent of `email` into a CompanyAlert.
 *
 * Never throws for a single intent: each one ends `fulfilled` (alert created
 * or already present), `skipped` (with a reason) or stays `pending` (a
 * transient write failure, retried on the next link click).
 *
 * @param {object} args
 * @param {any} args.db Admin Firestore.
 * @param {string} args.email Normalised address (document id).
 * @param {string} args.uid Firebase Auth uid the visitor signs in as.
 * @param {(value: string) => string} args.normalizeKey normalizeCompanyAlertKey.
 * @param {(key: string) => string} [args.groupKey] companyFollowGroupKey: two
 *   keys with the same group key are ONE follow.
 * @param {string} args.via `confirmation_link` | `login_link` | `backfill`.
 * @param {number} [args.nowMs]
 * @param {number} [args.ttlMs] Intents older than this are expired, not used.
 * @param {boolean} [args.skipIfAnyAlertForKey] Treat an unfollowed (inactive)
 *   alert for the key as a binding refusal regardless of dates (backfill).
 * @param {boolean} [args.dryRun] Plan only, write nothing.
 */
export async function fulfillCompanyFollowIntents({
  db,
  email,
  uid,
  normalizeKey,
  groupKey = (key) => key,
  via,
  nowMs = Date.now(),
  ttlMs = COMPANY_FOLLOW_INTENT_TTL_MS,
  skipIfAnyAlertForKey = false,
  dryRun = false,
}) {
  const outcome = { created: 0, existing: 0, skipped: 0, expired: 0, pending: 0, total: 0, reasons: {}, alertIds: [] };
  const bump = (reason) => { outcome.reasons[reason] = (outcome.reasons[reason] || 0) + 1; };
  if (!db || !email || !uid || typeof normalizeKey !== 'function') return outcome;

  const subscriberRef = db.collection('newsletter_subscribers').doc(email);
  const intentsSnap = await subscriberRef
    .collection(COMPANY_FOLLOW_INTENTS_SUBCOLLECTION)
    .where('status', '==', 'pending')
    .limit(MAX_INTENTS_PER_FULFILLMENT)
    .get();
  const intents = [];
  intentsSnap.forEach((doc) => intents.push({ id: doc.id, ref: doc.ref, data: doc.data() || {} }));
  outcome.total = intents.length;
  if (intents.length === 0) return outcome;

  const mark = async (intent, fields) => {
    if (dryRun) return;
    await intent.ref.set({ ...fields, updated_at: FieldValue.serverTimestamp() }, { merge: true });
  };

  const subscriberSnap = await subscriberRef.get();
  const blockReason = companyFollowBlockReason(subscriberSnap.exists ? subscriberSnap.data() || {} : null);

  // Newest intent per follow group wins (locale, provenance and member key of
  // the last click).
  const byKey = new Map();
  for (const intent of intents) {
    const created = toMillis(intent.data.created_at);
    const key = normalizeKey(String(intent.data.company_key || intent.data.company || ''));
    if (!key) {
      outcome.skipped += 1; bump('invalid_company');
      await mark(intent, { status: 'skipped', skip_reason: 'invalid_company' });
      continue;
    }
    if (created == null || nowMs - created > ttlMs) {
      outcome.expired += 1; bump('expired');
      await mark(intent, { status: 'expired' });
      continue;
    }
    if (blockReason) {
      outcome.skipped += 1; bump(blockReason);
      await mark(intent, { status: 'skipped', skip_reason: blockReason });
      continue;
    }
    const followGroup = groupKey(key);
    const group = byKey.get(followGroup) || [];
    group.push({ ...intent, key, createdMs: created });
    byKey.set(followGroup, group);
  }
  if (byKey.size === 0) return outcome;

  const alertsCol = db.collection('job_alert_subscribers').doc(email).collection('alerts');
  const alertsSnap = await alertsCol.get();
  const alerts = [];
  alertsSnap.forEach((doc) => alerts.push({ id: doc.id, data: doc.data() || {} }));
  let activeCompanyAlerts = alerts.filter((a) => a.data.specificCompanyKey && a.data.active !== false).length;

  for (const [followGroup, group] of byKey) {
    group.sort((a, b) => b.createdMs - a.createdMs);
    const newest = group[0];
    const key = newest.key;
    const finishAll = async (fields) => { for (const intent of group) await mark(intent, fields); };
    try {
      const sameKey = alerts.filter((a) => a.data.specificCompanyKey
        && groupKey(String(a.data.specificCompanyKey)) === followGroup);
      const active = sameKey.find((a) => a.data.specificCompanyKey === key && a.data.active !== false)
        || sameKey.find((a) => a.data.active !== false);
      if (active) {
        outcome.existing += 1; bump('already_following');
        outcome.alertIds.push(active.id);
        await finishAll({ status: 'fulfilled', fulfilled_via: via, fulfilled_at: FieldValue.serverTimestamp(), alert_id: active.id, already_following: true });
        continue;
      }
      // An explicit unfollow AFTER the click is binding. A click after an old
      // unfollow is a re-follow and gets a fresh document, as in the browser.
      const unfollowedAfter = sameKey.some((a) => {
        if (skipIfAnyAlertForKey) return true;
        const off = toMillis(a.data.unsubscribed_at) ?? toMillis(a.data.updatedAt) ?? toMillis(a.data.updated_at);
        return off == null || off >= newest.createdMs;
      });
      if (unfollowedAfter) {
        outcome.skipped += 1; bump('unfollowed');
        await finishAll({ status: 'skipped', skip_reason: 'unfollowed' });
        continue;
      }
      if (activeCompanyAlerts >= MAX_COMPANY_ALERTS_PER_USER) {
        outcome.skipped += 1; bump('alert_limit_reached');
        await finishAll({ status: 'skipped', skip_reason: 'alert_limit_reached' });
        continue;
      }

      const locale = normalizeLocale(newest.data.locale);
      const idempotencyKey = companyFollowAlertIdempotencyKey({ userId: uid, email, locale, companyKey: key });
      const docData = buildCompanyFollowAlertDoc({ email, userId: uid, intent: newest.data, companyKey: key, idempotencyKey });
      if (dryRun) {
        outcome.created += 1; bump('would_create');
        activeCompanyAlerts += 1;
        continue;
      }

      await db.collection('job_alert_subscribers').doc(email).set({
        email,
        userId: uid,
        locale,
        status: 'active',
        isActive: true,
        active: true,
        account_deleted_at: FieldValue.delete(),
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: true });

      const deterministicRef = alertsCol.doc(`intent_${idempotencyKey}`);
      const deterministicSnap = await deterministicRef.get();
      let alertId = deterministicRef.id;
      if (deterministicSnap.exists) {
        // A soft-deleted tombstone owns the deterministic id: a fresh follow is
        // a new document, never a resurrection (same rule as createAlert).
        const added = await alertsCol.add(docData);
        alertId = added.id;
      } else {
        await deterministicRef.set(docData);
      }
      activeCompanyAlerts += 1;
      outcome.created += 1; bump('created');
      outcome.alertIds.push(alertId);
      alerts.push({ id: alertId, data: { specificCompanyKey: key, active: true } });

      await subscriberRef.collection('events').add({
        email,
        event_type: 'job_alert_created',
        source_channel: 'company_follow_intent',
        meta: { alert_id: alertId, company_key: key, via },
        timestamp: FieldValue.serverTimestamp(),
        occurred_at: new Date(nowMs).toISOString(),
      });
      await finishAll({ status: 'fulfilled', fulfilled_via: via, fulfilled_at: FieldValue.serverTimestamp(), alert_id: alertId });
    } catch (err) {
      // Transient: leave the intents pending for the next link click.
      outcome.pending += 1; bump('write_failed');
      console.warn('[companyFollowIntents] fulfilment failed (kept pending):', err?.message || err);
    }
  }

  if (!dryRun && outcome.pending === 0 && outcome.created + outcome.existing > 0 && subscriberSnap.exists) {
    // Same completion marker `subscribeCompanyAlert` clears in the browser.
    await subscriberRef.set({ company_follow_followup_pending: false }, { merge: true });
  }
  return outcome;
}
