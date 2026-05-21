#!/usr/bin/env node
/**
 * scripts/dist-shrink.mjs
 *
 * Post-build dist/ shrinker. Runs AFTER `vite build` and BEFORE the tar
 * pack in deploy.yml. Trims the published-site byte count (the binding
 * GH Pages quota — see deploy.yml:646 "1 GB Pages threshold" comment)
 * without changing visible content or violating any SEO gate.
 *
 * Two reductions, each measured on the May 21 2026 artifact baseline:
 *
 *   1. html-minifier-terser pass on dist/**\/*.html
 *      - Safe-aggressive options (no removeOptionalTags, no minifyJS:
 *        the Vite output is already esbuild-minified)
 *      - JSON-LD blocks are preserved verbatim via ignoreCustomFragments
 *        (vincolo N2 from htmlMinify.ts — Google Rich Results consumer
 *        tolerance is unknown for whitespace-collapsed JSON-LD)
 *      - Measured saving: ~3% on top of the existing htmlMinify.ts pass
 *        ≈ 270 MB across 7.86 GB of HTML
 *
 *   2. JSON re-stringify on dist/data/**\/*.json
 *      - Reads with JSON.parse, writes with JSON.stringify (no indent)
 *      - Measured saving: ~5% on the data JSON files (~16 MB)
 *
 * The third lever (twitter:* duplicate strip) was moved to the source
 * — see build-plugins/*.ts; the no-twitter-dupes vitest gate prevents
 * regression. Stripping at the dist layer would mask source drift.
 *
 * Output is DOM-equivalent + content-equivalent to the input. The
 * verify-l2-equivalence.mjs harness covers (1); (2) is a JSON.parse →
 * JSON.stringify roundtrip (lossless).
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';

const require = createRequire(import.meta.url);
const { minify: htmlMinify } = require('html-minifier-terser');

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────
const args = new Map();
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    args.set(k, v ?? true);
  }
}
const DIST = resolve(args.get('dist') || 'dist');
const CONCURRENCY = Number(args.get('concurrency') || Math.max(2, cpus().length));
const DRY = args.get('dry') === true || args.get('dry') === 'true';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// html-minifier-terser options. JSON-LD is left opaque via
// ignoreCustomFragments — exact same contract as build-plugins/shared/htmlMinify.ts.
const MINIFY_OPTS = {
  collapseWhitespace: true,
  conservativeCollapse: true,
  collapseInlineTagWhitespace: false,
  removeComments: true,
  removeAttributeQuotes: true,
  removeRedundantAttributes: true,
  removeEmptyAttributes: true,
  removeOptionalTags: false,
  collapseBooleanAttributes: true,
  useShortDoctype: true,
  minifyCSS: true,
  minifyJS: false,
  processConditionalComments: true,
  sortAttributes: false,
  sortClassName: false,
  ignoreCustomFragments: [
    /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>[\s\S]*?<\/script>/gi,
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function walkExt(root, ext) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await readdir(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && p.endsWith(ext)) out.push(p);
    }
  }
  return out;
}

async function shrinkHtmlFile(file, stats) {
  const before = await readFile(file, 'utf8');
  const beforeBytes = Buffer.byteLength(before, 'utf8');

  let minified;
  try {
    minified = await htmlMinify(before, MINIFY_OPTS);
  } catch (err) {
    // Some pages may contain malformed-but-tolerated markup. Skip rather
    // than fail the build — record but don't throw.
    stats.htmlErrors++;
    if (stats.htmlErrorExamples.length < 5) {
      stats.htmlErrorExamples.push({ file, msg: String(err.message || err).slice(0, 200) });
    }
    return;
  }
  const afterBytes = Buffer.byteLength(minified, 'utf8');

  if (afterBytes < beforeBytes) {
    if (!DRY) await writeFile(file, minified, 'utf8');
    stats.htmlBytesBefore += beforeBytes;
    stats.htmlBytesAfter += afterBytes;
    stats.htmlFilesShrunk++;
  } else {
    stats.htmlBytesBefore += beforeBytes;
    stats.htmlBytesAfter += beforeBytes;
  }
  stats.htmlFilesSeen++;
}

async function shrinkJsonFile(file, stats) {
  const before = await readFile(file, 'utf8');
  const beforeBytes = Buffer.byteLength(before, 'utf8');
  let parsed;
  try { parsed = JSON.parse(before); }
  catch {
    stats.jsonErrors++;
    return;
  }
  const after = JSON.stringify(parsed);
  const afterBytes = Buffer.byteLength(after, 'utf8');

  if (afterBytes < beforeBytes) {
    if (!DRY) await writeFile(file, after, 'utf8');
    stats.jsonBytesBefore += beforeBytes;
    stats.jsonBytesAfter += afterBytes;
    stats.jsonFilesShrunk++;
  } else {
    stats.jsonBytesBefore += beforeBytes;
    stats.jsonBytesAfter += beforeBytes;
  }
  stats.jsonFilesSeen++;
}

// Simple promise pool — Promise.all on 825k tasks blows the heap.
async function pool(items, fn, concurrency) {
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  let distStat;
  try { distStat = await stat(DIST); }
  catch {
    console.error(`dist-shrink: ${DIST} not found`);
    process.exit(2);
  }
  if (!distStat.isDirectory()) {
    console.error(`dist-shrink: ${DIST} is not a directory`);
    process.exit(2);
  }

  console.log(`dist-shrink: scanning ${DIST}${DRY ? ' (DRY RUN)' : ''}`);
  const t0 = Date.now();
  const htmlFiles = await walkExt(DIST, '.html');
  const jsonFiles = await walkExt(join(DIST, 'data'), '.json');
  console.log(`dist-shrink: ${htmlFiles.length} HTML, ${jsonFiles.length} JSON (concurrency=${CONCURRENCY})`);

  const stats = {
    htmlFilesSeen: 0, htmlFilesShrunk: 0, htmlBytesBefore: 0, htmlBytesAfter: 0,
    htmlErrors: 0, htmlErrorExamples: [],
    jsonFilesSeen: 0, jsonFilesShrunk: 0, jsonBytesBefore: 0, jsonBytesAfter: 0,
    jsonErrors: 0,
  };

  await pool(htmlFiles, (f) => shrinkHtmlFile(f, stats), CONCURRENCY);
  await pool(jsonFiles, (f) => shrinkJsonFile(f, stats), CONCURRENCY);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const mb = (n) => +(n / 1024 / 1024).toFixed(2);
  const savedHtml = stats.htmlBytesBefore - stats.htmlBytesAfter;
  const savedJson = stats.jsonBytesBefore - stats.jsonBytesAfter;
  const savedTotal = savedHtml + savedJson;

  console.log('');
  console.log('dist-shrink summary');
  console.log('───────────────────');
  console.log(`HTML  : ${stats.htmlFilesShrunk}/${stats.htmlFilesSeen} shrunk  ${mb(stats.htmlBytesBefore)}→${mb(stats.htmlBytesAfter)} MB  saved ${mb(savedHtml)} MB  (errors: ${stats.htmlErrors})`);
  console.log(`JSON  : ${stats.jsonFilesShrunk}/${stats.jsonFilesSeen} shrunk  ${mb(stats.jsonBytesBefore)}→${mb(stats.jsonBytesAfter)} MB  saved ${mb(savedJson)} MB  (errors: ${stats.jsonErrors})`);
  console.log(`Total : ${mb(savedTotal)} MB saved in ${elapsed}s${DRY ? ' (DRY — no files written)' : ''}`);

  if (stats.htmlErrors > 0) {
    console.log('');
    console.log('First HTML errors:');
    for (const e of stats.htmlErrorExamples) console.log(`  ${e.file}: ${e.msg}`);
  }
}

// Run main() only when invoked as a script, not when imported as a
// module (e.g. by tests/seo/dist-shrink.test.ts).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

export { MINIFY_OPTS };
