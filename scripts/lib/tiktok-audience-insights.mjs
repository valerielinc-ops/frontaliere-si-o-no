import { fetchRetry } from './ga4-service-account.mjs';
import { TIKTOK_API } from './tiktok-publish.mjs';

export const TIKTOK_AUDIENCE_SCOPE = 'user.info.stats';

function safeCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/u.test(value.trim())) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function failureStatus(response, payload) {
  const code = String(payload?.error?.code || '').toLowerCase();
  if (response?.status === 401 || response?.status === 403 || /scope|permission|unauthorized|access_token/u.test(code)) {
    return 'permission-unavailable';
  }
  if (response?.status === 429 || /rate_limit/u.test(code)) return 'rate-limited';
  return 'api-error';
}

/** Read only the authenticated user's follower total; callers must policy-gate this API use. */
export async function collectTikTokAudienceSnapshot({
  accessToken,
  asOf = new Date(),
  fetchImpl = fetchRetry,
} = {}) {
  const snapshotAt = new Date(asOf).toISOString();
  if (!String(accessToken || '').trim()) return { status: 'credentials-missing', snapshotAt, snapshot: null };
  const url = new URL(`${TIKTOK_API}/user/info/`);
  url.searchParams.set('fields', 'follower_count');
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

  const apiCode = String(payload?.error?.code || '').toLowerCase();
  if (!response?.ok || (apiCode && apiCode !== 'ok')) {
    return {
      status: failureStatus(response, payload),
      reasonCode: apiCode ? `tiktok-${apiCode.replace(/[^a-z0-9_-]/gu, '_').slice(0, 50)}` : `http-${Number(response?.status) || 0}`,
      snapshotAt,
      snapshot: null,
    };
  }
  const value = safeCount(payload?.data?.user?.follower_count);
  if (value === null) return { status: 'metric-unavailable', snapshotAt, snapshot: null };
  return {
    status: 'available',
    snapshotAt,
    snapshot: {
      channel: 'tiktok',
      metric: 'followers',
      value,
      snapshotAt,
      status: 'available',
      source: 'tiktok-user-info',
    },
  };
}
