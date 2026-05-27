/**
 * Google Indexing API — notify Google of new/updated URLs.
 *
 * Uses the FIREBASE_SERVICE_ACCOUNT_JSON env var (or /tmp/firebase-sa.json file)
 * to authenticate as a service account with the Indexing API.
 *
 * No external dependencies — uses Node.js built-in `crypto` for JWT signing.
 *
 * Quota: 200 URL notifications/day (free).
 * Typical usage: ~32 notifications/day (8 articles × 4 locales).
 *
 * @see https://developers.google.com/search/apis/indexing-api/v3/quickstart
 */

import { createSign } from 'node:crypto';
import fs from 'node:fs';

const INDEXING_API_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/indexing';
const TOKEN_LIFETIME_SECONDS = 3600;

/**
 * Load service account credentials from env or file.
 * @returns {object|null} Parsed service account JSON or null if unavailable.
 */
function loadCredentials() {
  // Try env var first (GitHub Actions)
  const envJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (envJson) {
    try { return JSON.parse(envJson); } catch { /* fall through */ }
  }
  // Try file path (local dev with `firebase-sa.json`)
  const filePath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/tmp/firebase-sa.json';
  if (fs.existsSync(filePath)) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { /* fall through */ }
  }
  return null;
}

/**
 * Create a signed JWT for Google OAuth2 service account auth.
 * @param {object} creds - Service account credentials with client_email and private_key
 * @returns {string} Signed JWT assertion
 */
function createJwtAssertion(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: creds.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + TOKEN_LIFETIME_SECONDS,
  };

  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${encode(header)}.${encode(payload)}`;

  const sign = createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(creds.private_key, 'base64url');

  return `${unsigned}.${signature}`;
}

/**
 * Exchange a JWT assertion for an access token.
 * @param {string} assertion - Signed JWT
 * @returns {Promise<string>} Access token
 */
async function getAccessToken(assertion) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

/**
 * Notify Google Indexing API about one or more updated URLs.
 * Errors are logged but never thrown — the caller's workflow must not be blocked.
 *
 * @param {string[]} urls - List of full canonical URLs to notify
 * @param {object} [options]
 * @param {'URL_UPDATED'|'URL_DELETED'} [options.type='URL_UPDATED'] - Notification type
 * @returns {Promise<Array<{url: string, ok: boolean, error?: string}>>}
 */
export async function notifyGoogleIndexing(urls, { type = 'URL_UPDATED' } = {}) {
  if (!urls || urls.length === 0) return [];

  const creds = loadCredentials();
  if (!creds) {
    console.warn('[indexing-api] ⚠️  No service account credentials found — skipping Indexing API notification.');
    return urls.map(url => ({ url, ok: false, error: 'no_credentials' }));
  }

  let accessToken;
  try {
    const jwt = createJwtAssertion(creds);
    accessToken = await getAccessToken(jwt);
  } catch (err) {
    console.error(`[indexing-api] ❌ Auth failed: ${err.message}`);
    return urls.map(url => ({ url, ok: false, error: err.message }));
  }

  const results = [];
  for (const url of urls) {
    try {
      const res = await fetch(INDEXING_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ url, type }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`[indexing-api] ❌ ${url}: ${res.status} ${text}`);
        results.push({ url, ok: false, error: `${res.status} ${text}` });
        continue;
      }

      const data = await res.json();
      const latestType = data?.urlNotificationMetadata?.latestUpdate?.type || type;
      console.log(`[indexing-api] ✅ ${url} → ${latestType}`);
      results.push({ url, ok: true });
    } catch (err) {
      console.error(`[indexing-api] ❌ ${url}: ${err.message}`);
      results.push({ url, ok: false, error: err.message });
    }
  }

  const succeeded = results.filter(r => r.ok).length;
  console.log(`[indexing-api] 📊 ${succeeded}/${urls.length} URLs notified successfully.`);
  return results;
}
