#!/usr/bin/env node
/**
 * Audit generated static HTML pages for duplicate body content within a locale.
 *
 * Walks `dist/**\/*.html`, groups pages by locale (inferred from the URL path
 * prefix: `/en/…`, `/de/…`, `/fr/…`, anything else = `it`). For each page it
 * extracts the visible body text — `<script>`, `<style>`, and the top-level
 * `<nav>` / `<header>` / `<footer>` / `<aside>` chrome are stripped before
 * hashing so that shared shell markup never triggers false positives.
 *
 * The remaining text is whitespace-normalised and hashed with SHA-256.
 * Pages within the SAME locale that produce the same hash are grouped into
 * "clusters" — each cluster ≥2 pages is a duplicate group.
 *
 * Exit code:
 *   0 — no locale has more than CLUSTER_THRESHOLD duplicate clusters
 *   1 — at least one locale breached the threshold; first 20 clusters are printed
 *
 * Cross-locale duplicates are ALLOWED (a page translated to the same editorial
 * copy in multiple languages is intentional, not a duplicate).
 *
 * Usage:
 *   node scripts/audit-content-duplicates.mjs            # audits ./dist
 *   node scripts/audit-content-duplicates.mjs path/to/dist
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CLUSTER_THRESHOLD = 5;
const MAX_REPORTED = 20;
const LOCALE_PREFIXES = /** @type {const} */ (['en', 'de', 'fr']);

/**
 * Recursively walk a directory and yield every `.html` file.
 * @param {string} dir
 * @returns {Generator<string>}
 */
function* walkHtml(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkHtml(full);
    } else if (stat.isFile() && full.endsWith('.html')) {
      yield full;
    }
  }
}

/**
 * Infer locale from a `dist`-relative path. Italian is the implicit default.
 * @param {string} relPath
 * @returns {'it'|'en'|'de'|'fr'}
 */
function inferLocale(relPath) {
  const first = relPath.split(sep)[0] || '';
  if (LOCALE_PREFIXES.includes(/** @type {'en'|'de'|'fr'} */ (first))) {
    return /** @type {'en'|'de'|'fr'} */ (first);
  }
  return 'it';
}

/**
 * Strip shared chrome (top-level nav/header/footer/aside) + scripts + styles
 * from raw HTML, returning the visible body text used for duplicate detection.
 *
 * The regexes intentionally use `.*?` (non-greedy) and the `s` flag so that
 * every match is as small as possible. We only strip ONE top-level block per
 * tag name — the goal is to remove the shell chrome emitted by
 * `buildSeoPageHtml`, not inline `<nav>` in article content (which belongs to
 * the per-entity body).
 *
 * @param {string} html
 * @returns {string}
 */
function extractBodyText(html) {
  if (!html) return '';
  let body = html;

  // Remove the <head>…</head> entirely.
  body = body.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ');

  // Remove all script / style / svg / template blocks.
  body = body.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  body = body.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
  body = body.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, ' ');
  body = body.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ');

  // Remove chrome shells — the first occurrence of each only, so we don't
  // accidentally delete an article's inner <nav> (breadcrumb) that IS
  // per-entity content.
  body = body.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  body = body.replace(/<header\b[^>]*(role=["']banner["']|class=["'][^"']*site-[^"']*["'])[^>]*>[\s\S]*?<\/header>/gi, ' ');

  // Strip any remaining tags + decode trivial entities.
  body = body.replace(/<[^>]+>/g, ' ');
  body = body
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&(?:[a-z]+|#\d+);/gi, ' ');

  // Normalise whitespace.
  return body.replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} content
 * @returns {string}
 */
function sha256(content) {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Group duplicate hashes by locale.
 * @param {Array<{ relPath: string; locale: string; hash: string; wordCount: number }>} pages
 * @returns {Map<string, Map<string, string[]>>} locale → (hash → [relPath])
 */
function groupDuplicates(pages) {
  /** @type {Map<string, Map<string, string[]>>} */
  const byLocale = new Map();
  for (const p of pages) {
    if (!byLocale.has(p.locale)) byLocale.set(p.locale, new Map());
    const localeMap = /** @type {Map<string, string[]>} */ (byLocale.get(p.locale));
    if (!localeMap.has(p.hash)) localeMap.set(p.hash, []);
    /** @type {string[]} */ (localeMap.get(p.hash)).push(p.relPath);
  }
  return byLocale;
}

/**
 * @param {string} distDir
 * @returns {{ exitCode: number; totals: Record<string, number>; duplicates: Array<{ locale: string; hash: string; paths: string[] }> }}
 */
function audit(distDir) {
  /** @type {Array<{ relPath: string; locale: string; hash: string; wordCount: number }>} */
  const pages = [];

  try {
    statSync(distDir);
  } catch {
    console.error(`[audit-content-duplicates] dist directory not found: ${distDir}`);
    return { exitCode: 1, totals: {}, duplicates: [] };
  }

  for (const file of walkHtml(distDir)) {
    const relPath = relative(distDir, file);
    const html = readFileSync(file, 'utf-8');
    const bodyText = extractBodyText(html);
    if (!bodyText) continue;
    // Skip very small stubs (error pages, 404, empty redirects) — they're not
    // indexable content and dominate cross-locale noise.
    const wordCount = bodyText.split(/\s+/).length;
    if (wordCount < 40) continue;
    const locale = inferLocale(relPath);
    pages.push({ relPath, locale, hash: sha256(bodyText), wordCount });
  }

  const grouped = groupDuplicates(pages);
  /** @type {Record<string, number>} */
  const totals = {};
  /** @type {Array<{ locale: string; hash: string; paths: string[] }>} */
  const duplicates = [];

  for (const [locale, localeMap] of grouped.entries()) {
    let dupClusters = 0;
    for (const [hash, paths] of localeMap.entries()) {
      if (paths.length < 2) continue;
      dupClusters++;
      duplicates.push({ locale, hash, paths });
    }
    totals[locale] = dupClusters;
  }

  duplicates.sort((a, b) => b.paths.length - a.paths.length);

  const breached = Object.values(totals).some((n) => n > CLUSTER_THRESHOLD);
  return { exitCode: breached ? 1 : 0, totals, duplicates };
}

/**
 * @param {{ exitCode: number; totals: Record<string, number>; duplicates: Array<{ locale: string; hash: string; paths: string[] }> }} result
 */
function printReport(result) {
  const { totals, duplicates } = result;
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
    return;
  }

  const reported = duplicates.slice(0, MAX_REPORTED);
  console.log(`\n[audit-content-duplicates] Top ${reported.length} duplicate cluster(s):`);
  for (const cluster of reported) {
    console.log(`  [${cluster.locale}] hash=${cluster.hash.slice(0, 12)}… pages=${cluster.paths.length}`);
    for (const p of cluster.paths.slice(0, 6)) {
      console.log(`    - ${p}`);
    }
    if (cluster.paths.length > 6) {
      console.log(`    … and ${cluster.paths.length - 6} more`);
    }
  }
}

function main() {
  const arg = process.argv[2];
  const distDir = arg ? arg : 'dist';
  const result = audit(distDir);
  printReport(result);
  if (result.exitCode !== 0) {
    console.error(
      `\n[audit-content-duplicates] FAIL — at least one locale exceeded the ${CLUSTER_THRESHOLD}-cluster threshold.`,
    );
  }
  process.exit(result.exitCode);
}

// Only execute when this file is invoked directly (not when imported for tests).
const invokedPath = process.argv[1] ? process.argv[1] : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  main();
}

export { audit, extractBodyText, inferLocale, sha256 };
