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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SITE_URL = 'https://frontaliereticino.ch';
// Budget: 200 requests/day total. Reserve 40 for articles (10 articles × 4 locales).
// Remaining 160 for job URLs, spread across deploys.
const DAILY_BUDGET = 160;
const MAX_PER_DEPLOY = Math.max(1, Math.min(30, Number(process.env.GSC_JOBS_INDEXING_MAX || 15)));
const MAX_RETRIES = 2;
const INDEXING_API = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SUBMITTED_URLS_PATH = '/tmp/indexing-api-submitted-today.json';

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

function sortAndLimit(urls, alreadySubmitted) {
  const unique = new Map();
  for (const item of urls) {
    if (!unique.has(item.url)) unique.set(item.url, item);
  }

  const list = [...unique.values()];
  // Prioritize never-submitted URLs, then by recency
  list.sort((a, b) => {
    const aSubmitted = alreadySubmitted.has(a.url) ? 1 : 0;
    const bSubmitted = alreadySubmitted.has(b.url) ? 1 : 0;
    if (aSubmitted !== bSubmitted) return aSubmitted - bSubmitted;
    const da = Date.parse(a.date || '') || 0;
    const db = Date.parse(b.date || '') || 0;
    return db - da;
  });

  // Filter out already-submitted URLs and cap to per-deploy max
  const fresh = list.filter((item) => !alreadySubmitted.has(item.url));
  return fresh.slice(0, MAX_PER_DEPLOY);
}

// ── Daily submission tracker ────────────────────────────────
// Tracks which URLs were already submitted today to avoid burning quota
// on the same URLs across multiple deploys per day.

function loadSubmittedToday() {
  try {
    if (!existsSync(SUBMITTED_URLS_PATH)) return new Set();
    const data = JSON.parse(readFileSync(SUBMITTED_URLS_PATH, 'utf-8'));
    // Ignore stale data from a previous day
    const today = new Date().toISOString().slice(0, 10);
    if (data.date !== today) return new Set();
    return new Set(data.urls || []);
  } catch {
    return new Set();
  }
}

function saveSubmittedToday(urls) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const existing = loadSubmittedToday();
    for (const u of urls) existing.add(u);
    const payload = { date: today, urls: [...existing], count: existing.size };
    writeFileSync(SUBMITTED_URLS_PATH, JSON.stringify(payload, null, 2));
    log('💾', `Tracked ${existing.size} URLs submitted today`);
  } catch (err) {
    log('⚠️', `Failed to save submission tracker: ${err.message}`);
  }
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

  // 0. Check daily budget
  const alreadySubmitted = loadSubmittedToday();
  if (alreadySubmitted.size >= DAILY_BUDGET) {
    log('ℹ️', `Daily budget reached (${alreadySubmitted.size}/${DAILY_BUDGET} URLs) — skipping`);
    process.exit(0);
  }

  const remaining = DAILY_BUDGET - alreadySubmitted.size;
  const deployMax = Math.min(MAX_PER_DEPLOY, remaining);
  log('📊', `Budget: ${alreadySubmitted.size}/${DAILY_BUDGET} used today, ${remaining} remaining, max ${deployMax} this deploy`);

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

  const allJobUrls = buildJobUrls(jobs);
  const jobUrls = sortAndLimit(allJobUrls, alreadySubmitted).slice(0, deployMax);
  if (jobUrls.length === 0) {
    log('ℹ️', `No new job URLs to submit (${alreadySubmitted.size} already submitted today)`);
    process.exit(0);
  }

  // 3. Pre-flight: probe with the first URL to catch config errors early
  const probe = await preflightProbe(auth.token, jobUrls[0].url);
  if (!probe.ok) {
    log('🛑', 'Aborting batch — fix the configuration issue above and re-deploy.');
    process.exit(0);
  }

  // 4. Submit batch (first URL already submitted by probe, start from index 1)
  log('📨', `Submitting ${jobUrls.length} new JobPosting URLs to Indexing API (${alreadySubmitted.size} already submitted today)`);

  const submitted = [jobUrls[0].url]; // probe URL counts
  let ok = 1;
  let fail = 0;

  let consecutive429 = 0;
  for (let i = 1; i < jobUrls.length; i++) {
    // Throttle: 200ms between requests to stay under Google's burst limit
    if (i > 1) await sleep(200);

    const item = jobUrls[i];
    const result = await submitUrl(auth.token, item.url);

    if (result.ok) {
      ok += 1;
      consecutive429 = 0;
      submitted.push(item.url);
    } else {
      fail += 1;
      log('⚠️', `Failed (${result.status}): ${item.url} ${result.body || ''}`.trim());

      // Abort on 403 — no point continuing
      if (result.fatal) {
        log('🛑', `Fatal error — aborting remaining ${jobUrls.length - i - 1} submissions`);
        break;
      }

      // Abort on sustained 429 — quota exhausted, stop wasting requests
      if (result.status === 429) {
        consecutive429++;
        if (consecutive429 >= 3) {
          log('🛑', `Quota exhausted (${consecutive429} consecutive 429s) — aborting remaining ${jobUrls.length - i - 1} submissions`);
          break;
        }
      } else {
        consecutive429 = 0;
      }
    }
    await sleep(120);
  }

  // 5. Persist submitted URLs for dedup across deploys today
  saveSubmittedToday(submitted);

  log('📊', `Job indexing: ${ok} submitted, ${fail} failed (of ${jobUrls.length} total). Daily total: ${alreadySubmitted.size + submitted.length}/${DAILY_BUDGET}`);
}

main().catch((err) => {
  log('❌', `Unhandled error: ${err.message}`);
  process.exit(0);
});
