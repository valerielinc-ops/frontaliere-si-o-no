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

import { createJwtAssertion, exchangeAssertionForToken } from './google-service-account-token.mjs';
import fs from 'node:fs';

const INDEXING_API_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const SCOPE = 'https://www.googleapis.com/auth/indexing';

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
    const jwt = createJwtAssertion(creds, SCOPE);
    accessToken = await exchangeAssertionForToken(jwt);
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
