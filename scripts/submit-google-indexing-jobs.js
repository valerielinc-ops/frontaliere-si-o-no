#!/usr/bin/env node
/**
 * Google Indexing API (JobPosting only)
 *
 * Submits recently updated job posting URLs to the Indexing API.
 * Google only supports JobPosting / BroadcastEvent for this API.
 *
 * Environment variables (from GitHub Secrets):
 *   GSC_CLIENT_ID
 *   GSC_CLIENT_SECRET
 *   GSC_REFRESH_TOKEN
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SITE_URL = 'https://www.frontaliereticino.ch';
const MAX_SUBMISSIONS = Math.max(1, Math.min(100, Number(process.env.GSC_JOBS_INDEXING_MAX || 50)));
const MAX_RETRIES = 2;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(prefix, msg) {
  console.log(`${prefix} ${msg}`);
}

async function getAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
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
    throw new Error(`Token refresh failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.access_token;
}

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

async function submitUrl(accessToken, url, attempt = 1) {
  try {
    const res = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
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

async function main() {
  const clientId = process.env.GSC_CLIENT_ID;
  const clientSecret = process.env.GSC_CLIENT_SECRET;
  const refreshToken = process.env.GSC_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    log('⚠️', 'GSC secrets not configured — skipping job indexing');
    process.exit(0);
  }

  let token;
  try {
    token = await getAccessToken(clientId, clientSecret, refreshToken);
  } catch (err) {
    log('⚠️', `Failed to get access token — ${err.message}`);
    process.exit(0);
  }

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

  log('📨', `Submitting ${jobUrls.length} JobPosting URLs to Indexing API`);

  let ok = 0;
  let fail = 0;
  for (const item of jobUrls) {
    const result = await submitUrl(token, item.url);
    if (result.ok) {
      ok += 1;
    } else {
      fail += 1;
      log('⚠️', `Indexing API failed (${result.status}): ${item.url} ${result.body || ''}`.trim());
    }
    await sleep(120);
  }

  log('📊', `Job indexing: ${ok} submitted, ${fail} failed`);
}

main().catch((err) => {
  log('❌', `Unhandled error: ${err.message}`);
  process.exit(0);
});
