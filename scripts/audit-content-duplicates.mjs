#!/usr/bin/env node
/**
 * Audit generated static HTML pages for duplicate body content within a locale.
 *
 * Walks `dist/**\/*.html`, groups pages by locale, hashes their visible body
 * text (stripping head/scripts/styles/svg/chrome), and groups by SHA-256
 * hash. Pages within the SAME locale that produce the same hash are
 * "duplicate clusters". Cross-locale duplicates are ALLOWED.
 *
 * Two execution modes:
 *   1. Standalone CLI:  node scripts/audit-content-duplicates.mjs [dist]
 *   2. Unified runner:  imported by scripts/audit-all.mjs via factory().
 */

import { readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';

const CLUSTER_THRESHOLD = 5;
const MAX_REPORTED = 20;
// How many member paths of a single duplicate cluster are retained. The gate
// turns on the cluster COUNT per locale, never on the membership list, and the
// CLI prints `cluster.paths.length` members of at most MAX_REPORTED clusters.
const PATHS_PER_CLUSTER_CAP = 50;
const LOCALE_PREFIXES = ['en', 'de', 'fr'];

function inferLocale(relPath) {
  const first = relPath.split(sep)[0] || '';
  if (LOCALE_PREFIXES.includes(first)) return first;
  return 'it';
}

function canonicalizeDistPath(relPath) {
  const posix = relPath.split(sep).join('/');
  if (posix === 'index.html') return '/';
  if (posix.endsWith('/index.html')) return posix.slice(0, -'index.html'.length);
  if (posix.endsWith('.html')) return `${posix.slice(0, -'.html'.length)}/`;
  return posix;
}

// Quote-flexible — PR #478 baked removeAttributeQuotes upstream. URL hrefs and
// short single-token meta names/contents lose their quotes in dist/.
function extractCanonical(html) {
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const scope = headMatch ? headMatch[1] : html;
  const m = /<link[^>]+rel=["']?canonical["']?[^>]*href=["']?([^"'\s>]+)["']?/i.exec(scope);
  if (m) return m[1].trim();
  const m2 = /<link[^>]+href=["']?([^"'\s>]+)["']?[^>]*rel=["']?canonical["']?/i.exec(scope);
  return m2 ? m2[1].trim() : null;
}

function hasNoindex(html) {
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const scope = headMatch ? headMatch[1] : html;
  const m = /<meta[^>]+name=["']?robots["']?[^>]*content=["']?([^"'>]+?)["']?\s*\/?>/i.exec(scope);
  if (!m) return false;
  return /\bnoindex\b/i.test(m[1]);
}

export function extractBodyText(html) {
  if (!html) return '';
  let body = html;
  body = body.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ');
  body = body.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  body = body.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
  body = body.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, ' ');
  body = body.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  body = body.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  body = body.replace(/<header\b[^>]*(role=["']banner["']|class=["'][^"']*site-[^"']*["'])[^>]*>[\s\S]*?<\/header>/gi, ' ');
  body = body.replace(/<[^>]+>/g, ' ');
  body = body
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&(?:[a-z]+|#\d+);/gi, ' ');
  return body.replace(/\s+/g, ' ').trim();
}

export function sha256(content) {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export { inferLocale };

export function createAuditor(opts = {}) {
  const clusterThreshold = opts.clusterThreshold ?? CLUSTER_THRESHOLD;
  // Grouped AS WE GO: locale → hash → { n, paths }.
  //
  // This used to be a flat `pages[]` with one `{relPath, locale, hash,
  // wordCount}` object PER SCANNED FILE, regrouped into exactly this shape in
  // report(). At the ~977'000 files a sampled post-deploy run scans that is
  // ~977'000 objects, each holding a 64-char hex digest string, alive until
  // report() — which then built the grouping ALONGSIDE it, so both peaked
  // together. `audit:all` died at `Ineffective mark-compacts near heap limit`
  // on run 32261742920 with this auditor in the process.
  //
  // Grouping in collect() keeps one entry per DISTINCT body instead of one per
  // file, holds each digest once instead of twice, and removes the second
  // peak. `wordCount` is gone because nothing ever read it.
  //
  // The verdict is unchanged: `n` is the TRUE cluster size (paths is only the
  // reported sample), so per-locale cluster counts and `breached` are
  // bit-for-bit what they were.
  const byLocale = new Map();
  const seenUrlKeys = new Set();

  return {
    name: 'content-duplicates',
    collect(file, html) {
      const relPath = relative(DEFAULT_DIST, file);
      const urlKey = canonicalizeDistPath(relPath);
      if (seenUrlKeys.has(urlKey)) return;
      seenUrlKeys.add(urlKey);

      if (hasNoindex(html)) return;
      const bodyText = extractBodyText(html);
      if (!bodyText) return;
      const wordCount = bodyText.split(/\s+/).length;
      if (wordCount < 40) return;

      const canonical = extractCanonical(html);
      if (canonical) {
        const canonicalPath = canonical.replace(/^https?:\/\/[^/]+/, '').replace(/#.*$/, '').replace(/\?.*$/, '');
        const normalizedCanonical = canonicalPath.replace(/\/$/, '') || '/';
        const normalizedSelf = urlKey.replace(/\/$/, '') || '/';
        if (normalizedCanonical !== normalizedSelf) return;
      }

      const locale = inferLocale(relPath);
      const hash = sha256(bodyText);
      let m = byLocale.get(locale);
      if (m === undefined) {
        m = new Map();
        byLocale.set(locale, m);
      }
      const cluster = m.get(hash);
      if (cluster === undefined) {
        m.set(hash, { n: 1, paths: [relPath] });
      } else {
        cluster.n++;
        // A duplicate cluster is described, not enumerated: the report prints
        // a handful and the JSON keeps a sample. Retaining all N paths of a
        // 40'000-page cluster is memory spent on output nobody reads.
        if (cluster.paths.length < PATHS_PER_CLUSTER_CAP) cluster.paths.push(relPath);
      }
    },
    report() {
      const totals = {};
      const duplicates = [];
      for (const [locale, m] of byLocale.entries()) {
        let dupClusters = 0;
        for (const [hash, cluster] of m.entries()) {
          if (cluster.n < 2) continue;
          dupClusters++;
          duplicates.push({ locale, hash, n: cluster.n, paths: cluster.paths });
        }
        totals[locale] = dupClusters;
      }
      duplicates.sort((a, b) => b.n - a.n);

      const breached = Object.values(totals).some((n) => n > clusterThreshold);
      const offenders = duplicates.map((c) => ({
        path: c.paths[0],
        feature: c.locale,
        metric: c.n,
        ratio: null,
        hash: c.hash,
        pages: c.paths,
      }));

      return {
        passed: !breached,
        offendersTotal: offenders.length,
        offenders,
        threshold: { metric: 'clustersPerLocale', value: clusterThreshold, comparator: '<=' },
        byFeature: totals,
        extra: { totals, duplicates },
        humanSummary: breached
          ? `${Object.entries(totals).map(([l, n]) => `${l}=${n}`).join(', ')} (threshold ${clusterThreshold})`
          : `no locale exceeded ${clusterThreshold} duplicate clusters`,
      };
    },
  };
}

export const factory = createAuditor;
export const auditor = factory();

// ─── Standalone CLI ──────────────────────────────────────────────────────────

async function standalone() {
  const arg = process.argv[2];
  const distDir = arg && !arg.startsWith('--') ? arg : DEFAULT_DIST;

  const s = await stat(distDir).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(`[audit-content-duplicates] dist directory not found: ${distDir}`);
    process.exit(1);
  }

  const a = createAuditor();
  const files = await walkHtmlFiles(distDir);
  for (const file of files) {
    let html;
    try { html = await readFile(file, 'utf8'); }
    catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    a.collect(file, html);
  }
  const result = await a.report();
  await writeAuditReport({
    audit: a.name,
    passed: result.passed,
    threshold: result.threshold,
    offenders: result.offenders,
    byFeature: result.byFeature,
  });

  const { totals, duplicates } = result.extra;
  console.log('[audit-content-duplicates] Duplicate clusters per locale:');
  const localeKeys = Object.keys(totals).sort();
  if (localeKeys.length === 0) {
    console.log('  (no locales detected)');
  } else {
    for (const loc of localeKeys) {
      console.log(`  ${loc}: ${totals[loc]} duplicate cluster(s)`);
    }
  }

  if (duplicates.length === 0) {
    console.log('[audit-content-duplicates] OK — no duplicate bodies detected.');
  } else {
    const reported = duplicates.slice(0, MAX_REPORTED);
    console.log(`\n[audit-content-duplicates] Top ${reported.length} duplicate cluster(s):`);
    for (const cluster of reported) {
      // `n` is the true cluster size; `paths` is the retained sample
      // (PATHS_PER_CLUSTER_CAP). Printing paths.length here would UNDERSTATE a
      // large cluster the moment the cap bites — the one way this memory fix
      // could have quietly changed what a reader sees.
      console.log(`  [${cluster.locale}] hash=${cluster.hash.slice(0, 12)}… pages=${cluster.n}`);
      for (const p of cluster.paths.slice(0, 6)) console.log(`    - ${p}`);
      if (cluster.n > 6) console.log(`    … and ${cluster.n - 6} more`);
    }
  }

  if (!result.passed) {
    console.error(`\n[audit-content-duplicates] FAIL — at least one locale exceeded the ${CLUSTER_THRESHOLD}-cluster threshold.`);
  }
  process.exit(result.passed ? 0 : 1);
}

const invokedPath = process.argv[1] ? process.argv[1] : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  standalone().catch((err) => {
    console.error('[audit-content-duplicates] crashed:', err);
    process.exit(2);
  });
}
