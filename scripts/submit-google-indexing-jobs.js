#!/usr/bin/env node
/**
 * Google Indexing API (JobPosting only)
 *
 * Submits recently updated job posting URLs to the Indexing API.
 * Google only supports JobPosting / BroadcastEvent for this API.
 *
 * Authentication (tried in order):
 *   1. Service Account via GOOGLE_APPLICATION_CREDENTIALS (preferred in CI)
 *      — The SA must be added as Owner in Google Search Console for the site
 *   2. OAuth2 user credentials via GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN
 *
 * Prerequisites:
 *   - "Web Search Indexing API" must be enabled in the GCP project:
 *     https://console.cloud.google.com/apis/library/indexing.googleapis.com
 *   - The authenticating identity (SA email or user) must be an Owner of the
 *     Search Console property for the site.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SITE_URL = 'https://www.frontaliereticino.ch';
const MAX_SUBMISSIONS = Math.max(1, Math.min(100, Number(process.env.GSC_JOBS_INDEXING_MAX || 50)));
const MAX_RETRIES = 2;
const INDEXING_API = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(prefix, msg) {
  console.log(`${prefix} ${msg}`);
}

// ── Service Account JWT auth ────────────────────────────────
// Creates a self-signed JWT and exchanges it for an access token.
// This avoids the need for OAuth2 client credentials entirely.

function loadServiceAccount() {
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!saPath || !existsSync(saPath)) return null;
  try {
    const sa = JSON.parse(readFileSync(saPath, 'utf-8'));
    if (!sa.client_email || !sa.private_key) return null;
    return sa;
  } catch {
    return null;
  }
}

function createJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: INDEXING_SCOPE,
    aud: TOKEN_URI,
    iat: now,
    exp: now + 3600,
  };

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;

  const sign = createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(sa.private_key, 'base64url');

  return `${unsigned}.${signature}`;
}

async function getAccessTokenFromSA(sa) {
  const jwt = createJwt(sa);
  const res = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SA token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.access_token;
}

// ── OAuth2 user credentials auth (fallback) ─────────────────

async function getAccessTokenFromOAuth(clientId, clientSecret, refreshToken) {
  const res = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OAuth token refresh failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.access_token;
}

// ── Resolve access token (SA first, then OAuth2) ────────────

async function resolveAccessToken() {
  // 1. Try Service Account (preferred in CI — no user credentials needed)
  const sa = loadServiceAccount();
  if (sa) {
    try {
      const token = await getAccessTokenFromSA(sa);
      log('🔑', `Authenticated via Service Account (${sa.client_email})`);
      return { token, identity: sa.client_email };
    } catch (err) {
      log('⚠️', `SA auth failed: ${err.message}`);
      log('ℹ️', 'Falling back to OAuth2 user credentials...');
    }
  }

  // 2. Try OAuth2 user credentials
  const clientId = process.env.GSC_CLIENT_ID;
  const clientSecret = process.env.GSC_CLIENT_SECRET;
  const refreshToken = process.env.GSC_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const token = await getAccessTokenFromOAuth(clientId, clientSecret, refreshToken);
  log('🔑', 'Authenticated via OAuth2 user credentials');
  return { token, identity: 'OAuth2 user' };
}

// ── Pre-flight probe ────────────────────────────────────────
// Submit a known URL to detect 403 "API not enabled" before
// wasting time on the full batch.

async function preflightProbe(accessToken, probeUrl) {
  const res = await fetch(INDEXING_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: probeUrl, type: 'URL_UPDATED' }),
  });

  if (res.ok) return { ok: true };

  const text = await res.text().catch(() => '');

  if (res.status === 403) {
    // Parse the error for actionable diagnostics
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    const reason = parsed?.error?.message || text.slice(0, 300);

    if (reason.includes('not been used') || reason.includes('not enabled') || reason.includes('API has not been')) {
      log('❌', `Indexing API is NOT enabled in the GCP project.`);
      log('💡', 'Fix: Enable "Web Search Indexing API" at:');
      log('  ', ' https://console.cloud.google.com/apis/library/indexing.googleapis.com');
      return { ok: false, fatal: true };
    }

    if (reason.includes('permission') || reason.includes('PERMISSION_DENIED') || reason.includes('not an owner')) {
      log('❌', `Permission denied — the authenticated identity is not an Owner in Search Console.`);
      log('💡', 'Fix: Add the identity as Owner in Google Search Console:');
      log('  ', ' https://search.google.com/search-console/users');
      return { ok: false, fatal: true };
    }

    if (reason.includes('insufficient authentication scopes')) {
      log('❌', `OAuth token lacks the "indexing" scope.`);
      log('💡', 'Fix: Re-run setup-google-oauth.mjs to regenerate the token with the indexing scope.');
      return { ok: false, fatal: true };
    }

    log('⚠️', `Pre-flight 403: ${reason}`);
    return { ok: false, fatal: true };
  }

  // 429 or 5xx on probe is transient — don't abort
  if (res.status === 429 || res.status >= 500) {
    log('⚠️', `Pre-flight got ${res.status} — proceeding with batch (may be transient)`);
    return { ok: true };
  }

  return { ok: true };
}

// ── Job loading ─────────────────────────────────────────────

function loadJobs() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const filePath = resolve(__dirname, '..', 'public', 'data', 'jobs.json');
  const raw = readFileSync(filePath, 'utf-8');
  const jobs = JSON.parse(raw);
  return Array.isArray(jobs) ? jobs : [];
}

function buildJobUrls(jobs) {
  const urls = [];
  for (const job of jobs) {
    const slug = job?.slugByLocale?.it || job?.slug;
    if (!slug) continue;
    const url = `${SITE_URL}/cerca-lavoro-ticino/${slug}/`;
    const date = job?.postedDate || job?.crawledAt || '';
    urls.push({ url, date });
  }
  return urls;
}

function sortAndLimit(urls) {
  const unique = new Map();
  for (const item of urls) {
    if (!unique.has(item.url)) unique.set(item.url, item);
  }

  const list = [...unique.values()];
  list.sort((a, b) => {
    const da = Date.parse(a.date || '') || 0;
    const db = Date.parse(b.date || '') || 0;
    return db - da;
  });

  return list.slice(0, MAX_SUBMISSIONS);
}

// ── Submit a single URL ─────────────────────────────────────

async function submitUrl(accessToken, url, attempt = 1) {
  try {
    const res = await fetch(INDEXING_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url, type: 'URL_UPDATED' }),
    });

    if (res.ok) return { ok: true };

    if ((res.status === 429 || res.status >= 500) && attempt <= MAX_RETRIES) {
      const delay = 500 * attempt;
      log('⏳', `Indexing API ${res.status} — retry ${attempt}/${MAX_RETRIES} in ${delay}ms`);
      await sleep(delay);
      return submitUrl(accessToken, url, attempt + 1);
    }

    const text = await res.text().catch(() => '');

    // Abort entire batch on 403 — no point retrying permission errors
    if (res.status === 403) {
      return { ok: false, status: res.status, body: text.slice(0, 200), fatal: true };
    }

    return { ok: false, status: res.status, body: text.slice(0, 200) };
  } catch (err) {
    if (attempt <= MAX_RETRIES) {
      const delay = 500 * attempt;
      log('⏳', `Network error — retry ${attempt}/${MAX_RETRIES} in ${delay}ms`);
      await sleep(delay);
      return submitUrl(accessToken, url, attempt + 1);
    }
    return { ok: false, status: 0, body: err.message };
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  log('📨', 'Google Indexing API — JobPosting URL notifications');

  // 1. Authenticate
  let auth;
  try {
    auth = await resolveAccessToken();
  } catch (err) {
    log('⚠️', `Authentication failed: ${err.message}`);
    process.exit(0);
  }

  if (!auth) {
    log('ℹ️', 'No credentials available (GOOGLE_APPLICATION_CREDENTIALS or GSC_* env vars) — skipping');
    process.exit(0);
  }

  // 2. Load jobs
  let jobs;
  try {
    jobs = loadJobs();
  } catch (err) {
    log('⚠️', `Unable to read jobs.json — ${err.message}`);
    process.exit(0);
  }

  const jobUrls = sortAndLimit(buildJobUrls(jobs));
  if (jobUrls.length === 0) {
    log('ℹ️', 'No job URLs found to submit');
    process.exit(0);
  }

  // 3. Pre-flight: probe with the first URL to catch config errors early
  const probe = await preflightProbe(auth.token, jobUrls[0].url);
  if (!probe.ok) {
    log('🛑', 'Aborting batch — fix the configuration issue above and re-deploy.');
    process.exit(0);
  }

  // 4. Submit batch (first URL already submitted by probe, start from index 1)
  log('📨', `Submitting ${jobUrls.length} JobPosting URLs to Indexing API`);

  let ok = 1; // first URL was the probe
  let fail = 0;

  for (let i = 1; i < jobUrls.length; i++) {
    const item = jobUrls[i];
    const result = await submitUrl(auth.token, item.url);

    if (result.ok) {
      ok += 1;
    } else {
      fail += 1;
      log('⚠️', `Failed (${result.status}): ${item.url} ${result.body || ''}`.trim());

      // Abort on 403 — no point continuing
      if (result.fatal) {
        log('🛑', `Fatal error — aborting remaining ${jobUrls.length - i - 1} submissions`);
        break;
      }
    }
    await sleep(120);
  }

  log('📊', `Job indexing: ${ok} submitted, ${fail} failed (of ${jobUrls.length} total)`);
}

main().catch((err) => {
  log('❌', `Unhandled error: ${err.message}`);
  process.exit(0);
});
