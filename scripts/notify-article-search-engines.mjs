#!/usr/bin/env node
/**
 * Notify search engines that a fast-published article's URLs are live.
 *
 * Issue #4837. Invoked by `.github/workflows/fast-publish-article.yml` AFTER
 * `scripts/wait-for-live-article-shards.mjs` has confirmed every locale URL
 * actually returns 200 — never before. The old behaviour (removed from
 * `generate-article.yml` in the same change) pinged Google straight after
 * dispatching the deploy, on the false assumption that a deploy lands in ~2-3
 * minutes; the real worst case measured in this repo is 2h04m37s (run
 * 29505580973), so Google was routinely sent to crawl a 404.
 *
 * Both channels are notified with the SAME explicit URL list:
 *   - Google Indexing API — takes URLs directly.
 *   - IndexNow (Bing/Yandex) — normally driven by the deployed sitemaps
 *     (`scripts/submit-indexnow.js`), which are apex-only artifacts that do not
 *     change until the next full deploy. Without a direct submit here, a
 *     fast-published article would be discoverable by Google in minutes but
 *     invisible to Bing/Yandex for hours — an asymmetry with no reason to
 *     exist.
 *
 * Best-effort by contract: always exits 0. The article is already live; failing
 * to notify a search engine must never be reported as a failed publish. The
 * post-deploy submitters remain the backstop either way.
 *
 * Usage: node scripts/notify-article-search-engines.mjs --summary <summary.json>
 *        node scripts/notify-article-search-engines.mjs --indexnow-only --summary <summary.json>
 *        node scripts/notify-article-search-engines.mjs <url> [url...]
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

import { notifyGoogleIndexing } from './lib/indexing-api.mjs';
import { submitIndexNowUrls, verifyIndexNowKey } from './lib/indexnow-submit.mjs';

const SITE_ORIGIN = 'https://frontaliereticino.ch';

function indexableUrlFromShardPath(relPath) {
  if (typeof relPath !== 'string' || !/\/index\.html$/i.test(relPath)) return null;
  const route = `/${relPath.replace(/^\/+/, '').replace(/\/index\.html$/i, '')}/`;
  try {
    return new URL(route, SITE_ORIGIN).href;
  } catch {
    return null;
  }
}

/**
 * The fast-publish summary contains every path pushed to the locale shards,
 * not only the article's four canonical URLs. Include the section landing,
 * archive pagination and topic hubs as well: they are real changed pages and
 * the topic sitemap is produced from the same rendered set.
 */
export function urlsFromPublishSummary(summary) {
  const urls = new Set();
  for (const shard of Array.isArray(summary?.shards) ? summary.shards : []) {
    if (typeof shard?.url === 'string' && shard.url) urls.add(shard.url);
    for (const relPath of Array.isArray(shard?.paths) ? shard.paths : []) {
      const url = indexableUrlFromShardPath(relPath);
      if (url) urls.add(url);
    }
  }
  for (const section of Object.values(summary?.sections || {})) {
    for (const paths of Object.values(section?.pathsByLocale || {})) {
      for (const relPath of Array.isArray(paths) ? paths : []) {
        const url = indexableUrlFromShardPath(relPath);
        if (url) urls.add(url);
      }
    }
  }
  return [...urls].sort();
}

function parseArgs(argv) {
  const summaryIdx = argv.indexOf('--summary');
  if (summaryIdx !== -1) {
    const summaryPath = argv[summaryIdx + 1];
    if (!summaryPath) {
      console.error('[notify-search-engines] --summary requires a path');
      return [];
    }
    try {
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      return urlsFromPublishSummary(summary);
    } catch (err) {
      console.error(`[notify-search-engines] cannot read ${summaryPath}: ${err.message}`);
      return [];
    }
  }
  return argv.filter((a) => a.startsWith('http'));
}

function ledgerPathFromArgs(argv) {
  const index = argv.indexOf('--ledger');
  return index === -1 ? undefined : argv[index + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  const indexNowOnly = argv.includes('--indexnow-only');
  const urls = [...new Set(parseArgs(argv))];
  const ledgerPath = ledgerPathFromArgs(argv);
  if (urls.length === 0) {
    console.log('[notify-search-engines] no URLs to submit — nothing to do');
    return;
  }

  console.log(`[notify-search-engines] submitting ${urls.length} URL(s):`);
  for (const u of urls) console.log(`  • ${u}`);

  const key = await verifyIndexNowKey({ attempts: 3, delayMs: 1000 });
  if (key.ok) {
    console.log(`[notify-search-engines] IndexNow key verified (attempt ${key.attempts})`);
  } else {
    // Keep the publish path best-effort, but make a propagation/key failure
    // visible. The daily complete-graph workflow remains the durable retry.
    console.warn(`[notify-search-engines] IndexNow key preflight failed: ${key.reason}`);
  }

  // Run both channels independently: one failing must not skip the other.
  const [google, indexnow] = await Promise.allSettled([
    indexNowOnly ? Promise.resolve(null) : notifyGoogleIndexing(urls, { ledgerPath }),
    submitIndexNowUrls(urls),
  ]);

  if (indexNowOnly) {
    console.log('[notify-search-engines] Google Indexing API: skipped (--indexnow-only)');
  } else if (google.status === 'fulfilled') {
    const ok = (google.value || []).filter((r) => r?.ok).length;
    console.log(`[notify-search-engines] Google Indexing API: ${ok}/${urls.length} accepted`);
  } else {
    console.log(`[notify-search-engines] Google Indexing API failed: ${google.reason?.message || google.reason}`);
  }

  if (indexnow.status === 'fulfilled') {
    const ok = (indexnow.value?.results || []).filter((r) => r?.ok).length;
    const total = (indexnow.value?.results || []).length;
    console.log(`[notify-search-engines] IndexNow: ${ok}/${total} endpoint(s) accepted ${indexnow.value?.submitted ?? 0} URL(s)`);
    if (ok === 0) process.exitCode = 1;
  } else {
    console.log(`[notify-search-engines] IndexNow failed: ${indexnow.reason?.message || indexnow.reason}`);
    process.exitCode = 1;
  }
}

// Run as standalone only if invoked directly (repo idiom — see
// scripts/audit-footer-root-presence.mjs). Guards against a plain `import`
// of this module executing its whole side-effecting run.
const invokedDirectly = (() => {
  // Entrypoint canonico, non suffisso del path (#7292): `endsWith` diceva true
  // per QUALUNQUE entrypoint il cui `argv[1]` finisse con questo nome di file;
  // `realpathSync` copre l'invocazione via symlink, dove `argv[1]` e' il link.
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[notify-search-engines] unexpected error: ${err?.message || err}`);
    // Deliberately exit 0 — see the header contract.
  });
}
