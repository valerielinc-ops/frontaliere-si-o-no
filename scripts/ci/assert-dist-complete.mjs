#!/usr/bin/env node
/**
 * assert-dist-complete.mjs
 *
 * PRECONDITION check for every dist-walking audit: assert that `dist/` is the
 * COMPLETE logical site, not just the trunk `github-pages` artifact.
 *
 * Why this exists
 * ---------------
 * Once `LOCALE_SHARDS_LIVE` / `<SECTION>_SHARD_LIVE` are on, the published
 * `github-pages` artifact has the `en/de/fr` subtrees AND the per-section
 * subtrees (`cerca-lavoro-ticino`, `cerca-lavoro-svizzera`, …) stripped out —
 * they are served from their own shard repos through the Cloudflare Worker at
 * the SAME URLs. `post-deploy-validate-dist.yml` therefore rehydrates both
 * shard families into `dist/` before auditing (see its "Rehydrate locale then
 * section shards" step) so the audits keep full coverage.
 *
 * A consumer that extracts the artifact and audits it WITHOUT rehydrating
 * walks a fraction of the site, and every dist-walking audit then reports the
 * missing subtrees as a structural defect of the *site* instead of a defect of
 * the *measurement*. That happened in audit replay run 30346794790
 * (issue #4857): 224,032 files restored, 41,837 reachable paths visited, and
 * `audit:max-bfs-depth` reported `sitemap-search-clusters-006/007` as an
 * entire content tier below crawl depth — while the same report showed
 * `reached: 0` for shards 001-005 too, which `data/bfs-depth-baseline.json`
 * records as 100% reachable at depth ≤4. Every cluster canonicalizes under
 * `/cerca-lavoro-svizzera/`, i.e. exactly one of the stripped section
 * subtrees. The verdict was an artifact of the partial dist; it cost a
 * wrong-root-cause issue and an agent investigation.
 *
 * What this does NOT do
 * ---------------------
 * This is a precondition, NOT a replacement for any gate. "Sitemap advertises
 * a URL with no page behind it" stays owned by `validate:sitemap-pages` /
 * `audit:orphan-sitemap-pages`, which run on the complete dist. This check
 * only distinguishes "the measurement input is incomplete" (exit 2 —
 * inconclusive, rehydrate and re-run) from "the site has a defect" (an audit
 * verdict). It never relaxes a threshold and never downgrades an audit
 * failure: it fails the job EARLIER, before a misleading report is produced.
 *
 * Usage
 * -----
 *   node scripts/ci/assert-dist-complete.mjs
 *   node scripts/ci/assert-dist-complete.mjs --dist=/tmp/dist-prod --sample=60
 *   node scripts/ci/assert-dist-complete.mjs --json
 *
 * Fixing every offender in ONE pass
 * ---------------------------------
 * The default 40-URL sample answers "is this dist complete?" cheaply, but it is
 * the wrong tool for "which URLs do I have to fix?": it names at most 5 example
 * URLs per sitemap, so a maintainer fixes those, re-runs the ~hours-long publish
 * pipeline, and meets the next five. `--full --report=<path>` checks EVERY
 * sitemap URL and writes the COMPLETE offender list as JSON, so one run yields
 * the whole work list. `--full` costs a stat() per URL (~240k on this site)
 * instead of ~2.7k, which is why it is opt-in rather than the default.
 *
 *   node scripts/ci/assert-dist-complete.mjs --full --report=/tmp/missing.json
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readdir, readFile, access, stat, writeFile } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flatString } from '../lib/flat-string.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const argv = process.argv.slice(2);
const args = new Map();
for (const a of argv) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    args.set(k, v ?? true);
  }
}

const resolvePath = (p) => (isAbsolute(p) ? p : join(ROOT, p));
const DIST = resolvePath(String(args.get('dist') ?? 'dist'));
const MODE_JSON = Boolean(args.get('json'));
// `--full` (or `--sample=0`) means "no sampling": sampleEvenly() returns the
// whole list once the requested count reaches its length, so Infinity is the
// no-op sample rather than a special case threaded through the walk.
const MODE_FULL = Boolean(args.get('full'));
const rawSample = Number(args.get('sample') ?? 40);
const SAMPLE_PER_SITEMAP = MODE_FULL || rawSample === 0 ? Infinity : rawSample;
const REPORT_PATH = args.get('report') ? resolvePath(String(args.get('report'))) : null;

/**
 * Thresholds. A rehydrated dist samples at ~0% missing; a trunk-only dist
 * samples at ~100% missing for every sharded subtree. The gap between those
 * two populations is the whole signal, so the bar sits far from both:
 *
 *  • SHARD_MISSING_FAIL_PCT (50%) — half a sitemap's sampled URLs having no
 *    file at all is an entire subtree absent, never organic drift.
 *  • MIN_SAMPLE_FOR_SHARD (20) — tiny sitemaps (a handful of URLs) can hit a
 *    high percentage on one miss, so they only count toward the overall rate.
 *  • OVERALL_MISSING_FAIL_PCT (10%) — catches a partial restore spread across
 *    many sitemaps (e.g. one locale subtree missing) that no single sitemap
 *    crosses 50% on.
 */
export const DEFAULT_COMPLETENESS_TOL = {
  shardMissingFailPct: 50,
  minSampleForShard: 20,
  overallMissingFailPct: 10,
};

/**
 * Pure evaluation half, exported for unit tests (same split as
 * `evaluateBfsGate` in scripts/audit-bfs-depth.mjs). No I/O, no process.exit.
 *
 * @param {object} input
 * @param {Record<string, { sampled: number; missing: number; examples: string[] }>} input.perSitemap
 * @param {typeof DEFAULT_COMPLETENESS_TOL} [input.tol]
 * @returns {{ ok: boolean, sampledTotal: number, missingTotal: number, overallMissingPct: number,
 *             failures: Array<{ name: string; sampled: number; missing: number; missingPct: number; examples: string[] }> }}
 */
export function evaluateDistCompleteness({ perSitemap, tol }) {
  const resolvedTol = { ...DEFAULT_COMPLETENESS_TOL, ...(tol ?? {}) };
  let sampledTotal = 0;
  let missingTotal = 0;
  const failures = [];

  for (const [name, row] of Object.entries(perSitemap)) {
    const sampled = Number(row?.sampled ?? 0);
    const missing = Number(row?.missing ?? 0);
    sampledTotal += sampled;
    missingTotal += missing;
    if (sampled < resolvedTol.minSampleForShard) continue;
    const missingPct = sampled ? (missing / sampled) * 100 : 0;
    if (missingPct >= resolvedTol.shardMissingFailPct) {
      failures.push({
        name,
        sampled,
        missing,
        missingPct: Number(missingPct.toFixed(2)),
        examples: (row?.examples ?? []).slice(0, 5),
      });
    }
  }

  const overallMissingPct = sampledTotal ? (missingTotal / sampledTotal) * 100 : 0;
  const overallFails = overallMissingPct >= resolvedTol.overallMissingFailPct;

  failures.sort((a, b) => b.missingPct - a.missingPct);

  return {
    ok: failures.length === 0 && !overallFails,
    sampledTotal,
    missingTotal,
    overallMissingPct: Number(overallMissingPct.toFixed(2)),
    failures,
  };
}

/**
 * Deterministic even-stride sample — no RNG, so a re-run on the same dist
 * inspects the same URLs and a failure is reproducible from the log alone.
 */
export function sampleEvenly(items, count) {
  if (items.length <= count) return items.slice();
  const stride = items.length / count;
  const out = [];
  for (let i = 0; i < count; i++) out.push(items[Math.floor(i * stride)]);
  return out;
}

function extractLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m;
  // flatString: each loc is a regex capture slicing INTO the whole sitemap XML,
  // and the derived paths outlive it in a cross-sitemap accumulator — see
  // scripts/lib/flat-string.mjs (issue #7419).
  while ((m = re.exec(xml)) !== null) out.push(flatString(m[1].trim()));
  return out;
}

function urlToRelPath(url) {
  try {
    const u = new URL(url);
    let p = u.pathname || '/';
    if (p.startsWith('/')) p = p.slice(1);
    if (p.endsWith('/')) p = p.slice(0, -1);
    return p;
  } catch {
    return null;
  }
}

/**
 * Mirrors `resolvePathToDistFile` in scripts/audit-bfs-depth.mjs, plus a
 * literal-path fallback so a sitemap that lists a non-HTML resource (an image
 * or PDF sitemap — none today, all 81 children are page sitemaps) resolves on
 * the file itself instead of counting as an absent page.
 */
async function hasDistFile(rel) {
  for (const candidate of [join(DIST, rel, 'index.html'), join(DIST, `${rel}.html`)]) {
    try { await access(candidate); return true; } catch { /* try next */ }
  }
  // Literal path last, and only when it is a FILE: `dist/<rel>` exists as a
  // DIRECTORY for every stripped page too (the shard strip removes index.html
  // but can leave the folder), so an access() check alone would report a
  // missing page as present and defeat the whole check.
  try {
    const st = await stat(join(DIST, rel));
    return st.isFile();
  } catch {
    return false;
  }
}

async function main() {
  let entries;
  try {
    entries = await readdir(DIST);
  } catch (err) {
    console.error(`FAIL: dist directory ${DIST} is unreadable: ${err.message}`);
    process.exit(2);
  }

  const sitemapFiles = entries.filter((f) => /^sitemap.*\.xml$/i.test(f)).sort();
  if (sitemapFiles.length === 0) {
    console.error(`FAIL: no sitemap*.xml found in ${DIST} — dist/ is not a deployed site tree.`);
    process.exit(2);
  }

  /** @type {Record<string, { sampled: number; missing: number; examples: string[] }>} */
  const perSitemap = {};

  for (const file of sitemapFiles) {
    let xml;
    try {
      xml = await readFile(join(DIST, file), 'utf-8');
    } catch {
      continue;
    }
    // Drop nested-sitemap entries: the index lists child .xml files, not pages.
    const locs = extractLocs(xml).filter((u) => !/\.xml(\?|$)/i.test(u));
    if (locs.length === 0) continue;

    const sample = sampleEvenly(locs, SAMPLE_PER_SITEMAP);
    let missing = 0;
    const examples = [];
    // Every offender, not just the 5 shown on the console — this is what makes
    // `--report` a complete work list instead of another sampled hint.
    const missingUrls = [];
    for (const loc of sample) {
      const rel = urlToRelPath(loc);
      if (rel === null) continue;
      if (!(await hasDistFile(rel))) {
        missing++;
        missingUrls.push(loc);
        if (examples.length < 5) examples.push(loc);
      }
    }
    perSitemap[file] = { sampled: sample.length, missing, examples, missingUrls, total: locs.length };
  }

  const result = evaluateDistCompleteness({ perSitemap });

  // Written on success too: a green run's report is the baseline a later red
  // run gets diffed against, and an always-present path keeps the workflow's
  // upload step from having to branch on the gate's exit code.
  if (REPORT_PATH) {
    const report = {
      dist: DIST,
      mode: MODE_FULL || SAMPLE_PER_SITEMAP === Infinity ? 'full' : `sample:${SAMPLE_PER_SITEMAP}`,
      ok: result.ok,
      sampledTotal: result.sampledTotal,
      missingTotal: result.missingTotal,
      overallMissingPct: result.overallMissingPct,
      failures: result.failures,
      missingBySitemap: Object.fromEntries(
        Object.entries(perSitemap)
          .filter(([, row]) => row.missing > 0)
          .map(([name, row]) => [name, { total: row.total, sampled: row.sampled, missing: row.missing, urls: row.missingUrls }]),
      ),
    };
    try {
      await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');
      // stderr, never stdout: under `--json` stdout must stay parseable JSON,
      // and callers redirect it to a file (see revalidate-dist-from-run.yml).
      console.error(`Report written to ${REPORT_PATH} (${result.missingTotal} missing URL(s) listed in full).`);
    } catch (err) {
      // A report is a diagnostic aid; losing it must not change the verdict.
      console.error(`WARN: could not write report to ${REPORT_PATH}: ${err.message}`);
    }
  }

  if (MODE_JSON) {
    process.stdout.write(JSON.stringify({ dist: DIST, perSitemap, ...result }, null, 2) + '\n');
  } else {
    const header = `${'Sitemap'.padEnd(44)} ${'Sampled'.padStart(8)} ${'Missing'.padStart(8)} ${'Missing%'.padStart(9)}`;
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const [name, row] of Object.entries(perSitemap)) {
      const pct = row.sampled ? ((row.missing / row.sampled) * 100).toFixed(1) : '0.0';
      console.log(`${name.padEnd(44)} ${String(row.sampled).padStart(8)} ${String(row.missing).padStart(8)} ${pct.padStart(9)}`);
    }
    console.log('-'.repeat(header.length));
    console.log(`${'TOTAL'.padEnd(44)} ${String(result.sampledTotal).padStart(8)} ${String(result.missingTotal).padStart(8)} ${String(result.overallMissingPct).padStart(9)}`);
  }

  if (result.ok) {
    console.log(`\n✅ dist/ looks complete (${result.missingTotal}/${result.sampledTotal} sampled URLs missing, ${result.overallMissingPct}%).`);
    return;
  }

  console.error('\n══════════════════════════════════════════════════════════════════════');
  console.error('INCONCLUSIVE: dist/ is not the complete logical site — audits aborted');
  console.error('══════════════════════════════════════════════════════════════════════');
  console.error('');
  console.error(`Sampled ${result.sampledTotal} sitemap URLs, ${result.missingTotal} (${result.overallMissingPct}%) have no`);
  console.error(`page file under ${DIST}.`);
  if (result.failures.length > 0) {
    console.error('');
    console.error('Sitemaps whose content is essentially absent from dist/:');
    for (const f of result.failures) {
      console.error(`  ${f.name}: ${f.missing}/${f.sampled} sampled URLs missing (${f.missingPct}%)`);
      for (const ex of f.examples) console.error(`    ${ex}`);
    }
  }
  console.error('');
  console.error('How to fix');
  console.error('----------');
  console.error('The `github-pages` artifact is the TRUNK only: with LOCALE_SHARDS_LIVE /');
  console.error('<SECTION>_SHARD_LIVE on, the en/de/fr subtrees and the per-section subtrees');
  console.error('(cerca-lavoro-ticino, cerca-lavoro-svizzera, …) are stripped from it and');
  console.error('served from their own shard repos at the same URLs. Rehydrate them before');
  console.error('auditing, exactly like post-deploy-validate-dist.yml does:');
  console.error('');
  console.error('  bash scripts/lib/rehydrate-locale-shards.sh');
  console.error('  bash scripts/lib/rehydrate-section-shards.sh');
  console.error('');
  console.error('Do NOT read the aborted audits as a site defect: a partial dist makes every');
  console.error('dist-walking audit report absent subtrees as unreachable/thin/orphan content.');
  console.error('');
  if (!REPORT_PATH) {
    console.error('Only 5 example URLs per sitemap are shown above, and only a sample was');
    console.error('checked. To get EVERY offending URL in one pass — instead of re-running the');
    console.error('publish pipeline once per fix — re-run against the same dist with:');
    console.error('');
    console.error('  node scripts/ci/assert-dist-complete.mjs --full --report=/tmp/missing.json');
    console.error('');
    console.error('and to do that without a rebuild, replay a prior deploy\'s artifacts with the');
    console.error('`Revalidate dist from prior run` workflow (workflow_dispatch, deploy_run_id).');
    console.error('');
  }
  process.exit(2);
}

// Import-safe: unit tests import the pure helpers without triggering a walk.
const invokedDirectly = (() => {
  // Entrypoint canonico, non suffisso del path (#7292): `endsWith` diceva true
  // per QUALUNQUE entrypoint il cui `argv[1]` finisse con questo nome di file;
  // `realpathSync` copre l'invocazione via symlink, dove `argv[1]` e' il link.
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error('assert-dist-complete crashed:', err.stack || err.message);
    process.exit(2);
  });
}
