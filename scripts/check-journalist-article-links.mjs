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
 * Ordering caveat (issue #3209 item 2): this script runs in the SAME workflow
 * job as scripts/publish-journalist-article.mjs, BEFORE that job's
 * commit/push/deploy steps (see .github/workflows/publish-journalist-articles.yml).
 * So an article published moments earlier in this exact run is not deployed
 * yet — its own live URL is guaranteed to 404. `isRecentlyPublished()` below
 * skips exactly those just-published docs (rather than fetching a URL known
 * to not be live yet) and leaves them for the next 15-minute cron tick, once
 * the deploy has had time to land — see that function's docstring for the
 * exact reasoning about why a fixed short window can't misfire on an
 * earlier-run doc.
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
import { checkLink, runWithConcurrency } from './lib/live-link-check.mjs';

const BASE_URL = 'https://frontaliereticino.ch';
const FETCH_TIMEOUT_MS = 10_000;
const HEAD_TIMEOUT_MS = 8_000;
const HEAD_CONCURRENCY = 5;
const MAX_BROKEN_URLS_STORED = 10;

// Comfortably covers the gap between publish-journalist-article.mjs stamping
// `publishedAt` and this SAME job reaching its (later) commit/push/deploy
// steps, while staying well under the 15-minute cron cadence — so a doc
// published in an EARLIER run (already deployed for at least one full cron
// interval) is never mistakenly skipped here.
const RECENTLY_PUBLISHED_SKIP_MS = 5 * 60 * 1000;

/** True when `publishedAtMs` is recent enough that the article's own page
 * cannot possibly be deployed yet — i.e. it was published by
 * publish-journalist-article.mjs earlier in THIS SAME workflow run, whose
 * commit/push/deploy-trigger steps only run after this script (issue #3209
 * item 2). Exported for tests. */
function isRecentlyPublished(publishedAtMs, now = Date.now()) {
  return typeof publishedAtMs === 'number' && Number.isFinite(publishedAtMs) && now - publishedAtMs < RECENTLY_PUBLISHED_SKIP_MS;
}

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
    const ok = await checkLink(url, HEAD_TIMEOUT_MS);
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

  const publishedAtMs = typeof doc.publishedAt?.toMillis === 'function' ? doc.publishedAt.toMillis() : null;
  if (isRecentlyPublished(publishedAtMs)) {
    const ageSec = Math.round((Date.now() - publishedAtMs) / 1000);
    console.log(
      `  ⏭️  ${docId}: published ${ageSec}s ago in this same run — commit/push/deploy hasn't run yet, ` +
        'own URL cannot be live. Skipping until next tick.',
    );
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

export { extractSameOriginLinks, runWithConcurrency, checkPageLinks, isRecentlyPublished, processDoc };
