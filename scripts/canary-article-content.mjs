#!/usr/bin/env node
/**
 * canary-article-content.mjs — Live article-content canary.
 *
 * Catches the article-stub regression class proactively, BETWEEN deploys.
 *
 * Why exists: incident 2026-05-28 — `ogPagesPlugin` emitted a dotfile
 * `dist/articoli-frontaliere/<slug>/.html` for ~2,540 articles. GitHub
 * Pages served the dotfile for `/<slug>/` URLs with content-type=
 * application/octet-stream (no extension match), masking the real
 * `<slug>/index.html`. The served body was a 1.7 KB infinite-redirect
 * stub with no SPA bundle, no AdSense tags, and `noindex,follow`.
 * AdSense RPM crashed 3.04 → 1.74 CHF/day in 48h because the stubs
 * carry zero monetization inventory.
 *
 * The fix in PR #713 (a) strips trailing slashes from the path before
 * `+ '.html'` concat in ogPagesPlugin, (b) skips dotfile basenames in
 * `transformFlatRedirect`, (c) added `audit:no-dotfile-html` as a
 * pre-deploy gate, and (d) repaired the rollback workflow's
 * artifact-expired path. This canary is the LAST line of defense:
 * a scheduled probe that catches any future regression of this class
 * (or any other failure mode that reduces an article URL to a stub)
 * by checking the LIVE site every 30 min.
 *
 * Checks per article (any failure → fail the URL):
 *   1. HTTP status == 200
 *   2. content-type starts with `text/html`  — guards against the
 *      dotfile-served-as-octet-stream case
 *   3. content-length >= MIN_BYTES (default 5000)  — real articles are
 *      15-110 KB, stubs are 1.7 KB
 *   4. body contains `src="/assets/index-`  — SPA bundle injected
 *   5. body does NOT contain `location.replace("<own URL>"` — no
 *      self-redirect loop (the stub's defining signature)
 *
 * Sample strategy: 20 random URLs from sitemap-blog.xml. With 97%
 * regression rate (incident baseline), 20 samples catches ≥1 broken
 * URL with probability >99.9%.
 *
 * Exit codes:
 *   0 — every sampled article passed all checks
 *   1 — at least one article failed; details on stdout for the workflow
 *       to consume and turn into a GitHub issue
 *   2 — the sitemap/probe could not complete after bounded retries; with
 *       --json, stdout contains an `error` summary for the workflow issue
 *
 * Usage:
 *   node scripts/canary-article-content.mjs              # default: 20 samples
 *   node scripts/canary-article-content.mjs --samples=10 # custom sample size
 *   node scripts/canary-article-content.mjs --json       # JSON summary on stdout
 */

import { realpathSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SITE = "https://frontaliereticino.ch";
const SITEMAP_URL = `${SITE}/sitemap-blog.xml`;
const DEFAULT_SAMPLES = 20;
const MIN_BYTES = 5000;
const FETCH_TIMEOUT_MS = 15000;
const PROBE_CONCURRENCY = 5;
const RETRY_ATTEMPTS = 3; // 1 initial request + 2 retries for transient failures.
const RETRY_BACKOFF_MS = 1000;
// Cloudflare in front of the live site returns 403 to requests carrying
// undici's default (empty) User-Agent from datacenter IPs (GitHub Actions
// runners). A descriptive UA — same convention as probe-5xx.mjs and
// check-sitemap-shard-size.mjs — clears the bot check so the probe reaches
// the real origin instead of failing on the sitemap fetch.
const USER_AGENT = "FrontaliereTicino-ContentCanary/1.0 (+https://frontaliereticino.ch)";

const args = process.argv.slice(2);
const samples = (() => {
  const f = args.find((a) => a.startsWith("--samples="));
  if (!f) return DEFAULT_SAMPLES;
  const n = Number.parseInt(f.slice("--samples=".length), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SAMPLES;
})();
const wantsJson = args.includes("--json");

function log(line) {
  if (!wantsJson) console.log(line);
  else console.error(line);
}

async function fetchWithTimeout(url, init = {}, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      ...init,
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...(init.headers || {}),
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status >= 500 && status < 600;
}

async function fetchWithRetry(
  url,
  init = {},
  {
    fetchImpl = fetch,
    sleepImpl = sleep,
    retryAttempts = RETRY_ATTEMPTS,
    retryBackoffMs = RETRY_BACKOFF_MS,
  } = {},
) {
  const attempts = Math.max(1, retryAttempts);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url, init, fetchImpl);
      if (!isRetryableStatus(res.status) || attempt === attempts) return res;
      // Release an intermediate error response before opening the next attempt.
      if (res.body) await res.body.cancel().catch(() => {});
    } catch (err) {
      lastError = err;
      if (attempt === attempts) throw err;
    }
    await sleepImpl(retryBackoffMs);
  }

  throw lastError || new Error(`fetch failed after ${attempts} attempts`);
}

async function loadArticleUrls({ fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const res = await fetchWithRetry(SITEMAP_URL, {}, { fetchImpl, sleepImpl });
  if (!res.ok) throw new Error(`sitemap fetch ${res.status}`);
  const xml = await res.text();
  const urls = [];
  const rx = /<loc>([^<]+)<\/loc>/g;
  let m;
  while ((m = rx.exec(xml)) !== null) urls.push(m[1]);
  return urls;
}

function pickSample(urls, n) {
  // Fisher-Yates partial shuffle for a uniformly random sample.
  const a = urls.slice();
  const k = Math.min(n, a.length);
  for (let i = 0; i < k; i += 1) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

async function probe(url, { fetchImpl = fetch, sleepImpl = sleep } = {}) {
  let res;
  try {
    res = await fetchWithRetry(
      url,
      { redirect: "manual" },
      { fetchImpl, sleepImpl },
    );
  } catch (err) {
    return { url, ok: false, reason: `fetch error: ${err.message || err}` };
  }
  if (res.status !== 200) {
    return { url, ok: false, reason: `HTTP ${res.status}` };
  }
  const ct = res.headers.get("content-type") || "";
  if (!ct.toLowerCase().startsWith("text/html")) {
    return { url, ok: false, reason: `content-type=${ct || "(none)"}` };
  }
  const body = await res.text();
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes < MIN_BYTES) {
    return { url, ok: false, reason: `body=${bytes}B < ${MIN_BYTES}B (stub?)`, bytes };
  }
  // src may be same-origin or an absolute CDN URL (ASSET_CDN/renderBuiltUrl).
  if (!/src="[^"]*\/assets\/index-/.test(body)) {
    return { url, ok: false, reason: "missing SPA bundle <script src=.../assets/index-*.js>", bytes };
  }
  // Self-redirect loop detector: bridges contain `location.replace("<self URL>"`.
  // Real articles ship a location.replace ONLY in their flat-sibling shell, not
  // the index.html shell — so any location.replace WHOSE TARGET equals the
  // current URL is the stub signature.
  const selfLoopRx = new RegExp(
    `location\\.replace\\(\\s*"${url.replace(/[/.?$^*+()|[\]\\{}]/g, "\\$&")}"`,
  );
  if (selfLoopRx.test(body)) {
    return { url, ok: false, reason: "self-redirect loop (location.replace to own URL)", bytes };
  }
  return { url, ok: true, bytes };
}

async function probeWithPool(urls, concurrency, options = {}) {
  const results = [];
  let cursor = 0;
  const lanes = Array.from({ length: concurrency }, async () => {
    while (cursor < urls.length) {
      const i = cursor++;
      const r = await probe(urls[i], options);
      results.push(r);
    }
  });
  await Promise.all(lanes);
  return results;
}

function buildErrorSummary(err) {
  return {
    site: SITE,
    sampleSize: 0,
    pass: 0,
    fail: 0,
    failures: [],
    error: err instanceof Error ? err.message : String(err || "unknown error"),
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  try {
    log(`[canary-article-content] sitemap=${SITEMAP_URL}`);
    const all = await loadArticleUrls();
    log(`[canary-article-content] sitemap=${all.length} URLs`);
    if (all.length === 0) {
      console.error("[canary-article-content] FAIL — sitemap empty");
      process.exit(1);
    }
    const sample = pickSample(all, samples);
    log(`[canary-article-content] sampling ${sample.length} URLs at concurrency=${PROBE_CONCURRENCY}`);
    const results = await probeWithPool(sample, PROBE_CONCURRENCY);
    const failures = results.filter((r) => !r.ok);
    const passes = results.filter((r) => r.ok);
    const summary = {
      site: SITE,
      sampleSize: sample.length,
      pass: passes.length,
      fail: failures.length,
      failures: failures.map((f) => ({ url: f.url, reason: f.reason, bytes: f.bytes })),
      timestamp: new Date().toISOString(),
    };
    if (wantsJson) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      log("");
      log(`Results: ${passes.length} pass, ${failures.length} fail (sample=${sample.length})`);
      for (const f of failures) {
        log(`  FAIL ${f.url} — ${f.reason}${f.bytes !== undefined ? ` (body=${f.bytes}B)` : ""}`);
      }
    }
    if (failures.length > 0) {
      console.error(
        `\x1b[31m[canary-article-content]\x1b[0m FAIL — ${failures.length}/${sample.length} articles regressed`,
      );
      process.exit(1);
    }
    console.log(
      `\x1b[32m[canary-article-content]\x1b[0m PASS — ${passes.length}/${sample.length} articles healthy`,
    );
    process.exit(0);
  } catch (err) {
    const summary = buildErrorSummary(err);
    if (wantsJson) console.log(JSON.stringify(summary, null, 2));
    console.error(`[canary-article-content] error: ${summary.error}`);
    process.exit(2);
  }
}

export {
  buildErrorSummary,
  fetchWithRetry,
  isRetryableStatus,
  loadArticleUrls,
  probe,
};

if (
  process.argv[1] &&
  (() => {
    try {
      return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
    } catch {
      return false;
    }
  })()
) {
  main();
}
