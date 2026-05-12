#!/usr/bin/env node
/**
 * audit-bfs-depth.mjs
 *
 * Walk `dist/` via BFS from `/`, tracking depth per visited URL. For every URL
 * listed in any `sitemap-*.xml`, record at what BFS depth it was reached
 * (∞ if unreachable). Per-sitemap aggregate: count URLs at depth > MAX_DEPTH
 * (default 4). The gate FAILS only when any sitemap's count goes UP relative
 * to `data/bfs-depth-baseline.json` — same ratchet pattern as
 * `audit-text-html-ratio.mjs` and `audit-orphan-pages-in-sitemaps.mjs`.
 *
 * Why this gate exists
 * --------------------
 * `audit-orphan-pages-in-sitemaps.mjs` walks the link graph TRANSITIVELY —
 * any page reachable via the "next" pagination chain at depth 50 is considered
 * non-orphan. Real crawlers (Ahrefs, Googlebot) cap their crawl depth, so a
 * URL only reachable at depth ≥ 5 is effectively orphan even if our BFS
 * accepts it. The May 2026 Ahrefs audit caught 1,854 IT blog articles in this
 * exact gap: linked from `/articoli-frontaliere/tutti/page-3..21/` chain,
 * passing the existing gate, flagged orphan by Ahrefs.
 *
 * The fix (commit aa987d38f7) added a 21-anchor navigator on
 * `/articoli-frontaliere/` so every archive page sits at depth 2 from `/`.
 * THIS gate prevents a future refactor from undoing that improvement
 * silently.
 *
 * Usage
 * -----
 *   node scripts/audit-bfs-depth.mjs                           # human summary
 *   node scripts/audit-bfs-depth.mjs --max-depth=5             # custom cap
 *   node scripts/audit-bfs-depth.mjs --limit=50                # show top N
 *   node scripts/audit-bfs-depth.mjs --feature=blog            # one bucket
 *   node scripts/audit-bfs-depth.mjs --json                    # JSON report
 *   node scripts/audit-bfs-depth.mjs --baseline=path.json      # ratchet mode
 *   node scripts/audit-bfs-depth.mjs --write-baseline=path.json
 *
 * Baseline / ratchet mode
 * -----------------------
 * The repo ships `data/bfs-depth-baseline.json` with the current per-sitemap
 * "at depth > MAX_DEPTH" counts. With `--baseline=<file>` the audit reads that
 * snapshot and FAILS only when:
 *   - any sitemap's offender count > baseline.perSitemap[name].atDepthGtMax
 *
 * MAX_DEPTH is baked into the baseline. Running with a different --max-depth
 * value than the baseline refuses to compare (false comparison would be
 * meaningless). Regenerate the baseline with --write-baseline=<file> after
 * deliberate improvements; never raise the numbers without explicit
 * justification in the PR description.
 */

import { readdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { writeAuditReport, relBaseline } from './lib/auditReport.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HOST = 'https://frontaliereticino.ch';

const argv = process.argv.slice(2);
const args = new Map();
for (const a of argv) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    args.set(k, v ?? true);
  }
}

// `--dist=<path>` lets a CI helper run the audit against an alternate dist/
// (e.g. an extracted github-pages artifact at /tmp/dist-prod/) without
// needing to symlink. Defaults to `<repo>/dist`.
const DIST = (() => {
  const v = args.get('dist');
  if (typeof v === 'string') return isAbsolute(v) ? v : join(ROOT, v);
  return join(ROOT, 'dist');
})();

const MAX_DEPTH = Number(args.get('max-depth') ?? 4);
const LIMIT = Number(args.get('limit') ?? 30);
const FEATURE_FILTER = typeof args.get('feature') === 'string' ? args.get('feature') : null;
const MODE_JSON = args.has('json');
const BASELINE_PATH = args.get('baseline');
const WRITE_BASELINE_PATH = args.get('write-baseline');

const resolvePath = (p) => (isAbsolute(p) ? p : join(ROOT, p));

// ---------------------------------------------------------------------------
// HTTPS fetch with timeout (mirror of audit-orphan-pages-in-sitemaps.mjs).
// ---------------------------------------------------------------------------

function fetchText(url, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'audit-bfs-depth/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        fetchText(next, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms fetching ${url}`));
    });
  });
}

function extractLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

function urlToCanonicalPath(url) {
  try {
    const u = new URL(url);
    let p = u.pathname || '/';
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  } catch {
    return null;
  }
}

function sitemapNameFromUrl(url) {
  const last = url.split('/').filter(Boolean).pop();
  return last || url;
}

async function fetchAllSitemaps() {
  const localIndexPath = join(DIST, 'sitemap.xml');
  let indexXml;
  let isLocal = false;
  try {
    await access(localIndexPath);
    indexXml = await readFile(localIndexPath, 'utf-8');
    isLocal = true;
    process.stderr.write(`[audit-bfs-depth] Reading local sitemap index ${relative(ROOT, localIndexPath)}\n`);
  } catch {
    const indexUrl = `${HOST}/sitemap.xml`;
    process.stderr.write(`[audit-bfs-depth] Fetching index ${indexUrl}\n`);
    indexXml = await fetchText(indexUrl);
  }
  const childUrls = extractLocs(indexXml).filter((u) => /\.xml(\?|$)/i.test(u));
  if (childUrls.length === 0) {
    throw new Error('Sitemap index returned zero <loc> entries — refusing to continue.');
  }
  process.stderr.write(`[audit-bfs-depth] Index lists ${childUrls.length} child sitemaps\n`);

  /** @type {Map<string, Set<string>>} */
  const sitemapsToUrls = new Map();
  /** @type {Map<string, string>} */
  const canonicalToOriginal = new Map();

  for (const childUrl of childUrls) {
    const name = sitemapNameFromUrl(childUrl);
    let xml;
    if (isLocal) {
      const localChildPath = join(DIST, name);
      try {
        await access(localChildPath);
        xml = await readFile(localChildPath, 'utf-8');
      } catch {
        process.stderr.write(`[audit-bfs-depth]   Skipping ${name} (not in local dist)\n`);
        continue;
      }
    } else {
      try {
        xml = await fetchText(childUrl);
      } catch (e) {
        throw new Error(`Failed to fetch child sitemap ${childUrl}: ${e.message}`);
      }
    }
    const locs = extractLocs(xml).filter((u) => !/\.xml(\?|$)/i.test(u));
    const set = new Set();
    for (const u of locs) {
      const p = urlToCanonicalPath(u);
      if (!p) continue;
      set.add(p);
      if (!canonicalToOriginal.has(p)) canonicalToOriginal.set(p, u);
    }
    sitemapsToUrls.set(name, set);
  }
  return { sitemapsToUrls, canonicalToOriginal };
}

// ---------------------------------------------------------------------------
// BFS-with-depth over dist/. Returns Map<canonicalPath, depth>.
// ---------------------------------------------------------------------------

function normaliseInternalPath(href) {
  if (!href) return null;
  let h = href.trim();
  if (!h) return null;
  const hash = h.indexOf('#');
  if (hash >= 0) h = h.slice(0, hash);
  const q = h.indexOf('?');
  if (q >= 0) h = h.slice(0, q);
  if (!h) return null;
  if (/^https?:\/\//i.test(h)) {
    try {
      const u = new URL(h);
      const allowedHosts = new Set(['frontaliereticino.ch', 'www.frontaliereticino.ch']);
      if (!allowedHosts.has(u.host.toLowerCase())) return null;
      let p = u.pathname || '/';
      if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
      return p;
    } catch {
      return null;
    }
  }
  if (h.startsWith('/')) {
    if (h.startsWith('//')) return null;
    let p = h;
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  }
  return null;
}

async function resolvePathToDistFile(path) {
  if (path === '/' || path === '') {
    const indexFile = join(DIST, 'index.html');
    try { await access(indexFile); return indexFile; } catch { return null; }
  }
  const rel = path.replace(/^\/+/, '');
  const a = join(DIST, rel, 'index.html');
  try { await access(a); return a; } catch { /* fall through */ }
  const b = join(DIST, `${rel}.html`);
  try { await access(b); return b; } catch { return null; }
}

const ROBOTS_NOINDEX_RE = /<meta\s+[^>]*name\s*=\s*["']robots["'][^>]*content\s*=\s*["'][^"']*\bnoindex\b[^"']*["'][^>]*>/i;
function htmlHasNoindex(html) { return ROBOTS_NOINDEX_RE.test(html); }

function extractAnchorHrefs(html) {
  const out = [];
  const tagRe = /<a\b[^>]*\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const href = m[2] ?? m[3] ?? m[4];
    if (typeof href === 'string') out.push(href);
  }
  return out;
}

async function bfsWithDepth() {
  const startFile = await resolvePathToDistFile('/');
  if (!startFile) {
    throw new Error(`BFS start node missing: ${join(DIST, 'index.html')} does not exist.`);
  }
  /** @type {Map<string, number>} */
  const depthOf = new Map();
  /** @type {Array<{ path: string; depth: number }>} */
  const frontier = [{ path: '/', depth: 0 }];
  depthOf.set('/', 0);

  while (frontier.length > 0) {
    const { path: cur, depth } = frontier.shift();
    const file = await resolvePathToDistFile(cur);
    if (!file) continue;
    let html;
    try { html = await readFile(file, 'utf8'); } catch { continue; }
    if (htmlHasNoindex(html)) continue; // bridge stops here — equity wouldn't propagate
    const hrefs = extractAnchorHrefs(html);
    for (const href of hrefs) {
      const p = normaliseInternalPath(href);
      if (!p) continue;
      if (depthOf.has(p)) continue; // already visited at lower-or-equal depth (BFS)
      depthOf.set(p, depth + 1);
      frontier.push({ path: p, depth: depth + 1 });
    }
  }
  return depthOf;
}

// ---------------------------------------------------------------------------
// Aggregate per sitemap.
// ---------------------------------------------------------------------------

function computePerSitemap(sitemapsToUrls, depthOf, canonicalToOriginal) {
  /** @type {Record<string, { total: number; reached: number; atDepthGtMax: number; deepest: number; examples: Array<{ url: string; depth: number | 'unreachable' }> }>} */
  const perSitemap = {};
  for (const [name, urls] of [...sitemapsToUrls.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let reached = 0;
    let deepest = 0;
    /** @type {Array<{ url: string; depth: number | 'unreachable' }>} */
    const offenders = [];
    for (const p of urls) {
      const d = depthOf.has(p) ? depthOf.get(p) : Infinity;
      if (Number.isFinite(d)) {
        reached++;
        if (d > deepest) deepest = d;
      }
      if (d > MAX_DEPTH) {
        offenders.push({ url: canonicalToOriginal.get(p) || p, depth: Number.isFinite(d) ? d : 'unreachable' });
      }
    }
    offenders.sort((a, b) => {
      const ai = a.depth === 'unreachable' ? Infinity : a.depth;
      const bi = b.depth === 'unreachable' ? Infinity : b.depth;
      return bi - ai;
    });
    perSitemap[name] = {
      total: urls.size,
      reached,
      atDepthGtMax: offenders.length,
      deepest,
      examples: offenders.slice(0, LIMIT),
      // Internal field used for regression dump only — not serialized to the
      // baseline JSON. Carries the FULL offender list so CI can dump every
      // offending URL on regression.
      offendersList: offenders,
    };
  }
  return perSitemap;
}

function printTable(perSitemap) {
  const header = `${'Sitemap'.padEnd(40)} ${'Total'.padStart(7)} ${'Reached'.padStart(8)} ${`>${MAX_DEPTH}`.padStart(7)} ${'Deepest'.padStart(8)}`;
  console.log(header);
  console.log('-'.repeat(header.length));
  let totals = { total: 0, reached: 0, gt: 0 };
  const entries = Object.entries(perSitemap).filter(([n]) => !FEATURE_FILTER || n.includes(String(FEATURE_FILTER)));
  for (const [name, row] of entries) {
    console.log(`${name.padEnd(40)} ${String(row.total).padStart(7)} ${String(row.reached).padStart(8)} ${String(row.atDepthGtMax).padStart(7)} ${String(row.deepest).padStart(8)}`);
    totals.total += row.total;
    totals.reached += row.reached;
    totals.gt += row.atDepthGtMax;
  }
  console.log('-'.repeat(header.length));
  console.log(`${'TOTAL'.padEnd(40)} ${String(totals.total).padStart(7)} ${String(totals.reached).padStart(8)} ${String(totals.gt).padStart(7)}`);
  for (const [name, row] of entries) {
    if (row.atDepthGtMax === 0) continue;
    console.log(`\n# ${name} — top ${Math.min(LIMIT, row.examples.length)} URLs at depth > ${MAX_DEPTH}`);
    for (const ex of row.examples) console.log(`  depth=${String(ex.depth).padStart(3)}  ${ex.url}`);
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const { sitemapsToUrls, canonicalToOriginal } = await fetchAllSitemaps();
  process.stderr.write(`[audit-bfs-depth] BFS-walking dist/ from /\n`);
  const depthOf = await bfsWithDepth();
  process.stderr.write(`[audit-bfs-depth] Visited ${depthOf.size} reachable paths\n`);

  const perSitemap = computePerSitemap(sitemapsToUrls, depthOf, canonicalToOriginal);

  // Flatten per-sitemap offenders into a single list for the shared report
  // schema. Each offender carries its source sitemap as `feature` so the
  // breakdown matches the human stdout table. Sort worst (deepest) first.
  /** @type {Array<{path:string, feature:string, metric:number|string, ratio:null, sitemap:string, depth:number|string}>} */
  const flatOffenders = [];
  /** @type {Record<string, number>} */
  const byFeatureForReport = {};
  for (const [name, row] of Object.entries(perSitemap)) {
    const list = row.offendersList || [];
    byFeatureForReport[name] = list.length;
    for (const o of list) {
      flatOffenders.push({
        path: o.url,
        feature: name,
        metric: o.depth,
        ratio: null,
        sitemap: name,
        depth: o.depth,
      });
    }
  }
  flatOffenders.sort((a, b) => {
    const av = a.depth === 'unreachable' ? Infinity : Number(a.depth);
    const bv = b.depth === 'unreachable' ? Infinity : Number(b.depth);
    return bv - av;
  });

  const writeReport = (passed, baselineDelta) => writeAuditReport({
    audit: 'max-bfs-depth',
    passed,
    threshold: { metric: 'depth', value: MAX_DEPTH, comparator: '<=' },
    baselineFile: relBaseline(typeof BASELINE_PATH === 'string' ? BASELINE_PATH : null),
    baselineDelta,
    offenders: flatOffenders,
    byFeature: byFeatureForReport,
    extra: { perSitemapSummary: Object.fromEntries(Object.entries(perSitemap).map(([n, r]) => [n, { total: r.total, reached: r.reached, atDepthGtMax: r.atDepthGtMax, deepest: r.deepest }])) },
  });

  if (MODE_JSON) {
    process.stdout.write(JSON.stringify({ maxDepth: MAX_DEPTH, perSitemap }, null, 2) + '\n');
  } else {
    printTable(perSitemap);
  }

  // Strip examples for the baseline-shape report (kept lean).
  const perSitemapForBaseline = {};
  for (const [name, row] of Object.entries(perSitemap)) {
    perSitemapForBaseline[name] = {
      total: row.total,
      reached: row.reached,
      atDepthGtMax: row.atDepthGtMax,
      deepest: row.deepest,
    };
  }

  if (WRITE_BASELINE_PATH && typeof WRITE_BASELINE_PATH === 'string') {
    const baseline = {
      version: 1,
      generatedAt: new Date().toISOString(),
      maxDepth: MAX_DEPTH,
      perSitemap: perSitemapForBaseline,
      _comment:
        'Baseline for audit-bfs-depth.mjs. atDepthGtMax must only DECREASE — ' +
        'this gate is a ratchet. Regenerate after lowering offenders by adding ' +
        'internal links from a hub at depth ≤ ' + (MAX_DEPTH - 1) + '. Never raise the ' +
        'numbers without explicit justification (it means new URLs are buried below ' +
        'crawl-depth and Ahrefs/Googlebot will flag them as orphan).',
    };
    const outPath = resolvePath(WRITE_BASELINE_PATH);
    await writeFile(outPath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
    process.stderr.write(`\n→ wrote baseline to ${relative(ROOT, outPath)}\n`);
  }

  if (BASELINE_PATH && typeof BASELINE_PATH === 'string') {
    const inPath = resolvePath(BASELINE_PATH);
    let baseline;
    try {
      baseline = JSON.parse(await readFile(inPath, 'utf8'));
    } catch (err) {
      console.error(`\nFAIL: baseline file ${relative(ROOT, inPath)} could not be read: ${err.message}`);
      console.error('   Generate one first with --write-baseline=' + relative(ROOT, inPath));
      process.exit(2);
    }
    if (Number(baseline.maxDepth) !== MAX_DEPTH) {
      console.error(`\nFAIL: baseline maxDepth=${baseline.maxDepth} ≠ run maxDepth=${MAX_DEPTH}.`);
      console.error('   The two settings produce non-comparable counts. Either pass');
      console.error(`   --max-depth=${baseline.maxDepth} or rebaseline with the new value.`);
      process.exit(2);
    }
    /** @type {Array<{ name: string; prev: number; current: number; deepest: number }>} */
    const regressions = [];
    for (const [name, row] of Object.entries(perSitemap)) {
      const prev = baseline.perSitemap?.[name];
      if (!prev) continue;
      if (row.atDepthGtMax > Number(prev.atDepthGtMax ?? 0)) {
        regressions.push({ name, prev: Number(prev.atDepthGtMax), current: row.atDepthGtMax, deepest: row.deepest });
      }
    }
    if (regressions.length > 0) {
      console.error('\n══════════════════════════════════════════════════════════════════════');
      console.error('FAIL: BFS-depth gate REGRESSED');
      console.error('══════════════════════════════════════════════════════════════════════');
      console.error('');
      console.error('Why this gate exists');
      console.error('--------------------');
      console.error(`URLs at BFS depth > ${MAX_DEPTH} from / are effectively orphan from`);
      console.error('Ahrefs/Googlebot perspective: real crawlers cap their crawl depth.');
      console.error('Even if the URL is technically reachable via deep pagination,');
      console.error('search engines will not credit it with internal-link equity.');
      console.error('');
      console.error('What just happened');
      console.error('------------------');
      for (const r of regressions) {
        console.error(`  ${r.name}: ${r.current} URLs at depth > ${MAX_DEPTH} (baseline allows ${r.prev}, deepest now ${r.deepest})`);
      }
      console.error('');
      // Dump ALL offenders for each regressed sitemap so the CI log alone is
      // enough to diagnose without downloading the dist artifact.
      for (const r of regressions) {
        const full = perSitemap[r.name]?.offendersList || [];
        console.error(`Full offender list for sitemap "${r.name}" (${r.current} URLs at depth > ${MAX_DEPTH}, baseline ${r.prev}, +${r.current - r.prev}):`);
        for (const o of full) {
          console.error(`  depth=${o.depth}  ${o.url}`);
        }
        console.error('');
      }
      console.error('How to fix');
      console.error('----------');
      console.error('1. Run locally to see the offending URLs:');
      console.error(`     node scripts/audit-bfs-depth.mjs --limit=50`);
      console.error('');
      console.error('2. For each regressed sitemap, identify which hub page should');
      console.error(`   link the buried URLs at depth ≤ ${MAX_DEPTH - 1}. Add the links and rebuild.`);
      console.error('   Common pattern: replace compact pagination ("1, current, last") with');
      console.error('   a full page navigator linking every page-N from the section index.');
      console.error('');
      console.error('3. After lowering the count, regenerate the baseline:');
      console.error('     npm run build && \\');
      console.error('       npm run audit:max-bfs-depth:rebaseline');
      console.error('   Commit the new baseline JSON together with the linking change.');
      console.error('');
      console.error('4. The baseline number must only ever DECREASE. Per CLAUDE.md');
      console.error('   non-negotiable rule #5: orphans are fixed via internal links,');
      console.error('   never noindex.');
      const regressionTotal = regressions.reduce((sum, r) => sum + (r.current - r.prev), 0);
      const beforeTotal = regressions.reduce((sum, r) => sum + r.prev, 0);
      const afterTotal = regressions.reduce((sum, r) => sum + r.current, 0);
      await writeReport(false, { before: beforeTotal, after: afterTotal, regression: regressionTotal });
      process.exit(1);
    }
    process.stderr.write('[audit-bfs-depth] ratchet OK — no regression\n');
    await writeReport(true, null);
    return;
  }
  // No baseline check requested — still emit a report so artifact diffs work.
  await writeReport(flatOffenders.length === 0, null);
}

main().catch((err) => {
  console.error('audit-bfs-depth crashed:', err.stack || err.message);
  process.exit(2);
});
