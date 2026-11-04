import { GRAPH_API } from './instagram-graph-constants.mjs';

const PROBE_TIMEOUT_MS = 15000;
const REQUIRED_PUBLISH_PERMISSION = 'instagram_content_publish';
const INSTAGRAM_CAPABILITY_PERMISSIONS = Object.freeze([
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_insights',
  'instagram_manage_comments',
  'instagram_manage_messages',
  'pages_manage_metadata',
]);

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

/** Read the Facebook user token's granted Instagram scopes in one request. */
export async function probeInstagramPermissions({ userAccessToken, fetchImpl = fetch } = {}) {
  const unavailablePermissions = Object.fromEntries(
    INSTAGRAM_CAPABILITY_PERMISSIONS.map((permission) => [permission, 'unavailable']),
  );
  const token = String(userAccessToken || '').trim();
  if (!token) {
    return {
      permissionStatuses: unavailablePermissions,
      publishPermissionStatus: 'unavailable',
      note: 'Publish permission probe skipped because FB_USER_ACCESS_TOKEN is missing',
    };
  }

  const url = new URL(`${GRAPH_API}/me/permissions`);
  const result = await getGraphJson(url.toString(), token, fetchImpl);
  if (!result.ok) {
    return { permissionStatuses: unavailablePermissions, publishPermissionStatus: 'unavailable', note: result.note };
  }

  const permissions = Array.isArray(result.payload?.data) ? result.payload.data : null;
  if (!permissions) {
    return {
      permissionStatuses: unavailablePermissions,
      publishPermissionStatus: 'unavailable',
      note: 'Meta permission response did not contain a permissions list',
    };
  }

  const permissionStatuses = Object.fromEntries(INSTAGRAM_CAPABILITY_PERMISSIONS.map((name) => {
    const matches = permissions.filter((item) => item?.permission === name);
    if (matches.length === 0) return [name, 'missing'];
    const statuses = new Set(matches.map((item) => item?.status));
    if (statuses.size !== 1 || !['granted', 'declined', 'expired'].includes([...statuses][0])) {
      return [name, 'unavailable'];
    }
    return [name, [...statuses][0] === 'granted' ? 'granted' : 'missing'];
  }));
  const publishPermissionStatus = permissionStatuses[REQUIRED_PUBLISH_PERMISSION];
  return {
    permissionStatuses,
    publishPermissionStatus,
    note: publishPermissionStatus === 'granted'
      ? 'Meta reports instagram_content_publish as granted'
      : publishPermissionStatus === 'missing'
        ? 'Meta does not report instagram_content_publish as granted'
        : 'Meta publishing permission could not be verified',
  };
}

/** Check the Facebook user token's explicit Instagram publishing grant. */
export async function probeInstagramPublishPermission(options = {}) {
  const result = await probeInstagramPermissions(options);
  return { publishPermissionStatus: result.publishPermissionStatus, note: result.note };
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
