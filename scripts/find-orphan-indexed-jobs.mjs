#!/usr/bin/env node
/**
 * Find Google-indexed job URLs that no longer have a corresponding
 * active or expired job page. These "orphan" URLs show the SPA homepage
 * fallback (soft 404) and should get proper soft-landing content.
 *
 * Uses: GSC Search Analytics API + local jobs.json + expired-jobs.json
 *
 * Usage:
 *   node scripts/load-rc-env.mjs && node scripts/find-orphan-indexed-jobs.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SITE_URL = 'https://frontaliereticino.ch';
const JOB_PREFIX = '/cerca-lavoro-ticino/';

// ── Load env ─────────────────────────────────────────────
const GSC_CLIENT_ID = process.env.GSC_CLIENT_ID || '';
const GSC_CLIENT_SECRET = process.env.GSC_CLIENT_SECRET || '';
const GSC_REFRESH_TOKEN = process.env.GSC_REFRESH_TOKEN || '';

async function getAccessToken() {
  if (!GSC_CLIENT_ID || !GSC_CLIENT_SECRET || !GSC_REFRESH_TOKEN) {
    throw new Error('Missing GSC_CLIENT_ID, GSC_CLIENT_SECRET, or GSC_REFRESH_TOKEN');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GSC_CLIENT_ID,
      client_secret: GSC_CLIENT_SECRET,
      refresh_token: GSC_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`OAuth token error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// ── Collect known slugs ──────────────────────────────────
function collectKnownSlugs() {
  const slugs = new Set();

  // Active jobs
  const jobsPath = path.join(ROOT, 'data', 'jobs.json');
  if (fs.existsSync(jobsPath)) {
    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
    for (const job of (Array.isArray(jobs) ? jobs : [])) {
      if (job.slug) slugs.add(job.slug);
      if (job.slugByLocale) {
        for (const s of Object.values(job.slugByLocale)) {
          if (s) slugs.add(String(s));
        }
      }
      if (Array.isArray(job.previousSlugs)) {
        for (const s of job.previousSlugs) {
          if (s) slugs.add(s);
        }
      }
      if (job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
        for (const arr of Object.values(job.previousSlugsByLocale)) {
          if (Array.isArray(arr)) for (const s of arr) { if (s) slugs.add(s); }
        }
      }
    }
  }

  // Expired jobs
  const expiredPath = path.join(ROOT, 'data', 'expired-jobs.json');
  if (fs.existsSync(expiredPath)) {
    const expired = JSON.parse(fs.readFileSync(expiredPath, 'utf-8'));
    for (const job of (Array.isArray(expired) ? expired : [])) {
      if (job.slug) slugs.add(job.slug);
      if (job.slugByLocale) {
        for (const s of Object.values(job.slugByLocale)) {
          if (s) slugs.add(String(s));
        }
      }
    }
  }

  // All-known-job-slugs (historical)
  const allKnownPath = path.join(ROOT, 'data', 'all-known-job-slugs.json');
  if (fs.existsSync(allKnownPath)) {
    const known = JSON.parse(fs.readFileSync(allKnownPath, 'utf-8'));
    if (Array.isArray(known)) {
      for (const s of known) {
        if (s) slugs.add(String(s));
      }
    }
  }

  return slugs;
}

// ── GSC: get indexed job URLs ────────────────────────────
async function getIndexedJobUrls(accessToken) {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const urls = new Set();
  let startRow = 0;

  while (true) {
    const res = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startDate,
          endDate,
          dimensions: ['page'],
          dimensionFilterGroups: [{
            filters: [{
              dimension: 'page',
              operator: 'contains',
              expression: '/cerca-lavoro-ticino/',
            }],
          }],
          rowLimit: 5000,
          startRow,
        }),
      },
    );

    if (!res.ok) {
      console.error(`GSC API error: ${res.status} ${await res.text()}`);
      break;
    }

    const data = await res.json();
    const rows = data.rows || [];
    if (rows.length === 0) break;

    for (const row of rows) {
      const pageUrl = row.keys?.[0] || '';
      if (pageUrl.includes('/cerca-lavoro-ticino/')) {
        urls.add(pageUrl);
      }
    }

    startRow += rows.length;
    if (rows.length < 5000) break;
  }

  return urls;
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log('🔍 Finding orphan indexed job URLs...\n');

  const knownSlugs = collectKnownSlugs();
  console.log(`📊 Known slugs: ${knownSlugs.size} (active + expired + previousSlugs + all-known)`);

  let accessToken;
  try {
    accessToken = await getAccessToken();
    console.log('✅ GSC OAuth token obtained');
  } catch (e) {
    console.error('❌ Cannot get GSC access token:', e.message);
    console.log('\nFallback: checking local sitemap for job URLs...');
    return;
  }

  const indexedUrls = await getIndexedJobUrls(accessToken);
  console.log(`📊 Google-indexed job URLs (last 90 days): ${indexedUrls.size}`);

  // Extract slugs from URLs and find orphans
  const orphans = [];
  for (const url of indexedUrls) {
    const match = url.match(/\/cerca-lavoro-ticino\/([^/?#]+)/);
    if (!match) continue;
    const slug = match[1].replace(/\/$/, '');
    if (!slug || knownSlugs.has(slug)) continue;
    orphans.push({ url, slug });
  }

  console.log(`\n🚨 Orphan URLs (indexed but no matching job): ${orphans.length}\n`);

  if (orphans.length === 0) {
    console.log('✅ No orphan job URLs found!');
    return;
  }

  for (const { url, slug } of orphans.slice(0, 50)) {
    console.log(`  ❌ ${slug}`);
    console.log(`     ${url}`);
  }
  if (orphans.length > 50) {
    console.log(`  ... and ${orphans.length - 50} more`);
  }

  // Save to file for the build plugin to generate soft-landing pages
  const orphanSlugs = orphans.map(o => o.slug);
  const outPath = path.join(ROOT, 'data', 'orphan-indexed-job-slugs.json');
  fs.writeFileSync(outPath, JSON.stringify(orphanSlugs, null, 2) + '\n');
  console.log(`\n💾 Saved ${orphanSlugs.length} orphan slugs to ${outPath}`);
  console.log('   → The build plugin can use this to generate soft-landing pages');
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
