/**
 * Pure decision logic shared by the batch backfill script
 * (`scripts/backfill-jobalerts-from-newsletter.mjs`, via the
 * `scripts/lib/jobalert-backfill-core.mjs` shim) and the real-time
 * `onDocumentWritten` trigger (`jobAlertBackfillTrigger.js`) that fires on
 * every `newsletter_subscribers/{email}` write going forward.
 *
 * Canonical here (not in `services/`) because Cloud Functions have no
 * bundler and cannot import anything outside `functions/`.
 *
 * Why `onDocumentWritten`, not `onDocumentCreated`: on every social sign-in
 * (Google/Facebook/LinkedIn/One-Tap), `saveUserProfileToFirestore`
 * (services/authService.ts) fires an un-awaited `setDoc(..., {merge:true})`
 * with only auth fields (no job/location signal), racing the full
 * `upsertNewsletterSubscriber` write that carries the real signal fields —
 * and the bare write structurally tends to land first (fewer awaits, no
 * pre-read). A one-shot `onDocumentCreated` would see zero signal at create
 * time and skip the subscriber permanently, since the later merge is an
 * UPDATE the create-hook never sees. `signalTierChanged` (below) lets the
 * write-hook re-evaluate on every write cheaply (pure field diff, no
 * Firestore read) and only do real work when eligibility actually flips —
 * which both catches the delayed signal and keeps routine engagement writes
 * (open/click tracking) a no-op.
 *
 * Signal tiers, cheapest-first:
 *  1. `job_category`/`job_location` — job-specific context (job_gate unlock,
 *     JobBoard social sign-in with a job in progress). `buildAlertProfile`
 *     (services/jobAlertMatching.mjs) turns these into soft keyword/sector
 *     tokens automatically.
 *  2. `location_interest`/`geo_city` — generic location signal with no job
 *     context (IP-geolocated city, a location preference picked elsewhere).
 *     Live count against prod newsletter_subscribers (2026-07-03) found this
 *     tier adds only ~5 subscribers beyond tier 1 — most no-signal docs have
 *     no geo data at all — but it's a correct, zero-cost fallback so it's
 *     kept: `buildAlertProfile` already reads these same fields into
 *     preferredLocations/preferredCantons as a SOFT ranking signal, so a
 *     tier-2 alert becomes a broad "jobs near you" digest rather than a
 *     precise match — never a hard filter (`cantonFilter` stays null).
 */

import { isNewsletterExcluded } from './lib/emailSuppression.js';

export const MAX_ALERTS_PER_USER = 3; // services/jobAlertService.ts:68
export const ALERT_ID = 'backfill-newsletter';

export function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

/**
 * @param {Record<string, unknown>|null|undefined} data
 * @returns {'signal'|'location-fallback'|'none'}
 */
export function getSignalTier(data) {
  const category = String(data?.job_category || '').trim();
  const location = String(data?.job_location || '').trim();
  if (category || location) return 'signal';
  const locationInterest = String(data?.location_interest || '').trim();
  const geoCity = String(data?.geo_city || '').trim();
  if (locationInterest || geoCity) return 'location-fallback';
  return 'none';
}

/**
 * True when the signal tier differs between the doc's prior and new state —
 * i.e. this write is the one that actually made (or unmade) eligibility,
 * not an unrelated field update (auth profile fields, engagement tracking).
 * `beforeData` is null on doc creation (treated as tier 'none').
 * @param {Record<string, unknown>|null} beforeData
 * @param {Record<string, unknown>|null|undefined} afterData
 * @returns {boolean}
 */
export function signalTierChanged(beforeData, afterData) {
  const beforeTier = beforeData ? getSignalTier(beforeData) : 'none';
  return getSignalTier(afterData) !== beforeTier;
}

/**
 * Pure eligibility check for one `newsletter_subscribers` doc.
 * @returns {'invalid-email'|'suppressed'|'no-signal'|null} skip reason, null = eligible.
 */
export function shouldSkipSubscriber(email, data) {
  if (!email || !email.includes('@')) return 'invalid-email';
  if (isNewsletterExcluded(data?.status)) return 'suppressed';
  if (getSignalTier(data) === 'none') return 'no-signal';
  return null;
}

/**
 * Pure payload builder — no Firestore I/O, no serverTimestamp (callers stamp
 * `createdAt`/`backfilled_at`/`updated_at` after this returns, so the shape
 * stays testable without mocking firebase-admin).
 *
 * `existingBackfill` is the full prior `backfill-newsletter` doc data (or
 * null on first creation). Its `active` flag is carried forward as-is so a
 * re-run/re-trigger never undoes a user's explicit unsubscribe (`deleteAlert`
 * sets `active: false`) — only a brand-new doc defaults to `active: true`.
 */
export function buildAlertPayload(email, data, existingBackfill) {
  const tier = getSignalTier(data);
  const channel = data?.source_channel || 'unknown';
  return {
    email,
    userId: data?.user_id || null,
    keywords: [],
    locations: [],
    contractTypes: [],
    sectors: [],
    cantonFilter: null,
    frequency: 'daily',
    locale: data?.preferred_locale || data?.locale || 'it',
    sourceJobSlug: data?.job_slug || null,
    sourceJobUrl: null,
    sourceJobTitle: null,
    specificJobId: null,
    specificCompanyKey: null,
    active: existingBackfill ? existingBackfill.active !== false : true,
    matchCount: existingBackfill?.matchCount || 0,
    lastMatchedAt: existingBackfill?.lastMatchedAt || null,
    // Provenance — lets a future audit tell inferred alerts apart from
    // explicit ones, see which signup channel triggered it, and which
    // signal tier it was built from.
    backfilled_from:
      tier === 'location-fallback'
        ? `newsletter_subscribers:${channel}:location-fallback`
        : `newsletter_subscribers:${channel}`,
  };
}
