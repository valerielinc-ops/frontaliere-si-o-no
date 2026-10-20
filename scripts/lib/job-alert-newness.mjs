/**
 * Candidate-window rules for the daily JobAlert sender.
 *
 * There are two different clocks in the jobs dataset:
 *
 * - `crawledAt` says when the listing was last verified in the live inventory;
 * - `firstSeenAt` says when this listing was first discovered.
 *
 * The first clock is the availability window for a recipient who was away. The
 * second is the only clock that may describe an offer as genuinely new. A
 * re-crawl must therefore be eligible for catch-up when it is still unseen by
 * the recipient, but it must not receive a NEW badge merely because its
 * `crawledAt` moved forward.
 */

export const DEFAULT_JOB_ALERT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const CLOSED_JOB_STATUSES = new Set([
  'archived',
  'closed',
  'deleted',
  'expired',
  'inactive',
  'removed',
  'withdrawn',
]);

function firstFiniteMillis(...values) {
  for (const value of values) {
    const millis = toMillis(value);
    if (millis > 0) return millis;
  }
  return 0;
}

/**
 * Convert the date shapes used by Firestore and the assembled job dataset to
 * epoch milliseconds. Invalid values deliberately become 0: callers can then
 * quarantine the row instead of widening a window to the whole history.
 */
export function toMillis(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value instanceof Date) return value.getTime() || 0;
  if (value && typeof value.toMillis === 'function') {
    const millis = Number(value.toMillis());
    return Number.isFinite(millis) ? millis : 0;
  }
  if (value === null || value === undefined || value === '') return 0;
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : 0;
}

function expiryMillis(value) {
  const text = String(value || '').trim();
  // Crawler deadlines are often date-only. `validThrough: 2026-09-21` means
  // valid through that calendar date, not expired at 00:00 UTC on that date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const millis = Date.parse(`${text}T23:59:59.999Z`);
    return Number.isFinite(millis) ? millis : 0;
  }
  return toMillis(value);
}

/**
 * The inventory timestamp is the last time a job was available to the sender.
 * `postedDate` and `firstSeenAt` are compatibility fallbacks for legacy rows
 * that predate the crawler's `crawledAt` field.
 */
export function jobInventoryTimestampMs(job) {
  return firstFiniteMillis(job?.crawledAt, job?.postedDate, job?.firstSeenAt);
}

/**
 * Whether a listing may still be shown in a JobAlert email.
 * Missing expiry metadata is allowed for legacy crawler rows; an explicit
 * terminal state, inactive flag, or past expiry is not.
 */
export function isOpenJobAlertJob(job, nowMs = Date.now()) {
  if (!job || typeof job !== 'object') return false;
  if (!Number.isFinite(nowMs)) return false;
  if (job.active === false) return false;

  const status = String(job.status || '').trim().toLowerCase();
  if (CLOSED_JOB_STATUSES.has(status)) return false;

  for (const field of ['expiredAt', 'expiresAt', 'validThrough']) {
    const raw = job[field];
    if (raw !== null && raw !== undefined && String(raw).trim() !== '' && !expiryMillis(raw)) {
      // An explicit but malformed validity marker is unknown state, not proof
      // that the offer is open. Keep it out of a user-facing send.
      return false;
    }
    const expiry = expiryMillis(job[field]);
    if (expiry > 0 && expiry <= nowMs) return false;
  }
  return true;
}

/**
 * Resolve the lower bound for one recipient's inventory window.
 *
 * A valid recipient `last_sent_at` is the cursor. On the first send, the
 * alert's creation time prevents a new subscription from receiving the entire
 * historical inventory; the ordinary 24h lookback remains the safety net for
 * legacy alerts without a creation timestamp. Future cursors are fail-closed:
 * they resolve to `now`, never to an older fallback that could send history.
 */
export function resolveJobAlertCursor({
  recipientLastSentAt,
  alertCreatedAt,
  nowMs = Date.now(),
  initialLookbackMs = DEFAULT_JOB_ALERT_LOOKBACK_MS,
} = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const lookback = Number.isFinite(initialLookbackMs) && initialLookbackMs >= 0
    ? initialLookbackMs
    : DEFAULT_JOB_ALERT_LOOKBACK_MS;
  const initialCursor = now - lookback;
  const createdAt = toMillis(alertCreatedAt);
  const safeCreatedAt = createdAt > 0 && createdAt <= now ? createdAt : 0;
  const lastSentAt = toMillis(recipientLastSentAt);

  if (lastSentAt > now) {
    return { cursorMs: now, reason: 'future-last-sent' };
  }
  if (lastSentAt > 0) {
    return {
      cursorMs: Math.max(lastSentAt, safeCreatedAt),
      reason: 'recipient-last-sent',
    };
  }
  return {
    cursorMs: Math.max(initialCursor, safeCreatedAt),
    reason: safeCreatedAt > initialCursor ? 'alert-created' : 'initial-lookback',
  };
}

/**
 * Select inventory rows that became available after the recipient's cursor.
 *
 * This function intentionally does not use `firstSeenAt` for the lower bound:
 * an offer first discovered before the recipient's last send may still be a
 * legitimate catch-up item if it was not previously sent to that alert. The
 * per-alert `sentJobIds` ledger remains the duplicate guard; firstSeenAt is
 * reserved for freshness copy/ranking.
 *
 * @returns {{jobs: object[], cursorMs: number, reason: string, excluded: {
 *   missingInventoryTimestamp: number,
 *   futureInventoryTimestamp: number,
 *   closed: number,
 * }}}
 */
export function selectJobAlertCandidates(jobs, options = {}) {
  const now = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const cursor = resolveJobAlertCursor(options);
  const selected = [];
  const excluded = {
    missingInventoryTimestamp: 0,
    futureInventoryTimestamp: 0,
    closed: 0,
  };

  for (const job of jobs || []) {
    const inventoryAt = jobInventoryTimestampMs(job);
    if (!inventoryAt) {
      excluded.missingInventoryTimestamp++;
      continue;
    }
    if (inventoryAt > now) {
      excluded.futureInventoryTimestamp++;
      continue;
    }
    if (inventoryAt <= cursor.cursorMs) continue;
    if (!isOpenJobAlertJob(job, now)) {
      excluded.closed++;
      continue;
    }
    selected.push(job);
  }

  return {
    jobs: selected,
    cursorMs: cursor.cursorMs,
    reason: cursor.reason,
    excluded,
  };
}

const ROW_MISSING_TIMESTAMP = 0;
const ROW_FUTURE_TIMESTAMP = 1;
const ROW_CLOSED = 2;
const ROW_OPEN = 3;

/**
 * {@link selectJobAlertCandidates} for many recipients over ONE inventory and
 * ONE clock (#9314). The daily sender selects a window per alert (5.160 alerts
 * x ~20K rows in run 36097910375), and every call re-parsed each row's
 * inventory timestamp and re-checked its expiry fields — facts that depend
 * only on the row and on `nowMs`, never on the recipient. They are computed
 * once here; each `select()` then only compares the precomputed timestamps
 * with that recipient's cursor.
 *
 * `select(options)` returns exactly what
 * `selectJobAlertCandidates(jobs, { ...options, nowMs })` returns — same rows
 * in the same order, same cursor, reason and exclusion counts — for the
 * `nowMs` fixed here. The inventory must not change between two calls.
 *
 * @param {Iterable<object>} jobs
 * @param {{nowMs?: number}} [options]
 * @returns {(options?: {recipientLastSentAt?: unknown, alertCreatedAt?: unknown, initialLookbackMs?: number}) => ReturnType<typeof selectJobAlertCandidates>}
 */
export function createJobAlertCandidateSelector(jobs, { nowMs } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const rows = [];
  for (const job of jobs || []) rows.push(job);
  const inventoryAt = new Float64Array(rows.length);
  const state = new Uint8Array(rows.length);
  let missingInventoryTimestamp = 0;
  let futureInventoryTimestamp = 0;
  for (let i = 0; i < rows.length; i++) {
    const at = jobInventoryTimestampMs(rows[i]);
    inventoryAt[i] = at;
    if (!at) {
      state[i] = ROW_MISSING_TIMESTAMP;
      missingInventoryTimestamp++;
    } else if (at > now) {
      state[i] = ROW_FUTURE_TIMESTAMP;
      futureInventoryTimestamp++;
    } else {
      state[i] = isOpenJobAlertJob(rows[i], now) ? ROW_OPEN : ROW_CLOSED;
    }
  }

  return function select(options = {}) {
    const cursor = resolveJobAlertCursor({ ...options, nowMs: now });
    const selected = [];
    let closed = 0;
    for (let i = 0; i < rows.length; i++) {
      const rowState = state[i];
      if (rowState < ROW_CLOSED) continue; // counted once above, before any cursor
      if (inventoryAt[i] <= cursor.cursorMs) continue;
      if (rowState === ROW_CLOSED) {
        closed++;
        continue;
      }
      selected.push(rows[i]);
    }
    return {
      jobs: selected,
      cursorMs: cursor.cursorMs,
      reason: cursor.reason,
      excluded: { missingInventoryTimestamp, futureInventoryTimestamp, closed },
    };
  };
}
