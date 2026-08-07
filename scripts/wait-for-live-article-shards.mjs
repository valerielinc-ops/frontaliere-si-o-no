#!/usr/bin/env node
/**
 * Poll all locale shard URLs from a publish-article-fast.mjs summary JSON
 * until every one is live (or a timeout is reached).
 *
 * Built for fast-publish-article.yml (issue #4837 stream C): unlike
 * scripts/wait-for-live-article-meta.mjs (which polls ONE url and requires an
 * expected og:title to match against), the fast-publish summary contract
 * (stream A) only guarantees `{ shards: [{ locale, url, ... }, ...] }` — no
 * og:title. Reuses the SAME liveness primitive
 * (scripts/lib/live-link-check.mjs's checkLink/runWithConcurrency) already
 * shared by send-job-alerts.mjs and check-journalist-article-links.mjs,
 * instead of a third hand-rolled HEAD/timeout construct (AGENTS.md
 * Non-Negotiable #6).
 *
 * Usage:
 *   node scripts/wait-for-live-article-shards.mjs <summary-json-path>
 *
 * Exit codes:
 *   0 = every shard URL verified live and serving the pushed bytes
 *   1 = at least one shard URL is NOT REACHABLE (the push did not land), or
 *       bad input — a real incident
 *   2 = every shard URL is reachable but at least one still serves older
 *       bytes: the push landed and Pages has not caught up. Not a success (do
 *       not ping search engines at it yet) and not an incident either.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkLink, runWithConcurrency, DEFAULT_LIVE_CHECK_USER_AGENT } from './lib/live-link-check.mjs';

const [, , summaryPath] = process.argv;

if (!summaryPath) {
  console.error('Usage: node scripts/wait-for-live-article-shards.mjs <summary-json-path>');
  process.exit(1);
}

let summary;
try {
  summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
} catch (error) {
  console.error(`❌ Could not read/parse summary JSON at ${summaryPath}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const shards = Array.isArray(summary?.shards) ? summary.shards : [];
const urls = shards.map((shard) => shard?.url).filter((url) => typeof url === 'string' && url.length > 0);

if (urls.length === 0) {
  console.error(`❌ No shard URLs found in ${summaryPath} (expected .shards[].url)`);
  process.exit(1);
}

// 5 min, matching wait-for-live-article-meta.mjs's established default rather
// than inventing a second number. Measured shard Pages publish is ~30s (push
// 09:14:01Z -> last-modified 09:14:31Z on frontaliere-articolifrontaliere-it),
// so this is ~10x margin. Deliberately generous: a timeout here opens a
// dedup'd GitHub issue, and a false alarm feeds the issue-fix loop and burns
// shared Claude quota (AGENTS.md "Auth automazioni & frugalità quota").
const timeoutMs = Number(process.env.FAST_PUBLISH_WAIT_TIMEOUT_MS || 5 * 60 * 1000);
const intervalMs = Number(process.env.FAST_PUBLISH_WAIT_INTERVAL_MS || 5 * 1000);
const deadline = Date.now() + timeoutMs;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log(`🔍 Verifying ${urls.length} live shard URL(s):`);
for (const url of urls) console.log(`   - ${url}`);

// ── Content verification, not just HTTP status ───────────────────────────
// A status-only check cannot tell a freshly-propagated 200 from a stale 200
// still serving the previous build. That is harmless for a brand-new article
// (it previously 404'd, so any 200 is necessarily the new page) but wrong for a
// re-publish of an already-live article_id — exactly the manual
// workflow_dispatch path used to validate this feature — where a stale 200
// would green-light the Google/IndexNow ping before the new bytes are served.
//
// We rendered the HTML ourselves and pushed it, so we can compare against it.
// The only difference between our bytes and the served bytes is Cloudflare's
// edge-injected bot-fight script, which is stripped from both sides before
// hashing (verified against production by scripts/check-article-byte-identity.mjs).
const CF_INJECTED_RX = /<script>\(function\(\)\{[^<]*__CF\$cv\$params[\s\S]*?<\/script>/g;
const CF_BEACON_RX = /<script[^>]*\/cdn-cgi\/[^>]*>[\s\S]*?<\/script>/g;

const normalise = (html) =>
  String(html || '').replace(CF_INJECTED_RX, '').replace(CF_BEACON_RX, '').trim();

const digest = (html) => createHash('sha256').update(normalise(html)).digest('hex');

const summaryDir = path.dirname(path.resolve(summaryPath));
const distDir = process.env.FAST_PUBLISH_DIST_DIR || path.join(summaryDir, 'dist');

/** url -> sha256 of the HTML we rendered for it, when we can read it back. */
const expected = new Map();
for (const shard of shards) {
  const rel = Array.isArray(shard?.paths) ? shard.paths.find((p) => p.endsWith('index.html')) : null;
  if (!shard?.url || !rel) continue;
  const abs = path.join(distDir, rel);
  try {
    expected.set(shard.url, digest(fs.readFileSync(abs, 'utf8')));
  } catch {
    // Rendered file not readable here (e.g. the caller cleaned the scratch dir):
    // fall back to status-only for that URL rather than failing the publish.
    console.log(`ℹ️  ${shard.url}: rendered HTML not readable at ${abs} — status-only verification for this locale`);
  }
}
if (expected.size > 0) {
  console.log(`🔐 Content verification active for ${expected.size}/${urls.length} URL(s) (sha256 of the pushed HTML).`);
}

async function servesExpectedContent(url) {
  const want = expected.get(url);
  if (!want) return true; // status-only for this URL
  try {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_fpcb=${Date.now()}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      // The User-Agent is NOT optional. undici's fetch() sends none, and the
      // zone's firewall answers an empty UA with 403 + a 5.7 KB challenge page
      // (measured: plain fetch -> 403/5730B, same URL with any UA -> 200/23505B).
      // Without this the content check could never match and every fast publish
      // would burn its full timeout and report a failed publish. Reuses the
      // same UA checkLink already sends, which the firewall allow-lists.
      headers: {
        'User-Agent': DEFAULT_LIVE_CHECK_USER_AGENT,
        'Cache-Control': 'no-cache',
      },
    });
    if (!res.ok) return false;
    return digest(await res.text()) === want;
  } catch {
    return false;
  }
}

let lastResults = urls.map(() => false);

while (Date.now() < deadline) {
  const statuses = await runWithConcurrency(urls, urls.length, (url) => checkLink(url, 8000, { cacheBust: true }));
  lastResults = await runWithConcurrency(
    urls,
    urls.length,
    async (url, i) => Boolean(statuses[i]) && (await servesExpectedContent(url)),
  );
  if (lastResults.every(Boolean)) {
    console.log('✅ All shard URLs are live and serving the pushed content.');
    process.exit(0);
  }
  const pending = urls.filter((_, i) => !lastResults[i]);
  console.log(`⏳ ${pending.length}/${urls.length} shard URL(s) not yet serving the pushed content — retrying in ${Math.round(intervalMs / 1000)}s`);
  for (const url of pending) console.log(`   - ${url}`);
  await sleep(intervalMs);
}

// ── Two very different failures, told apart ──────────────────────────────
//
// "200 but stale" and "still 404" were reported as one outcome, and both
// failed the run and opened a priority:high issue. They are not the same
// thing:
//
//   still 404  → the push did not land. The article is not readable. Real.
//   200, stale → the push landed and Pages has not caught up yet. The article
//                arrives on its own; nothing is broken and nobody must act.
//
// Measured 2026-08-06 (run 31093424415): four URLs timed out during a GitHub
// Pages `major_outage`, an urgent issue was opened, and all four were serving
// correctly when checked afterwards — a false alarm that also fed the
// issue-fix loop and burned shared Claude quota, which this file's own header
// says to avoid.
//
// Exit 2 is the delayed case. It still is NOT a success: the pushed bytes are
// not being served yet, so the caller must not ping Google/IndexNow at them —
// it simply is not an incident either.
const stillDown = urls.filter((_, i) => !lastResults[i]);
const finalStatuses = await runWithConcurrency(
  stillDown, Math.max(1, stillDown.length), (url) => checkLink(url, 8000, { cacheBust: true }),
);
const absent = stillDown.filter((_, i) => !finalStatuses[i]);
const stale = stillDown.filter((_, i) => Boolean(finalStatuses[i]));

if (absent.length > 0) {
  console.error(`❌ Timed out after ${Math.round(timeoutMs / 1000)}s — ${absent.length}/${urls.length} shard URL(s) are NOT REACHABLE (the push did not land):`);
  for (const url of absent) console.error(`   - ${url}`);
  for (const url of stale) console.error(`   - ${url}  (reachable, still serving older bytes)`);
  process.exit(1);
}

console.warn(`::warning::Timed out after ${Math.round(timeoutMs / 1000)}s — ${stale.length}/${urls.length} shard URL(s) are LIVE but still serving older bytes. The push landed; Pages has not caught up. Not an incident: no ping should fire yet, and the pages arrive on their own.`);
for (const url of stale) console.warn(`   - ${url}`);
process.exit(2);
