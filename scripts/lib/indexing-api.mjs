/**
 * Google Indexing API — notify Google of new/updated URLs.
 *
 * Uses the FIREBASE_SERVICE_ACCOUNT_JSON env var (or /tmp/firebase-sa.json file)
 * to authenticate as a service account with the Indexing API.
 *
 * No external dependencies — uses Node.js built-in `crypto` for JWT signing.
 *
 * Quota: the approved 2,000-request project budget is shared with the job
 * publisher through the serialized indexing-api-jobs-ledger.
 *
 * @see https://developers.google.com/search/apis/indexing-api/v3/quickstart
 */

import { createJwtAssertion, exchangeAssertionForToken } from './google-service-account-token.mjs';
import {
  loadLedger,
  quotaDayKey,
  recordNotification,
  reserveQuota,
  spentOn,
} from './indexing-jobs-planner.mjs';
import { DAILY_BUDGET, DEFAULT_INDEXING_LEDGER, writeLedgerFile } from './indexing-api-quota.mjs';
import fs from 'node:fs';

const INDEXING_API_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const SCOPE = 'https://www.googleapis.com/auth/indexing';
export const LEDGER_UNAVAILABLE = 'shared_ledger_unavailable';

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
 * Read the ledger this publisher must share with the job submitter. Unlike the
 * owner it never bootstraps one: without the counter it cannot know how much of
 * the shared budget is left, and a missing ledger is as unknown as a broken one.
 * The next monitor-gsc-seo run creates it and the following publish resumes.
 * @returns {object|null} null when the spent quota cannot be established.
 */
function readSharedLedger(ledgerPath, today) {
  try {
    const ledger = loadLedger(fs.readFileSync(ledgerPath, 'utf8'), today);
    if (!ledger) console.warn(`[indexing-api] ⚠️ Shared ledger is invalid: ${ledgerPath}`);
    return ledger;
  } catch (err) {
    console.warn(`[indexing-api] ⚠️ Cannot read shared ledger: ${err.message}`);
    return null;
  }
}

/**
 * Notify Google Indexing API about one or more updated URLs.
 * Errors are logged but never thrown — the caller's workflow must not be blocked.
 *
 * @param {string[]} urls - List of full canonical URLs to notify
 * @param {object} [options]
 * @param {'URL_UPDATED'|'URL_DELETED'} [options.type='URL_UPDATED'] - Notification type
 * @param {string} [options.ledgerPath] - Shared serialized ledger path
 * @param {string} [options.source='article'] - Ledger caller label
 * @returns {Promise<Array<{url: string, ok: boolean, error?: string}>>}
 */
export async function notifyGoogleIndexing(
  urls,
  {
    type = 'URL_UPDATED',
    ledgerPath = process.env.INDEXING_API_LEDGER || DEFAULT_INDEXING_LEDGER,
    source = 'article',
  } = {},
) {
  if (!urls || urls.length === 0) return [];

  const creds = loadCredentials();
  if (!creds) {
    console.warn('[indexing-api] ⚠️  No service account credentials found — skipping Indexing API notification.');
    return urls.map(url => ({ url, ok: false, error: 'no_credentials' }));
  }

  // Before auth: the token exchange is a Google request too, and a run that
  // cannot account for its quota must not make any.
  const today = quotaDayKey();
  const ledger = readSharedLedger(ledgerPath, today);
  if (!ledger) return urls.map(url => ({ url, ok: false, error: LEDGER_UNAVAILABLE }));
  const available = Math.max(0, DAILY_BUDGET - spentOn(ledger, today));
  if (available === 0) {
    console.warn(`[indexing-api] ℹ️ Shared quota exhausted (${DAILY_BUDGET}/${DAILY_BUDGET}) — skipping ${urls.length} URL(s).`);
    return urls.map(url => ({ url, ok: false, error: 'shared_quota_exhausted' }));
  }
  if (available < urls.length) {
    console.warn(`[indexing-api] ℹ️ Shared quota leaves ${available} request(s) — ${urls.length - available} URL(s) deferred.`);
  }

  const saveLedger = () => {
    try {
      writeLedgerFile(ledgerPath, ledger);
      return true;
    } catch (err) {
      console.warn(`[indexing-api] ⚠️ Cannot persist shared ledger: ${err.message}`);
      return false;
    }
  };
  if (!saveLedger()) return urls.map(url => ({ url, ok: false, error: LEDGER_UNAVAILABLE }));

  let accessToken;
  try {
    const jwt = createJwtAssertion(creds, SCOPE);
    accessToken = await exchangeAssertionForToken(jwt);
  } catch (err) {
    console.error(`[indexing-api] ❌ Auth failed: ${err.message}`);
    return urls.map(url => ({ url, ok: false, error: err.message }));
  }

  const results = [];
  const batch = urls.slice(0, available);
  for (const [index, url] of batch.entries()) {
    // Reserve before POST: retries or a process interruption must not cause
    // the next caller to spend the same quota slot again. An unpersisted
    // reservation does not exist for the next caller, so it stops the run.
    if (!reserveQuota(ledger, today)) break;
    if (!saveLedger()) {
      results.push(...batch.slice(index).map(u => ({ url: u, ok: false, error: LEDGER_UNAVAILABLE })));
      break;
    }
    let result;
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
        result = { url, ok: false, status: res.status, error: `${res.status} ${text}`.slice(0, 220) };
      } else {
        const data = await res.json();
        const latestType = data?.urlNotificationMetadata?.latestUpdate?.type || type;
        console.log(`[indexing-api] ✅ ${url} → ${latestType}`);
        result = { url, ok: true, status: res.status };
      }
    } catch (err) {
      console.error(`[indexing-api] ❌ ${url}: ${err.message}`);
      result = { url, ok: false, status: 0, error: err.message };
    }
    recordNotification(ledger, { url, type, source }, result, today);
    saveLedger();
    results.push(result);
  }

  const succeeded = results.filter(r => r.ok).length;
  console.log(`[indexing-api] 📊 ${succeeded}/${urls.length} URLs notified successfully.`);
  return results;
}
