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
 *
 * ─── Diagnostic output ───────────────────────────────────────────────
 * Aside from totals, prints two breakdowns to inform "fix at source"
 * decisions:
 *
 *   • Top directories by saving — lets you see which build-plugin
 *     emission paths produce the most minifiable HTML. If a single
 *     top-level dir contributes >30% of total saving, the matching
 *     plugin should be patched to emit the tighter form directly
 *     (avoids paying for minify on every deploy).
 *
 *   • Per-rule contribution — measured on a 200-file random sample,
 *     each html-minifier-terser option is disabled in turn to attribute
 *     bytes back to that option. A rule contributing <1% can be turned
 *     off to speed up the pass without material loss.
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { spawnSync } from 'node:child_process';

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
const SAMPLE_SIZE = Number(args.get('sample') || 200);
// Top-N rows printed for "biggest file" leaderboards.
const TOP_N = Number(args.get('top') || 15);
// Min saved bytes for a file to be tracked individually. Below this we
// only keep aggregate counts. 500 B filters out near-empty SPA fallback
// shells whose noise drowns the actionable "fix this template" signal.
const TRACK_SAVED_MIN = Number(args.get('track-min') || 500);
// Ratio leaderboard ignores files smaller than this — a 200 B file that
// shrinks to 80 B is 60% saving but tells us nothing useful about
// where to spend refactor time.
const RATIO_MIN_BYTES = Number(args.get('ratio-min-bytes') || 5 * 1024);

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// html-minifier-terser options. JSON-LD is left opaque via
// ignoreCustomFragments — exact same contract as build-plugins/shared/htmlMinify.ts.
//
// Disabled-by-design (each measured at 0% contribution on the May 21
// 2026 production sample, run #26250403558):
//   - removeComments           : prior `htmlMinify.ts` pass already strips them
//   - removeRedundantAttributes: build plugins never emit redundant attrs
//   - removeEmptyAttributes    : build plugins never emit empty attrs
//   - useShortDoctype          : `htmlTemplate.ts` already emits short doctype
//   - minifyCSS                : almost no inline CSS in our output (one
//                                 sample saved 12 B total → not worth the
//                                 CSS-AST parsing cost across 841k files)
//
// Disabled 2026-05-22 due to audit incompatibility:
//   - removeAttributeQuotes    : ~14 dist-walking audits carry quote-strict
//                                 regexes baked into their baseline snapshots
//                                 (footer-root-presence, spa-bundle-injection,
//                                 h1-title-duplicates, sitemap-canonicals,
//                                 title-length, salary-landing-template,
//                                 content-duplicates, no-literal-markdown, …).
//                                 Run #26255102850 surfaced 438k+ false-
//                                 positive regressions. Re-enable once those
//                                 audits migrate to the quote-flex pattern
//                                 already used in tests/seo/dist-shrink.test.ts
//                                 ("canonical/hreflang/robots regexes").
const MINIFY_OPTS = {
  collapseWhitespace: true,
  conservativeCollapse: true,
  collapseInlineTagWhitespace: false,
  removeComments: false,
  removeAttributeQuotes: false,          // reverted — audits depend on quoted attrs
  removeRedundantAttributes: false,
  removeEmptyAttributes: false,
  removeOptionalTags: false,             // SEO-risk: kept off
  collapseBooleanAttributes: true,       // 1.5% — cheap, keep
  useShortDoctype: false,
  minifyCSS: false,
  minifyJS: false,                       // Vite already esbuild-minifies
  processConditionalComments: false,
  sortAttributes: false,
  sortClassName: false,
  ignoreCustomFragments: [
    /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>[\s\S]*?<\/script>/gi,
  ],
};

// Rules to attribute savings to, in the per-rule breakdown. Each is
// toggled OFF in turn against the baseline opts; the byte delta vs
// the all-rules baseline = that rule's marginal contribution.
const RULES_TO_PROFILE = [
  'collapseWhitespace',
  'removeComments',
  'removeAttributeQuotes',
  'removeRedundantAttributes',
  'removeEmptyAttributes',
  'collapseBooleanAttributes',
  'useShortDoctype',
  'minifyCSS',
];

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

// Bytes-on-disk for the given directory. Tries `du -sb` (GNU, exact
// apparent bytes, used on Linux CI) and falls back to `du -sk` × 1024
// (POSIX, blocks-of-1024 — works on macOS BSD du too). Returns null
// only if neither is available.
function diskBytes(dir) {
  try {
    let r = spawnSync('du', ['-sb', dir], { encoding: 'utf8', maxBuffer: 64 * 1024 });
    if (r.status === 0) {
      const n = parseInt(r.stdout.split(/\s+/)[0], 10);
      if (Number.isFinite(n)) return n;
    }
    r = spawnSync('du', ['-sk', dir], { encoding: 'utf8', maxBuffer: 64 * 1024 });
    if (r.status === 0) {
      const k = parseInt(r.stdout.split(/\s+/)[0], 10);
      if (Number.isFinite(k)) return k * 1024;
    }
  } catch { /* fall through */ }
  return null;
}

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '?';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(2) + ' KB';
  return n + ' B';
}

// Top-level directory under DIST for a file path. Used to bucket savings
// so the human can see which build-plugin emission path to target at
// source. `cerca-lavoro-ticino/foo/bar/index.html` → `cerca-lavoro-ticino`.
function topDir(file) {
  const rel = relative(DIST, file);
  const i = rel.indexOf('/');
  return i < 0 ? '(root)' : rel.slice(0, i);
}

// Locale bucket. Italian root = `it`; everything under en/, de/, fr/
// keeps its locale prefix. Lets the human compare per-locale waste so a
// locale-specific template can be patched in isolation.
function localeOf(file) {
  const rel = relative(DIST, file);
  const i = rel.indexOf('/');
  const first = i < 0 ? rel : rel.slice(0, i);
  return (first === 'en' || first === 'de' || first === 'fr') ? first : 'it';
}

// Pre-defined size buckets (ascending). The minifier behaves very
// differently on a 1 KB SPA shell vs a 50 KB SEO landing — splitting by
// size shows whether we're paying CPU time for low-yield small files.
const SIZE_BUCKETS = [
  { name: '< 1 KB',       max: 1024 },
  { name: '1 - 5 KB',     max: 5 * 1024 },
  { name: '5 - 20 KB',    max: 20 * 1024 },
  { name: '20 - 100 KB',  max: 100 * 1024 },
  { name: '> 100 KB',     max: Infinity },
];
function sizeBucketName(bytes) {
  for (const b of SIZE_BUCKETS) if (bytes < b.max) return b.name;
  return SIZE_BUCKETS[SIZE_BUCKETS.length - 1].name;
}

async function shrinkHtmlFile(file, stats, buckets) {
  const before = await readFile(file, 'utf8');
  const beforeBytes = Buffer.byteLength(before, 'utf8');

  let minified;
  try {
    minified = await htmlMinify(before, MINIFY_OPTS);
  } catch (err) {
    stats.htmlErrors++;
    // Keep all errors (up to a sanity cap so a runaway pattern can't
    // exhaust memory). Print FULL message — `pgb903fvy5l…` placeholders
    // in the prior 200-char truncation hid the actual line context.
    if (stats.htmlErrorExamples.length < 200) {
      stats.htmlErrorExamples.push({
        file,
        msg: String(err.message || err),
      });
    }
    return;
  }
  const afterBytes = Buffer.byteLength(minified, 'utf8');

  stats.htmlFilesSeen++;
  stats.htmlBytesBefore += beforeBytes;
  const savedBytes = beforeBytes - afterBytes;
  if (afterBytes < beforeBytes) {
    if (!DRY) await writeFile(file, minified, 'utf8');
    stats.htmlBytesAfter += afterBytes;
    stats.htmlFilesShrunk++;

    // Per-directory aggregation (kept from PR #475).
    const d = topDir(file);
    const de = buckets.byDir.get(d);
    if (de) { de.saved += savedBytes; de.files += 1; }
    else buckets.byDir.set(d, { saved: savedBytes, files: 1 });

    // Per-locale aggregation (it/en/de/fr).
    const loc = localeOf(file);
    const le = buckets.byLocale.get(loc);
    if (le) { le.saved += savedBytes; le.files += 1; le.beforeBytes += beforeBytes; }
    else buckets.byLocale.set(loc, { saved: savedBytes, files: 1, beforeBytes });

    // Size bucket histogram (bucket by pre-shrink size — the minifier
    // cost scales with input size, the saving with input size and
    // template slop).
    const bucket = sizeBucketName(beforeBytes);
    const be = buckets.bySize.get(bucket);
    if (be) { be.saved += savedBytes; be.files += 1; be.beforeBytes += beforeBytes; }
    else buckets.bySize.set(bucket, { saved: savedBytes, files: 1, beforeBytes });

    // Per-file leaderboard: only track files with material saving so
    // memory stays bounded on 800k-file builds. The leaderboard is what
    // tells you "this exact template needs a source patch".
    if (savedBytes >= TRACK_SAVED_MIN) {
      buckets.bigFiles.push({ file, before: beforeBytes, saved: savedBytes });
    }
  } else {
    stats.htmlBytesAfter += beforeBytes;
    // Even when nothing was saved, count the file in its size bucket so
    // the histogram totals are honest.
    const bucket = sizeBucketName(beforeBytes);
    const be = buckets.bySize.get(bucket);
    if (be) { be.files += 1; be.beforeBytes += beforeBytes; }
    else buckets.bySize.set(bucket, { saved: 0, files: 1, beforeBytes });
  }
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

  stats.jsonFilesSeen++;
  stats.jsonBytesBefore += beforeBytes;
  if (afterBytes < beforeBytes) {
    if (!DRY) await writeFile(file, after, 'utf8');
    stats.jsonBytesAfter += afterBytes;
    stats.jsonFilesShrunk++;
  } else {
    stats.jsonBytesAfter += beforeBytes;
  }
}

// Promise pool — Promise.all on 800k tasks blows the heap.
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

// Pick N random files, read into memory, return the corpus. Used for
// the per-rule breakdown so it runs against the PRE-minify HTML (the
// main pass will mutate the files on disk; we need a frozen sample).
async function loadSample(files, n) {
  const shuffled = [...files].sort(() => Math.random() - 0.5).slice(0, Math.min(n, files.length));
  const corpus = [];
  for (const f of shuffled) {
    try { corpus.push(await readFile(f, 'utf8')); } catch { /* skip */ }
  }
  return corpus;
}

// Per-rule attribution. Run baseline (all rules ON) once, then run with
// each rule individually disabled. Loss vs baseline = that rule's
// marginal contribution. ~2 s on a 200-file sample.
async function profileRules(corpus) {
  if (corpus.length === 0) return { baselineSaved: 0, corpusBytes: 0, contrib: [] };
  const corpusBytes = corpus.reduce((s, h) => s + Buffer.byteLength(h, 'utf8'), 0);

  async function totalOut(opts) {
    let bytes = 0;
    for (const h of corpus) {
      try { bytes += Buffer.byteLength(await htmlMinify(h, opts), 'utf8'); }
      catch { bytes += Buffer.byteLength(h, 'utf8'); }
    }
    return bytes;
  }

  const baselineOut = await totalOut(MINIFY_OPTS);
  const baselineSaved = corpusBytes - baselineOut;

  const contrib = [];
  for (const rule of RULES_TO_PROFILE) {
    const opts = { ...MINIFY_OPTS, [rule]: false };
    const out = await totalOut(opts);
    // Bytes we WOULD HAVE saved with this rule disabled (smaller). The
    // delta vs baselineOut = how much this rule alone contributes.
    contrib.push({ rule, deltaBytes: out - baselineOut });
  }
  contrib.sort((a, b) => b.deltaBytes - a.deltaBytes);
  return { baselineSaved, corpusBytes, contrib };
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
  const initialBytes = diskBytes(DIST);
  console.log(`dist-shrink: initial dist size: ${fmtBytes(initialBytes)}`);

  const t0 = Date.now();
  const htmlFiles = await walkExt(DIST, '.html');
  const jsonFiles = await walkExt(join(DIST, 'data'), '.json');
  console.log(`dist-shrink: ${htmlFiles.length} HTML, ${jsonFiles.length} JSON (concurrency=${CONCURRENCY})`);

  // Freeze a sample BEFORE the main pass mutates the files on disk.
  const sample = await loadSample(htmlFiles, SAMPLE_SIZE);

  const stats = {
    htmlFilesSeen: 0, htmlFilesShrunk: 0, htmlBytesBefore: 0, htmlBytesAfter: 0,
    htmlErrors: 0, htmlErrorExamples: [],
    jsonFilesSeen: 0, jsonFilesShrunk: 0, jsonBytesBefore: 0, jsonBytesAfter: 0,
    jsonErrors: 0,
  };
  // All per-bucket aggregates flow through this single object so the
  // shrinkHtmlFile signature stays clean as new dimensions are added.
  const buckets = {
    byDir: new Map(),
    byLocale: new Map(),
    bySize: new Map(),
    bigFiles: [],     // {file, before, saved} for files with saved ≥ TRACK_SAVED_MIN
  };

  await pool(htmlFiles, (f) => shrinkHtmlFile(f, stats, buckets), CONCURRENCY);
  await pool(jsonFiles, (f) => shrinkJsonFile(f, stats), CONCURRENCY);
  const byDir = buckets.byDir;

  // Per-rule attribution runs on the frozen sample. Independent of the
  // main pass; safe to do after.
  const ruleProfile = await profileRules(sample);

  const finalBytes = diskBytes(DIST);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const savedHtml = stats.htmlBytesBefore - stats.htmlBytesAfter;
  const savedJson = stats.jsonBytesBefore - stats.jsonBytesAfter;
  const savedTotal = savedHtml + savedJson;
  const diskDelta = initialBytes != null && finalBytes != null
    ? initialBytes - finalBytes : null;

  console.log('');
  console.log('dist-shrink summary');
  console.log('───────────────────');
  console.log(
    `HTML  : ${stats.htmlFilesShrunk}/${stats.htmlFilesSeen} shrunk` +
    `  ${fmtBytes(stats.htmlBytesBefore)} → ${fmtBytes(stats.htmlBytesAfter)}` +
    `  saved ${fmtBytes(savedHtml)}` +
    `  (errors: ${stats.htmlErrors})`,
  );
  console.log(
    `JSON  : ${stats.jsonFilesShrunk}/${stats.jsonFilesSeen} shrunk` +
    `  ${fmtBytes(stats.jsonBytesBefore)} → ${fmtBytes(stats.jsonBytesAfter)}` +
    `  saved ${fmtBytes(savedJson)}` +
    `  (errors: ${stats.jsonErrors})`,
  );
  console.log(
    `Disk  : ${fmtBytes(initialBytes)} → ${fmtBytes(finalBytes)}` +
    `  delta ${fmtBytes(diskDelta)}` +
    `  in ${elapsed}s${DRY ? ' (DRY — no files written)' : ''}`,
  );
  console.log(
    `Total bytes saved (HTML+JSON content): ${fmtBytes(savedTotal)}`,
  );

  // Top directories by HTML saving — actionable for "fix at source".
  if (byDir.size > 0) {
    const totalDirSaved = [...byDir.values()].reduce((s, e) => s + e.saved, 0);
    const sorted = [...byDir.entries()].sort((a, b) => b[1].saved - a[1].saved);
    console.log('');
    console.log('Top directories by HTML saving (target these at source):');
    const topN = sorted.slice(0, 10);
    const maxDirLen = Math.max(...topN.map(([d]) => d.length), 10);
    for (const [dir, e] of topN) {
      const pct = totalDirSaved > 0 ? (e.saved * 100 / totalDirSaved).toFixed(1) : '0.0';
      const avgPerFile = e.files > 0 ? Math.round(e.saved / e.files) : 0;
      console.log(
        `  ${dir.padEnd(maxDirLen)}  ${fmtBytes(e.saved).padStart(10)}` +
        `  (${pct.padStart(5)}%)` +
        `  across ${String(e.files).padStart(7)} files` +
        `  avg ${avgPerFile} B/file`,
      );
    }
    if (sorted.length > 10) {
      const tail = sorted.slice(10).reduce((s, [, e]) => s + e.saved, 0);
      const tailFiles = sorted.slice(10).reduce((s, [, e]) => s + e.files, 0);
      console.log(
        `  ${`(${sorted.length - 10} others)`.padEnd(maxDirLen)}  ${fmtBytes(tail).padStart(10)}` +
        `  across ${String(tailFiles).padStart(7)} files`,
      );
    }
  }

  // Per-rule contribution from the sample. Tells you which html-minifier
  // options are pulling weight and which are noise — turn the latter off
  // to speed up the next deploy.
  if (ruleProfile.contrib.length > 0 && ruleProfile.baselineSaved > 0) {
    console.log('');
    console.log(
      `Per-rule contribution` +
      ` (sample ${sample.length} files, ${fmtBytes(ruleProfile.corpusBytes)};` +
      ` baseline saved ${fmtBytes(ruleProfile.baselineSaved)}):`,
    );
    const maxRuleLen = Math.max(...RULES_TO_PROFILE.map((r) => r.length));
    for (const { rule, deltaBytes } of ruleProfile.contrib) {
      const pct = (deltaBytes * 100 / ruleProfile.baselineSaved).toFixed(1);
      console.log(
        `  ${rule.padEnd(maxRuleLen)}  ${fmtBytes(deltaBytes).padStart(10)}  (${pct.padStart(5)}%)`,
      );
    }
  }

  // Per-locale aggregation. If one locale's templates are bloated
  // disproportionately the fix is locale-specific (e.g. a localized
  // string composition that emits redundant attributes).
  if (buckets.byLocale.size > 0) {
    console.log('');
    console.log('Per-locale HTML saving:');
    const localeOrder = ['it', 'en', 'de', 'fr'];
    const present = localeOrder.filter((l) => buckets.byLocale.has(l));
    const maxLocLen = Math.max(...present.map((l) => l.length), 2);
    for (const loc of present) {
      const e = buckets.byLocale.get(loc);
      const pctOfInput = e.beforeBytes > 0
        ? (e.saved * 100 / e.beforeBytes).toFixed(2) : '0.00';
      const avgPerFile = e.files > 0 ? Math.round(e.saved / e.files) : 0;
      console.log(
        `  ${loc.padEnd(maxLocLen)}  ${fmtBytes(e.saved).padStart(10)}` +
        `  ${pctOfInput.padStart(5)}% of ${fmtBytes(e.beforeBytes).padStart(8)}` +
        `  across ${String(e.files).padStart(7)} files` +
        `  avg ${avgPerFile} B/file`,
      );
    }
  }

  // Size-bucket histogram. If 80% of saving comes from files >20 KB and
  // the <1 KB bucket contributes negligible bytes, we could SKIP small
  // files in the next iteration of dist-shrink to recover CI minutes.
  if (buckets.bySize.size > 0) {
    console.log('');
    console.log('Saving by HTML file-size bucket:');
    const totalShrunkSaved = [...buckets.bySize.values()].reduce((s, e) => s + e.saved, 0);
    const maxBucketLen = Math.max(...SIZE_BUCKETS.map((b) => b.name.length), 5);
    // Preserve fixed ascending order from SIZE_BUCKETS.
    for (const b of SIZE_BUCKETS) {
      const e = buckets.bySize.get(b.name);
      if (!e) continue;
      const avgPerFile = e.files > 0 ? Math.round(e.saved / e.files) : 0;
      const pct = totalShrunkSaved > 0 ? (e.saved * 100 / totalShrunkSaved).toFixed(1) : '0.0';
      console.log(
        `  ${b.name.padEnd(maxBucketLen)}  ${fmtBytes(e.saved).padStart(10)}` +
        `  (${pct.padStart(5)}%)` +
        `  across ${String(e.files).padStart(7)} files` +
        `  avg ${avgPerFile} B/file`,
      );
    }
  }

  // Per-file leaderboard — absolute. The single files contributing most
  // bytes. Each is a concrete refactor target ("open this template,
  // tighten it once, save these bytes on every build forever").
  if (buckets.bigFiles.length > 0) {
    const byAbs = [...buckets.bigFiles].sort((a, b) => b.saved - a.saved).slice(0, TOP_N);
    console.log('');
    console.log(`Top ${byAbs.length} HTML files by absolute saving (refactor candidates):`);
    for (const f of byAbs) {
      const rel = relative(DIST, f.file);
      const ratio = f.before > 0 ? (f.saved * 100 / f.before).toFixed(1) : '0.0';
      console.log(
        `  ${fmtBytes(f.saved).padStart(10)}` +
        `  ${fmtBytes(f.before).padStart(10)} → ${fmtBytes(f.before - f.saved).padStart(10)}` +
        `  (${ratio.padStart(5)}%)  ${rel}`,
      );
    }
  }

  // Per-file leaderboard — ratio. Files whose template is proportionally
  // most bloated. Ignores small files (RATIO_MIN_BYTES) so a 200 B SPA
  // shell that shrinks 60% doesn't crowd the actionable signal.
  if (buckets.bigFiles.length > 0) {
    const candidates = buckets.bigFiles.filter((f) => f.before >= RATIO_MIN_BYTES);
    if (candidates.length > 0) {
      const byRatio = candidates
        .sort((a, b) => (b.saved / b.before) - (a.saved / a.before))
        .slice(0, TOP_N);
      console.log('');
      console.log(
        `Top ${byRatio.length} HTML files by saving ratio` +
        ` (only files ≥ ${fmtBytes(RATIO_MIN_BYTES)} — bloat density):`,
      );
      for (const f of byRatio) {
        const rel = relative(DIST, f.file);
        const ratio = (f.saved * 100 / f.before).toFixed(1);
        console.log(
          `  ${ratio.padStart(5)}%` +
          `  ${fmtBytes(f.saved).padStart(10)} of ${fmtBytes(f.before).padStart(10)}` +
          `  ${rel}`,
        );
      }
    }
  }

  // Full error dump (replaces the "First 5" preview). The previous
  // version truncated each error to 200 chars, which cut the actual
  // line context away — making source-fix triage impossible. Each error
  // now shows the full message; the path tells which template to grep
  // in build-plugins/*.ts.
  if (stats.htmlErrors > 0) {
    console.log('');
    console.log(`HTML parse errors (${stats.htmlErrors} total, showing ${stats.htmlErrorExamples.length}):`);
    for (const e of stats.htmlErrorExamples) {
      const rel = relative(DIST, e.file);
      console.log(`  ${rel}`);
      // Indent error message; clip only at \n so we don't bury the
      // useful line/col info that html-minifier-terser puts on line 1.
      const firstLine = e.msg.split('\n')[0];
      console.log(`    └─ ${firstLine}`);
    }
  }
}

// Run main() only when invoked as a script, not when imported as a
// module (e.g. by tests/seo/dist-shrink.test.ts).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

export { MINIFY_OPTS };
