/**
 * Cloudflare Workers invocation metrics.
 *
 * The dashboard's "Errors" chart is backed by workersInvocationsAdaptive.
 * Query each error status separately: an unfiltered account query can hit
 * Cloudflare's row cap before it has returned every error row for one Worker.
 */
import {
  CF_ANALYTICS_MAX_ROWS,
  MAX_HOURS,
  cfGraphQL,
} from './cf-analytics.mjs';

export const WORKER_NAME = 'frontaliere-locale-router';

export const WORKER_ERROR_STATUSES = Object.freeze([
  'scriptThrewException',
  'exceededResources',
  'internalError',
]);

export const WORKER_INVOCATIONS_QUERY = `
query GetWorkersInvocationErrors(
  $accountTag: string!
  $datetimeStart: Time!
  $datetimeEnd: Time!
  $scriptName: string!
  $status: string!
  $limit: Int!
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: $limit
        filter: {
          scriptName: $scriptName
          status: $status
          datetime_geq: $datetimeStart
          datetime_leq: $datetimeEnd
        }
      ) {
        sum { requests errors }
        dimensions { datetime scriptName status }
      }
    }
  }
}`;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parseHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`Invalid Cloudflare Worker metrics window: ${value}`);
  }
  return Math.min(hours, MAX_HOURS);
}

function parseDate(value, fallback) {
  const timestamp = Date.parse(String(value ?? ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function summarizeStatus(status, rows, limit, window) {
  const requests = rows.reduce((total, row) => total + finiteNumber(row?.sum?.requests), 0);
  const errors = rows.reduce((total, row) => total + finiteNumber(row?.sum?.errors), 0);
  const dates = rows
    .map((row) => Date.parse(String(row?.dimensions?.datetime ?? '')))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  return {
    status,
    requests,
    errors,
    errorRate: requests > 0 ? errors / requests : 0,
    rows: rows.length,
    complete: rows.length < limit,
    firstAt: dates.length ? new Date(dates[0]).toISOString() : null,
    latestAt: dates.length ? new Date(dates[dates.length - 1]).toISOString() : null,
    window,
  };
}

/**
 * Read the three error series shown by the Workers Metrics dashboard.
 *
 * @param {string} token Cloudflare API token with account analytics access
 * @param {string} accountTag Cloudflare account id/tag
 * @param {object} [opts]
 * @param {number} [opts.hours=23] trailing window, capped below one day
 * @param {Date|string} [opts.until=new Date()] window end
 * @param {string} [opts.scriptName=WORKER_NAME]
 * @param {string[]} [opts.statuses=WORKER_ERROR_STATUSES]
 * @param {number} [opts.limit=CF_ANALYTICS_MAX_ROWS]
 * @param {typeof fetch} [opts.fetchImpl=fetch]
 * @returns {Promise<{worker:string,accountTag:string,window:{hours:number,from:string,to:string},statuses:Array<object>,complete:boolean}>}
 */
export async function fetchWorkerInvocationErrors(token, accountTag, opts = {}) {
  if (!token) throw new Error('Cloudflare API token is missing.');
  if (!accountTag) throw new Error('Cloudflare account tag is missing.');

  const hours = parseHours(opts.hours ?? 23);
  const until = opts.until ? new Date(opts.until) : new Date();
  if (!Number.isFinite(until.getTime())) throw new Error('Invalid Cloudflare Worker metrics end time.');
  const window = {
    hours,
    from: new Date(until.getTime() - hours * 3_600_000).toISOString(),
    to: until.toISOString(),
  };
  const scriptName = opts.scriptName || WORKER_NAME;
  const statuses = opts.statuses || WORKER_ERROR_STATUSES;
  const limit = opts.limit ?? CF_ANALYTICS_MAX_ROWS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!Array.isArray(statuses) || statuses.length === 0) throw new Error('No Worker error statuses configured.');
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('Invalid Cloudflare Worker metrics row limit.');

  const measurements = [];
  for (const status of statuses) {
    const data = await cfGraphQL(token, WORKER_INVOCATIONS_QUERY, {
      accountTag,
      datetimeStart: window.from,
      datetimeEnd: window.to,
      scriptName,
      status,
      limit,
    }, fetchImpl);
    const accounts = data?.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error(`Cloudflare account ${accountTag} was not returned for Worker metrics.`);
    }
    const rows = accounts[0]?.workersInvocationsAdaptive;
    if (!Array.isArray(rows)) throw new Error(`Cloudflare returned no rows for Worker status ${status}.`);
    measurements.push(summarizeStatus(status, rows, limit, window));
  }

  return {
    worker: scriptName,
    accountTag,
    window,
    statuses: measurements,
    complete: measurements.every((measurement) => measurement.complete),
  };
}

export function statusMeasurement(measurement, status) {
  return measurement?.statuses?.find((item) => item.status === status) || null;
}

export function measurementIsClean(measurement, status) {
  const item = statusMeasurement(measurement, status);
  return measurement?.complete === true && item?.complete === true && item.errors === 0;
}

export function measurementAt(measurement) {
  return parseDate(measurement?.window?.to, new Date().toISOString());
}
