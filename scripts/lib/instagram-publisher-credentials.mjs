import { GRAPH_API, INSTAGRAM_LOGIN_GRAPH_API } from './instagram-graph-constants.mjs';

const ACCOUNT_ID_PATTERN = /^\d{5,32}$/u;

export const INSTAGRAM_LOGIN_REQUIRED_PUBLISH_SCOPES = Object.freeze([
  'instagram_business_basic',
  'instagram_business_content_publish',
]);

export const INSTAGRAM_LOGIN_PUBLISH_ENV = Object.freeze({
  INSTAGRAM_PUBLISHING_AUTH_MODE: 'INSTAGRAM_PUBLISHING_AUTH_MODE',
  INSTAGRAM_LOGIN_USER_ID: 'INSTAGRAM_LOGIN_USER_ID',
  INSTAGRAM_LOGIN_USERNAME: 'INSTAGRAM_LOGIN_USERNAME',
  INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: 'INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT',
  INSTAGRAM_LOGIN_GRANTED_SCOPES: 'INSTAGRAM_LOGIN_GRANTED_SCOPES',
});

function rcValue(template, name) {
  const value = template?.parameters?.[name]?.defaultValue?.value;
  return typeof value === 'string' ? value.trim() : '';
}

export function hasInstagramLoginPublishScopes(value) {
  const granted = new Set(String(value || '').split(',').map((scope) => scope.trim()).filter(Boolean));
  return INSTAGRAM_LOGIN_REQUIRED_PUBLISH_SCOPES.every((scope) => granted.has(scope));
}

/** Resolve only the explicitly selected Instagram publishing identity. */
export function getInstagramPublisherCredentials(env = process.env, { now = Date.now() } = {}) {
  const mode = String(env.INSTAGRAM_PUBLISHING_AUTH_MODE || 'facebook_login').trim();
  if (!['facebook_login', 'instagram_login'].includes(mode)) {
    return { mode: 'invalid', accessToken: null, igUserId: null, apiBase: GRAPH_API };
  }
  if (mode === 'instagram_login') {
    const configuredToken = String(env.INSTAGRAM_LOGIN_ACCESS_TOKEN || '').trim();
    const igUserId = String(env.INSTAGRAM_LOGIN_USER_ID || '').trim();
    const expiresAt = Date.parse(String(env.INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT || ''));
    const scopesGranted = hasInstagramLoginPublishScopes(env.INSTAGRAM_LOGIN_GRANTED_SCOPES);
    return {
      mode,
      accessToken: configuredToken && scopesGranted && Number.isFinite(expiresAt) && expiresAt > now ? configuredToken : null,
      igUserId: ACCOUNT_ID_PATTERN.test(igUserId) ? igUserId : null,
      apiBase: INSTAGRAM_LOGIN_GRAPH_API,
    };
  }

  const accessToken = String(env.INSTAGRAM_ACCESS_TOKEN || '').trim();
  const igUserId = String(env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '').trim();
  return {
    mode: 'facebook_login',
    accessToken: accessToken || null,
    igUserId: ACCOUNT_ID_PATTERN.test(igUserId) ? igUserId : null,
    apiBase: GRAPH_API,
  };
}

/** Resolve publisher credentials from the client and server Remote Config templates. */
export function getInstagramPublisherCredentialsFromTemplates({
  clientTemplate,
  serverTemplate,
  env = process.env,
  now = Date.now(),
} = {}) {
  const serverValues = Object.fromEntries(Object.entries(INSTAGRAM_LOGIN_PUBLISH_ENV)
    .map(([envName, rcName]) => [envName, rcValue(serverTemplate, rcName)]));
  const resolvedEnv = {
    ...env,
    INSTAGRAM_PUBLISHING_AUTH_MODE: String(
      env.INSTAGRAM_PUBLISHING_AUTH_MODE
      || serverValues.INSTAGRAM_PUBLISHING_AUTH_MODE
      || rcValue(clientTemplate, 'INSTAGRAM_PUBLISHING_AUTH_MODE')
      || '',
    ).trim(),
    INSTAGRAM_ACCESS_TOKEN: String(env.INSTAGRAM_ACCESS_TOKEN || rcValue(clientTemplate, 'INSTAGRAM_ACCESS_TOKEN')).trim(),
    INSTAGRAM_BUSINESS_ACCOUNT_ID: String(env.INSTAGRAM_BUSINESS_ACCOUNT_ID || rcValue(clientTemplate, 'INSTAGRAM_BUSINESS_ACCOUNT_ID')).trim(),
  };
  for (const [envName] of Object.entries(INSTAGRAM_LOGIN_PUBLISH_ENV)) {
    if (!String(env[envName] || '').trim() && serverValues[envName]) resolvedEnv[envName] = serverValues[envName];
  }
  return getInstagramPublisherCredentials(resolvedEnv, { now });
}
