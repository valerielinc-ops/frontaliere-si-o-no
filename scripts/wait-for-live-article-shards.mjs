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
 *   1 = at least one shard URL is unreachable AND its shard push was not
 *       confirmed landed (so the push really may not have landed), or bad
 *       input — a real incident
 *   2 = the pushed bytes are not being served yet, but every URL that is not
 *       serving them belongs to a shard whose push IS confirmed landed —
 *       either reachable-but-stale, or not published yet by Pages. Not a
 *       success (do not ping search engines at it yet) and not an incident.
 *
 * Environment:
 *   FAST_PUBLISH_PUSHED_LOCALES — comma-separated `shards[].locale` values
 *     whose git push the caller has CONFIRMED landed on the shard remote. See
 *     the classification block at the bottom of this file for why the probe
 *     cannot derive this itself. Absent/empty ⇒ nothing is confirmed ⇒ the
 *     conservative pre-existing behaviour (any unreachable URL is an incident),
 *     which keeps every other caller unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkLink, runWithConcurrency, DEFAULT_LIVE_CHECK_USER_AGENT } from './lib/live-link-check.mjs';
import { intFromEnv } from './lib/int-from-env.mjs';

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
const timeoutMs = intFromEnv('FAST_PUBLISH_WAIT_TIMEOUT_MS', 5 * 60 * 1000);
const intervalMs = intFromEnv('FAST_PUBLISH_WAIT_INTERVAL_MS', 5 * 1000);
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

// url -> locale, so a confirmed-pushed locale can be matched back to the URL
// this probe polls. Keyed on url because that is what the poll loop carries.
const localeByUrl = new Map();
for (const shard of shards) {
  if (shard?.url && shard?.locale) localeByUrl.set(shard.url, String(shard.locale));
}
const confirmedPushed = new Set(
  String(process.env.FAST_PUBLISH_PUSHED_LOCALES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
if (confirmedPushed.size > 0) {
  console.log(`📦 Shard push confirmed landed for locale(s): ${[...confirmedPushed].join(', ')}`);
}
/** True when the caller vouched that this URL's shard push reached the remote. */
const pushConfirmed = (url) => confirmedPushed.has(localeByUrl.get(url));

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
// "the pushed bytes are not being served yet" and "the push did not land" were
// reported as one outcome, and both failed the run and opened a priority:high
// issue. They are not the same thing:
//
//   push did not land  → the article is not readable and never will be on its
//                        own. Someone must act. Real incident.
//   push landed        → the article arrives by itself as soon as the shard's
//                        Pages build publishes. Nothing is broken.
//
// The reachability of the URL CANNOT decide between them, and this is the whole
// correction over the first version of this block. That version read:
//
//     still 404  → the push did not land
//     200, stale → the push landed, Pages has not caught up
//
// which holds only for a RE-publish, where the URL already 200s from the
// previous build. For a brand-new article — the ordinary case — the URL 404s
// for the entire propagation window precisely BECAUSE the push landed and Pages
// has not published it yet. So the common case was permanently misfiled under
// "the push did not land".
//
// Measured twice:
//   2026-08-06, run 31093424415 — four URLs timed out during a GitHub Pages
//     `major_outage`; all four were serving correctly when checked afterwards.
//   2026-08-07, run 31148285623 — all four shard pushes confirmed on the remote
//     (`4c263cc..9469552` and siblings), en/de/fr live in ~40s, `it` still 404
//     at the 300s deadline. Reported as "the push did not land", run failed,
//     issue #5250 re-opened at priority:high, page a healthy 200 afterwards.
//     Healthy runs converge in 7-8 polls, so that locale was a Pages queue
//     outlier, nothing more.
// A false alarm there is not free: it feeds the issue-fix loop and burns shared
// Claude quota, which this file's own header says to avoid.
//
// The fact that actually separates the two is whether the git push reached the
// shard remote, and this process cannot observe that — it only ever sees the
// public URL. The caller can, and does: fast-publish-article.yml's shard-push
// step waits on each locale's push and exports the confirmed ones as
// FAST_PUBLISH_PUSHED_LOCALES. Unreachable + confirmed pushed ⇒ delayed.
// Unreachable + NOT confirmed ⇒ still an incident, so a genuinely lost push
// stays as loud as it was, and a caller that supplies nothing keeps the old
// conservative behaviour unchanged.
//
// Exit 2 is the delayed case. It still is NOT a success: the pushed bytes are
// not being served yet, so the caller must not ping Google/IndexNow at them —
// it simply is not an incident either.
const stillDown = urls.filter((_, i) => !lastResults[i]);
const finalStatuses = await runWithConcurrency(
  stillDown, Math.max(1, stillDown.length), (url) => checkLink(url, 8000, { cacheBust: true }),
);
const unreachable = stillDown.filter((_, i) => !finalStatuses[i]);
const stale = stillDown.filter((_, i) => Boolean(finalStatuses[i]));

// Unreachable, but the push is vouched for: the shard's Pages build simply has
// not published the commit yet. Same bucket as `stale` — delayed, not broken.
const unpublished = unreachable.filter((url) => pushConfirmed(url));
const absent = unreachable.filter((url) => !pushConfirmed(url));
const secs = Math.round(timeoutMs / 1000);

if (absent.length > 0) {
  console.error(`❌ Timed out after ${secs}s — ${absent.length}/${urls.length} shard URL(s) are NOT REACHABLE and their push is not confirmed landed:`);
  for (const url of absent) console.error(`   - ${url}`);
  for (const url of unpublished) console.error(`   - ${url}  (push confirmed landed, Pages has not published it yet)`);
  for (const url of stale) console.error(`   - ${url}  (reachable, still serving older bytes)`);
  process.exit(1);
}

console.warn(`::warning::Timed out after ${secs}s — ${unpublished.length + stale.length}/${urls.length} shard URL(s) are not serving the pushed bytes yet, but every one of their shard pushes is confirmed landed. Pages has not caught up. Not an incident: no ping should fire yet, and the pages arrive on their own.`);
for (const url of unpublished) console.warn(`   - ${url}  (push landed, not published yet)`);
for (const url of stale) console.warn(`   - ${url}  (reachable, still serving older bytes)`);
process.exit(2);
