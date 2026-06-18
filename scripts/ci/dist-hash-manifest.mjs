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
 *
 * Uses `find | xargs sha256sum` for speed on ~1M-file trees, then applies the
 * exclude filter + stable sort in JS so the exclude list stays maintainable.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const distDir = path.resolve(process.argv[2] || 'dist');
const outFile = process.argv[3] || 'dist-manifest.txt';

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

function excluded(rel) {
  return EXCLUDE.some((re) => re.test(rel));
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

const lines = [];
for (const line of raw.split('\n')) {
  if (!line) continue;
  // sha256sum format: "<hash>  ./<relpath>"  (two spaces)
  const sp = line.indexOf('  ');
  if (sp < 0) continue;
  const hash = line.slice(0, sp);
  let rel = line.slice(sp + 2).replace(/^\.\//, '');
  if (excluded(rel)) continue;
  lines.push(`${hash}  ${rel}`);
}
// Stable sort by relpath (the part after the 2-space separator).
lines.sort((a, b) => {
  const pa = a.slice(a.indexOf('  ') + 2);
  const pb = b.slice(b.indexOf('  ') + 2);
  return pa < pb ? -1 : pa > pb ? 1 : 0;
});

fs.writeFileSync(outFile, lines.join('\n') + '\n');
console.log(`[dist-hash-manifest] ${lines.length} files hashed → ${outFile} (excluded build-id/commit-hash/collision/manifest)`);
