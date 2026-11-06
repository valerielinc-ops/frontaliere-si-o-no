/**
 * Search Console ownership for the Google Indexing API.
 *
 * This module deliberately has no sitemap/planner imports. The production
 * submitter and the read-only verification CLI must share the exact same
 * credential and metadata-probe path, while the CLI must also work from a
 * sparse checkout that contains no job dataset.
 */

import { existsSync, readFileSync } from 'node:fs';

import { createJwtAssertion, exchangeAssertionForToken } from './google-service-account-token.mjs';

const INDEXING_METADATA = 'https://indexing.googleapis.com/v3/urlNotifications/metadata';
const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const FETCH_TIMEOUT_MS = 20_000;
const SITE_URL = 'https://frontaliereticino.ch';

export const DEFAULT_OWNER_PROBE_URL = `${SITE_URL}/`;

function log(prefix, msg) { console.log(`${prefix} ${msg}`); }

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function loadServiceAccount() {
  const envJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (envJson) {
    try { const sa = JSON.parse(envJson); if (sa.client_email && sa.private_key) return sa; } catch { /* next */ }
  }
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!saPath || !existsSync(saPath)) return null;
  try {
    const sa = JSON.parse(readFileSync(saPath, 'utf-8'));
    return sa.client_email && sa.private_key ? sa : null;
  } catch { return null; }
}

async function oauthUserToken() {
  const { GSC_CLIENT_ID: clientId, GSC_CLIENT_SECRET: clientSecret, GSC_REFRESH_TOKEN: refreshToken } = process.env;
  if (!clientId || !clientSecret || !refreshToken) return null;
  const res = await fetchWithTimeout(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  if (!res.ok) throw new Error(`OAuth token refresh failed (${res.status})`);
  return (await res.json()).access_token || null;
}

/**
 * Read-only ownership probe. 200 (already notified) and 404 (never notified)
 * both prove Google accepts the identity as owner; 403 means it does not.
 */
export function isOwnerProbeSuccess(status) {
  return status === 200 || status === 404;
}

export async function probeOwnership(token, url) {
  const res = await fetchWithTimeout(`${INDEXING_METADATA}?url=${encodeURIComponent(url)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (isOwnerProbeSuccess(res.status)) return { ok: true, status: res.status };
  const text = await res.text().catch(() => '');
  let reason = text.slice(0, 200);
  try { reason = JSON.parse(text)?.error?.message || reason; } catch { /* not JSON */ }
  return { ok: false, status: res.status, reason };
}

export async function resolveOwnerToken(probeUrl = DEFAULT_OWNER_PROBE_URL) {
  const identities = [
    { name: 'service account', get: async () => {
      const sa = loadServiceAccount();
      return sa ? exchangeAssertionForToken(createJwtAssertion(sa, INDEXING_SCOPE)) : null;
    } },
    { name: 'OAuth2 user (GSC_*)', get: oauthUserToken },
  ];
  for (const id of identities) {
    let token;
    try { token = await id.get(); } catch (err) { log('⚠️', `${id.name}: ${err.message}`); continue; }
    if (!token) { log('ℹ️', `${id.name}: no credentials`); continue; }
    const probe = await probeOwnership(token, probeUrl);
    if (probe.ok) {
      log('🔑', `Indexing API owner identity: ${id.name} (metadata probe ${probe.status})`);
      return token;
    }
    log('⚠️', `${id.name}: ownership probe ${probe.status} — ${probe.reason}`);
  }
  log('❌', 'No identity is a Search Console OWNER of sc-domain:frontaliereticino.ch.');
  log('💡', 'Grant Owner access to the service account or OAuth2 user at https://search.google.com/search-console/users');
  return null;
}
