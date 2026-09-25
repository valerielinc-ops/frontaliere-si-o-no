/**
 * Shared preferred-send-hour module for newsletter ESP webhooks.
 *
 * Pure function: takes a subscriber's open/click event history, returns the
 * UTC hour-of-day at which they most often open/click emails (a per-user
 * "best time to send"). Mirrors the structure of ./engagementScore.js — same
 * recency-weighting windows/values, same refresh-wrapper idiom (read subscriber
 * state, compute, write, swallow errors). Unlike engagementScore, the refresh
 * is gated behind a staleness check (see refreshPreferredSendHour) rather than
 * a skip-write-if-unchanged check — see that function's docblock for why.
 *
 * Circular mean, NOT arithmetic mean: hours-of-day wrap around at midnight, so
 * a user who opens at 23:00 and again at 01:00 has a preference near 00:00 —
 * an arithmetic mean of 23 and 1 would wrongly yield 12 (noon). Each event's
 * hour-of-day is converted to an angle on a 24-hour clock and the (sin, cos)
 * vectors are averaged (weighted by event intent and recency), then the resulting angle is
 * converted back to an hour. The resultant vector length doubles as a
 * "concentration" signal: close to 1 means the user's opens/clicks cluster
 * tightly around one hour, close to 0 means they're spread evenly across the
 * day (no real preference).
 */

// A click is a stronger intent signal than an open, but recency must still win
// when the click is materially older. With this half-life, a click from 10 days
// ago (2.5x intent) weighs less than an open from yesterday.
const EVENT_TYPE_WEIGHTS = { open: 1, click: 2.5 };
const RECENCY_HALF_LIFE_DAYS = 4;

export const PREFERRED_SEND_MIN_EVENTS = 3;
export const PREFERRED_SEND_WINDOW_DAYS = 180;
// Staleness-gate window for refreshPreferredSendHour (see below): once a
// subscriber has enough samples to trust the circular mean, re-derive it at
// most this often instead of on every single open/click.
export const PREFERRED_SEND_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

function recencyWeight(daysSince) {
 return Math.exp(-Math.LN2 * daysSince / RECENCY_HALF_LIFE_DAYS);
}

// Accepts a Date, an ISO/parsable date string, or a Firestore-Timestamp-like
// object exposing toDate(). Returns null for anything that doesn't parse to
// a finite timestamp instead of throwing — callers scan raw event history
// that may contain malformed/legacy rows.
function parseEventDate(value) {
 if (!value) return null;
 if (typeof value === 'object' && typeof value.toDate === 'function') {
  const fromTimestamp = value.toDate();
  return fromTimestamp instanceof Date && Number.isFinite(fromTimestamp.getTime()) ? fromTimestamp : null;
 }
 const date = value instanceof Date ? value : new Date(value);
 return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Convert accumulated (sin, cos) sums from a circular mean into an hour-of-day
 * integer in [0, 23]. Extracted from computePreferredSendHour so other
 * callers (e.g. offline scoring scripts) can share the exact same
 * angle-to-hour conversion instead of re-deriving it.
 *
 * @param {number} sumSin
 * @param {number} sumCos
 * @returns {number} integer hour 0-23
 */
export function circularMeanToHour(sumSin, sumCos) {
 const meanAngle = Math.atan2(sumSin, sumCos);
 let hourFloat = (meanAngle * 24) / (2 * Math.PI);
 if (hourFloat < 0) hourFloat += 24;
 // Math.round(23.6) === 24 → wrap back to hour 0 of the next day.
 return Math.round(hourFloat) % 24;
}

/**
 * @param {Array<{ type: 'open'|'click', occurredAt: Date|string|{toDate: Function} }>} events
 * @param {Date} [now] Reference "current time" — injectable for deterministic tests.
 * @returns {{ hourUtc: number|null, sampleCount: number, strength: number|null }}
 */
export function computePreferredSendHour(events, now = new Date()) {
 let sumSin = 0;
 let sumCos = 0;
 let sumWeight = 0;
 let sampleCount = 0;

 for (const event of Array.isArray(events) ? events : []) {
  if (!event || (event.type !== 'open' && event.type !== 'click')) continue;

  const occurredAt = parseEventDate(event.occurredAt);
  if (!occurredAt) continue;

  const daysSince = (now.getTime() - occurredAt.getTime()) / (1000 * 60 * 60 * 24);
  // Outside the lookback window (PREFERRED_SEND_WINDOW_DAYS, 180 days) or a
  // bogus future timestamp — skip.
  if (daysSince < 0 || daysSince >= PREFERRED_SEND_WINDOW_DAYS) continue;

  const weight = EVENT_TYPE_WEIGHTS[event.type] * recencyWeight(daysSince);
  if (weight <= 0) continue;

  sampleCount += 1;

  const hourOfDay = occurredAt.getUTCHours() + occurredAt.getUTCMinutes() / 60;
  const theta = (2 * Math.PI * hourOfDay) / 24;
  sumSin += weight * Math.sin(theta);
  sumCos += weight * Math.cos(theta);
  sumWeight += weight;
 }

 // Cold-start guard: too few data points to trust a circular mean (owner
 // decision — 3 events minimum, see PREFERRED_SEND_MIN_EVENTS).
 if (sampleCount < PREFERRED_SEND_MIN_EVENTS || sumWeight === 0) {
  return { hourUtc: null, sampleCount, strength: null };
 }

 const hourUtc = circularMeanToHour(sumSin, sumCos);

 const resultantLength = Math.sqrt(sumSin * sumSin + sumCos * sumCos) / sumWeight;
 const strength = Math.round(resultantLength * 1000) / 1000;

 return { hourUtc, sampleCount, strength };
}

/**
 * Re-read a subscriber's recent events and persist a freshly computed
 * preferred send hour. Safe to call after any open/click — failures are
 * swallowed and logged (identical contract to refreshEngagementScore).
 *
 * Unlike refreshEngagementScore, this is NOT wrapped in a Firestore
 * transaction: the events query has to run outside any transaction (see
 * below), and the derived value is a pure function of the events
 * subcollection alone — no other concurrently-mutated counter feeds into it,
 * so there's no read-decide-write race to protect against the way
 * refreshEngagementScore's transaction protects concurrent counter
 * increments. A plain get() + compare-before-write is sufficient here.
 *
 * Staleness gate (Firestore cost — #3798 code review): open/click webhooks
 * fire at high volume, and without a gate every single one of them paid for
 * an `events` query of up to 300 docs (~301 reads/event) just to re-derive a
 * number that, once a subscriber has enough history, barely moves from event
 * to event. refreshEngagementScore is O(1) (a counter increment inside a
 * transaction) — this was the expensive one by a wide margin. So: read the
 * subscriber doc FIRST (1 read); if it already has >= PREFERRED_SEND_MIN_EVENTS
 * samples AND was refreshed within the last PREFERRED_SEND_REFRESH_INTERVAL_MS
 * (6h), skip the events query entirely and return the cached values. The gate
 * intentionally does NOT engage below the sample-count threshold: a
 * cold-start subscriber (<3 events) has few events, so the query is cheap,
 * and every additional event materially changes whether they clear the
 * cold-start floor at all — recomputing on every event there is correct, not
 * wasteful.
 *
 * @param {FirebaseFirestore.DocumentReference} subscriberRef
 * @param {*} FieldValue admin.firestore.FieldValue
 * @returns {Promise<{ updated: boolean, hourUtc?: number|null, sampleCount?: number, strength?: number|null, churned?: boolean }>}
 */
export async function refreshPreferredSendHour(subscriberRef, FieldValue) {
 try {
  // Read the subscriber doc BEFORE the events query — this is what makes the
  // staleness gate below cheap (1 read) instead of paying for the up-to-300
  // doc events query first and only then discovering a refresh wasn't needed.
  const currentSnap = await subscriberRef.get();
  const current = currentSnap.exists ? currentSnap.data() : null;

  if (current && current.preferred_send_sample_count >= PREFERRED_SEND_MIN_EVENTS) {
   const updatedAt = parseEventDate(current.preferred_send_updated_at);
   // Intervallo, non semiretta: senza il limite inferiore a zero un
   // `preferred_send_updated_at` nel futuro (clock skew, data scritta male)
   // resterebbe "fresco" per sempre e congelerebbe il ricalcolo dell'ora di
   // invio a vita. Una data futura non e' un dato fresco, e' un dato rotto:
   // ricalcola.
   const freshAgeMs = updatedAt ? Date.now() - updatedAt.getTime() : null;
   const isFresh = freshAgeMs !== null
    && freshAgeMs >= 0 && freshAgeMs < PREFERRED_SEND_REFRESH_INTERVAL_MS;
   if (isFresh) {
    return {
     updated: false,
     hourUtc: current.preferred_send_hour_utc ?? null,
     sampleCount: current.preferred_send_sample_count,
     strength: current.preferred_send_strength ?? null,
    };
   }
  }

  // Query the events subcollection OUTSIDE of any transaction (Firestore
  // transactions can't mix an initial query read with later ref.get() reads
  // the way this needs). No `where('event_type', 'in', [...])` filter on
  // purpose — that would require a composite index (event_type + occurred_at)
  // that doesn't exist yet. Filtering client-side after limiting to the most
  // recent 300 events is cheap and avoids that deploy dependency.
  const eventsSnap = await subscriberRef
   .collection('events')
   .orderBy('occurred_at', 'desc')
   .limit(300)
   .get();

  const events = eventsSnap.docs
   .map((doc) => doc.data())
   .filter((data) => data && (data.event_type === 'open' || data.event_type === 'click'))
   .map((data) => ({ type: data.event_type, occurredAt: data.occurred_at }));

  const { hourUtc, sampleCount, strength } = computePreferredSendHour(events);

  // Churn instrumentation (#3798 Fix MEDIO-BASSO #6 — prep for calibrating the
  // 6h staleness gate above): only counts an actual change between two known
  // hours, not the first assignment (null → hour) a cold-start subscriber
  // gets once they clear PREFERRED_SEND_MIN_EVENTS. Feeds a future decision on
  // whether PREFERRED_SEND_REFRESH_INTERVAL_MS is too short (high churn = the
  // "preference" is still noisy) or safely longer (low churn = stable).
  const previousHourUtc = current?.preferred_send_hour_utc ?? null;
  const churned = previousHourUtc !== null && hourUtc !== null && hourUtc !== previousHourUtc;

  // Always write, even if the derived values are identical to what's already
  // stored: preferred_send_updated_at is what resets the staleness-gate
  // window above, so skipping the write on "unchanged" would mean the gate
  // never re-engages and this subscriber keeps paying the full events-query
  // cost on every future event forever.
  const update = {
   preferred_send_hour_utc: hourUtc,
   preferred_send_sample_count: sampleCount,
   preferred_send_strength: strength,
   preferred_send_updated_at: FieldValue.serverTimestamp(),
  };
  if (churned) update.preferred_send_hour_churn_count = FieldValue.increment(1);
  await subscriberRef.set(update, { merge: true });

  return { updated: true, hourUtc, sampleCount, strength, churned };
 } catch (err) {
  // Non-critical: webhook delivery should not fail because of this scoring.
  console.warn('[preferredSendHour] refresh failed:', err?.message);
  return { updated: false };
 }
}
