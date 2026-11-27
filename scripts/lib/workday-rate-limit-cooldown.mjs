/**
 * Cross-run cooldown for a Workday tenant that answers HTTP 429 (#20279).
 *
 * Workday throttles at the TENANT level: alcon, bossard, ferring and huntsman
 * answer 429 to the very first request of a run, from a GitHub runner and from
 * the Google Cloud relay egress alike. Every scheduled run used to hit those
 * tenants again, which can only prolong the throttling and leaves a red
 * crawler-health entry for each run. The in-run circuit
 * (`createWorkdayRequestContext`) and the runner egress state (#20086) live and
 * die with one run; this module is the memory BETWEEN runs.
 *
 * Where the memory lives: in the crawler's own summary slice
 * (jobs-crawler-summaries/by-crawler/<key>.json under the data directory), under the
 * `workdayRateLimit` field. That file is already (a) written by every crawler
 * on every run, the exit guard included, (b) committed with the group, (c)
 * present in the next run's checkout and (d) read by the crawler-health
 * monitor. The crawler-health state file is the monitor's derived state (no
 * crawler writes it) and the crawler-quarantine registry is group membership,
 * so neither can carry a per-run, per-tenant observation.
 *
 * Contract, per tenant:
 *   - a run that CLOSES in 429 (the last outcome of the tenant in that process
 *     was a terminal 429, direct and via relay) records
 *     `{ tenant, firstRateLimitedAt, lastRateLimitedAt, consecutiveRuns,
 *        nextAttemptAfter }`;
 *   - the delay doubles with the series: 6 h, 12 h, 24 h, capped at 24 h, and a
 *     `Retry-After` longer than the step is honoured (also capped at 24 h);
 *   - until `nextAttemptAfter` the next runs do NOT contact the tenant at all:
 *     the client throws a typed error before any request, the crawler takes its
 *     existing fail-closed soft exit (the previous slice stays live) and the
 *     summary carries the same record with outcome `rate-limited-cooldown`;
 *   - the first request that succeeds clears it: a summary without the field.
 *
 * Fail-open by construction: a missing, unparseable or inconsistent record
 * means "no cooldown" (the tenant is contacted as before), and a record can
 * never block a tenant for more than 24 h after its last contact.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Backoff per consecutive rate-limited run; the last step is also the cap. */
export const WORKDAY_COOLDOWN_STEPS_MS = Object.freeze([6 * HOUR_MS, 12 * HOUR_MS, 24 * HOUR_MS]);
export const WORKDAY_COOLDOWN_CAP_MS = WORKDAY_COOLDOWN_STEPS_MS[WORKDAY_COOLDOWN_STEPS_MS.length - 1];

/** The run contacted the tenant and it closed in 429: a cooldown starts or grows. */
export const WORKDAY_RATE_LIMITED_OUTCOME = 'rate-limited';
/** The run did not contact the tenant because its cooldown had not expired. */
export const WORKDAY_COOLDOWN_OUTCOME = 'rate-limited-cooldown';

const CLOCK_SKEW_MS = 5 * 60 * 1000;

const OUTCOMES = new Set([WORKDAY_RATE_LIMITED_OUTCOME, WORKDAY_COOLDOWN_OUTCOME]);

function parseIso(value) {
  if (typeof value !== 'string') return NaN;
  return Date.parse(value);
}

/**
 * Backoff for the Nth consecutive rate-limited run.
 *
 * @param {number} consecutiveRuns 1-based
 * @param {number|null} [retryAfterMs] vendor `Retry-After`, honoured when longer
 * @returns {number}
 */
export function workdayCooldownDelayMs(consecutiveRuns, retryAfterMs = null) {
  const index = Math.min(Math.max(1, Math.floor(Number(consecutiveRuns) || 1)), WORKDAY_COOLDOWN_STEPS_MS.length) - 1;
  const step = WORKDAY_COOLDOWN_STEPS_MS[index];
  const hint = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
  return Math.min(WORKDAY_COOLDOWN_CAP_MS, Math.max(step, hint));
}

/**
 * Validate a record read from a summary. Returns a clean copy or `null`.
 *
 * A record whose `lastRateLimitedAt` lies in the future (beyond clock skew) is
 * rejected: it would anchor the 24 h cap far ahead and silence the tenant.
 *
 * @param {unknown} raw
 * @param {number} [nowMs]
 */
export function normalizeWorkdayCooldownRecord(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { tenant, firstRateLimitedAt, lastRateLimitedAt, consecutiveRuns, nextAttemptAfter, outcome } = raw;
  if (typeof tenant !== 'string' || tenant.trim() === '') return null;
  if (!Number.isSafeInteger(consecutiveRuns) || consecutiveRuns < 1) return null;
  if (![firstRateLimitedAt, lastRateLimitedAt, nextAttemptAfter].every((value) => Number.isFinite(parseIso(value)))) {
    return null;
  }
  if (parseIso(lastRateLimitedAt) > nowMs + CLOCK_SKEW_MS) return null;
  if (parseIso(firstRateLimitedAt) > parseIso(lastRateLimitedAt)) return null;
  if (!OUTCOMES.has(outcome)) return null;
  return {
    tenant,
    firstRateLimitedAt,
    lastRateLimitedAt,
    consecutiveRuns,
    nextAttemptAfter,
    outcome,
  };
}

/** Epoch ms until which the tenant must not be contacted (never beyond the cap). */
export function workdayCooldownDeadlineMs(record) {
  const next = parseIso(record.nextAttemptAfter);
  const last = parseIso(record.lastRateLimitedAt);
  return Math.min(next, last + WORKDAY_COOLDOWN_CAP_MS);
}

/** Whether a (normalized) record still forbids contacting its tenant at `nowMs`. */
export function isWorkdayCooldownActive(record, nowMs) {
  return Boolean(record) && nowMs < workdayCooldownDeadlineMs(record);
}

/**
 * The record after a run that contacted the tenant and closed in 429.
 *
 * @param {unknown} previous the record the run started with (any tenant)
 * @param {{ tenant: string, nowMs: number, retryAfterMs?: number|null }} event
 */
export function nextWorkdayCooldownRecord(previous, { tenant, nowMs, retryAfterMs = null }) {
  const prior = normalizeWorkdayCooldownRecord(previous, nowMs);
  const sameTenant = prior && prior.tenant === tenant ? prior : null;
  const consecutiveRuns = sameTenant ? sameTenant.consecutiveRuns + 1 : 1;
  const nowIso = new Date(nowMs).toISOString();
  return {
    tenant,
    firstRateLimitedAt: sameTenant ? sameTenant.firstRateLimitedAt : nowIso,
    lastRateLimitedAt: nowIso,
    consecutiveRuns,
    nextAttemptAfter: new Date(nowMs + workdayCooldownDelayMs(consecutiveRuns, retryAfterMs)).toISOString(),
    outcome: WORKDAY_RATE_LIMITED_OUTCOME,
  };
}

/* ── Process-level registry ──────────────────────────────────────────────
 * One crawler is one node process, so the registry is the run's memory of
 * what the tenant(s) answered. The summary writer reads it at the end. */

/** @type {Map<string, { previous: object|null, skipped: boolean, rateLimited: { retryAfterMs: number|null }|null, succeeded: boolean }>} */
const registry = new Map();

function entryFor(tenant) {
  if (!registry.has(tenant)) {
    registry.set(tenant, { previous: null, skipped: false, rateLimited: null, succeeded: false });
  }
  return registry.get(tenant);
}

/** Load the record of the previous run's summary (called when the crawler registers). */
export function hydrateWorkdayCooldown(raw, nowMs = Date.now()) {
  const record = normalizeWorkdayCooldownRecord(raw, nowMs);
  if (record) entryFor(record.tenant).previous = record;
  return record;
}

/**
 * Called before a request to `tenant`. Returns the active record (and marks the
 * tenant as skipped by cooldown for this run), or `null` when it may be contacted.
 */
export function checkWorkdayCooldown(tenant, nowMs = Date.now()) {
  const entry = registry.get(tenant);
  if (!entry?.previous || !isWorkdayCooldownActive(entry.previous, nowMs)) return null;
  entry.skipped = true;
  return entry.previous;
}

/** A request of this process ended in a terminal 429 (direct and relay both exhausted). */
export function noteWorkdayRateLimited(tenant, { retryAfterMs = null } = {}) {
  const entry = entryFor(tenant);
  entry.rateLimited = { retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null };
  entry.succeeded = false;
}

/** A request of this process got a real answer: the tenant is serving this run. */
export function noteWorkdayRequestSucceeded(tenant) {
  const entry = entryFor(tenant);
  entry.rateLimited = null;
  entry.succeeded = true;
}

/**
 * The `workdayRateLimit` field for this run's summary, or `null` (absent).
 * Idempotent: it derives from the run's start record and its events, so a
 * second summary write in the same process yields the same value.
 */
export function workdayCooldownSummaryField(nowMs = Date.now()) {
  let chosen = null;
  for (const [tenant, entry] of registry) {
    let record = null;
    if (entry.succeeded) {
      record = null;
    } else if (entry.rateLimited) {
      record = nextWorkdayCooldownRecord(entry.previous, { tenant, nowMs, retryAfterMs: entry.rateLimited.retryAfterMs });
    } else if (entry.previous && entry.skipped) {
      record = { ...entry.previous, outcome: WORKDAY_COOLDOWN_OUTCOME };
    } else if (entry.previous && isWorkdayCooldownActive(entry.previous, nowMs)) {
      // Not contacted and not proven healthy (e.g. an early crash): keep the
      // memory rather than letting an unrelated failure reset the backoff.
      record = entry.previous;
    }
    if (record && (!chosen || parseIso(record.nextAttemptAfter) > parseIso(chosen.nextAttemptAfter))) chosen = record;
  }
  return chosen;
}

/** Test isolation for the process-wide registry. */
export function resetWorkdayCooldownRegistryForTests() {
  registry.clear();
}
