/**
 * Shared preferred-send-hour module for newsletter ESP webhooks.
 *
 * Pure function: takes a subscriber's open/click event history, returns the
 * UTC hour-of-day at which they most often open/click emails (a per-user
 * "best time to send"). Mirrors the structure of ./engagementScore.js — same
 * recency-weighting windows/values, same refresh-wrapper idiom (read subscriber
 * state, compute, skip-write-if-unchanged, swallow errors).
 *
 * Circular mean, NOT arithmetic mean: hours-of-day wrap around at midnight, so
 * a user who opens at 23:00 and again at 01:00 has a preference near 00:00 —
 * an arithmetic mean of 23 and 1 would wrongly yield 12 (noon). Each event's
 * hour-of-day is converted to an angle on a 24-hour clock and the (sin, cos)
 * vectors are averaged (weighted by recency), then the resulting angle is
 * converted back to an hour. The resultant vector length doubles as a
 * "concentration" signal: close to 1 means the user's opens/clicks cluster
 * tightly around one hour, close to 0 means they're spread evenly across the
 * day (no real preference).
 */

const RECENCY_WINDOWS = [
 { maxDays: 7, weight: 30 },
 { maxDays: 14, weight: 25 },
 { maxDays: 30, weight: 18 },
 { maxDays: 60, weight: 10 },
 { maxDays: 90, weight: 5 },
];

export const PREFERRED_SEND_MIN_EVENTS = 3;
export const PREFERRED_SEND_WINDOW_DAYS = 90;

function recencyWeight(daysSince) {
 for (const window of RECENCY_WINDOWS) {
  if (daysSince < window.maxDays) return window.weight;
 }
 return 0;
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
  // Outside the 90-day lookback window (or a bogus future timestamp) — skip.
  if (daysSince < 0 || daysSince >= PREFERRED_SEND_WINDOW_DAYS) continue;

  const weight = recencyWeight(daysSince);
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

 const meanAngle = Math.atan2(sumSin, sumCos);
 let hourFloat = (meanAngle * 24) / (2 * Math.PI);
 if (hourFloat < 0) hourFloat += 24;
 // Math.round(23.6) === 24 → wrap back to hour 0 of the next day.
 const hourUtc = Math.round(hourFloat) % 24;

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
 * @param {FirebaseFirestore.DocumentReference} subscriberRef
 * @param {*} FieldValue admin.firestore.FieldValue
 * @returns {Promise<{ updated: boolean, hourUtc?: number|null, sampleCount?: number, strength?: number|null }>}
 */
export async function refreshPreferredSendHour(subscriberRef, FieldValue) {
 try {
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

  const currentSnap = await subscriberRef.get();
  const current = currentSnap.exists ? currentSnap.data() : {};
  const unchanged = current
   && current.preferred_send_hour_utc === hourUtc
   && current.preferred_send_sample_count === sampleCount
   && current.preferred_send_strength === strength;
  if (unchanged) {
   return { updated: false, hourUtc, sampleCount, strength };
  }

  await subscriberRef.set({
   preferred_send_hour_utc: hourUtc,
   preferred_send_sample_count: sampleCount,
   preferred_send_strength: strength,
   preferred_send_updated_at: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { updated: true, hourUtc, sampleCount, strength };
 } catch (err) {
  // Non-critical: webhook delivery should not fail because of this scoring.
  console.warn('[preferredSendHour] refresh failed:', err?.message);
  return { updated: false };
 }
}
