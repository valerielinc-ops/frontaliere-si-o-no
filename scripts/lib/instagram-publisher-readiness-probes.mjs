import { GRAPH_API } from './instagram-graph-constants.mjs';

const PROBE_TIMEOUT_MS = 15000;
const REQUIRED_PUBLISH_PERMISSION = 'instagram_content_publish';

async function getGraphJson(url, accessToken, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null);
    if (!response?.ok || payload?.error) {
      const status = Number(response?.status) || 0;
      const code = Number(payload?.error?.code);
      return {
        ok: false,
        note: `Meta Graph probe failed (HTTP ${status}${Number.isFinite(code) && code > 0 ? `, code ${code}` : ''})`,
      };
    }
    return { ok: true, payload };
  } catch (error) {
    const reasonCode = String(error?.name || 'network-error').replace(/[^a-z0-9_-]/giu, '_').slice(0, 40);
    return { ok: false, note: `Meta Graph probe failed (${reasonCode})` };
  }
}

/** Check the Facebook user token's explicit Instagram publishing grant. */
export async function probeInstagramPublishPermission({ userAccessToken, fetchImpl = fetch } = {}) {
  const token = String(userAccessToken || '').trim();
  if (!token) {
    return {
      publishPermissionStatus: 'unavailable',
      note: 'Publish permission probe skipped because FB_USER_ACCESS_TOKEN is missing',
    };
  }

  const url = new URL(`${GRAPH_API}/me/permissions`);
  const result = await getGraphJson(url.toString(), token, fetchImpl);
  if (!result.ok) return { publishPermissionStatus: 'unavailable', note: result.note };

  const permissions = Array.isArray(result.payload?.data) ? result.payload.data : null;
  if (!permissions) {
    return {
      publishPermissionStatus: 'unavailable',
      note: 'Meta permission response did not contain a permissions list',
    };
  }

  const permission = permissions.find((item) => item?.permission === REQUIRED_PUBLISH_PERMISSION);
  if (permission?.status === 'granted') {
    return {
      publishPermissionStatus: 'granted',
      note: 'Meta reports instagram_content_publish as granted',
    };
  }
  return {
    publishPermissionStatus: 'missing',
    note: 'Meta does not report instagram_content_publish as granted',
  };
}

/** Verify that the configured publisher token can read the exact target account. */
export async function probeInstagramPublisherToken({
  instagramAccountId,
  accessToken,
  fetchImpl = fetch,
} = {}) {
  const accountId = String(instagramAccountId || '').trim();
  const token = String(accessToken || '').trim();
  if (!accountId || !token) {
    return {
      publisherTokenStatus: 'unavailable',
      note: 'Publisher token probe skipped because INSTAGRAM_BUSINESS_ACCOUNT_ID or INSTAGRAM_ACCESS_TOKEN is missing',
    };
  }

  const url = new URL(`${GRAPH_API}/${encodeURIComponent(accountId)}`);
  url.searchParams.set('fields', 'id');
  const result = await getGraphJson(url.toString(), token, fetchImpl);
  if (!result.ok) return { publisherTokenStatus: 'unavailable', note: result.note };

  const returnedId = String(result.payload?.id || '').trim();
  if (!returnedId) {
    return {
      publisherTokenStatus: 'unverified',
      note: 'Publisher token response did not expose the Instagram account ID',
    };
  }
  if (returnedId !== accountId) {
    return {
      publisherTokenStatus: 'mismatch',
      note: 'Publisher token resolves to a different Instagram account than configured',
    };
  }
  return {
    publisherTokenStatus: 'matched',
    note: 'Publisher token resolves to the configured Instagram account',
  };
}
