#!/usr/bin/env node
/**
 * Produce a deterministic sha256 manifest of a dist/ tree for the
 * matrix-vs-monolith equivalence check.
 *
 * Output: one line per file, `<sha256>  <dist-relative-path>`, sorted by path.
 * Excludes files that legitimately differ between two builds of the SAME commit
 * (per-build timestamps / build-internal bookkeeping) — NOT page content.
 *
 * Usage: node scripts/ci/dist-hash-manifest.mjs <distDir> <outFile>
 *                                               [--deploy-artifact-perimeter]
 *
 * Uses `find | xargs sha256sum` for speed on ~1M-file trees, then applies the
 * exclude filter + stable sort in JS so the exclude list stays maintainable.
 *
 * ── `--deploy-artifact-perimeter` (issue #4894) ─────────────────────────────
 * The `github-pages` artifact is NOT a snapshot of the `dist/` a build produces:
 * it is what `scripts/lib/deploy-it-pages-prep.sh` leaves behind AFTER the CDN
 * offload. Two whole-tree transforms happen on the deploy path only:
 *
 *   1. Offloaded trees are DELETED from the artifact — `dist/assets` (step 5,
 *      "Drop dist/assets after CDN push", FATAL-on-failure), plus `dist/og`,
 *      `dist/data`, `dist/job-canon` and the offloaded `dist/images/*` subtrees.
 *   2. `scripts/offload-generated-images-cdn.mjs` REWRITES every same-origin
 *      `/assets/`, `/og/`, `/data/`, `/images/<prefix>/` reference in every
 *      static HTML file to `https://cdn.frontaliereticino.ch/...`.
 *
 * Comparing a raw `dist/` against that tree can only ever be red. Measured on
 * matrix-equivalence-check run 27749079114: `only-in-matrix: 38049` (all of
 * `assets/`) and `content-mismatch: 445753` — 99.967 % of the shared paths,
 * i.e. every page, purely because of the URL rewrite. The check has therefore
 * verified NOTHING since 2026-06-18.
 *
 * This flag makes the comparison well-formed by applying the SAME normalisation
 * to BOTH sides (never to one):
 *   - skip the trees the deploy provably removes from the artifact, and
 *   - undo the CDN rewrite in text files before hashing, so the bytes compared
 *     are the pre-offload ones on both sides.
 *
 * What stays covered: the entire page surface — every HTML page, every sitemap
 * (including the 4-locale `xhtml:link` alternates), every hreflang block, robots,
 * feeds. What moves out of scope: the CDN-served binary/bundle trees, which the
 * artifact does not carry at all and which no byte comparison against it could
 * ever have covered.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));

const distDir = path.resolve(positional[0] || 'dist');
const outFile = positional[1] || 'dist-manifest.txt';
const deployPerimeter = flags.has('--deploy-artifact-perimeter');

if (!fs.existsSync(distDir)) {
  console.error(`[dist-hash-manifest] dist dir not found: ${distDir}`);
  process.exit(1);
}

// Files/paths that differ between two builds of the same commit for reasons
// UNRELATED to page content. Matched against the dist-relative path.
const EXCLUDE = [
  /^build-id\.txt$/,
  /^commit-hash(-short)?\.txt$/,
  /^\.write-collisions\.json$/,
  /(^|\/)\.contenthash[^/]*\.json$/,
  /(^|\/)\.vite-temp(\/|$)/,
  /(^|\/)\.cache(\/|$)/,
];

/**
 * The offloaded image prefixes, read from the module the codebase already
 * designates as canonical for them.
 *
 * `scripts/offload-generated-images-cdn.mjs` (TARGETS), `deploy-it-pages-prep.sh`
 * (CDN-push staging loop) and `ensure-image-cdn-redirect.mjs` (OFFLOADED_PREFIXES)
 * all carry their own copy and all three say, in a comment, "MUST stay in sync
 * with CDN_OFFLOADED_IMAGE_PREFIXES in services/cdnImageBase.ts". Adding a FIFTH
 * hand-maintained copy here is exactly the drift AGENTS.md #6 forbids, so this
 * parses the canonical one instead.
 *
 * Throws — never returns a partial or empty list. A silently empty list would
 * make the whole equivalence check pass vacuously, which is worse than a red one.
 */
function cdnOffloadedImagePrefixes() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.resolve(here, '..', '..', 'services', 'cdnImageBase.ts');
  let text;
  try {
    text = fs.readFileSync(src, 'utf-8');
  } catch (e) {
    throw new Error(`[dist-hash-manifest] cannot read ${src} for CDN_OFFLOADED_IMAGE_PREFIXES: ${e.message}`);
  }
  const block = text.match(/export const CDN_OFFLOADED_IMAGE_PREFIXES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!block) {
    throw new Error('[dist-hash-manifest] CDN_OFFLOADED_IMAGE_PREFIXES not found in services/cdnImageBase.ts — was it renamed? Refusing to hash with an unknown offload perimeter.');
  }
  const prefixes = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (prefixes.length === 0) {
    throw new Error('[dist-hash-manifest] CDN_OFFLOADED_IMAGE_PREFIXES parsed empty. Refusing to hash with an empty offload perimeter.');
  }
  return prefixes;
}

/**
 * Trees the deploy removes from the `github-pages` artifact after pushing them
 * to the CDN. `assets`/`data`/`og`/`job-canon` are dropped wholesale by
 * `deploy-it-pages-prep.sh`; the image subtrees come from the canonical list.
 * `images/blog/thumbnails` is an offload TARGET that is not in
 * CDN_OFFLOADED_IMAGE_PREFIXES (that constant covers only the self-hosted
 * brand/logo/author family), so it is named explicitly.
 */
function deployOffloadedTrees() {
  const dirs = ['assets', 'data', 'og', 'job-canon', 'images/blog/thumbnails'];
  for (const prefix of cdnOffloadedImagePrefixes()) {
    dirs.push(prefix.replace(/^\/+/, '').replace(/\/+$/, ''));
  }
  // Match the tree at the dist root AND under any locale prefix (dist/en/data/…).
  return dirs.map((d) => new RegExp(`^(?:[a-z]{2}/)?${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));
}

const DEPLOY_OFFLOADED = deployPerimeter ? deployOffloadedTrees() : [];

/** Deploy-time CDN base injected by offload-generated-images-cdn.mjs. */
const CDN_BASE_RX = /https:\/\/cdn\.frontaliereticino\.ch\//g;
/** Text surfaces the offload rewrite touches. */
const TEXT_EXT = /\.(html?|xml|txt|json)$/i;

function excluded(rel) {
  if (EXCLUDE.some((re) => re.test(rel))) return true;
  if (DEPLOY_OFFLOADED.some((re) => re.test(rel))) return true;
  return false;
}

// `find . -type f -print0 | xargs -0 sha256sum` from inside distDir → paths are
// `./relpath`. Parallelism via xargs -P for speed.
let raw;
try {
  raw = execFileSync(
    'bash',
    ['-eo', 'pipefail', '-c',
      `cd "${distDir}" && find . -type f -print0 | xargs -0 -P4 -n256 sha256sum`],
    { maxBuffer: 1024 * 1024 * 1024, encoding: 'utf-8' },
  );
} catch (e) {
  console.error(`[dist-hash-manifest] hashing failed: ${String(e).slice(0, 200)}`);
  process.exit(1);
}

const entries = [];
for (const line of raw.split('\n')) {
  if (!line) continue;
  // sha256sum format: "<hash>  ./<relpath>"  (two spaces)
  const sp = line.indexOf('  ');
  if (sp < 0) continue;
  const hash = line.slice(0, sp);
  let rel = line.slice(sp + 2).replace(/^\.\//, '');
  if (excluded(rel)) continue;
  entries.push({ hash, rel });
}

// Undo the deploy-time CDN rewrite before hashing the text surfaces, so both
// sides are compared on their pre-offload bytes. Only re-reads files whose
// extension the offload script actually touches; everything else keeps the
// sha256sum from the bulk pass above.
let rewritten = 0;
if (deployPerimeter) {
  const { createHash } = await import('node:crypto');
  for (const e of entries) {
    if (!TEXT_EXT.test(e.rel)) continue;
    let buf;
    try {
      buf = fs.readFileSync(path.join(distDir, e.rel));
    } catch {
      continue; // vanished between walk and read — keep the bulk hash
    }
    const text = buf.toString('utf-8');
    if (!text.includes('https://cdn.frontaliereticino.ch/')) continue;
    const normalized = text.replace(CDN_BASE_RX, '/');
    e.hash = createHash('sha256').update(normalized).digest('hex');
    rewritten++;
  }
}

const lines = entries.map((e) => `${e.hash}  ${e.rel}`);
// Stable sort by relpath (the part after the 2-space separator).
lines.sort((a, b) => {
  const pa = a.slice(a.indexOf('  ') + 2);
  const pb = b.slice(b.indexOf('  ') + 2);
  return pa < pb ? -1 : pa > pb ? 1 : 0;
});

fs.writeFileSync(outFile, lines.join('\n') + '\n');
console.log(`[dist-hash-manifest] ${lines.length} files hashed → ${outFile} (excluded build-id/commit-hash/collision/manifest)`);
if (deployPerimeter) {
  console.log(
    `[dist-hash-manifest] deploy-artifact perimeter ON: skipped ${DEPLOY_OFFLOADED.length} CDN-offloaded tree pattern(s); ` +
    `un-rewrote the CDN base in ${rewritten} text file(s) before hashing`,
  );
}
