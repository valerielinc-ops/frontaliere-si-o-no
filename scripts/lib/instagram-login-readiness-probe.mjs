import { INSTAGRAM_LOGIN_GRAPH_API } from './instagram-graph-constants.mjs';
import { hasInstagramLoginPublishScopes } from './instagram-publisher-credentials.mjs';

const PROBE_TIMEOUT_MS = 15_000;

export async function probeInstagramLoginPublisher({
  instagramUserId,
  expectedUsername,
  accessToken,
  tokenExpiresAt,
  grantedScopes,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const userId = String(instagramUserId || '').trim();
  const username = String(expectedUsername || '').replace(/^@/u, '').trim().toLowerCase();
  const token = String(accessToken || '').trim();
  const expiryMs = Date.parse(String(tokenExpiresAt || ''));
  if (!/^\d{5,32}$/u.test(userId) || !username || !token) {
    return { loginPublisherStatus: 'unavailable', note: 'Instagram Login token, account ID, or expected username is missing' };
  }
  if (!Number.isFinite(expiryMs) || expiryMs <= now) {
    return { loginPublisherStatus: 'expired', note: 'Instagram Login token expiration is missing or has passed; refresh or reconnect the account' };
  }
  if (!hasInstagramLoginPublishScopes(grantedScopes)) {
    return { loginPublisherStatus: 'missing-publish-scope', note: 'Instagram Login token was not verified with the required publishing scopes' };
  }

  const url = new URL(`${INSTAGRAM_LOGIN_GRAPH_API}/${encodeURIComponent(userId)}`);
  url.searchParams.set('fields', 'user_id,username,account_type');
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null);
    if (!response?.ok || payload?.error) {
      const status = Number(response?.status) || 0;
      const code = Number(payload?.error?.code);
      return {
        loginPublisherStatus: 'unavailable',
        note: `Instagram Login profile probe failed (HTTP ${status}${Number.isFinite(code) && code > 0 ? `, code ${code}` : ''})`,
      };
    }
    const returnedId = String(payload?.user_id || '').trim();
    if (returnedId !== userId) {
      return { loginPublisherStatus: 'mismatch', note: 'Instagram Login token resolves to a different professional account ID' };
    }
    const returnedUsername = String(payload?.username || '').replace(/^@/u, '').trim().toLowerCase();
    if (returnedUsername !== username) {
      return { loginPublisherStatus: 'mismatch', note: 'Instagram Login token resolves to a different Instagram username' };
    }
    const accountType = String(payload?.account_type || '').toUpperCase();
    if (!['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(accountType)) {
      return { loginPublisherStatus: 'not-professional', note: 'Instagram Login account is not a Business or Creator professional profile' };
    }
    return { loginPublisherStatus: 'matched', note: 'Instagram Login token resolves to the configured professional account and username' };
  } catch (error) {
    const reasonCode = String(error?.name || 'network-error').replace(/[^a-z0-9_-]/giu, '_').slice(0, 40);
    return { loginPublisherStatus: 'unavailable', note: `Instagram Login profile probe failed (${reasonCode})` };
  }
}
