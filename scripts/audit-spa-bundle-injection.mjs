#!/usr/bin/env node
/**
 * Audit: ratchet on the count of `dist/<path>/index.html` files missing the
 * SPA bundle `<script type="module" src="/assets/index-{hash}.js">` tag.
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
 * Why it's a ratchet, not a strict gate
 * -------------------------------------
 * The first run of this gate against the current build found 123k+ pages
 * lacking the bundle — many SEO emit templates in jobsSeoPagesPlugin /
 * staticPagesPlugin / ogPagesPlugin omit `${hasSpaBundle ? ... : ''}` by
 * pre-existing oversight, not by race. A strict gate would freeze every
 * deploy until the entire codebase is fixed; a ratchet lets normal deploys
 * proceed while still failing on REGRESSIONS (any new build whose violation
 * count exceeds the baseline). Each template fix lowers the count, the
 * baseline is rebased manually, and over time the ratchet drives the count
 * to zero — then we flip back to strict. Same pattern as
 * `audit:text-html-ratio` and `audit:h1-title-duplicates`.
 *
 * Failure mode → diagnosis
 * ------------------------
 * If this script exits non-zero, the new build has MORE bundle-less pages
 * than the baseline — usually a write-registry collision shifted a page
 * from "has bundle" to "no bundle". Inspect:
 *   - `dist/.write-collisions.json` (locally) or
 *   - the `write-collisions-analysis` GitHub Actions artifact (on CI)
 * to find which two plugins claimed the same path and which version won.
 *
 * Improvements (count drops) are accepted automatically. To lock in the
 * improvement as the new floor, run:
 *   npm run audit:spa-bundle-injection:rebaseline
 * and commit the updated `data/spa-bundle-injection-baseline.json`.
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

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIST = path.resolve(process.cwd(), 'dist');
const BASELINE_PATH = path.resolve(ROOT, 'data', 'spa-bundle-injection-baseline.json');
const REBASELINE = process.argv.includes('--rebaseline');

const { writeAuditReport: _writeAuditReport, relBaseline: _relBaseline } = await import('./lib/auditReport.mjs');

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
  // Editorial root pages emitted by staticPagesPlugin as static SEO landings.
  // They have full structured-data + hreflang to /it/, /en/, /de/, /fr/ — they
  // are intentionally non-SPA because they don't need interactivity (no
  // calculator, no job search, no comparators). All three are linked from the
  // footer and have substantial content (>3 KB body, h1 + paragraphs).
  'contact',
  'about',
  'privacy-policy',
  // PDF whitepaper landings emitted by pdfWhitepapersPlugin: each one is a
  // landing page with `<script type="application/ld+json">{"@type": "DigitalDocument", ...}`
  // and a "Scarica PDF" download button. No SPA functionality needed —
  // the page IS the download link.
  'guides/guida-completa-frontaliere-2026',
  'guides/lamal-vs-ssn-frontalieri',
  'guides/permesso-g-vantaggi-svantaggi',
]);

/**
 * Auto-skip pages whose HTML shape is a deliberate redirect: any page that
 * does `<meta http-equiv="refresh">` or `location.replace(` is by design a
 * 0-content bridge to a canonical URL, and asking it to ship the SPA bundle
 * makes no sense. The 2026-04-30 archive cross-locale audit found ~260 such
 * pages (articoli-frontaliere/, de/grenzgaenger-artikel/, fr/articles-frontalier/,
 * fr/articles-frontaliers/, en/cross-border-articles/) emitted as redirect
 * stubs. They were the long tail of the `271 missing the bundle` baseline.
 *
 * NOTE: SPA pages that legitimately render `location.replace` in inline
 * scripts (e.g. SPA_ACTION_REDIRECT_SCRIPT used for ?action= deep links)
 * also contain the SPA bundle anyway, so the regex never reaches the redirect
 * test on those pages. The two checks are layered: bundle present → done;
 * bundle absent + redirect detected → skip. False positives require a page
 * to be missing the bundle AND contain `location.replace` AND not be one
 * intentional path — a combination that would itself be a bug worth flagging.
 */
const REDIRECT_SHAPE_RX =
  /<meta\s+http-equiv="refresh"[^>]*>|location\.replace\(|window\.location\.href\s*=/i;

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
let skippedExplicit = 0;
let skippedRedirect = 0;
const violations = [];

for (const { absPath, relDir } of walkIndexHtml(DIST)) {
  if (SKIP_PATHS.has(relDir)) {
    skippedExplicit++;
    continue;
  }
  scanned++;
  const html = fs.readFileSync(absPath, 'utf-8');
  if (SPA_BUNDLE_RX.test(html)) continue;
  // Page is missing the bundle. Before flagging it, check whether its HTML
  // shape is a deliberate redirect (no SPA needed by design). Counted
  // separately so a regression that adds redirects in unexpected places
  // is still visible in the breakdown.
  if (REDIRECT_SHAPE_RX.test(html)) {
    skippedRedirect++;
    continue;
  }
  violations.push({ relDir, size: html.length });
}

console.log(
  `[audit:spa-bundle-injection] scanned ${scanned} index.html files (skipped ${skippedExplicit} via SKIP_PATHS, ${skippedRedirect} as redirect-shape)`,
);

// Group violations by top-2-segment directory so we can show drift per area
// in error / progress messages without dumping 100k paths.
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
const groupsObject = Object.fromEntries(
  sortedGroups.map(([key, { count }]) => [key, count]),
);

// Shared writer for every exit point below. Offenders are the full violations
// list grouped under their top-2-segment directory. We keep the existing
// stdout/stderr output verbatim; the JSON report is purely additive.
async function _emitReport(passed, baselineDelta) {
  const offendersForReport = violations.map((v) => {
    const segments = v.relDir.split('/');
    const feature = segments.slice(0, 2).join('/') || '<root>';
    return {
      path: v.relDir + '/index.html',
      feature,
      metric: v.size,
      ratio: null,
    };
  });
  await _writeAuditReport({
    audit: 'spa-bundle-injection',
    passed,
    threshold: { metric: 'count', value: 0, comparator: '<=baseline' },
    baselineFile: _relBaseline(BASELINE_PATH),
    baselineDelta,
    offenders: offendersForReport,
    byFeature: groupsObject,
    extra: { scanned, skippedExplicit, skippedRedirect },
  });
}

if (REBASELINE) {
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        total: violations.length,
        scanned,
        skippedExplicit,
        skippedRedirect,
        groups: groupsObject,
        rebasedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  console.log(
    `[audit:spa-bundle-injection] baseline rebased → ${path.relative(ROOT, BASELINE_PATH)} (total=${violations.length})`,
  );
  await _emitReport(true, null);
  process.exit(0);
}

let baseline = null;
if (fs.existsSync(BASELINE_PATH)) {
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
  } catch (err) {
    console.error(`[audit:spa-bundle-injection] failed to read baseline at ${BASELINE_PATH}: ${err}`);
    baseline = null;
  }
}

if (!baseline) {
  // First-run setup: no baseline yet. Don't fail the build; just log + write
  // the baseline so the next run can ratchet against it. The dev/CI is
  // expected to commit the baseline file alongside this audit.
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        total: violations.length,
        scanned,
        skippedExplicit,
        skippedRedirect,
        groups: groupsObject,
        rebasedAt: new Date().toISOString(),
        note: 'auto-created on first run; commit me',
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  console.log(
    `[audit:spa-bundle-injection] no baseline found — wrote initial baseline (total=${violations.length}). Commit ${path.relative(ROOT, BASELINE_PATH)}.`,
  );
  await _emitReport(true, null);
  process.exit(0);
}

const baselineTotal = typeof baseline.total === 'number' ? baseline.total : -1;
const current = violations.length;

if (current === 0 && baselineTotal === 0) {
  console.log('[audit:spa-bundle-injection] ✅ every index.html contains the SPA bundle script');
  await _emitReport(true, { before: baselineTotal, after: current, regression: 0 });
  process.exit(0);
}

if (current <= baselineTotal) {
  const delta = baselineTotal - current;
  console.log(
    `[audit:spa-bundle-injection] ✅ ${current} file(s) missing the bundle ` +
      `(baseline=${baselineTotal}, delta=-${delta}). ` +
      (delta > 0
        ? `Progress! Run \`npm run audit:spa-bundle-injection:rebaseline\` to lock in the new floor.`
        : `No regression.`),
  );
  // Print top groups for visibility even when passing.
  if (current > 0) {
    console.log('Affected directories (top 5):');
    for (const [key, { count }] of sortedGroups.slice(0, 5)) {
      console.log(`  ${String(count).padStart(6)} × ${key}`);
    }
  }
  await _emitReport(true, { before: baselineTotal, after: current, regression: 0 });
  process.exit(0);
}

// REGRESSION: current > baseline. Block.
const delta = current - baselineTotal;
console.error('');
console.error(
  `[audit:spa-bundle-injection] ❌ regression: ${current} files missing the SPA bundle (baseline=${baselineTotal}, delta=+${delta})`,
);
console.error('');
console.error('Affected directories (top 2 path segments):');
for (const [key, { count, samples }] of sortedGroups) {
  const baselineCount =
    baseline.groups && typeof baseline.groups[key] === 'number' ? baseline.groups[key] : 0;
  const groupDelta = count - baselineCount;
  const marker = groupDelta > 0 ? `+${groupDelta}` : `${groupDelta}`;
  console.error(`  ${String(count).padStart(6)} × ${key}  (baseline=${baselineCount}, delta=${marker})`);
  if (groupDelta > 0) {
    for (const s of samples) {
      console.error(`           ${s}`);
    }
  }
}
console.error('');
console.error('What this means');
console.error('---------------');
console.error('More pages are missing the SPA hydration script than the baseline allowed.');
console.error('Most likely cause: a write-registry collision shifted some pages from');
console.error('"has bundle" to "no bundle" because a bundle-less plugin won the race.');
console.error('');
console.error('Diagnose');
console.error('--------');
console.error('  • Locally:  open `dist/.write-collisions.json` — find the affected');
console.error('              path, see which plugin/call sites collided, then run');
console.error('              `npm run analyze:write-collisions`.');
console.error('  • On CI:    download the `write-collisions-analysis` artifact:');
console.error('              gh run download <run-id> -n write-collisions-analysis');
console.error('');
console.error('If you intentionally lowered the threshold by fixing emit templates,');
console.error('rebase the floor:');
console.error('  npm run audit:spa-bundle-injection:rebaseline');
console.error('and commit the updated data/spa-bundle-injection-baseline.json.');
console.error('');

await _emitReport(false, { before: baselineTotal, after: current, regression: delta });
process.exit(1);
