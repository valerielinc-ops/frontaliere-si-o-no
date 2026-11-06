/**
 * Shared Google Places Text Search budget primitives.
 *
 * The prospector asks for `websiteUri`, which makes its request Text Search
 * Enterprise. Pharmacy enrichment asks for display name and formatted
 * address, which is Text Search Pro. The operational allocations below are
 * deliberately below both official free-use caps and leave 100 requests of
 * headroom even if Google changes which field is billed at the higher SKU.
 *
 * Google policies allow a place_id to be retained indefinitely, but returned
 * place content is transient. This module therefore stores only counters;
 * neither a website URI nor a display name can enter a budget ledger.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Google pricing page: Places API Text Search Enterprise free-use cap. */
export const GOOGLE_PLACES_TEXT_SEARCH_ENTERPRISE_FREE_CAP = 1_000;
/** Google pricing page: Places API Text Search Pro free-use cap. */
export const GOOGLE_PLACES_TEXT_SEARCH_PRO_FREE_CAP = 5_000;

/** Owner-approved monthly allocation for the websiteUri resolver. */
export const PROSPECTOR_GOOGLE_PLACES_MONTHLY_LIMIT = 800;
/** Owner-approved pharmacy allocation; 800 + 100 stays below Enterprise's cap. */
export const PHARMACY_GOOGLE_PLACES_MONTHLY_LIMIT = 100;
export const GOOGLE_PLACES_SHARED_OPERATIONAL_LIMIT =
  PROSPECTOR_GOOGLE_PLACES_MONTHLY_LIMIT + PHARMACY_GOOGLE_PLACES_MONTHLY_LIMIT;

export const GOOGLE_PLACES_STOP_STATUSES = Object.freeze(new Set([401, 403, 429]));

const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

export function validGooglePlacesMonth(value) {
  return MONTH_RE.test(String(value || ''));
}

export function googlePlacesMonthKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid Google Places checkedAt: ${value}`);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Return a safe per-provider monthly limit. An absent/invalid configuration
 * uses the hard allocation; a configuration above that allocation is a
 * configuration error and must be rejected by the caller rather than
 * silently becoming a larger spend.
 */
export function googlePlacesMonthlyLimit(value, fallback) {
  const configured = Number(value);
  if (!Number.isInteger(configured) || configured <= 0) return fallback;
  return configured;
}

export function assertGooglePlacesMonthlyLimit(value, maximum, label = 'googlePlaces') {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`${label} monthlyRequestLimit must be a positive integer`);
  }
  if (limit > maximum) throw new Error(`${label} monthlyRequestLimit cannot exceed ${maximum}`);
  return limit;
}

/**
 * Rehydrate a providerUsage ledger. Invalid current-month state fails closed
 * at the caller's hard allocation: a damaged file can never authorize extra
 * requests. An older month starts at zero.
 */
export function googlePlacesProviderUsage(previous, checkedAt, maximum) {
  const month = googlePlacesMonthKey(checkedAt);
  const previousUsage = previous?.providerUsage;
  const previousRequests = previousUsage?.month === month
    ? Number(previousUsage?.googlePlaces?.requests)
    : 0;
  return {
    month,
    googlePlaces: {
      requests: Number.isInteger(previousRequests)
        ? Math.min(Math.max(previousRequests, 0), maximum)
        : maximum,
    },
  };
}

/** Reserve before the provider call. A failed call remains counted. */
export function reserveGooglePlacesRequest(providerUsage, monthlyLimit) {
  if (!providerUsage?.googlePlaces || providerUsage.googlePlaces.requests >= monthlyLimit) return false;
  providerUsage.googlePlaces.requests += 1;
  return true;
}

export function googlePlacesStatus(value) {
  const status = Number(value?.status ?? value?.response?.status ?? value);
  return Number.isInteger(status) ? status : 0;
}

export function isGooglePlacesStopStatus(value) {
  return GOOGLE_PLACES_STOP_STATUSES.has(googlePlacesStatus(value));
}

function readPersistentLedger(file, month, maximum) {
  if (!file) return { month, requests: 0, malformed: false };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { month, requests: 0, malformed: false };
    return { month, requests: maximum, malformed: true };
  }
  const requests = parsed?.month === month ? parsed?.googlePlaces?.requests : 0;
  if (!validGooglePlacesMonth(parsed?.month)
    || parsed?.schemaVersion !== 1
    || (parsed.month === month && (!Number.isInteger(requests) || requests < 0 || requests > maximum))) {
    return { month, requests: maximum, malformed: true };
  }
  return { month, requests, malformed: false };
}

function writePersistentLedger(file, state) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({
      schemaVersion: 1,
      month: state.month,
      googlePlaces: { requests: state.requests },
    }, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * A synchronous reservation object shared by concurrent TRACE lanes. The
 * increment and atomic write happen before the async API call begins, so
 * 401/403/429, parse failures, and transport failures all consume a slot.
 */
export function createPersistentGooglePlacesBudget({
  file = null,
  checkedAt = new Date().toISOString(),
  monthlyLimit,
  enabled = true,
} = {}) {
  if (!Number.isInteger(monthlyLimit) || monthlyLimit <= 0) {
    throw new Error('Google Places monthlyLimit must be a positive integer');
  }
  const month = googlePlacesMonthKey(checkedAt);
  const state = readPersistentLedger(file, month, monthlyLimit);
  let stoppedStatus = null;

  const budget = {
    get month() { return state.month; },
    get requests() { return state.requests; },
    get monthlyLimit() { return monthlyLimit; },
    get stoppedStatus() { return stoppedStatus; },
    get malformed() { return state.malformed; },
    get exhausted() { return state.requests >= monthlyLimit; },
    reserve() {
      if (!enabled || stoppedStatus || state.malformed || state.requests >= monthlyLimit) return false;
      state.requests += 1;
      writePersistentLedger(file, state);
      return true;
    },
    stop(status) {
      const normalized = googlePlacesStatus(status);
      if (GOOGLE_PLACES_STOP_STATUSES.has(normalized)) stoppedStatus = normalized;
    },
    snapshot() {
      return {
        month: state.month,
        googlePlaces: { requests: state.requests },
      };
    },
    reason() {
      if (!enabled) return 'disabled';
      if (state.malformed) return 'malformed_ledger';
      if (stoppedStatus) return `http_${stoppedStatus}`;
      if (state.requests >= monthlyLimit) return 'budget_exhausted';
      return null;
    },
  };
  return budget;
}
