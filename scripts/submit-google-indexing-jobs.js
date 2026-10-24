#!/usr/bin/env node
/**
 * Google Indexing API (JobPosting only)
 *
 * Notifies Google of job pages via the Indexing API, the official channel for
 * JobPosting (Google accepts only JobPosting / BroadcastEvent pages here).
 *
 * Callers:
 *   - post-deploy-publish.yml after every published deploy (small `--max`, so
 *     new jobs reach Google the same day);
 *   - monitor-gsc-seo.yml daily, right after the PT quota reset, with the
 *     URLs the GSC monitor found WITHOUT a "Job Postings" rich result as
 *     `--priority-file`, then the rest of the daily budget.
 *
 * Source of URLs: the LIVE job sitemaps (what Google is told exists), so the
 * script needs neither a build nor jobs.json. What to send and in which order
 * is decided by scripts/lib/indexing-jobs-planner.mjs against a persistent
 * ledger (`--ledger`, restored/saved by actions/cache in the workflows) that
 * also carries the per-day request counter shared by every caller.
 * Every URL is fetched live before it is notified: URL_UPDATED only for a 200
 * page carrying JobPosting without noindex, URL_DELETED only for 404/410 or
 * noindex. Nothing that is not a job page is ever sent.
 *
 * Authentication — the first identity Google accepts as Search Console OWNER
 * (checked with the read-only urlNotifications/metadata endpoint, which does
 * not consume the publish quota):
 *   1. Service account (GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT_JSON)
 *   2. OAuth2 user (GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN, from
 *      Remote Config via scripts/load-rc-env.mjs)
 * Until 2026-10 the script stopped at the service account: that identity is
 * only `siteFullUser` on sc-domain:frontaliereticino.ch, so every publish got
 * 403 "Failed to verify the URL ownership" and no job URL was ever notified.
 *
 * Usage:
 *   node scripts/submit-google-indexing-jobs.js [--max N] [--priority-file f.json]
 *        [--ledger path] [--dry-run]
 *
 * Always exits 0: notification is best-effort and must not fail a deploy.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { createJwtAssertion, exchangeAssertionForToken } from './lib/google-service-account-token.mjs';
import {
  quotaDayKey,
  isJobDetailCandidate,
  parseSitemapUrlset,
  parseJobSitemapIndex,
  loadLedger,
  observeSitemap,
  planSubmissions,
  recordOutcome,
  judgeLive,
  spentOn,
} from './lib/indexing-jobs-planner.mjs';

const SITE_URL = 'https://frontaliereticino.ch';
// Google default quota: 200 publish requests/day per GCP project. 40 stay
// reserved for scripts/notify-article-search-engines.mjs (10 articles × 4
// locales), which shares the project when the service account is the owner.
export const DAILY_BUDGET = 160;
const DEFAULT_MAX = 15;
const MAX_RETRIES = 2;
const FETCH_TIMEOUT_MS = 20_000;
const INDEXING_PUBLISH = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const INDEXING_METADATA = 'https://indexing.googleapis.com/v3/urlNotifications/metadata';
const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DEFAULT_LEDGER = '/tmp/indexing-api-jobs-ledger.json';
const USER_AGENT = 'frontaliere-indexing-api/2.0 (+https://frontaliereticino.ch)';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(prefix, msg) { console.log(`${prefix} ${msg}`); }

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export function parseArgs(argv) {
  const args = { max: DEFAULT_MAX, priorityFile: null, ledger: DEFAULT_LEDGER, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--max') args.max = Number(argv[++i]);
    else if (a === '--priority-file') args.priorityFile = argv[++i];
    else if (a === '--ledger') args.ledger = argv[++i];
  }
  const envMax = Number(process.env.GSC_JOBS_INDEXING_MAX);
  if (!argv.includes('--max') && Number.isFinite(envMax) && envMax > 0) args.max = envMax;
  args.max = Math.max(0, Math.min(DAILY_BUDGET, Math.floor(Number.isFinite(args.max) ? args.max : DEFAULT_MAX)));
  return args;
}

// ── Credentials ─────────────────────────────────────────────

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
async function probeOwnership(token, url) {
  const res = await fetchWithTimeout(`${INDEXING_METADATA}?url=${encodeURIComponent(url)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 200 || res.status === 404) return { ok: true };
  const text = await res.text().catch(() => '');
  let reason = text.slice(0, 200);
  try { reason = JSON.parse(text)?.error?.message || reason; } catch { /* not JSON */ }
  return { ok: false, status: res.status, reason };
}

async function resolveOwnerToken(probeUrl) {
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
    if (probe.ok) { log('🔑', `Indexing API owner identity: ${id.name}`); return token; }
    log('⚠️', `${id.name}: ownership probe ${probe.status} — ${probe.reason}`);
  }
  log('❌', 'No identity is a Search Console OWNER of sc-domain:frontaliereticino.ch.');
  log('💡', 'Fix: add the service account as Owner at https://search.google.com/search-console/users');
  return null;
}

// ── Sitemaps ────────────────────────────────────────────────

async function fetchText(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
      if (res.ok) return await res.text();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) { lastErr = err; }
    await sleep(1000 * attempt);
  }
  throw new Error(`${url}: ${lastErr?.message}`);
}

/** Every job-detail candidate across the live job sitemaps. Throws if any sitemap is unreadable. */
async function loadLiveJobUrls() {
  const index = await fetchText(`${SITE_URL}/sitemap.xml`);
  const sitemaps = parseJobSitemapIndex(index);
  if (sitemaps.length === 0) throw new Error('no job sitemap in the sitemap index');
  const byUrl = new Map();
  for (const sm of sitemaps) {
    for (const entry of parseSitemapUrlset(await fetchText(sm))) {
      if (!isJobDetailCandidate(entry.loc)) continue;
      const prev = byUrl.get(entry.loc);
      if (!prev || (entry.lastmod && (!prev.lastmod || entry.lastmod > prev.lastmod))) byUrl.set(entry.loc, entry);
    }
  }
  log('🗺️', `${byUrl.size} job-detail URLs in ${sitemaps.length} live job sitemaps`);
  return [...byUrl.values()];
}

async function liveCheck(type, url) {
  try {
    const res = await fetchWithTimeout(url, { redirect: 'manual', headers: { 'User-Agent': USER_AGENT } });
    const html = res.status === 200 ? await res.text() : '';
    return judgeLive(type, { status: res.status, html });
  } catch {
    // A timeout/transport rejection is not evidence that the page lacks a
    // JobPosting. Keep it retryable; recordOutcome deliberately leaves the
    // URL's not-job/gone markers untouched for this outcome.
    return 'transient';
  }
}

// ── Publish ─────────────────────────────────────────────────

async function publish(token, url, type, attempt = 1) {
  try {
    const res = await fetchWithTimeout(INDEXING_PUBLISH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, type }),
    });
    if (res.ok) return { ok: true, status: res.status };
    if (res.status >= 500 && attempt <= MAX_RETRIES) {
      await sleep(500 * attempt);
      return publish(token, url, type, attempt + 1);
    }
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: text.replace(/\s+/g, ' ').slice(0, 200) };
  } catch (err) {
    if (attempt <= MAX_RETRIES) { await sleep(500 * attempt); return publish(token, url, type, attempt + 1); }
    return { ok: false, status: 0, body: err.message };
  }
}

function readPriority(file) {
  if (!file || !existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    const list = Array.isArray(data) ? data : data.urls;
    return Array.isArray(list) ? list.filter((u) => typeof u === 'string') : [];
  } catch { return []; }
}

function summary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`); } catch { /* ignore */ }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = quotaDayKey();
  log('📨', `Google Indexing API — JobPosting notifications (quota day ${today} PT${args.dryRun ? ', DRY RUN' : ''})`);

  const ledger = loadLedger(existsSync(args.ledger) ? readFileSync(args.ledger, 'utf-8') : null, today);
  const spent = spentOn(ledger, today);
  const runBudget = Math.min(args.max, DAILY_BUDGET - spent);
  log('📊', `Budget: ${spent}/${DAILY_BUDGET} used today, this run may send ${Math.max(0, runBudget)}`);

  let entries;
  try { entries = await loadLiveJobUrls(); } catch (err) {
    log('⚠️', `Live sitemaps unreadable (${err.message}) — skipping, ledger untouched`);
    return;
  }
  observeSitemap(ledger, entries, today);
  const save = () => { if (!args.dryRun) writeFileSync(args.ledger, JSON.stringify(ledger)); };

  if (runBudget <= 0) { log('ℹ️', 'Daily budget reached — skipping'); save(); return; }

  const priority = readPriority(args.priorityFile);
  if (priority.length) log('🎯', `${priority.length} priority URL(s) from ${args.priorityFile}`);
  const plan = planSubmissions(ledger, { today, max: runBudget, priority });
  if (plan.length === 0) { log('ℹ️', 'Nothing to notify'); save(); return; }

  const token = args.dryRun ? null : await resolveOwnerToken(plan[0].url);
  if (!args.dryRun && !token) { save(); return; }

  const counts = { sent: 0, skipped: 0, failed: 0 };
  const byTier = {};
  let consecutive429 = 0;
  // Bound the live fetches: landing pages share the job-detail URL shape, and
  // a backlog full of them must not turn one run into thousands of GETs.
  const maxChecks = runBudget * 4;
  let checks = 0;
  for (const item of plan) {
    if (counts.sent >= runBudget || checks++ >= maxChecks) break;
    const verdict = await liveCheck(item.type, item.url);
    if (verdict !== 'ok') {
      counts.skipped += 1;
      if (!args.dryRun) recordOutcome(ledger, item, verdict, today);
      continue;
    }
    if (args.dryRun) {
      counts.sent += 1;
      byTier[item.tier] = (byTier[item.tier] || 0) + 1;
      log('  ', `would ${item.type} [${item.tier}] ${item.url}`);
      continue;
    }
    const res = await publish(token, item.url, item.type);
    if (res.ok) {
      counts.sent += 1;
      consecutive429 = 0;
      byTier[item.tier] = (byTier[item.tier] || 0) + 1;
      recordOutcome(ledger, item, 'sent', today);
      log('  ✅', `${item.type} [${item.tier}] ${item.url}`);
    } else {
      counts.failed += 1;
      log('  ⚠️', `${item.type} ${res.status} ${item.url} ${res.body || ''}`.trim());
      if (res.status === 403) { log('🛑', 'Permission error — aborting run'); break; }
      if (res.status === 429 && ++consecutive429 >= 2) {
        // Google's own counter is the truth: close the day so later callers skip.
        ledger.days[today] = DAILY_BUDGET;
        log('🛑', 'Quota exhausted (429) — closing the day');
        break;
      }
    }
    await sleep(150);
  }
  save();
  const tiers = Object.entries(byTier).map(([t, n]) => `${t}=${n}`).join(' ') || 'none';
  log('📊', `Sent ${counts.sent}, skipped ${counts.skipped} (live check), failed ${counts.failed}; tiers: ${tiers}. Day total ${spentOn(ledger, today)}/${DAILY_BUDGET}`);
  summary([
    '## Google Indexing API — job pages',
    '',
    `| Sent | Skipped (live check) | Failed | Tiers | Day total |`,
    `|---|---|---|---|---|`,
    `| ${counts.sent} | ${counts.skipped} | ${counts.failed} | ${tiers} | ${spentOn(ledger, today)}/${DAILY_BUDGET} |`,
  ]);
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => {
    log('❌', `Unhandled error: ${err.message}`);
    process.exit(0);
  });
}
