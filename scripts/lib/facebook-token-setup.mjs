import { GRAPH_API } from './instagram-graph-constants.mjs';
import {
  RC_SERVER_NAMESPACE,
  removeRcParamsWithEtag,
  stageRcParamValue,
  updateRcTemplateWithEtag,
} from './remote-config-admin.mjs';

const REQUIRED_USER_SCOPES = ['pages_show_list'];
const REQUIRED_PAGE_SCOPES = ['pages_manage_posts', 'pages_read_engagement'];
const REQUIRED_INSTAGRAM_PUBLISH_SCOPES = ['instagram_basic', 'instagram_content_publish'];
const CLIENT_TEMPLATE_META_SECRET_KEYS = [
  'SERVER_FB_USER_ACCESS_TOKEN',
  'SERVER_FB_USER_ACCESS_TOKEN_EXPIRES_AT',
  'SERVER_FB_PAGE_ACCESS_TOKEN',
  'SERVER_FB_PAGE_ACCESS_TOKEN_EXPIRES_AT',
  'SERVER_INSTAGRAM_ACCESS_TOKEN',
  'SERVER_INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT',
];
const REQUEST_TIMEOUT_MS = 15_000;

function assertCredential(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

async function graphJson(fetchImpl, url, { step, accessToken, method = 'GET' } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`${step} request failed; check network access and retry`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${step} returned an unreadable response`);
  }
  const error = body?.error;
  if (!response.ok || error) {
    const code = Number.isFinite(Number(error?.code)) ? `, Meta code ${Number(error.code)}` : '';
    throw new Error(`${step} failed (HTTP ${response.status}${code})`);
  }
  return body;
}

function tokenScopes(debugData, label) {
  const data = debugData?.data;
  if (data?.is_valid !== true) throw new Error(`${label} is invalid according to Meta`);
  if (!Array.isArray(data.scopes)) throw new Error(`${label} scopes could not be verified`);
  return new Set(data.scopes.filter((scope) => typeof scope === 'string'));
}

function requireScopes(scopes, required, label) {
  const missing = required.filter((scope) => !scopes.has(scope));
  if (missing.length) throw new Error(`${label} is missing required Meta permissions: ${missing.join(', ')}`);
}

function debugTokenUrl(token) {
  const url = new URL(`${GRAPH_API}/debug_token`);
  url.searchParams.set('input_token', token);
  return url;
}

function meAccountsUrl() {
  const url = new URL(`${GRAPH_API}/me/accounts`);
  url.searchParams.set('fields', 'id,name,access_token,instagram_business_account');
  return url;
}

function exchangeUrl({ appId, appSecret, shortLivedUserToken }) {
  const url = new URL(`${GRAPH_API}/oauth/access_token`);
  url.search = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLivedUserToken,
  }).toString();
  return url;
}

function metadataExpiry(value, label) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`${label} expiry could not be verified`);
  return seconds === 0 ? '0' : new Date(seconds * 1000).toISOString();
}

function stageParameters(template, parameters, description) {
  let next = template;
  let changed = false;
  for (const [name, value] of Object.entries(parameters)) {
    const staged = stageRcParamValue(next, name, value, description);
    if (staged.error) return staged;
    changed ||= staged.changed;
    if (staged.changed) next = staged.template;
  }
  return { changed, template: next };
}

/**
 * Exchanges and verifies Facebook tokens, then writes them to server-side
 * Firebase Remote Config parameters using ETag guarded publication. The
 * returned metadata never contains access-token values.
 */
export async function provisionFacebookPageCredentials({
  shortLivedUserToken,
  appId,
  appSecret,
  targetPageId = '',
  expectedInstagramAccountId = '',
  credentials,
  fetchImpl = fetch,
  updateConfig = updateRcTemplateWithEtag,
  removeClientConfig = removeRcParamsWithEtag,
  now = new Date(),
} = {}) {
  const shortToken = assertCredential(shortLivedUserToken, 'FB_SHORT_LIVED_USER_TOKEN');
  const clientId = assertCredential(appId, 'META_APP_ID');
  const clientSecret = assertCredential(appSecret, 'META_APP_SECRET');
  if (!credentials?.client_email || !credentials?.private_key || !credentials?.project_id) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS must contain a Firebase service account');
  }

  const exchanged = await graphJson(fetchImpl, exchangeUrl({
    appId: clientId,
    appSecret: clientSecret,
    shortLivedUserToken: shortToken,
  }), { step: 'Meta user-token exchange' });
  if (typeof exchanged.access_token !== 'string' || !exchanged.access_token
    || !Number.isFinite(Number(exchanged.expires_in)) || Number(exchanged.expires_in) <= 0) {
    throw new Error('Meta user-token exchange did not return a verifiable token lifetime');
  }
  const userToken = exchanged.access_token;
  const userTokenExpiresAt = new Date(now.getTime() + Number(exchanged.expires_in) * 1000).toISOString();

  const appAccessToken = `${clientId}|${clientSecret}`;
  const userDebug = await graphJson(fetchImpl, debugTokenUrl(userToken), {
    step: 'Meta user-token validation',
    accessToken: appAccessToken,
  });
  const userScopes = tokenScopes(userDebug, 'Long-lived user token');
  requireScopes(userScopes, REQUIRED_USER_SCOPES, 'Long-lived user token');
  if (String(userDebug.data.app_id || '') !== clientId) {
    throw new Error('Long-lived user token belongs to a different Meta app');
  }

  const pages = await graphJson(fetchImpl, meAccountsUrl(), {
    step: 'Meta Page discovery',
    accessToken: userToken,
  });
  const availablePages = Array.isArray(pages.data)
    ? pages.data.filter((page) => typeof page?.id === 'string' && typeof page?.access_token === 'string' && page.access_token)
    : [];
  const requestedPageId = String(targetPageId || '').trim();
  const page = requestedPageId
    ? availablePages.find((candidate) => candidate.id === requestedPageId)
    : availablePages.length === 1 ? availablePages[0] : null;
  if (!page) {
    throw new Error(requestedPageId
      ? 'The requested Facebook Page is not available to this Meta user token'
      : 'Select META_TARGET_PAGE_ID because this Meta user token can access multiple Pages');
  }

  const pageDebug = await graphJson(fetchImpl, debugTokenUrl(page.access_token), {
    step: 'Meta Page-token validation',
    accessToken: appAccessToken,
  });
  const pageScopes = tokenScopes(pageDebug, 'Facebook Page token');
  requireScopes(pageScopes, REQUIRED_PAGE_SCOPES, 'Facebook Page token');
  if (String(pageDebug.data.app_id || '') !== clientId) {
    throw new Error('Facebook Page token belongs to a different Meta app');
  }

  const linkedInstagramId = String(page.instagram_business_account?.id || '').trim();
  const instagramScopesGranted = REQUIRED_INSTAGRAM_PUBLISH_SCOPES.every((scope) => (
    userScopes.has(scope) && pageScopes.has(scope)
  ));
  let instagramPublisherIdentityVerified = false;
  if (linkedInstagramId && instagramScopesGranted) {
    const instagramIdentityUrl = new URL(`${GRAPH_API}/${encodeURIComponent(linkedInstagramId)}`);
    instagramIdentityUrl.searchParams.set('fields', 'id');
    try {
      const instagramIdentity = await graphJson(fetchImpl, instagramIdentityUrl, {
        step: 'Meta Instagram publisher identity validation',
        accessToken: page.access_token,
      });
      instagramPublisherIdentityVerified = String(instagramIdentity?.id || '') === linkedInstagramId;
    } catch {
      // Facebook credentials can still be provisioned; never install a
      // publisher token until Meta verifies the exact linked Instagram ID.
      instagramPublisherIdentityVerified = false;
    }
  }

  const description = `Facebook Page API credentials provisioned ${now.toISOString().slice(0, 10)}`;
  const parameters = {
    FB_PAGE_ID: page.id,
    SERVER_FB_USER_ACCESS_TOKEN: userToken,
    SERVER_FB_USER_ACCESS_TOKEN_EXPIRES_AT: userTokenExpiresAt,
    SERVER_FB_PAGE_ACCESS_TOKEN: page.access_token,
    SERVER_FB_PAGE_ACCESS_TOKEN_EXPIRES_AT: metadataExpiry(pageDebug.data.expires_at, 'Facebook Page token'),
  };
  let instagramPublisherConfigured = false;
  const update = await updateConfig({
    credentials,
    namespace: RC_SERVER_NAMESPACE,
    stage: (template) => {
      const expectedInstagramId = String(expectedInstagramAccountId || '').trim();
      instagramPublisherConfigured = Boolean(
        instagramPublisherIdentityVerified
        && linkedInstagramId
        && expectedInstagramId === linkedInstagramId,
      );
      const stagedParameters = instagramPublisherConfigured
        ? {
          ...parameters,
          SERVER_INSTAGRAM_ACCESS_TOKEN: page.access_token,
          SERVER_INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT: parameters.SERVER_FB_PAGE_ACCESS_TOKEN_EXPIRES_AT,
        }
        : parameters;
      return stageParameters(template, stagedParameters, description);
    },
    versionDescription: 'Provision Facebook Page API credentials with verified Meta scopes',
  });
  if (!update?.ok) throw new Error(`Firebase Remote Config update failed${update?.detail ? ` (${update.detail})` : ''}`);

  const clientCleanup = await removeClientConfig({
    credentials,
    namespace: 'firebase',
    names: CLIENT_TEMPLATE_META_SECRET_KEYS,
    versionDescription: 'Remove Meta social credentials from client Remote Config',
  });
  if (!clientCleanup?.ok) {
    throw new Error(`Meta credentials were stored in the server template, but client-template cleanup failed${clientCleanup?.detail ? ` (${clientCleanup.detail})` : ''}`);
  }

  return {
    pageId: page.id,
    userTokenExpiresAt,
    pageTokenExpiresAt: metadataExpiry(pageDebug.data.expires_at, 'Facebook Page token'),
    instagramPublisherConfigured,
    changed: Boolean(update.changed || clientCleanup.changed),
  };
}
