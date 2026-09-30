#!/usr/bin/env node

export const SOURCE_RELAY_OIDC_AUDIENCE = 'frontaliere-jobs-source-relay';
const GITHUB_OIDC_REQUEST_HOST = 'token.actions.githubusercontent.com';

function envValue(env, name) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

async function requestGithubOidcToken({
  fetchImpl,
  env,
  audience = SOURCE_RELAY_OIDC_AUDIENCE,
}) {
  const requestUrl = envValue(env, 'ACTIONS_ID_TOKEN_REQUEST_URL');
  const requestToken = envValue(env, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN');
  if (!requestUrl || !requestToken) return null;

  const tokenUrl = new URL(requestUrl);
  if (
    tokenUrl.protocol !== 'https:'
    || tokenUrl.hostname !== GITHUB_OIDC_REQUEST_HOST
    || tokenUrl.username
    || tokenUrl.password
    || tokenUrl.port
  ) throw new Error('github_oidc_request_url_not_allowed');
  tokenUrl.searchParams.set('audience', audience);
  const response = await fetchImpl(tokenUrl, {
    method: 'GET',
    headers: {
      Authorization: `bearer ${requestToken}`,
      Accept: 'application/json',
    },
  });
  if (!response?.ok) throw new Error(`github_oidc_token_${response?.status || 'unavailable'}`);
  const payload = await response.json();
  if (typeof payload?.value !== 'string' || !payload.value) throw new Error('github_oidc_token_missing');
  return payload.value;
}

/**
 * Fetch one allowlisted source URL through Firebase when direct egress fails.
 * An unset JOBS_SOURCE_RELAY_URL is deliberately a no-op so local runs and
 * workflows without the second-step wiring retain their existing behavior.
 */
export async function fetchSourceViaRelay(
  sourceUrl,
  {
    relayUrl,
    fetchImpl = globalThis.fetch,
    env = process.env,
    audience = SOURCE_RELAY_OIDC_AUDIENCE,
  } = {},
) {
  const configuredRelayUrl = envValue(
    { JOBS_SOURCE_RELAY_URL: relayUrl ?? env?.JOBS_SOURCE_RELAY_URL },
    'JOBS_SOURCE_RELAY_URL',
  );
  if (!configuredRelayUrl) return null;

  try {
    const endpoint = new URL(configuredRelayUrl);
    if (endpoint.protocol !== 'https:') throw new Error('relay_url_must_use_https');
    if (typeof sourceUrl !== 'string' || !sourceUrl) throw new Error('source_url_missing');

    const token = await requestGithubOidcToken({ fetchImpl, env, audience });
    if (!token) {
      console.warn('  ⚠️ Source relay configured but GitHub Actions OIDC is unavailable; keeping direct-fetch behavior.');
      return null;
    }

    endpoint.searchParams.set('url', sourceUrl);
    return await fetchImpl(endpoint, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/html, application/json',
      },
    });
  } catch (error) {
    console.warn(`  ⚠️ Source relay fetch failed: ${error?.message || error}`);
    return null;
  }
}

export { requestGithubOidcToken };
