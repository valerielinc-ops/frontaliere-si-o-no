import { GRAPH_API } from './instagram-graph-constants.mjs';
import { fetchRetry } from './ga4-service-account.mjs';

function safeCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/u.test(value.trim())) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function failureStatus(response, payload) {
  const code = Number(payload?.error?.code);
  if (response?.status === 401 || response?.status === 403 || code === 10 || code === 190) {
    return 'permission-unavailable';
  }
  if (response?.status === 429 || code === 4 || code === 17 || code === 32) return 'rate-limited';
  return 'api-error';
}

/** Collect one private account-level follower count without retaining the account ID. */
export async function collectInstagramAudienceSnapshot({
  accountId,
  accessToken,
  asOf = new Date(),
  fetchImpl = fetchRetry,
} = {}) {
  const snapshotAt = new Date(asOf).toISOString();
  if (!String(accountId || '').trim()) return { status: 'account-id-missing', snapshotAt, snapshot: null };
  if (!String(accessToken || '').trim()) return { status: 'credentials-missing', snapshotAt, snapshot: null };

  const url = new URL(`${GRAPH_API}/${encodeURIComponent(String(accountId).trim())}`);
  url.searchParams.set('fields', 'followers_count');
  let response;
  let payload;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    }, 2, 30_000);
    payload = await response.json().catch(() => null);
  } catch (error) {
    return {
      status: 'network-error',
      reasonCode: String(error?.name || 'request-failed').replace(/[^a-z0-9_-]/giu, '_').slice(0, 60),
      snapshotAt,
      snapshot: null,
    };
  }

  if (!response?.ok || payload?.error) {
    const errorCode = payload?.error?.code;
    return {
      status: failureStatus(response, payload),
      reasonCode: errorCode === undefined ? `http-${Number(response?.status) || 0}` : `graph-${String(errorCode).slice(0, 24)}`,
      snapshotAt,
      snapshot: null,
    };
  }
  const value = safeCount(payload?.followers_count);
  if (value === null) return { status: 'metric-unavailable', snapshotAt, snapshot: null };
  return {
    status: 'available',
    snapshotAt,
    snapshot: {
      channel: 'instagram',
      metric: 'followers',
      value,
      snapshotAt,
      status: 'available',
      source: 'instagram-graph-user',
    },
  };
}
