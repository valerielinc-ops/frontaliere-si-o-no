#!/usr/bin/env node
import { INSTAGRAM_LOGIN_GRAPH_API } from './lib/instagram-graph-constants.mjs';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  INSTAGRAM_LOGIN_ACCOUNT_METADATA_KEYS,
  INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY,
  commitInstagramLoginCredentialUpdate,
  isInstagramLoginCredentialWriteLocked,
  isInstagramLoginCredentialWritePending,
  readInstagramLoginCredentials,
} from './lib/instagram-login-remote-config.mjs';

const REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

export function isInstagramLoginTokenRefreshDue(expiresAtMs, now = Date.now(), { recoverPending = false } = {}) {
  return Number.isFinite(expiresAtMs) && expiresAtMs > now
    && (recoverPending || expiresAtMs - now <= REFRESH_WINDOW_MS);
}

function requiredValue(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is missing from the configured secret or server Remote Config metadata`);
  return normalized;
}

async function refreshToken(accessToken) {
  const url = new URL(`${INSTAGRAM_LOGIN_GRAPH_API.replace(/\/v\d+\.\d+$/u, '')}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', accessToken);
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token || !Number.isFinite(Number(payload.expires_in))) {
    throw new Error(`Instagram token refresh failed (HTTP ${response.status})`);
  }
  return payload;
}

async function verifyAccount({ accessToken, userId, username }) {
  const url = new URL(`${INSTAGRAM_LOGIN_GRAPH_API}/${encodeURIComponent(userId)}`);
  url.searchParams.set('fields', 'user_id,username');
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  const actualUsername = String(payload?.username || '').replace(/^@/u, '').trim().toLowerCase();
  if (!response.ok || payload?.error || String(payload?.user_id || '') !== userId || actualUsername !== username.toLowerCase()) {
    throw new Error(`Instagram token refresh returned a token that did not verify the configured account (HTTP ${response.status})`);
  }
}

async function main() {
  const config = await readInstagramLoginCredentials({ allowMissingTemplate: true });
  if (String(config.INSTAGRAM_PUBLISHING_AUTH_MODE || '').trim() !== 'instagram_login') {
    console.log('Instagram Login is not the selected publishing route; no token refresh needed.');
    return;
  }
  const recoverPending = isInstagramLoginCredentialWritePending(
    config[INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY],
    'INSTAGRAM_LOGIN_ACCESS_TOKEN',
  );
  if (isInstagramLoginCredentialWriteLocked(config[INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY]) && !recoverPending) {
    throw new Error('Instagram credentials are being updated or require app-secret recovery; no token refresh was started');
  }
  const accessToken = requiredValue(process.env.INSTAGRAM_LOGIN_ACCESS_TOKEN, 'Instagram Login access token');
  const userId = requiredValue(config.INSTAGRAM_LOGIN_USER_ID, 'Instagram Login user ID');
  const username = requiredValue(config.INSTAGRAM_LOGIN_USERNAME, 'Instagram Login username');
  const expiresAtMs = Date.parse(requiredValue(config.INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT, 'Instagram Login token expiry'));
  if (!Number.isFinite(expiresAtMs)) throw new Error('Instagram Login token expiration is invalid; reconnect the account');
  const workflowExpiry = String(process.env.INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT || '').trim();
  if (workflowExpiry && workflowExpiry !== config.INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT) {
    throw new Error('Instagram Login token metadata changed after this workflow loaded its secret; a fresh workflow run is required');
  }
  const now = Date.now();
  if (!isInstagramLoginTokenRefreshDue(expiresAtMs, now, { recoverPending })) {
    if (expiresAtMs <= now) throw new Error('Instagram Login token has expired; reconnect the account');
    console.log('Instagram Login token is outside the 30-day refresh window.');
    return;
  }

  const refreshed = await refreshToken(accessToken);
  await verifyAccount({ accessToken: refreshed.access_token, userId, username });
  const expiresIn = Number(refreshed.expires_in);
  const nextExpiry = new Date(now + expiresIn * 1000);
  if (expiresIn < 86_400 || Number.isNaN(nextExpiry.valueOf())) {
    throw new Error('Instagram returned an invalid refreshed token expiration');
  }
  const values = { INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: nextExpiry.toISOString() };
  const saved = await commitInstagramLoginCredentialUpdate({
    accessToken: refreshed.access_token,
    values,
    previousValues: { INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: config.INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT },
    expectedValues: Object.fromEntries(INSTAGRAM_LOGIN_ACCOUNT_METADATA_KEYS
      .map((key) => [key, config[key] || ''])),
    now: new Date(now),
    recoverPending,
    expectedLockValue: recoverPending ? config[INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY] : undefined,
  });
  console.log(`Instagram Login token refreshed for @${username}; token omitted from output; GitHub secret rotated and server Remote Config metadata ${saved.changed ? 'updated' : 'already current'}.`);
}

const directInvocation = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (directInvocation) {
  main().catch((error) => {
    console.error(`Instagram Login token refresh failed: ${error?.message || 'unexpected error'}`);
    process.exitCode = 1;
  });
}
