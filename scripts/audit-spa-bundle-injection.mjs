#!/usr/bin/env node
/**
 * Audit: every per-slug `dist/<path>/index.html` must include the SPA bundle
 * `<script type="module" src="/assets/index-{hash}.js">` tag.
 *
 * Why this gate exists
 * --------------------
 * The 2026-04-30 incident proved the bug: per-slug SEO pages occasionally
 * ship without the SPA hydration script because of a write race between
 * plugins (jobsSeoPagesPlugin emits with the bundle injected, staticPagesPlugin
 * /  ogPagesPlugin emit identical paths without it, parallel `Promise.all`
 * writeFile resolves non-deterministically). When the bundle-less version
 * wins on disk, the page stays stuck on pre-hydration static content and
 * articles infinite-loop with the no-slash redirect bridge.
 *
 * The `tests/e2e/post-deploy-rendering-live.spec.ts` E2E test catches this
 * AFTER the deploy is live — too late, the broken HTML is already serving
 * users. This script runs BEFORE the GitHub Pages artifact upload, so a
 * broken build never reaches production.
 *
 * Failure mode → diagnosis
 * ------------------------
 * If this script exits non-zero, the dist/ output is corrupt. The proximate
 * cause is almost always a write-registry collision. Inspect:
 *   - `dist/.write-collisions.json` (locally) or
 *   - the `write-collisions-analysis` GitHub Actions artifact (on CI)
 * to find which two plugins claimed the same path and which version won.
 *
 * Scope
 * -----
 * Walks every `index.html` under dist/, EXCEPT:
 *   - GitHub Pages 404 fallback (404.html, but we walk index.html only)
 *   - SPA-shell admin pages (none currently — placeholder for future)
 *   - Pages explicitly opted out via SKIP_PATHS below
 *
 * Non-index.html files (flat redirect bridges from flatHtmlRedirectPlugin)
 * are correctly excluded by the walk.
 */
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');

if (!fs.existsSync(DIST)) {
  console.error(`[audit:spa-bundle-injection] dist/ not found at ${DIST}`);
  process.exit(1);
}

/**
 * Match the SPA bundle script tag. Vite emits attributes in a stable order:
 *   <script type="module" crossorigin [fetchpriority="high"] src="/assets/index-{hash}.js">
 * The hash is content-addressed so it changes between builds. We only require
 * `type="module"` somewhere in the same tag and `src="/assets/index-{hash}.js"`.
 */
const SPA_BUNDLE_RX =
  /<script[^>]*type="module"[^>]*src="\/assets\/index-[A-Za-z0-9_-]+\.js"/;

/**
 * Per-slug index.html files MAY legitimately not contain the SPA bundle when
 * they are not user-facing pages. Add explicit relative paths here (POSIX,
 * relative to dist/, no leading slash, no trailing slash).
 *
 * Each entry should be commented with the rationale so the list stays small
 * and self-explanatory. If you find yourself adding a path because "the test
 * fails on it", that's the bug — fix the emitter, don't add to this list.
 */
const SKIP_PATHS = new Set([
  // (none currently)
]);

function* walkIndexHtml(dir, base = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Skip asset/data/image directories — they don't contain index.html anyway,
      // but skipping saves I/O on large trees.
      if (entry.name === 'assets' || entry.name === 'data' || entry.name === 'images') continue;
      yield* walkIndexHtml(path.join(dir, entry.name), path.posix.join(base, entry.name));
    } else if (entry.name === 'index.html') {
      yield { absPath: path.join(dir, entry.name), relDir: base };
    }
  }
}

let scanned = 0;
let skipped = 0;
const violations = [];

for (const { absPath, relDir } of walkIndexHtml(DIST)) {
  if (SKIP_PATHS.has(relDir)) {
    skipped++;
    continue;
  }
  scanned++;
  const html = fs.readFileSync(absPath, 'utf-8');
  if (!SPA_BUNDLE_RX.test(html)) {
    violations.push({ relDir, size: html.length });
  }
}

console.log(
  `[audit:spa-bundle-injection] scanned ${scanned} index.html files (skipped ${skipped} via SKIP_PATHS)`,
);

if (violations.length === 0) {
  console.log('[audit:spa-bundle-injection] ✅ every index.html contains the SPA bundle script');
  process.exit(0);
}

// Group violations by top-2-segment directory so the user immediately sees
// the affected feature area (e.g. "cerca-lavoro-ticino: 142 files" vs spread
// across many roots). Helps map the failure to a specific build plugin.
const groups = new Map();
for (const v of violations) {
  const segments = v.relDir.split('/');
  const key = segments.slice(0, 2).join('/') || '<root>';
  if (!groups.has(key)) groups.set(key, { count: 0, samples: [] });
  const entry = groups.get(key);
  entry.count++;
  if (entry.samples.length < 3) entry.samples.push(v.relDir + '/');
}

const sortedGroups = Array.from(groups.entries()).sort((a, b) => b[1].count - a[1].count);

console.error('');
console.error(
  `[audit:spa-bundle-injection] ❌ ${violations.length} file(s) missing the SPA bundle script tag`,
);
console.error('');
console.error('Affected directories (top 2 path segments):');
for (const [key, { count, samples }] of sortedGroups) {
  console.error(`  ${String(count).padStart(6)} × ${key}`);
  for (const s of samples) {
    console.error(`           ${s}`);
  }
}
console.error('');
console.error('What this means');
console.error('---------------');
console.error('Every per-slug page is supposed to ship with the SPA hydration script:');
console.error('  <script type="module" src="/assets/index-{hash}.js">');
console.error('When this tag is missing, the page stays on its pre-hydration static');
console.error('content forever — chrome and interactivity are gone, and articles can');
console.error('infinite-loop against the no-slash redirect bridge.');
console.error('');
console.error('Most likely cause');
console.error('-----------------');
console.error('A write-registry collision: two plugins (or two call sites in the');
console.error('same plugin) emitted to the same dist/ path with different content,');
console.error('one with the bundle and one without, and the bundle-less write won');
console.error('the parallel `Promise.all` race.');
console.error('');
console.error('Diagnose');
console.error('--------');
console.error('  • Locally:  open `dist/.write-collisions.json` — find the affected');
console.error('              path, see which plugin/call sites collided.');
console.error('  • On CI:    download the `write-collisions-analysis` artifact:');
console.error('              gh run download <run-id> -n write-collisions-analysis');
console.error('');

process.exit(1);
