/**
 * Dormant-tier win-back — pure classifier (#4299).
 *
 * DISTINCT from scripts/lib/subscriberSunset.mjs's single-email zombie
 * sunset (SUNSET_MIN_SENDS=12 sends AND SUNSET_MIN_AGE_DAYS=120 days AND
 * ZERO opens/clicks EVER — a narrow, permanent list-hygiene safety net).
 * This targets the broader `engagement_level === 'dormant'` cohort (score
 * 0-9, see functions/src/lib/engagementScore.js — recency-weighted, so it
 * also catches subscribers who engaged before but have since gone quiet),
 * sized at 1,863 subscribers by issue #4299, run through a TWO-email
 * sequence ahead of the SAME sunset policy:
 *
 *   1. `stage1` — a lighter-touch "here's what you missed" re-engagement
 *      email (real article-performance winners), stamp
 *      dormant_winback_stage1_sent_at.
 *   2. `stage2` — after STAGE1_GRACE_DAYS with still no re-engagement, the
 *      more direct "are you still there?" message (reuses
 *      services/winbackEmail.mjs's copy/branding), stamp
 *      dormant_winback_stage2_sent_at.
 *   3. `sunset` — after STAGE2_GRACE_DAYS with still no re-engagement, hand
 *      off to the SAME status:'inactive' transition scripts/newsletter-sunset.mjs
 *      uses, so both paths converge on one NEWSLETTER_EXCLUDED_STATUSES
 *      policy (services/emailSuppression.mjs) instead of a second, competing
 *      "inactive" meaning.
 *
 * Mutually exclusive with the zombie-sunset track by construction, but ONLY
 * for NEVER-engaged subscribers (zero lifetime opens/clicks): a never-engaged
 * subscriber who already meets (or is already inside) subscriberSunset's
 * SUNSET_MIN_SENDS + SUNSET_MIN_AGE_DAYS floor is left to that track instead.
 * A subscriber with ANY historical engagement always stays on this track
 * (subscriberSunset's classifySunset returns 'none' forever for anyone with
 * open/click>0, so deferring an engaged dormant there would strand them —
 * review PR #4338, bug D).
 *
 * Any real re-engagement (freshly computed engagementLevel climbs out of
 * 'dormant') at any point cancels the sequence — 'reactivate' clears the
 * stage timestamps so a later relapse into 'dormant' starts the sequence
 * fresh rather than resuming a stale grace clock.
 *
 * NOTE on testability: `calculateEngagementScore` (functions/src/lib/engagementScore.js)
 * derives its recency component from the REAL `Date.now()`, not an injectable
 * clock (same contract scripts/lib/subscriberFromFirestoreRow.mjs already
 * relies on) — so fixtures must use real-relative dates (`daysAgo()`,
 * computed from actual now) for engagement-level inputs. The `nowMs` param
 * here only governs THIS classifier's own stage-grace-day math (stage1 →
 * stage2 → sunset timing), which stays fully injectable/pure.
 */
import { calculateEngagementScore } from '../../functions/src/lib/engagementScore.js';
import { SUNSET_MIN_SENDS, SUNSET_MIN_AGE_DAYS } from './subscriberSunset.mjs';
import { toMillis } from './firestoreTimestamp.mjs';
import { isNewsletterOptOutBinding } from '../../services/newsletterOptOut.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

// Below this many sends, a subscriber hasn't had a fair chance to engage yet
// (mirrors the "new" tier floor in services/newsletter-priority.mjs) — never
// win-back someone who has barely been mailed.
export const MIN_SENDS_BEFORE_WINBACK = 3;
export const STAGE1_GRACE_DAYS = 10;
export const STAGE2_GRACE_DAYS = 14;

// Statuses we may transition FROM. We never touch unsubscribed / bounced /
// complained / suppressed (explicit or hard signals own those), and an empty
// / missing status is treated as mailable ('active'-equivalent). Mirrors
// subscriberSunset.mjs's MAILABLE_STATUSES.
const MAILABLE_STATUSES = new Set(['active', 'confirmed', '']);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

/**
 * Earliest "age" anchor for the subscriber: when they joined / first got
 * mailed. Falls back across the common field spellings (mirrors
 * subscriberSunset.mjs's firstSeenMillis).
 */
function firstSeenMillis(sub) {
  return (
    toMillis(sub?.created_at) ??
    toMillis(sub?.createdAt) ??
    toMillis(sub?.subscribed_at) ??
    toMillis(sub?.subscribedAt) ??
    toMillis(sub?.first_sent_at) ??
    toMillis(sub?.firstSentAt) ??
    null
  );
}

/**
 * @typedef {{ action: 'none'|'stage1'|'stage2'|'sunset'|'reactivate', reason: string }} DormantWinbackVerdict
 */

/**
 * Classify a newsletter subscriber for the dormant-tier win-back sequence.
 * Pure aside from the real-clock dependency inherited from
 * calculateEngagementScore (see module doc); caller passes `nowMs` for the
 * stage-grace-day math.
 *
 * @param {object} sub Firestore newsletter_subscribers doc fields
 * @param {number} nowMs current time in ms
 * @returns {DormantWinbackVerdict}
 */
export function classifyDormantWinback(sub, nowMs) {
  const status = norm(sub?.status);
  const { level } = calculateEngagementScore(sub);

  // Same first question as classifySunset, for the same reason: MAILABLE_STATUSES
  // keeps `status: 'unsubscribed'` out, but the stamp is the other half of the
  // record and 458 documents carry only its camelCase spelling (#5673). A
  // win-back is still mail, so a recorded opt-out ends the sequence here rather
  // than at the status check further down (#5688). Via the shared predicate, so
  // somebody who left and explicitly came back is not stranded (#5711).
  if (isNewsletterOptOutBinding(sub)) {
    return { action: 'none', reason: 'recorded opt-out — not a win-back candidate' };
  }

  const stage1At = toMillis(sub?.dormant_winback_stage1_sent_at);
  const stage2At = toMillis(sub?.dormant_winback_stage2_sent_at);

  // Real re-engagement at any point cancels the sequence — only worth a
  // Firestore write (clearing the stage timestamps) if the sequence had
  // actually started.
  if (level !== 'dormant') {
    if (stage1At != null || stage2At != null) {
      return { action: 'reactivate', reason: `engagement recovered to '${level}' mid-sequence` };
    }
    return { action: 'none', reason: `not dormant (level='${level}')` };
  }

  // Already sunset (either track): leave it be. Only the zombie-sunset track
  // reactivates an 'inactive' doc, so there is a single writer for that
  // transition.
  if (status === 'inactive') {
    return { action: 'none', reason: 'already inactive' };
  }

  if (!MAILABLE_STATUSES.has(status)) {
    return { action: 'none', reason: `status '${status}' is not eligible` };
  }

  const sends = num(sub?.send_count ?? sub?.sendCount);
  if (sends < MIN_SENDS_BEFORE_WINBACK) {
    return { action: 'none', reason: `too new (sends=${sends}, floor=${MIN_SENDS_BEFORE_WINBACK})` };
  }

  // Defer to the stricter zombie-sunset track ONLY when this subscriber is
  // NEVER-engaged (zero lifetime opens/clicks) — the same condition
  // subscriberSunset.mjs's classifySunset requires before it will ever act.
  // A subscriber with historical engagement (the common case for the
  // recency-weighted 'dormant' tier: score is low because they've gone
  // quiet RECENTLY, not because they never engaged) would otherwise be
  // deferred here to a track that immediately returns 'none' for anyone
  // with open/click>0 — an ownership gap where neither track ever touches
  // them again (review PR #4338, bug D). Never run both campaigns on the
  // same address, but only never-engaged subscribers are actually shared
  // ground between the two.
  const neverEngaged = num(sub?.open_count ?? sub?.openCount) === 0 && num(sub?.click_count ?? sub?.clickCount) === 0;
  const firstSeen = firstSeenMillis(sub);
  const ageDays = firstSeen == null ? 0 : (nowMs - firstSeen) / DAY_MS;
  const isSunsetTrackCandidate = neverEngaged && sends >= SUNSET_MIN_SENDS && ageDays >= SUNSET_MIN_AGE_DAYS;
  const alreadyOnSunsetTrack = neverEngaged && toMillis(sub?.winback_sent_at ?? sub?.winbackSentAt) != null;
  if (isSunsetTrackCandidate || alreadyOnSunsetTrack) {
    return { action: 'none', reason: 'owned by the zombie-sunset track instead' };
  }

  if (stage1At == null) {
    return { action: 'stage1', reason: `dormant (sends=${sends}, ageDays=${Math.floor(ageDays)}), starting win-back` };
  }

  if (stage2At == null) {
    const graceDays = (nowMs - stage1At) / DAY_MS;
    if (graceDays >= STAGE1_GRACE_DAYS) {
      return { action: 'stage2', reason: `no re-engagement ${Math.floor(graceDays)}d after stage 1` };
    }
    return { action: 'none', reason: `within stage-1 grace (${Math.floor(graceDays)}d/${STAGE1_GRACE_DAYS}d)` };
  }

  const graceDays = (nowMs - stage2At) / DAY_MS;
  if (graceDays >= STAGE2_GRACE_DAYS) {
    return { action: 'sunset', reason: `no re-engagement ${Math.floor(graceDays)}d after stage 2` };
  }
  return { action: 'none', reason: `within stage-2 grace (${Math.floor(graceDays)}d/${STAGE2_GRACE_DAYS}d)` };
}
