#!/usr/bin/env node
/**
 * Analyse the per-path collision dump produced by `sharedWriteRegistry` +
 * `writeRegistryLifecyclePlugin` during a build with `WRITE_COLLISION_DUMP=1`.
 *
 * Inputs (defaults match the layout produced by the lifecycle plugin):
 *   - dist/.write-collisions.json
 *   - dist/.write-collisions-data/<hash>.html (one per unique content version)
 *
 * What it does
 * ------------
 * For every colliding path, this script loads each version's content from the
 * dump dir and runs heuristics that reflect the actual operational concerns
 * we hit on 2026-04-30:
 *
 *   - **SPA bundle present**: `<script type="module" src="/assets/index-*.js">`
 *     — when missing, the page can't hydrate (Bug 2). Decisive signal: a
 *     version without the bundle should NEVER win.
 *   - **JSON-LD blocks**: `<script type="application/ld+json">` count.
 *     Higher is better for SEO ranking.
 *   - **Body text length**: visible-text size after stripping markup. A
 *     longer body usually means richer content (the canonical, not a stub).
 *   - **Self-bouncing redirect**: `<script>location.replace(...)</script>` at
 *     body end — the legacy bug-1 pattern. Should never win.
 *   - **noindex robots tag**: `<meta name="robots" content="noindex">` —
 *     present on bridge stubs only. Shouldn't win unless the path is
 *     explicitly a bridge.
 *
 * From those signals it produces a verdict per path:
 *
 *   - **clear-winner**: one version wins on every meaningful signal. Encode
 *     via a single-owner refactor (preferred) or `declareSharedPath()`.
 *   - **near-tie**: versions are close — needs human judgement, see the diff.
 *   - **regression-risk**: NO version has the SPA bundle, OR all versions
 *     are bridge stubs. Path is structurally broken; investigate the source
 *     plugin emit logic.
 *
 * Aggregations across paths group by (callSite-pair, plugin-pair) so a single
 * structural pattern (e.g. "for-each-locale loop in jobsSeoPagesPlugin emit
 * site X") becomes visible as one fix that resolves N collisions at once.
 *
 * Output: human-readable report to stdout + machine-readable JSON next to
 * the inputs (`dist/write-collisions-analysis.json`, no leading dot so it's
 * downloadable from CI artifacts without depending on dotfile pass-through).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const INPUT_JSON = process.env.WRITE_COLLISIONS_INPUT
  ? path.resolve(process.env.WRITE_COLLISIONS_INPUT)
  : path.resolve(ROOT, 'dist', '.write-collisions.json');

const DUMP_DIR = process.env.WRITE_COLLISIONS_DUMP_DIR
  ? path.resolve(process.env.WRITE_COLLISIONS_DUMP_DIR)
  : path.resolve(ROOT, 'dist', '.write-collisions-data');

const OUTPUT_JSON = process.env.WRITE_COLLISIONS_OUTPUT
  ? path.resolve(process.env.WRITE_COLLISIONS_OUTPUT)
  : path.resolve(ROOT, 'dist', 'write-collisions-analysis.json');

if (!fs.existsSync(INPUT_JSON)) {
  console.error(`[analyze] missing input: ${INPUT_JSON}`);
  console.error('Run a build with WRITE_COLLISION_DUMP=1 first, then point this');
  console.error('script at the resulting dist/.write-collisions.json.');
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(INPUT_JSON, 'utf-8'));
if (!Array.isArray(report.paths) || report.paths.length === 0) {
  console.log('[analyze] no colliding paths recorded — nothing to analyse.');
  process.exit(0);
}

const dumpAvailable = fs.existsSync(DUMP_DIR);
if (!dumpAvailable) {
  console.warn(
    `[analyze] dump dir not found at ${DUMP_DIR} — running on metadata only. ` +
      'Heuristics that require content (SPA bundle presence, body length, etc.) ' +
      'will be skipped. Build with WRITE_COLLISION_DUMP=1 to enable full analysis.',
  );
}

/**
 * Per-version heuristic signals computed from raw HTML content. Keys match
 * the operational concerns documented at the top of this file. Booleans are
 * used for "present/absent" signals so they aggregate cleanly; counts and
 * lengths are numeric.
 */
function inspectContent(html) {
  return {
    hasSpaBundle: /<script[^>]*type="module"[^>]*src="\/assets\/index-[A-Za-z0-9_-]+\.js"/.test(html),
    jsonLdCount: (html.match(/<script[^>]+type="application\/ld\+json"/g) || []).length,
    bodyTextLength: html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .length,
    selfBouncingRedirect: /<script>location\.replace\(['"][^'"]*['"]\+location\.hash\)<\/script>/.test(html),
    noindex: /<meta\s+name="robots"\s+content="noindex/i.test(html),
    canonicalHref: (html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i) || [, null])[1],
    hasJobPosting: /<script[^>]+type="application\/ld\+json"[^>]*>\s*\{[^}]*"@type"\s*:\s*"JobPosting"/.test(html),
    hasCollectionPage: /<script[^>]+type="application\/ld\+json"[^>]*>\s*\{[^}]*"@type"\s*:\s*"CollectionPage"/.test(html),
  };
}

function loadVersionContent(version) {
  if (!dumpAvailable) return null;
  const file = path.join(DUMP_DIR, `${version.contentHash}.html`);
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Decide which version is the "right" winner among N versions of the same
 * path. Order of precedence (deal-breakers first):
 *
 *   1. Drop versions that contain the self-bouncing redirect script — that
 *      pattern is the bug-1 cause and never wins.
 *   2. Among survivors, prefer versions with the SPA bundle injected — the
 *      bug-2 cause.
 *   3. Among those, prefer versions WITHOUT the noindex meta (a bridge
 *      stub should never beat a real page).
 *   4. Among those, prefer the version with the most JSON-LD blocks.
 *   5. Tie-break by `bodyTextLength` (longer = richer content).
 *   6. Final tie-break by version order in the input array (first claim wins
 *      to keep the result deterministic).
 *
 * Returns a verdict label and the index of the winning version.
 */
function decideWinner(versions, contents) {
  const candidates = versions.map((v, idx) => ({ v, idx, sig: contents[idx] }));
  if (candidates.length === 0) return { verdict: 'no-versions', winnerIdx: -1 };

  if (!dumpAvailable) {
    // Fall back to size as a weak signal; flag for human review.
    candidates.sort((a, b) => b.v.size - a.v.size);
    return { verdict: 'metadata-only', winnerIdx: candidates[0].idx };
  }

  // Step 1: drop self-bouncing redirects
  let pool = candidates.filter((c) => c.sig && !c.sig.selfBouncingRedirect);
  if (pool.length === 0) {
    return { verdict: 'regression-risk:all-self-bouncing', winnerIdx: candidates[0].idx };
  }

  // Step 2: prefer SPA bundle
  const withBundle = pool.filter((c) => c.sig.hasSpaBundle);
  if (withBundle.length > 0) {
    pool = withBundle;
  } else {
    // Decisive: NO version has the bundle — Bug 2 territory. Flag.
    return { verdict: 'regression-risk:no-spa-bundle', winnerIdx: pool[0].idx };
  }

  // Step 3: prefer non-noindex
  const indexable = pool.filter((c) => !c.sig.noindex);
  if (indexable.length > 0) pool = indexable;

  // Step 4 + 5: rank by jsonLdCount desc, then bodyTextLength desc
  pool.sort((a, b) => {
    if (b.sig.jsonLdCount !== a.sig.jsonLdCount) return b.sig.jsonLdCount - a.sig.jsonLdCount;
    if (b.sig.bodyTextLength !== a.sig.bodyTextLength) return b.sig.bodyTextLength - a.sig.bodyTextLength;
    return a.idx - b.idx;
  });

  const top = pool[0];
  // Near-tie: top and runner-up are within 5% on all numeric signals.
  if (pool.length >= 2) {
    const next = pool[1];
    const close =
      Math.abs(top.sig.jsonLdCount - next.sig.jsonLdCount) <= 1 &&
      Math.abs(top.sig.bodyTextLength - next.sig.bodyTextLength) / Math.max(top.sig.bodyTextLength, 1) < 0.05;
    if (close) return { verdict: 'near-tie', winnerIdx: top.idx };
  }
  return { verdict: 'clear-winner', winnerIdx: top.idx };
}

const perPath = [];
const patternBuckets = new Map();
const verdictCounts = new Map();

for (const entry of report.paths) {
  const versions = entry.versions || [];
  const contents = versions.map((v) => {
    const html = loadVersionContent(v);
    return html === null ? null : inspectContent(html);
  });
  const { verdict, winnerIdx } = decideWinner(versions, contents);
  verdictCounts.set(verdict, (verdictCounts.get(verdict) || 0) + 1);

  const callSitePairs = new Set();
  const pluginPairs = new Set();
  for (let i = 0; i < versions.length; i += 1) {
    for (let j = i + 1; j < versions.length; j += 1) {
      callSitePairs.add([versions[i].callSite, versions[j].callSite].sort().join('  ↔  '));
      pluginPairs.add([versions[i].plugin, versions[j].plugin].sort().join(' ↔ '));
    }
  }

  // Pattern bucket = (callSite-pair × verdict). Same pattern → same fix.
  const patternKey = `${verdict} :: ${Array.from(callSitePairs).join('  |  ')}`;
  if (!patternBuckets.has(patternKey)) {
    patternBuckets.set(patternKey, { verdict, callSitePairs: Array.from(callSitePairs), count: 0, samplePaths: [] });
  }
  const bucket = patternBuckets.get(patternKey);
  bucket.count += 1;
  if (bucket.samplePaths.length < 5) bucket.samplePaths.push(entry.path);

  perPath.push({
    path: entry.path,
    versionCount: versions.length,
    verdict,
    winnerIdx,
    winner: winnerIdx >= 0 ? versions[winnerIdx] : null,
    versions: versions.map((v, idx) => ({
      ...v,
      signals: contents[idx],
    })),
    pluginPairs: Array.from(pluginPairs),
    callSitePairs: Array.from(callSitePairs),
  });
}

// Sort patterns by count desc — fix the dominant pattern first.
const sortedPatterns = Array.from(patternBuckets.entries())
  .map(([key, b]) => ({ key, ...b }))
  .sort((a, b) => b.count - a.count);

// Console output
console.log('');
console.log('━━━ write-collisions analysis ━━━');
console.log(`source: ${path.relative(ROOT, INPUT_JSON)}`);
console.log(`dump:   ${dumpAvailable ? path.relative(ROOT, DUMP_DIR) : '(absent — metadata only)'}`);
console.log(`paths analysed: ${perPath.length}`);
console.log('');
console.log('verdict breakdown:');
for (const [v, c] of Array.from(verdictCounts.entries()).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(6)} × ${v}`);
}
console.log('');
console.log(`top patterns (count × callSite-pair, fix one ⇒ resolves all paths in that bucket):`);
for (const p of sortedPatterns.slice(0, 10)) {
  console.log(`  ${String(p.count).padStart(5)} × ${p.verdict}`);
  for (const cs of p.callSitePairs) {
    console.log(`             ${cs}`);
  }
  for (const sp of p.samplePaths) {
    console.log(`             ↳ ${sp}`);
  }
  console.log('');
}

if (sortedPatterns.length > 10) {
  console.log(`… ${sortedPatterns.length - 10} more pattern bucket(s) — see ${path.relative(ROOT, OUTPUT_JSON)}`);
}

// Machine-readable output
fs.writeFileSync(
  OUTPUT_JSON,
  JSON.stringify(
    {
      sourceJson: path.relative(ROOT, INPUT_JSON),
      dumpDir: dumpAvailable ? path.relative(ROOT, DUMP_DIR) : null,
      verdictCounts: Object.fromEntries(verdictCounts),
      patterns: sortedPatterns,
      paths: perPath,
    },
    null,
    2,
  ),
  'utf-8',
);
console.log(`full analysis → ${path.relative(ROOT, OUTPUT_JSON)}`);
