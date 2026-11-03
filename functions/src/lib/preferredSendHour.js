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
export const PREFERRED_SEND_HOUR_BUFFER_SIZE = 300;
const PREFERRED_SEND_HOUR_BUFFER_LAST_TIMESTAMP = 'preferred_send_hour_buffer_last_timestamp';
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

function preferredEventFromData(data) {
 return preferredEventFromInput(data);
}

function preferredEventFromInput(event) {
 if (!event) return null;
 const type = event.type ?? event.event_type;
 const occurredAt = parseEventDate(event.occurredAt ?? event.occurred_at);
 if ((type !== 'open' && type !== 'click') || !occurredAt) return null;
 return { type, occurredAt };
}

function bufferEntryFromEvent(event) {
 const normalized = preferredEventFromInput(event);
 if (!normalized) return null;
 return {
  event_type: normalized.type,
  hour_utc: normalized.occurredAt.getUTCHours(),
  occurred_at: normalized.occurredAt.toISOString(),
 };
}

function bufferEntryToEvent(entry) {
 if (!entry || (entry.event_type !== 'open' && entry.event_type !== 'click')) return null;
 const occurredAt = parseEventDate(entry.occurred_at);
 if (!occurredAt || !Number.isInteger(entry.hour_utc)
  || entry.hour_utc < 0 || entry.hour_utc > 23
  || entry.hour_utc !== occurredAt.getUTCHours()) return null;
 return { type: entry.event_type, occurredAt };
}

function normalizePreferredSendHourBuffer(value) {
 if (!Array.isArray(value)) return null;
 const entries = value.map((entry) => {
  const event = bufferEntryToEvent(entry);
  return event ? bufferEntryFromEvent(event) : null;
 });
 // A partially malformed buffer cannot be safely repaired without the source
 // events, so treat it like a missing backfill rather than silently changing
 // the subscriber's sample.
 if (entries.some((entry) => !entry)) return null;
 return entries
  .sort(compareBufferEntries)
  .slice(-PREFERRED_SEND_HOUR_BUFFER_SIZE);
}

function compareBufferEntries(left, right) {
 return parseEventDate(left.occurred_at).getTime() - parseEventDate(right.occurred_at).getTime();
}

function latestBufferTimestamp(entries, fallback = null) {
 let latest = parseEventDate(fallback);
 for (const entry of entries) {
  const occurredAt = parseEventDate(entry.occurred_at);
  if (occurredAt && (!latest || occurredAt.getTime() > latest.getTime())) latest = occurredAt;
 }
 return latest ? latest.toISOString() : null;
}

function bufferEntriesFromEventDocs(docs) {
 return docs
  .map((doc) => bufferEntryFromEvent(preferredEventFromData(doc.data())))
  .filter(Boolean)
  .sort(compareBufferEntries)
  .slice(-PREFERRED_SEND_HOUR_BUFFER_SIZE);
}

function insertEventIntoBuffer(entries, event) {
 const entry = bufferEntryFromEvent(event);
 if (!entry) return entries;

 return [...entries, entry]
  .sort(compareBufferEntries)
  .slice(-PREFERRED_SEND_HOUR_BUFFER_SIZE);
}

function bufferEvents(entries) {
 return entries
  .filter((entry) => entry.event_type === 'open' || entry.event_type === 'click')
  .map((entry) => ({ type: entry.event_type, occurredAt: entry.occurred_at }));
}

function preferredEventsQuery(subscriberRef) {
 return subscriberRef
  .collection('events')
  .where('event_type', 'in', ['open', 'click'])
  .orderBy('occurred_at', 'desc')
  .limit(PREFERRED_SEND_HOUR_BUFFER_SIZE);
}

function isPreferredSendHourFresh(current) {
 if (!current || current.preferred_send_sample_count < PREFERRED_SEND_MIN_EVENTS) return false;
 const updatedAt = parseEventDate(current.preferred_send_updated_at);
 const freshAgeMs = updatedAt ? Date.now() - updatedAt.getTime() : null;
 return freshAgeMs !== null
  && freshAgeMs >= 0 && freshAgeMs < PREFERRED_SEND_REFRESH_INTERVAL_MS;
}

/**
 * Update the subscriber's preferred-send-hour buffer and, when stale, persist
 * a freshly computed preferred send hour. Safe to call after any open/click —
 * failures are swallowed and logged (identical contract to
 * refreshEngagementScore).
 *
 * The subscriber document read, buffer read-modify-write, staleness gate and
 * derived-value write share one transaction. A missing buffer performs one
 * historical legacy events query in that transaction to backfill it; subsequent
 * calls never read the events subcollection again. Buffer entries retain only
 * open/click event types, their timestamps and UTC hours. The separate
 * timestamp is a watermark for the backfill/update state, not a replacement
 * for each entry's timestamp.
 *
 * The staleness gate still does not engage below the sample-count threshold:
 * every additional open/click can change whether a cold-start subscriber
 * clears the floor. Once the buffer exists, a fresh calculation returns
 * cached derived values after recording the new open/click in the buffer.
 *
 * @param {FirebaseFirestore.DocumentReference} subscriberRef
 * @param {*} FieldValue FieldValue from firebase-admin/firestore
 * @param {{type?: string, event_type?: string, occurredAt?: *, occurred_at?: *}} [currentEvent]
 * @returns {Promise<{ updated: boolean, hourUtc?: number|null, sampleCount?: number, strength?: number|null, churned?: boolean }>}
 */
export async function refreshPreferredSendHour(subscriberRef, FieldValue, currentEvent = null) {
 try {
  const firestore = subscriberRef?.firestore;
  if (!firestore || typeof firestore.runTransaction !== 'function') {
   throw new Error('Preferred send hour refresh requires a Firestore transaction');
  }

  return await firestore.runTransaction(async (transaction) => {
   const currentSnap = await transaction.get(subscriberRef);
   const current = currentSnap?.exists ? (currentSnap.data() || {}) : null;
   let buffer = normalizePreferredSendHourBuffer(current?.preferred_send_hour_buffer);
   const bufferWasMissing = buffer === null;

   if (bufferWasMissing) {
    // The one and only historical backfill for a subscriber. Keep this query
    // identical to the legacy window: the server-side open/click filter is
    // applied before the occurred_at ordering and 300-row limit.
    const eventsSnap = await transaction.get(preferredEventsQuery(subscriberRef));
    buffer = bufferEntriesFromEventDocs(eventsSnap.docs || []);
   } else {
    buffer = insertEventIntoBuffer(buffer, currentEvent);
   }

   const bufferLastTimestamp = latestBufferTimestamp(
    buffer,
    current?.[PREFERRED_SEND_HOUR_BUFFER_LAST_TIMESTAMP],
   );
   const isFresh = isPreferredSendHourFresh(current);
   const bufferUpdate = {
    preferred_send_hour_buffer: buffer,
    [PREFERRED_SEND_HOUR_BUFFER_LAST_TIMESTAMP]: bufferLastTimestamp,
   };

   if (isFresh) {
    // A real webhook always supplies currentEvent, so its buffer append is
    // still committed transactionally even when the derived value is fresh.
    // A direct maintenance/read call with an already-present buffer needs no
    // no-op write.
    if (bufferWasMissing || bufferEntryFromEvent(currentEvent)) {
     transaction.set(subscriberRef, bufferUpdate, { merge: true });
    }
    return {
     updated: false,
     hourUtc: current.preferred_send_hour_utc ?? null,
     sampleCount: current.preferred_send_sample_count,
     strength: current.preferred_send_strength ?? null,
    };
   }

   const { hourUtc, sampleCount, strength } = computePreferredSendHour(bufferEvents(buffer));

   // Churn instrumentation (#3798 Fix MEDIO-BASSO #6 — prep for calibrating the
   // 6h staleness gate above): only counts an actual change between two known
   // hours, not the first assignment (null → hour) a cold-start subscriber
   // gets once they clear PREFERRED_SEND_MIN_EVENTS.
   const previousHourUtc = current?.preferred_send_hour_utc ?? null;
   const churned = previousHourUtc !== null && hourUtc !== null && hourUtc !== previousHourUtc;

   // Always write, even if the derived values are identical to what's already
   // stored: preferred_send_updated_at is what resets the staleness-gate
   // window above. The same transaction also commits the circular buffer.
   const update = {
    ...bufferUpdate,
    preferred_send_hour_utc: hourUtc,
    preferred_send_sample_count: sampleCount,
    preferred_send_strength: strength,
    preferred_send_updated_at: FieldValue.serverTimestamp(),
   };
   if (churned) update.preferred_send_hour_churn_count = FieldValue.increment(1);
   transaction.set(subscriberRef, update, { merge: true });

   return { updated: true, hourUtc, sampleCount, strength, churned };
  });
 } catch (err) {
  // Non-critical: webhook delivery should not fail because of this scoring.
  console.warn('[preferredSendHour] refresh failed:', err?.message);
  return { updated: false };
 }
}
