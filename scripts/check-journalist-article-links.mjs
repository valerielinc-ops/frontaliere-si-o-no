#!/usr/bin/env node
/**
 * check-journalist-article-links.mjs — Per-article live internal-link health
 * check for journalist-published content (issue #3174).
 *
 * Distinct from scripts/validate-internal-links.mjs: that validator is
 * dist-scoped (walks the local `dist/` build against the sitemap) and has no
 * concept of an individual journalist_articles Firestore doc. This script
 * instead crawls each PUBLISHED journalist article's live URLs (one per
 * locale) straight from Firestore `publishedUrls`, fetches the live HTML,
 * extracts same-origin links, HEAD-checks them with a small concurrency cap,
 * and writes the result back onto the doc so the dashboard can surface
 * "3 broken links" without a human re-checking manually.
 *
 * Best-effort at every level: a network hiccup on one locale must not abort
 * the run, crash other docs, or block other locales of the same doc.
 *
 * Live gate (issue #3209 item 2 / follow-up): this script runs in the SAME
 * workflow job as scripts/publish-journalist-article.mjs, BEFORE that job's
 * commit/push/deploy steps (see .github/workflows/publish-journalist-articles.yml),
 * AND deploys can queue behind other commits for well over the 15-minute
 * cron cadence. A fixed post-publish time window can't tell "not deployed
 * yet" from "deployed" — it previously guessed via a 5-minute skip, which
 * both fires too early under a busy deploy queue and stays silent too long
 * once the deploy has actually landed. Instead this gates on
 * `doc.liveVerifiedAt`, stamped by scripts/notify-journalist-article-live.mjs
 * only after it has curled all 4 locale URLs and confirmed 200 post-deploy —
 * the same real signal the "article is live" email now waits on, not a guess.
 *
 * Exit codes:
 *   0 — ran fine (including per-doc/per-locale failures, which are logged and
 *       skipped, not fatal).
 *   1 — hard infra failure only (Firestore query itself failed).
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/check-journalist-article-links.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url';

const BASE_URL = 'https://frontaliereticino.ch';
const FETCH_TIMEOUT_MS = 10_000;
const HEAD_TIMEOUT_MS = 8_000;
const HEAD_CONCURRENCY = 5;
const MAX_BROKEN_URLS_STORED = 10;

async function initDb() {
  const admin = (await import('firebase-admin')).default;
  if (!admin.apps?.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  return admin.firestore();
}

/** Same-quote-flexible <a href> extraction as scripts/validate-internal-links.mjs,
 * adapted to operate on a fetched live page (resolves relative hrefs against
 * `pageUrl`, keeps only same-origin targets, strips hash/query for dedupe). */
function extractSameOriginLinks(html, pageUrl) {
  const out = new Set();
  const regex = /<a\b[^>]*href=["']?([^"'\s>]+)["']?/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith('#')) continue;
    if (/^(mailto|tel|javascript):/i.test(raw)) continue;
    try {
      const href = new URL(raw, pageUrl);
      if (href.origin !== BASE_URL) continue;
      href.hash = '';
      out.add(href.toString());
    } catch {
      // ignore malformed hrefs
    }
  }
  return [...out];
}

/** Run `worker(item)` over `items` with at most `concurrency` in flight. */
async function runWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const results = new Array(items.length);
  async function run() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, run));
  return results;
}

/** HEAD-check a single URL; falls back to a ranged GET if the origin rejects
 * HEAD (some static hosts / edge configs return 405/501 for it). */
async function checkLink(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
    if (res.status === 405 || res.status === 501) {
      const getRes = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
      });
      return getRes.ok || getRes.status === 206;
    }
    return res.ok;
  } catch {
    return false;
  }
}

/** Fetch a live page + check all its same-origin outlinks. Returns the
 * linkCheck result shape (services/journalistTypes.ts JournalistArticleLinkCheckResult). */
async function checkPageLinks(pageUrl) {
  const pageRes = await fetch(pageUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!pageRes.ok) throw new Error(`page fetch failed: HTTP ${pageRes.status}`);
  const html = await pageRes.text();
  const links = extractSameOriginLinks(html, pageUrl);

  const brokenUrls = [];
  let brokenCount = 0;
  await runWithConcurrency(links, HEAD_CONCURRENCY, async (url) => {
    const ok = await checkLink(url);
    if (ok) return;
    brokenCount += 1;
    if (brokenUrls.length < MAX_BROKEN_URLS_STORED) brokenUrls.push(url);
  });

  return {
    checkedAt: new Date().toISOString(),
    totalLinks: links.length,
    brokenLinks: brokenCount,
    brokenUrls,
  };
}

async function processDoc(db, docSnap) {
  const docId = docSnap.id;
  const doc = docSnap.data();
  const publishedUrls = doc.publishedUrls || {};
  const locales = Object.keys(publishedUrls);
  if (!locales.length) {
    console.warn(`  ⚠️  ${docId}: no publishedUrls — skipping.`);
    return;
  }

  if (!doc.liveVerifiedAt) {
    console.log(`  ⏭️  ${docId}: not live-verified yet (deploy pending) — skipping until it is.`);
    return;
  }

  console.log(`\n🔗 Checking links for journalist_articles/${docId} (${locales.length} locale(s))...`);
  for (const locale of locales) {
    const url = publishedUrls[locale];
    try {
      const result = await checkPageLinks(url);
      await docSnap.ref.update({ [`linkCheck.${locale}`]: result });
      console.log(`  ${result.brokenLinks > 0 ? '⚠️ ' : '✅'} ${locale}: ${result.totalLinks} link(s), ${result.brokenLinks} broken`);
    } catch (err) {
      // Best-effort per locale: log and move on, never abort the doc or the run.
      console.warn(`  ⚠️  ${docId}/${locale}: link check failed (non-fatal): ${err.message}`);
    }
  }
}

async function main() {
  const db = await initDb();
  const snap = await db.collection('journalist_articles').where('status', '==', 'published').get();
  console.log(`[check-journalist-article-links] ${snap.size} published article(s) to check.`);

  for (const docSnap of snap.docs) {
    try {
      await processDoc(db, docSnap);
    } catch (err) {
      // Should be unreachable (processDoc already isolates per-locale errors),
      // but keep the per-doc boundary hard in case of an unexpected throw.
      console.error(`  ❌ ${docSnap.id}: unexpected failure (non-fatal, skipping doc): ${err.message}`);
    }
  }

  console.log('[check-journalist-article-links] done.');
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[check-journalist-article-links] FATAL:', err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
}

export { extractSameOriginLinks, runWithConcurrency, checkPageLinks, processDoc };
