/**
 * Cloud Logging reader for Cloud Functions errors (scripts/cloud-function-error-issue-sync.mjs).
 *
 * Counts ERROR-or-worse log entries per function over a trailing window using
 * the Logging API `entries:list` (read-only scope). Only counts, function names
 * and timestamps leave this module: log payloads can carry user data, so they
 * are never copied into issues or run logs.
 *
 * Needs the service account to hold `roles/logging.viewer` (permission
 * `logging.logEntries.list`) on the project; without it the API answers 403 and
 * the caller reports "could not measure", never "no errors".
 */
import { getServiceAccountToken } from './ga4-service-account.mjs';

export const LOGGING_READ_SCOPE = 'https://www.googleapis.com/auth/logging.read';
export const LOGGING_ENDPOINT = 'https://logging.googleapis.com/v2/entries:list';
export const DEFAULT_PROJECT_ID = 'frontaliere-ticino';
export const MAX_PAGES = 10;
export const PAGE_SIZE = 1000;
/** Function ids are DNS-label-like; anything else is not trusted as an issue title part. */
const FUNCTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The Logging filter: errors from 1st-gen (`cloud_function`) and 2nd-gen (`cloud_run_revision`) functions. */
export function buildFilter({ since }) {
  return [
    'severity>=ERROR',
    '(resource.type="cloud_function" OR resource.type="cloud_run_revision")',
    `timestamp>="${since.toISOString()}"`,
  ].join(' AND ');
}

/** The function a log entry belongs to, or null when it cannot be named safely. */
export function functionNameOf(entry) {
  const labels = entry?.resource?.labels || {};
  const raw = labels.function_name || labels.service_name || '';
  return FUNCTION_NAME_RE.test(raw) ? raw : null;
}

/**
 * @param {{ token: string, projectId?: string, hours?: number, now?: Date, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ projectId: string, window: {hours:number,from:string,to:string}, functions: Array<{name:string,errors:number,latestAt:string}>, entries: number, complete: boolean }>}
 *   `complete` is false when the page cap was hit: the counts are then a lower bound.
 */
export async function fetchFunctionErrors({ token, projectId = DEFAULT_PROJECT_ID, hours = 24, now = new Date(), fetchImpl = fetch }) {
  const since = new Date(now.getTime() - hours * 3_600_000);
  const counts = new Map();
  let pageToken;
  let pages = 0;
  let total = 0;
  do {
    const res = await fetchImpl(LOGGING_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resourceNames: [`projects/${projectId}`],
        filter: buildFilter({ since }),
        orderBy: 'timestamp desc',
        pageSize: PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Cloud Logging ${res.status}${res.status === 403 ? ' (service account needs roles/logging.viewer)' : ''}`);
    const data = await res.json();
    for (const entry of data.entries || []) {
      total++;
      const name = functionNameOf(entry);
      if (!name) continue;
      const cur = counts.get(name) || { name, errors: 0, latestAt: '' };
      cur.errors++;
      if (entry.timestamp && entry.timestamp > cur.latestAt) cur.latestAt = entry.timestamp;
      counts.set(name, cur);
    }
    pageToken = data.nextPageToken;
    pages++;
  } while (pageToken && pages < MAX_PAGES);
  return {
    projectId,
    window: { hours, from: since.toISOString(), to: now.toISOString() },
    functions: [...counts.values()].sort((a, b) => b.errors - a.errors || a.name.localeCompare(b.name)),
    entries: total,
    complete: !pageToken,
  };
}

export const getLoggingToken = () => getServiceAccountToken([LOGGING_READ_SCOPE], { logInfo: () => {}, logError: () => {} });
