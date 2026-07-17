#!/usr/bin/env node
/**
 * check-bing-status.mjs — lightweight, read-only Bing Webmaster status check
 * (issue #4305, scope item 3). Reports real, live state — does not submit
 * anything.
 *
 * Checks:
 *   1. GetUrlSubmissionQuota — remaining daily/monthly URL Submission API
 *      quota (this is the quota that gates SubmitUrlbatch in
 *      scripts/submit-indexnow.js / submit-indexnow-batch.mjs).
 *   2. GetFeeds — Bing's real sitemap-submission-status endpoint (Bing calls
 *      submitted sitemaps "feeds" in this API; GetSitemaps does not exist —
 *      confirmed via a live 404 probe 2026-07-17).
 *
 * Usage:
 *   node scripts/check-bing-status.mjs
 *   node scripts/check-bing-status.mjs --site https://frontaliereticino.ch
 *
 * Auth: BING_API_KEY in env — load via
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/load-rc-env.mjs)"
 */

import { getBingUrlSubmissionQuota, getBingFeeds } from './lib/bing-webmaster.mjs';

const args = process.argv.slice(2);
const siteArgIdx = args.indexOf('--site');
const SITE_URL = siteArgIdx !== -1 ? args[siteArgIdx + 1] : 'https://frontaliereticino.ch';

function daysAgo(isoString) {
  if (!isoString) return null;
  const ms = Date.now() - new Date(isoString).getTime();
  return +(ms / (24 * 3600 * 1000)).toFixed(1);
}

async function main() {
  const apiKey = process.env.BING_API_KEY;
  if (!apiKey) {
    console.error('BING_API_KEY not set. Run scripts/load-rc-env.mjs first (or export it).');
    process.exit(1);
  }

  console.log(`Bing Webmaster status check — ${SITE_URL}\n`);

  const [quota, feeds] = await Promise.all([
    getBingUrlSubmissionQuota(apiKey, SITE_URL),
    getBingFeeds(apiKey, SITE_URL),
  ]);

  console.log('=== URL Submission API quota ===');
  if (quota) {
    console.log(`  Daily quota remaining:   ${quota.dailyQuota}`);
    console.log(`  Monthly quota remaining: ${quota.monthlyQuota}`);
    if (quota.dailyQuota === 0) {
      console.log('  ⚠️  Daily quota exhausted — submit-indexnow.js will skip the Bing URL Submission API subset today.');
    }
  } else {
    console.log('  ⚠️  Could not fetch quota (API key invalid, site not verified, or API unreachable).');
  }

  console.log('\n=== Submitted sitemaps ("feeds") ===');
  if (feeds && feeds.length > 0) {
    for (const f of feeds) {
      const crawledAgo = daysAgo(f.lastCrawled);
      console.log(`  ${f.url}`);
      console.log(`    Type:          ${f.type}`);
      console.log(`    Status:        ${f.status}`);
      console.log(`    URL count:     ${f.urlCount.toLocaleString()}`);
      console.log(`    Submitted:     ${f.submitted || '(unknown)'}`);
      console.log(`    Last crawled:  ${f.lastCrawled || '(unknown)'}${crawledAgo !== null ? ` (${crawledAgo}d ago)` : ''}`);
      if (crawledAgo !== null && crawledAgo > 14) {
        console.log(`    ⚠️  Last crawled >14 days ago — Bing may not be revisiting this sitemap regularly.`);
      }
      if (f.status && f.status !== 'Success') {
        console.log(`    ⚠️  Status is not "Success" — investigate.`);
      }
    }
  } else if (feeds && feeds.length === 0) {
    console.log('  ⚠️  No sitemaps submitted to Bing Webmaster Tools for this site.');
  } else {
    console.log('  ⚠️  Could not fetch feed/sitemap status (API key invalid, site not verified, or API unreachable).');
  }

  const problems = [];
  if (!quota) problems.push('quota check failed');
  if (quota && quota.dailyQuota === 0) problems.push('daily quota exhausted');
  if (!feeds) problems.push('feed status check failed');
  if (feeds && feeds.length === 0) problems.push('no sitemap submitted');
  if (feeds && feeds.some((f) => f.status !== 'Success')) problems.push('a submitted sitemap is not in Success status');

  console.log(`\n${problems.length === 0 ? '✅ All checks nominal.' : `⚠️  Issues found: ${problems.join('; ')}`}`);
  if (problems.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
