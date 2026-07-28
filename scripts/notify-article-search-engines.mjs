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
 *        node scripts/notify-article-search-engines.mjs <url> [url...]
 */
import fs from 'node:fs';

import { notifyGoogleIndexing } from './lib/indexing-api.mjs';
import { submitIndexNowUrls } from './lib/indexnow-submit.mjs';

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
      return (summary.shards || []).map((s) => s?.url).filter(Boolean);
    } catch (err) {
      console.error(`[notify-search-engines] cannot read ${summaryPath}: ${err.message}`);
      return [];
    }
  }
  return argv.filter((a) => a.startsWith('http'));
}

async function main() {
  const urls = [...new Set(parseArgs(process.argv.slice(2)))];
  if (urls.length === 0) {
    console.log('[notify-search-engines] no URLs to submit — nothing to do');
    return;
  }

  console.log(`[notify-search-engines] submitting ${urls.length} URL(s):`);
  for (const u of urls) console.log(`  • ${u}`);

  // Run both channels independently: one failing must not skip the other.
  const [google, indexnow] = await Promise.allSettled([
    notifyGoogleIndexing(urls),
    submitIndexNowUrls(urls),
  ]);

  if (google.status === 'fulfilled') {
    const ok = (google.value || []).filter((r) => r?.ok).length;
    console.log(`[notify-search-engines] Google Indexing API: ${ok}/${urls.length} accepted`);
  } else {
    console.log(`[notify-search-engines] Google Indexing API failed: ${google.reason?.message || google.reason}`);
  }

  if (indexnow.status === 'fulfilled') {
    const ok = (indexnow.value?.results || []).filter((r) => r?.ok).length;
    const total = (indexnow.value?.results || []).length;
    console.log(`[notify-search-engines] IndexNow: ${ok}/${total} endpoint(s) accepted ${indexnow.value?.submitted ?? 0} URL(s)`);
  } else {
    console.log(`[notify-search-engines] IndexNow failed: ${indexnow.reason?.message || indexnow.reason}`);
  }
}

// Run as standalone only if invoked directly (repo idiom — see
// scripts/audit-footer-root-presence.mjs). Guards against a plain `import`
// of this module executing its whole side-effecting run.
const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[notify-search-engines] unexpected error: ${err?.message || err}`);
    // Deliberately exit 0 — see the header contract.
  });
}
