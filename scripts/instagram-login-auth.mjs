#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import { realpathSync } from 'node:fs';
import { pathToFileURL, URL } from 'node:url';
import { INSTAGRAM_LOGIN_GRAPH_API } from './lib/instagram-graph-constants.mjs';
import { INSTAGRAM_LOGIN_REQUIRED_PUBLISH_SCOPES } from './lib/instagram-publisher-credentials.mjs';
import {
  INSTAGRAM_LOGIN_ACCOUNT_METADATA_KEYS,
  INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY,
  commitInstagramLoginCredentialUpdate,
  isInstagramLoginCredentialWriteLocked,
  isInstagramLoginCredentialWritePending,
  readInstagramLoginCredentials,
} from './lib/instagram-login-remote-config.mjs';

const CALLBACK_TIMEOUT_MS = 8 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

function requiredValue(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is not configured in Firebase server Remote Config`);
  return normalized;
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is not configured in the process environment`);
  return value;
}

export function callbackConfig(redirectUri) {
  const url = new URL(redirectUri);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash) {
    throw new Error('INSTAGRAM_LOGIN_REDIRECT_URI must be a registered loopback http URL with an explicit port');
  }
  return { url, host: url.hostname, port: Number(url.port) };
}

export function buildAuthorizationUrl({ appId, redirectUri, state }) {
  const url = new URL('https://www.instagram.com/oauth/authorize');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', INSTAGRAM_LOGIN_REQUIRED_PUBLISH_SCOPES.join(','));
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeAuthorizationCode({ appId, appSecret, redirectUri, code }) {
  const response = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const rawPayload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const payload = rawPayload;
    throw new Error(`Instagram authorization-code exchange failed (HTTP ${response.status}${payload?.error_type ? `, ${String(payload.error_type).slice(0, 40)}` : ''})`);
  }
  return normalizeInstagramLoginTokenExchangeResponse(rawPayload);
}

export function normalizeInstagramLoginTokenExchangeResponse(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Instagram authorization-code exchange returned an invalid response');
  }
  let normalized = payload;
  if (Array.isArray(payload.data)) {
    if (payload.access_token || payload.user_id) {
      throw new Error('Instagram authorization-code exchange returned an ambiguous token response');
    }
    if (payload.data.length !== 1 || !payload.data[0] || typeof payload.data[0] !== 'object' || Array.isArray(payload.data[0])) {
      throw new Error('Instagram authorization-code exchange returned an invalid data envelope');
    }
    normalized = {
      ...payload.data[0],
      ...(payload.data[0].permissions === undefined && payload.permissions !== undefined
        ? { permissions: payload.permissions }
        : {}),
    };
  }
  const accessToken = typeof normalized.access_token === 'string' ? normalized.access_token.trim() : '';
  if (!accessToken || normalized.error) {
    throw new Error('Instagram authorization-code exchange did not return an access token');
  }
  return { ...normalized, access_token: accessToken };
}

function grantedInstagramScopes(value) {
  if (typeof value === 'string') return value.split(',').map((scope) => scope.trim()).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [entry.trim()].filter(Boolean);
    if (entry && typeof entry === 'object' && String(entry.status || '').toLowerCase() === 'granted') {
      return [String(entry.permission || '').trim()].filter(Boolean);
    }
    return [];
  });
}

export function verifyGrantedPublishScopes(payload) {
  const granted = new Set(grantedInstagramScopes(payload?.permissions));
  const missing = INSTAGRAM_LOGIN_REQUIRED_PUBLISH_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length) {
    throw new Error(`Instagram OAuth did not grant the required publishing scopes: ${missing.join(', ')}`);
  }
  return INSTAGRAM_LOGIN_REQUIRED_PUBLISH_SCOPES.join(',');
}

async function exchangeLongLivedToken({ appSecret, shortLivedToken }) {
  const url = new URL(`${INSTAGRAM_LOGIN_GRAPH_API.replace(/\/v\d+\.\d+$/u, '')}/access_token`);
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('access_token', shortLivedToken);
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token || !Number.isFinite(Number(payload.expires_in))) {
    throw new Error(`Instagram long-lived token exchange failed (HTTP ${response.status})`);
  }
  return payload;
}

async function fetchProfile(accessToken) {
  const url = new URL(`${INSTAGRAM_LOGIN_GRAPH_API}/me`);
  url.searchParams.set('fields', 'user_id,username,account_type');
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    throw new Error(`Instagram profile verification failed (HTTP ${response.status})`);
  }
  return payload;
}

function waitForAuthorizationCode({ redirectUri, expectedState }) {
  const { url: redirect, host, port } = callbackConfig(redirectUri);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (server.listening) server.close();
      if (error) reject(error);
      else resolve(code);
    };
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      if (request.method !== 'GET' || requestUrl.pathname !== redirect.pathname) {
        response.writeHead(404).end('Not found.');
        return;
      }
      const error = requestUrl.searchParams.get('error');
      const state = requestUrl.searchParams.get('state');
      const code = requestUrl.searchParams.get('code');
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      if (error) {
        response.end('Instagram authorization was not completed. You can close this tab.');
        finish(new Error('Instagram authorization was denied or cancelled'));
        return;
      }
      const receivedState = Buffer.from(state || '', 'utf8');
      const expectedStateBuffer = Buffer.from(expectedState, 'utf8');
      if (!state || receivedState.length !== expectedStateBuffer.length
        || !crypto.timingSafeEqual(receivedState, expectedStateBuffer)) {
        response.end('Authorization state could not be verified. You can close this tab.');
        finish(new Error('Instagram OAuth state mismatch; authorization aborted'));
        return;
      }
      if (!code) {
        response.end('Instagram did not return an authorization code. You can close this tab.');
        finish(new Error('Instagram OAuth callback did not include an authorization code'));
        return;
      }
      response.end('Authorization received. You can close this tab.');
      finish(null, code);
    });
    const timeout = setTimeout(() => finish(new Error('Instagram authorization timed out')), CALLBACK_TIMEOUT_MS);
    server.on('error', (error) => finish(new Error(`Instagram OAuth callback listener failed (${error.code || 'server-error'})`)));
    server.listen(port, host, () => console.log(`Waiting for the Instagram OAuth callback on loopback port ${port}.`));
  });
}

async function main() {
  const stored = await readInstagramLoginCredentials();
  const recoverPending = isInstagramLoginCredentialWritePending(
    stored[INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY],
    'INSTAGRAM_LOGIN_ACCESS_TOKEN',
  );
  if (isInstagramLoginCredentialWriteLocked(stored[INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY]) && !recoverPending) {
    throw new Error('Instagram credentials are already being updated; wait for the active transaction to finish');
  }
  const appId = requiredValue(stored.INSTAGRAM_LOGIN_APP_ID, 'INSTAGRAM_LOGIN_APP_ID');
  const appSecret = requiredEnv('INSTAGRAM_LOGIN_APP_SECRET');
  const redirectUri = requiredValue(stored.INSTAGRAM_LOGIN_REDIRECT_URI, 'INSTAGRAM_LOGIN_REDIRECT_URI');
  const expectedUsername = requiredEnv('INSTAGRAM_USERNAME').replace(/^@/u, '').toLowerCase();
  callbackConfig(redirectUri);
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('Firebase Remote Config credentials are unavailable');

  const state = crypto.randomBytes(32).toString('base64url');
  console.log('Instagram Login requests only basic profile access and content publishing.');
  console.log(`Registered redirect URI: ${redirectUri}`);
  console.log('Open this URL, sign into the intended professional account, and grant the requested scopes:');
  console.log(buildAuthorizationUrl({ appId, redirectUri, state }));

  const code = await waitForAuthorizationCode({ redirectUri, expectedState: state });
  const shortToken = await exchangeAuthorizationCode({ appId, appSecret, redirectUri, code });
  const grantedScopes = verifyGrantedPublishScopes(shortToken);
  const longToken = await exchangeLongLivedToken({ appSecret, shortLivedToken: shortToken.access_token });
  const profile = await fetchProfile(longToken.access_token);
  const userId = String(profile.user_id || '').trim();
  const username = String(profile.username || '').replace(/^@/u, '').trim();
  const accountType = String(profile.account_type || '').toUpperCase();
  if (!/^\d{5,32}$/u.test(userId)) throw new Error('Instagram profile did not return a valid professional account ID');
  const exchangedUserId = String(shortToken.user_id || '').trim();
  if (exchangedUserId && exchangedUserId !== userId) {
    throw new Error('The authorization-code response and verified profile identify different Instagram accounts');
  }
  if (!username || username.toLowerCase() !== expectedUsername) {
    throw new Error('The authorized Instagram username does not match the configured target account');
  }
  if (!['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(accountType)) {
    throw new Error('The authorized Instagram account is not a Business or Creator professional account');
  }

  const expiresIn = Number(longToken.expires_in);
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  if (!Number.isFinite(expiresIn) || expiresIn < 86_400 || Number.isNaN(expiresAt.valueOf())) {
    throw new Error('Instagram did not return a valid long-lived token expiration');
  }
  const values = {
    INSTAGRAM_PUBLISHING_AUTH_MODE: 'instagram_login',
    INSTAGRAM_LOGIN_USER_ID: userId,
    INSTAGRAM_LOGIN_USERNAME: username,
    INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: expiresAt.toISOString(),
    INSTAGRAM_LOGIN_GRANTED_SCOPES: grantedScopes,
  };
  const expectedValues = Object.fromEntries([
    'INSTAGRAM_LOGIN_APP_ID',
    'INSTAGRAM_LOGIN_REDIRECT_URI',
    ...INSTAGRAM_LOGIN_ACCOUNT_METADATA_KEYS,
  ].map((key) => [key, stored[key] || '']));
  const previousValues = Object.fromEntries(INSTAGRAM_LOGIN_ACCOUNT_METADATA_KEYS
    .map((key) => [key, stored[key] || null]));
  const saved = await commitInstagramLoginCredentialUpdate({
    accessToken: longToken.access_token,
    values,
    previousValues,
    expectedValues,
    recoverPending,
    expectedLockValue: recoverPending ? stored[INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY] : undefined,
  });
  console.log(`Instagram Login connected to @${username}; publisher token saved to GitHub Actions Secrets and omitted from output.`);
  console.log(`Token expiry recorded in server Remote Config ${saved.changed ? 'updated' : 'already current'}.`);
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
    console.error(`Instagram Login setup failed: ${error?.message || 'unexpected error'}`);
    process.exitCode = 1;
  });
}
