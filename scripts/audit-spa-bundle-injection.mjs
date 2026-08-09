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
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { REDIRECT_STUB_MARKER } from '../build-plugins/shared/redirectStubMarker.mjs';

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
 *
 * Quote-flexible — PR #478 baked removeAttributeQuotes upstream in htmlMinify.ts.
 * `type="module"` → `type=module` (single token, no special chars) and
 * `src="/assets/index-abc.js"` → `src=/assets/index-abc.js` (HTML5 allows
 * unquoted attr values containing `/`; the only trailing-slash case is rejected
 * upstream to avoid `/>` self-close collision, and `.js` doesn't end in `/`).
 */
// src may be same-origin (/assets/…) or an absolute CDN URL
// (https://cdn.frontaliereticino.ch/assets/…) when ASSET_CDN/renderBuiltUrl is
// active — the post-deploy artifact is post-rewrite, so tolerate both.
const SPA_BUNDLE_RX =
  /<script[^>]*type=["']?module["']?[^>]*src=["']?(?:https?:\/\/[^"'\s]+)?\/assets\/index-[A-Za-z0-9_-]+\.js["']?/;

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

// ─── Walk + read: bounded-concurrency streaming (was fully synchronous) ──────
//
// WHY THIS IS NOT `readdirSync`/`readFileSync` ANY MORE (issue #5432, point 6b)
// ----------------------------------------------------------------------------
// This gate was the single critical path of the whole `validate-dist-postbuild`
// job. Measured on three consecutive real runs (per-gate rows from
// /tmp/post-build-timings.txt):
//
//   run 31283409340  audit:spa-bundle-injection 1735.12s   step wall 1740s
//   run 31287634802  audit:spa-bundle-injection 1769.40s   step wall 1776s
//   run 31296098323  audit:spa-bundle-injection 1880.28s   step wall 1885s
//
// i.e. 99.6-99.7 % of the "Post-build validations + SEO audits (capped
// parallel)" step. The runner-up (`audit:all`, 996-1109s) and the other eight
// gates all finished INSIDE this one's window, so the last ~13-15 minutes of
// the step were one single-threaded Node process on a 4 vCPU runner.
//
// The cause was not the work, it was the scheduling: on the rehydrated
// production dist (~2.07M index.html files, one directory per page) the
// synchronous generator issued ~4.1M blocking syscalls strictly one at a time,
// leaving the event loop — and three of the four vCPUs — idle in between.
// Overlapping them via libuv's fs threadpool is the same lever
// `scripts/lib/audit-runner.mjs` already applies (its WALK_CONCURRENCY for the
// walk, its READAHEAD for the reads).
//
// THIS IS A PURE I/O-SCHEDULING CHANGE — the gate's COVERAGE AND VERDICT ARE
// UNCHANGED. Specifically, and deliberately:
//
//   • the visited directory set is identical: still skipping exactly `assets` /
//     `data` / `images`, still descending into dot-directories. (That last
//     point is why this walker is private instead of reusing audit-runner's
//     `walkHtmlFiles`, which skips dot-prefixed entries and does not skip
//     assets/data/images — reusing it would have silently changed the file set,
//     and therefore the ratcheted count.)
//   • the scanned file set is identical: still every entry literally named
//     `index.html`, still without an isFile() test, so a symlinked index.html
//     is still read exactly as before.
//   • read errors still propagate and abort the run, exactly as readFileSync
//     did. This gate fails closed; it must never silently skip a file.
//   • the counters, the SKIP_PATHS / redirect-shape branches and the violation
//     records below are byte-for-byte the previous ones.
//   • NO SAMPLING. See the note above the baseline comparison for why this
//     particular gate must keep scanning 100 % of dist/.
//
// Only DISCOVERY ORDER changes, and it reaches exactly two cosmetic places: the
// order of `offenders` in the JSON report, and which 3 paths a group prints as
// `samples` on failure. No counter and no verdict depends on it.
//
// Concurrency constants mirror scripts/lib/audit-runner.mjs. The real ceiling
// is libuv's default 4-thread fs pool; anything above it merely keeps that pool
// saturated.
const WALK_CONCURRENCY = 24;
const READ_CONCURRENCY = 8;

/**
 * FIFO with an O(1) `take()` that also releases the consumed prefix. A plain
 * `Array.shift()` is a memmove over the frontier (six figures of entries here);
 * a bare index cursor never frees, retaining one path string per directory ever
 * visited (~2M). This keeps live memory proportional to the frontier, which
 * matters under the pool's `--max-old-space-size=4096` cap.
 */
function makeQueue() {
  const items = [];
  let head = 0;
  return {
    get size() {
      return items.length - head;
    },
    push(v) {
      items.push(v);
    },
    take() {
      const v = items[head];
      items[head++] = undefined;
      if (head >= 4096 && head * 2 >= items.length) {
        items.splice(0, head);
        head = 0;
      }
      return v;
    },
  };
}

/**
 * Walk `root` and invoke `onFile(relDir, html)` for every `index.html`, with at
 * most WALK_CONCURRENCY readdir() and READ_CONCURRENCY readFile() in flight.
 * Rejects with the first error seen, after the in-flight operations drain.
 *
 * @param {string} root
 * @param {(relDir: string, html: string) => void} onFile
 */
async function scanIndexHtml(root, onFile) {
  const dirs = makeQueue();
  const files = makeQueue();
  dirs.push({ dir: root, base: '' });

  let dirsInFlight = 0;
  let readsInFlight = 0;
  let failure = null;
  let settled = false;

  await new Promise((resolve, reject) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      if (failure) reject(failure);
      else resolve();
    };
    // Termination. In the happy path both queues must be empty AND nothing in
    // flight. Once a failure is recorded we stop scheduling, so the queues stay
    // populated forever — the condition then has to be "everything in flight
    // has drained", or the promise never settles and Node exits 13 with
    // "unsettled top-level await" instead of surfacing the real error.
    const idle = () =>
      dirsInFlight === 0 && readsInFlight === 0 && (failure !== null || (dirs.size === 0 && files.size === 0));

    const pump = () => {
      if (settled) return;
      // On the first failure we stop SCHEDULING, but let everything already in
      // flight drain before rejecting, so no promise is left dangling.
      if (!failure) {
        while (dirsInFlight < WALK_CONCURRENCY && dirs.size > 0) {
          const { dir, base } = dirs.take();
          dirsInFlight++;
          readdir(dir, { withFileTypes: true })
            .then(
              (entries) => {
                for (const entry of entries) {
                  if (entry.isDirectory()) {
                    // Skip asset/data/image directories — they don't contain
                    // index.html anyway, but skipping saves I/O on large trees.
                    if (entry.name === 'assets' || entry.name === 'data' || entry.name === 'images') continue;
                    dirs.push({
                      dir: path.join(dir, entry.name),
                      base: path.posix.join(base, entry.name),
                    });
                  } else if (entry.name === 'index.html') {
                    files.push({ absPath: path.join(dir, entry.name), relDir: base });
                  }
                }
              },
              (err) => {
                failure ??= err;
              },
            )
            .finally(() => {
              dirsInFlight--;
              pump();
            });
        }
        while (readsInFlight < READ_CONCURRENCY && files.size > 0) {
          const { absPath, relDir } = files.take();
          readsInFlight++;
          readFile(absPath, 'utf-8')
            .then(
              (html) => {
                // onFile is the accumulator below; a throw in it is a bug, but
                // it must surface as a rejection, not as an unhandled one.
                try {
                  onFile(relDir, html);
                } catch (err) {
                  failure ??= err;
                }
              },
              (err) => {
                failure ??= err;
              },
            )
            .finally(() => {
              readsInFlight--;
              pump();
            });
        }
      }
      if (idle()) finish();
    };

    pump();
  });
}

let scanned = 0;
let skippedExplicit = 0;
let skippedRedirect = 0;
const violations = [];

await scanIndexHtml(DIST, (relDir, html) => {
  if (SKIP_PATHS.has(relDir)) {
    skippedExplicit++;
    return;
  }
  scanned++;
  if (SPA_BUNDLE_RX.test(html)) return;
  // Page is missing the bundle. Before flagging it, check whether its HTML
  // shape is a deliberate redirect (no SPA needed by design). Counted
  // separately so a regression that adds redirects in unexpected places
  // is still visible in the breakdown.
  // Deliberate redirect stubs built by buildCanonicalBridgePage embed the
  // REDIRECT_STUB_MARKER comment: their redirect behaviour lives in the
  // externalised /assets/early-boot-{hash}.js, so the inline
  // location.replace( sniff above never matches them (run 27371848400:
  // +32k false "missing bundle" regressions, all "Pagina spostata" stubs).
  if (REDIRECT_SHAPE_RX.test(html) || html.includes(REDIRECT_STUB_MARKER)) {
    skippedRedirect++;
    return;
  }
  violations.push({ relDir, size: html.length });
});

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

// ─── Why this gate is NEVER sampled ──────────────────────────────────────────
// AUDIT_SAMPLE_RATE / AUDIT_SAMPLE_SALT (scripts/lib/audit-runner.mjs's
// sampleFiles()) are deliberately NOT honoured here, and this script is
// deliberately NOT registered in scripts/audit-all.mjs — registering it there
// would inherit that runner's sampling implicitly.
//
// The reason is arithmetic, not caution. The comparison below is
// `current <= baselineTotal` with ZERO tolerance, on a raw count. Reading a
// fraction `p` of dist/ turns that count into a binomial draw; even after
// rescaling it the way scripts/lib/mixAdjustedRateGate.mjs does for the
// per-feature RATE ratchets in audit-title-length / audit-h1-title-duplicates
// / audit-text-html-ratio, the rescaled count carries a standard deviation of
// sqrt(N·(1−p)/p) — at N≈10 659 observed and p=0.25 that is ±180 offenders
// against a baseline of 10 800, i.e. headroom smaller than 1σ and a false RED
// on a double-digit percentage of runs.
//
// (This file therefore does NOT name that helper as a call. The guard in
// tests/seo/regressed-feature-message.test.ts treats any scripts/audit-*.mjs
// that contains the call as a sampled ratchet and requires it to also use
// formatRegressedFeature — correct for a gate that samples, wrong for one
// that documents why it must not.)
//
// Those rate ratchets tolerate sampling because they gate on a per-feature
// RATE with an explicit `minAbsDelta` noise floor; this one gates on an
// absolute count with no floor at all. Sampling it would not "weaken the
// threshold silently" — it would make the gate flap. Either failure mode ends
// the same way: someone switches it off. Hence: 100 % of dist/, every run, and
// the speed comes from the I/O scheduling above instead.
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
