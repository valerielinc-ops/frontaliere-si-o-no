#!/usr/bin/env node
/**
 * audit-orphan-pages-in-sitemaps.mjs
 *
 * Detect "orphaned pages in sitemaps" — URLs listed in any of the live
 * sitemap-*.xml files but not reachable via internal-link traversal from
 * the homepage `/`. Semrush flags these (currently ~4,936 on
 * frontaliereticino.ch) because they consume crawl budget without site-
 * structure support and tend to rank worse.
 *
 * --------------------------------------------------------------------------
 * Pipeline
 * --------------------------------------------------------------------------
 * 1. Fetch sitemap.xml index from https://frontaliereticino.ch/sitemap.xml
 *    and follow every <sitemap><loc> child it lists. 30s timeout per fetch;
 *    failures are LOUD (no silent skips — a missing sitemap is a real bug).
 * 2. Parse <loc> entries from each child sitemap into:
 *      sitemapsToUrls: Map<sitemapName, Set<canonicalPath>>
 *    where canonicalPath strips the host, fragments, and normalises
 *    trailing slashes consistently.
 * 3. Build the "linked" set from the LOCAL worktree:
 *      Mode A (preferred): BFS reachability from `/` over dist/**\/*.html.
 *                          Start at dist/index.html, follow every <a href>,
 *                          stop at noindex pages (don't extract their
 *                          outgoing links — they're crawl-graph dead-ends),
 *                          stop at files that don't exist in dist/. The
 *                          returned set is the reachable subgraph.
 *      Mode B (fallback):  scan source files (App.tsx, components/,
 *                          services/, build-plugins/, scripts/) for
 *                          string/template literals shaped like internal
 *                          paths ('/foo/bar' or `/foo/${slug}`). Approximate;
 *                          used only when dist/ is empty.
 *    Mode A is used automatically when dist/ has ≥ 10 HTML files. Force
 *    Mode B with --source-mode (faster local iteration).
 * 4. Diff: orphans = sitemapUrls \ linkedUrls.
 * 5. Output:
 *      - Stdout table (Sitemap | Total | Orphans | %).
 *      - Top N orphan example URLs per sitemap.
 *      - JSON report at data/orphan-pages-audit.json.
 *      - Baseline at data/orphan-pages-baseline.json (only if missing,
 *        unless --rebaseline).
 *
 * --------------------------------------------------------------------------
 * Caveats
 * --------------------------------------------------------------------------
 * - Mode B is approximate: dynamic href values built at runtime
 *   (e.g. `/${locale}/articles/${slug}`) may underestimate the linked set,
 *   inflating the orphan count. The ratchet baseline shipped from a Mode-B
 *   run is therefore only a stop-gap; once CI runs Mode A on a real dist/,
 *   regenerate via --rebaseline.
 * - Trailing slashes: both `/foo/` and `/foo` are normalised to the
 *   no-trailing-slash form on BOTH sides before set-diffing (so we never
 *   classify a page as orphan due to a slash mismatch).
 * - The `--gate=baseline` ratchet only makes sense in Mode A. The two modes
 *   measure fundamentally different things (graph reachability vs source-
 *   string membership), so cross-mode comparison is meaningless. Invoking
 *   the gate in Mode B exits 1 with a clear error.
 *
 * --------------------------------------------------------------------------
 * CLI flags
 * --------------------------------------------------------------------------
 *   --feature=<name>    Limit output to one sitemap (e.g. --feature=blog
 *                       matches sitemap-blog.xml).
 *   --limit=<n>         Examples per sitemap in stdout (default 20).
 *   --source-mode       Force Mode B even when dist/ is populated.
 *   --out=<path>        Override the JSON report path (default
 *                       data/orphan-pages-audit.json).
 *   --rebaseline        Overwrite data/orphan-pages-baseline.json from this
 *                       run. Use after a deliberate improvement.
 *   --gate=baseline     Compare current run to baseline; exit 1 if any
 *                       sitemap orphan count is HIGHER than baseline. Mode A
 *                       only.
 */

import { readdir, readFile, stat, writeFile, access } from 'node:fs/promises';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { writeAuditReport, relBaseline } from './lib/auditReport.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const DATA_DIR = join(ROOT, 'data');
const HOST = 'https://frontaliereticino.ch';

const argv = process.argv.slice(2);
const args = new Map();
for (const a of argv) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    args.set(k, v ?? true);
  }
}

const FEATURE_FILTER = typeof args.get('feature') === 'string' ? args.get('feature') : null;
const LIMIT = Number(args.get('limit') ?? 20);
const FORCE_SOURCE_MODE = args.has('source-mode');
const OUT_PATH = args.get('out')
  ? resolvePath(String(args.get('out')))
  : join(DATA_DIR, 'orphan-pages-audit.json');
const REBASELINE = args.has('rebaseline');
const GATE = args.get('gate'); // string | true | undefined
const GATE_BASELINE = GATE === 'baseline';
const BASELINE_PATH = join(DATA_DIR, 'orphan-pages-baseline.json');

function resolvePath(p) {
  return isAbsolute(p) ? p : join(ROOT, p);
}

// ---------------------------------------------------------------------------
// HTTPS fetch with timeout (no extra deps — node stdlib only).
// ---------------------------------------------------------------------------

function fetchText(url, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'orphan-pages-audit/1.0' } }, (res) => {
      // Follow one redirect if present.
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

// ---------------------------------------------------------------------------
// Sitemap parsing — extracts every <loc> via a non-validating regex. The
// live sitemaps are well-formed XML, so the regex is sufficient and avoids
// adding a parser dependency.
// ---------------------------------------------------------------------------

function extractLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

function urlToCanonicalPath(url) {
  try {
    const u = new URL(url);
    let p = u.pathname || '/';
    // Strip trailing slash from non-root paths.
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
  // Prefer LOCAL dist/sitemap*.xml when available — fetching live sitemaps
  // creates an apples-to-oranges comparison: BFS walks just-built dist/
  // while the sitemap reflects the LAST DEPLOY's data. When data refreshes
  // between deploys add/drop pages, the live sitemap names URLs the local
  // dist no longer emits, surfacing as phantom orphans (deploy-blocking
  // false positives). Only fall back to fetching live when dist/ is empty
  // (e.g. running this audit against the deployed site directly).
  const localIndexPath = join(DIST, 'sitemap.xml');
  let indexXml;
  let isLocal = false;
  try {
    await access(localIndexPath);
    indexXml = await readFile(localIndexPath, 'utf-8');
    isLocal = true;
    process.stderr.write(`[audit] Reading local sitemap index ${localIndexPath}\n`);
  } catch {
    const indexUrl = `${HOST}/sitemap.xml`;
    process.stderr.write(`[audit] Fetching index ${indexUrl}\n`);
    indexXml = await fetchText(indexUrl);
  }
  const childUrls = extractLocs(indexXml).filter((u) => /\.xml(\?|$)/i.test(u));

  if (childUrls.length === 0) {
    throw new Error('Sitemap index returned zero <loc> entries — refusing to continue.');
  }

  process.stderr.write(`[audit] Index lists ${childUrls.length} child sitemaps\n`);

  /** @type {Map<string, Set<string>>} */
  const sitemapsToUrls = new Map();
  /** @type {Map<string, string>} */
  const canonicalToOriginal = new Map();

  // Sequential to be polite to the host.
  for (const childUrl of childUrls) {
    const name = sitemapNameFromUrl(childUrl);
    let xml;
    if (isLocal) {
      const localChildPath = join(DIST, name);
      try {
        await access(localChildPath);
        xml = await readFile(localChildPath, 'utf-8');
        process.stderr.write(`[audit]   Reading local ${name} ...\n`);
      } catch {
        // Child not on disk — skip rather than fall back to live (mixing
        // local + live sitemaps would re-introduce the staleness gap).
        process.stderr.write(`[audit]   Skipping ${name} (not in local dist)\n`);
        continue;
      }
    } else {
      process.stderr.write(`[audit]   Fetching ${name} ...\n`);
      try {
        xml = await fetchText(childUrl);
      } catch (e) {
        throw new Error(`Failed to fetch child sitemap ${childUrl}: ${e.message}`);
      }
    }
    const locs = extractLocs(xml).filter((u) => !/\.xml(\?|$)/i.test(u)); // exclude nested sitemap entries
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
// File-walking helpers.
// ---------------------------------------------------------------------------

async function* walkFiles(dir, predicate) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Skip dot-prefixed dirs (debug artifacts, not deployed pages).
    if (entry.isDirectory() && entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full, predicate);
    } else if (entry.isFile() && predicate(full, entry.name)) {
      yield full;
    }
  }
}

async function distHasEnoughHtml(distRoot = DIST) {
  try {
    await access(distRoot);
  } catch {
    return false;
  }
  let count = 0;
  for await (const _ of walkFiles(distRoot, (_, name) => name.endsWith('.html'))) {
    count += 1;
    if (count >= 10) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Path normalisation — used both when extracting hrefs from HTML and when
// matching against sitemap canonical paths.
// ---------------------------------------------------------------------------

function normaliseInternalPath(href) {
  if (!href) return null;
  let h = href.trim();
  if (!h) return null;
  // Strip fragments and queries — the sitemap canonical paths don't carry them.
  const hash = h.indexOf('#');
  if (hash >= 0) h = h.slice(0, hash);
  const q = h.indexOf('?');
  if (q >= 0) h = h.slice(0, q);
  if (!h) return null;
  // Absolute URLs to the canonical host.
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
  // Bare leading-slash internal path.
  if (h.startsWith('/')) {
    // Reject protocol-relative ('//foo') and scheme-like prefixes.
    if (h.startsWith('//')) return null;
    let p = h;
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mode A: BFS reachability from `/` over dist/.
// ---------------------------------------------------------------------------

/**
 * Resolve a normalised internal path to a dist HTML file path.
 * Returns null if neither candidate exists.
 *   `/foo/bar` → dist/foo/bar/index.html OR dist/foo/bar.html
 *   `/`        → dist/index.html
 */
async function resolvePathToDistFile(distRoot, path) {
  if (path === '/' || path === '') {
    const indexFile = join(distRoot, 'index.html');
    try {
      await access(indexFile);
      return indexFile;
    } catch {
      return null;
    }
  }
  // Strip leading slash for join.
  const rel = path.replace(/^\/+/, '');
  const candidateA = join(distRoot, rel, 'index.html');
  try {
    await access(candidateA);
    return candidateA;
  } catch {
    /* fall through */
  }
  const candidateB = join(distRoot, `${rel}.html`);
  try {
    await access(candidateB);
    return candidateB;
  } catch {
    return null;
  }
}

const ROBOTS_NOINDEX_RE =
  /<meta\s+[^>]*name\s*=\s*["']robots["'][^>]*content\s*=\s*["'][^"']*\bnoindex\b[^"']*["'][^>]*>/i;

function htmlHasNoindex(html) {
  return ROBOTS_NOINDEX_RE.test(html);
}

/**
 * Extract every <a href="..."> from an HTML string. Deliberately ignores
 * <link rel="alternate"> and <link rel="canonical"> — Semrush-style BFS
 * reachability follows only <a> tags (those are the navigable graph).
 */
function extractAnchorHrefs(html) {
  const out = [];
  // Match <a ...> (NOT <link ...>) and capture its href value.
  const tagRe = /<a\b[^>]*\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const href = m[2] ?? m[3] ?? m[4];
    if (typeof href === 'string') out.push(href);
  }
  return out;
}

/**
 * BFS reachability from `/` across dist/.
 * Returns { linked, stats }:
 *   linked:        Set of normalised paths visited (i.e. files that exist
 *                  AND were reached via the link graph from `/`).
 *   stats.visited: linked.size
 *   stats.noindex: count of pages reached but not crawled-through
 *                  (their outgoing links were skipped)
 *   stats.dead:    count of frontier paths whose target file did not exist
 *                  in dist/ (i.e. dangling links — interesting for separate
 *                  diagnostics but not part of the reachable set)
 */
async function bfsReachableFromHome(distRoot) {
  const startFile = await resolvePathToDistFile(distRoot, '/');
  if (!startFile) {
    throw new Error(`BFS start node missing: ${join(distRoot, 'index.html')} does not exist.`);
  }

  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {Set<string>} */
  const enqueued = new Set();
  /** @type {string[]} */
  const frontier = ['/'];
  enqueued.add('/');

  let noindexCount = 0;
  let deadCount = 0;

  while (frontier.length > 0) {
    const current = frontier.shift();
    const file = await resolvePathToDistFile(distRoot, current);
    if (!file) {
      // Dangling internal link — counts as unreachable (nothing to crawl).
      deadCount += 1;
      continue;
    }
    let html;
    try {
      html = await readFile(file, 'utf8');
    } catch {
      deadCount += 1;
      continue;
    }
    // The page exists, so it IS reachable. Record it.
    visited.add(current);
    // If noindex, treat as a bridge: don't extract outgoing links (Semrush
    // wouldn't propagate equity through a noindex page).
    if (htmlHasNoindex(html)) {
      noindexCount += 1;
      continue;
    }
    const hrefs = extractAnchorHrefs(html);
    for (const href of hrefs) {
      const p = normaliseInternalPath(href);
      if (!p) continue;
      if (enqueued.has(p)) continue;
      enqueued.add(p);
      frontier.push(p);
    }
  }

  return {
    linked: visited,
    stats: { visited: visited.size, noindex: noindexCount, dead: deadCount },
  };
}

// ---------------------------------------------------------------------------
// Mode B: source-tree scan for path-shaped string/template literals.
// (Unchanged from prior implementation — kept as a fallback when no dist/.)
// ---------------------------------------------------------------------------

const SOURCE_ROOTS = ['App.tsx', 'components', 'services', 'build-plugins', 'scripts'];
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mjs', '.js', '.jsx', '.cjs']);

function looksLikeInternalSlugLiteral(s) {
  if (!s.startsWith('/')) return false;
  if (s.startsWith('//')) return false;
  if (/^\/(?:Users|home|tmp|var|opt|usr|etc)(?:\/|$)/.test(s)) return false;
  if (s.includes('\\')) return false;
  if (!/^\/[A-Za-z0-9._\-/${}]*$/.test(s)) return false;
  if (s.length > 200) return false;
  return true;
}

async function collectLinkedUrlsModeB() {
  /** @type {Set<string>} */
  const linked = new Set();
  /** @type {Set<string>} */
  const linkedPrefixes = new Set();

  const stringRe = /(['"`])((?:\\\1|(?!\1).)*?)\1/g; // single, double, backtick
  for (const root of SOURCE_ROOTS) {
    const full = join(ROOT, root);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isFile()) {
      await scanSourceFile(full, linked, linkedPrefixes, stringRe);
    } else if (s.isDirectory()) {
      for await (const file of walkFiles(full, (_, name) => {
        const dot = name.lastIndexOf('.');
        if (dot < 0) return false;
        return SOURCE_EXTS.has(name.slice(dot));
      })) {
        await scanSourceFile(file, linked, linkedPrefixes, stringRe);
      }
    }
  }

  return { linked, linkedPrefixes };
}

async function scanSourceFile(file, linked, linkedPrefixes, stringRe) {
  let src;
  try {
    src = await readFile(file, 'utf8');
  } catch {
    return;
  }
  let m;
  stringRe.lastIndex = 0;
  while ((m = stringRe.exec(src)) !== null) {
    const lit = m[2];
    if (!lit) continue;
    if (!looksLikeInternalSlugLiteral(lit)) continue;

    const dollar = lit.indexOf('${');
    if (dollar < 0) {
      let p = lit;
      if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
      linked.add(p);
    } else {
      const prefix = lit.slice(0, dollar);
      let pre = prefix;
      if (pre.length > 1 && pre.endsWith('/')) pre = pre.slice(0, -1);
      const slashCount = (pre.match(/\//g) || []).length;
      if (slashCount >= 2) {
        linkedPrefixes.add(pre);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Orphan computation.
// ---------------------------------------------------------------------------

function isLinked(path, linked, linkedPrefixes) {
  if (linked.has(path)) return true;
  if (!linkedPrefixes || linkedPrefixes.size === 0) return false;
  for (const pre of linkedPrefixes) {
    if (path === pre) return true;
    if (path.startsWith(pre + '/')) return true;
  }
  return false;
}

function computeOrphans(sitemapsToUrls, linked, linkedPrefixes, canonicalToOriginal) {
  /** @type {Record<string, { total: number; orphans: number; examples: string[]; orphansList: string[] }>} */
  const perSitemap = {};
  let totalSitemapUrls = 0;
  let totalOrphans = 0;

  const sortedSitemaps = [...sitemapsToUrls.keys()].sort();
  for (const name of sortedSitemaps) {
    const urls = sitemapsToUrls.get(name);
    const orphans = [];
    for (const p of urls) {
      if (!isLinked(p, linked, linkedPrefixes)) {
        orphans.push(p);
      }
    }
    perSitemap[name] = {
      total: urls.size,
      orphans: orphans.length,
      examples: orphans.slice(0, LIMIT).map((p) => canonicalToOriginal.get(p) || p),
      // Internal field used for regression diff; not retained in baseline copy
      // because the example slice is already representative.
      orphansList: orphans,
    };
    totalSitemapUrls += urls.size;
    totalOrphans += orphans.length;
  }

  return { perSitemap, totalSitemapUrls, totalOrphans };
}

// ---------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------

function printTable(report, mode) {
  const lines = [];
  lines.push(`Mode: ${mode}`);
  lines.push('');
  const header = `${'Sitemap'.padEnd(40)} ${'Total'.padStart(7)} ${'Orphans'.padStart(8)} ${'%'.padStart(7)}`;
  lines.push(header);
  lines.push('-'.repeat(header.length));

  const rows = Object.entries(report.perSitemap).filter(([name]) => {
    if (!FEATURE_FILTER) return true;
    return name.includes(String(FEATURE_FILTER));
  });

  for (const [name, row] of rows) {
    const pct = row.total === 0 ? 0 : (row.orphans / row.total) * 100;
    lines.push(
      `${name.padEnd(40)} ${String(row.total).padStart(7)} ${String(row.orphans).padStart(8)} ${pct.toFixed(1).padStart(6)}%`,
    );
  }
  lines.push('-'.repeat(header.length));
  const totalPct = report.totalSitemapUrls === 0 ? 0 : (report.totalOrphans / report.totalSitemapUrls) * 100;
  lines.push(
    `${'TOTAL'.padEnd(40)} ${String(report.totalSitemapUrls).padStart(7)} ${String(report.totalOrphans).padStart(8)} ${totalPct.toFixed(1).padStart(6)}%`,
  );

  for (const [name, row] of rows) {
    if (row.orphans === 0) continue;
    lines.push('');
    lines.push(`# ${name} — top ${Math.min(LIMIT, row.examples.length)} orphan examples`);
    for (const ex of row.examples) lines.push(`  ${ex}`);
  }

  process.stdout.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Baseline / ratchet plumbing.
// ---------------------------------------------------------------------------

async function readBaseline() {
  try {
    const txt = await readFile(BASELINE_PATH, 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/**
 * Compare current run against baseline. Returns:
 *   { regressed: bool, regressions: Array<{ sitemap, prev, current, newOrphans }> }
 * Where `newOrphans` is up to 10 paths present in `current` but not in
 * `baseline` for that sitemap (best-effort: when baseline doesn't carry the
 * full orphan list — which it shouldn't, to keep file size sane — we fall
 * back to listing the current-run examples).
 */
function compareAgainstBaseline(current, baseline, perSitemapInMemory) {
  if (!baseline) return { regressed: false, regressions: [] };
  const regressions = [];
  for (const [name, row] of Object.entries(current.perSitemap)) {
    const prev = baseline.perSitemap?.[name];
    if (!prev) continue;
    if (row.orphans > prev.orphans) {
      const baselineExamplesSet = new Set(prev.examples || []);
      // Prefer the in-memory full list (orphansList) over the capped examples
      // so the CI log carries every offending URL — diagnosing without the
      // dist artifact is non-negotiable.
      const fullList = perSitemapInMemory?.[name]?.orphansList || row.examples || [];
      const newOrphans = fullList.filter((u) => !baselineExamplesSet.has(u));
      const surfaced = newOrphans.length > 0 ? newOrphans : fullList;
      regressions.push({ sitemap: name, prev: prev.orphans, current: row.orphans, newOrphans: surfaced });
    }
  }
  return { regressed: regressions.length > 0, regressions };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  // Determine mode FIRST so we can fail fast on gate-vs-mode mismatch before
  // any network traffic.
  const useModeA = !FORCE_SOURCE_MODE && (await distHasEnoughHtml());
  const mode = useModeA ? 'html' : 'source';

  if (GATE_BASELINE && !useModeA) {
    process.stderr.write(
      '[audit] FATAL: --gate=baseline requires Mode A (built dist/). Run `npm run build` first, then re-run.\n',
    );
    process.exit(1);
  }

  const { sitemapsToUrls, canonicalToOriginal } = await fetchAllSitemaps();
  process.stderr.write(`[audit] Using Mode ${useModeA ? 'A (BFS from /)' : 'B (source scan)'}\n`);

  let linked;
  let linkedPrefixes;
  if (useModeA) {
    const r = await bfsReachableFromHome(DIST);
    linked = r.linked;
    linkedPrefixes = new Set();
    process.stderr.write(
      `[audit] BFS visited ${r.stats.visited} reachable pages (skipped ${r.stats.noindex} noindex bridges, ${r.stats.dead} dead-ends)\n`,
    );
  } else {
    const r = await collectLinkedUrlsModeB();
    linked = r.linked;
    linkedPrefixes = r.linkedPrefixes;
    process.stderr.write(
      `[audit] Linked set: ${linked.size} exact paths, ${linkedPrefixes.size} dynamic prefixes\n`,
    );
  }

  const report = computeOrphans(sitemapsToUrls, linked, linkedPrefixes, canonicalToOriginal);

  // Strip the heavy orphansList field before serialising so the JSON stays
  // small. examples[] is already capped at LIMIT (default 20).
  const perSitemapForOutput = {};
  for (const [name, row] of Object.entries(report.perSitemap)) {
    perSitemapForOutput[name] = {
      total: row.total,
      orphans: row.orphans,
      examples: row.examples,
    };
  }

  const json = {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode,
    totalSitemapUrls: report.totalSitemapUrls,
    totalOrphans: report.totalOrphans,
    perSitemap: perSitemapForOutput,
  };

  await writeFile(OUT_PATH, JSON.stringify(json, null, 2) + '\n', 'utf8');
  process.stderr.write(`[audit] Wrote report → ${relative(ROOT, OUT_PATH)}\n`);

  // Build the structured offenders list once — used by every exit branch below.
  const _flatOrphans = [];
  const _byFeatureForReport = {};
  for (const [name, row] of Object.entries(report.perSitemap)) {
    const list = row.orphansList || row.examples || [];
    _byFeatureForReport[name] = row.orphans;
    for (const u of list) {
      _flatOrphans.push({
        path: canonicalToOriginal.get(u) || u,
        feature: name,
        metric: 1,
        ratio: null,
        sitemap: name,
      });
    }
  }
  const _writeOrphanReport = (passed, baselineDelta) => writeAuditReport({
    audit: 'orphan-sitemap-pages',
    passed,
    threshold: { metric: 'count', value: 0, comparator: '<=baseline' },
    baselineFile: relBaseline(BASELINE_PATH),
    baselineDelta,
    offenders: _flatOrphans,
    byFeature: _byFeatureForReport,
    extra: { mode, totalSitemapUrls: report.totalSitemapUrls },
  });

  // Baseline read + gate-check / rebaseline handling.
  const existing = await readBaseline();

  if (GATE_BASELINE) {
    if (!existing) {
      process.stderr.write('[audit] FATAL: --gate=baseline invoked but no baseline found.\n');
      process.exit(1);
    }
    const cmp = compareAgainstBaseline(json, existing, report.perSitemap);
    if (cmp.regressed) {
      const lines = [];
      lines.push('[gate] REGRESSION — orphan-pages-in-sitemaps');
      for (const r of cmp.regressions) {
        lines.push(
          `  ${r.sitemap}: baseline=${r.prev} → current=${r.current} (+${r.current - r.prev})`,
        );
        for (const u of r.newOrphans) lines.push(`    - ${u}`);
      }
      process.stderr.write(lines.join('\n') + '\n');
      printTable(report, mode);
      const prevTotal = cmp.regressions.reduce((s, r) => s + r.prev, 0);
      const currTotal = cmp.regressions.reduce((s, r) => s + r.current, 0);
      await _writeOrphanReport(false, { before: prevTotal, after: currTotal, regression: currTotal - prevTotal });
      process.exit(1);
    }
    process.stderr.write('[gate] OK — no regression\n');
    printTable(report, mode);
    await _writeOrphanReport(true, null);
    return;
  }

  if (REBASELINE || !existing) {
    await writeFile(BASELINE_PATH, JSON.stringify(json, null, 2) + '\n', 'utf8');
    process.stderr.write(
      `[audit] ${REBASELINE ? 'Rebaselined' : 'Seeded baseline'} → ${relative(ROOT, BASELINE_PATH)}\n`,
    );
  }

  printTable(report, mode);
  await _writeOrphanReport(report.totalOrphans === 0, null);
}

// Only run main() when invoked directly as a script (not when imported by
// tests via dynamic import).
const invokedDirectly = (() => {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1] ? process.argv[1] : '';
    return argv1 && (argv1 === thisFile || argv1.endsWith('audit-orphan-pages-in-sitemaps.mjs'));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[audit] FATAL: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Internal exports for tests. (Node ignores these when invoked as a script;
// they're only reachable via dynamic import().)
// ---------------------------------------------------------------------------

export const __test = {
  bfsReachableFromHome,
  extractAnchorHrefs,
  htmlHasNoindex,
  normaliseInternalPath,
  resolvePathToDistFile,
  compareAgainstBaseline,
  distHasEnoughHtml,
};
