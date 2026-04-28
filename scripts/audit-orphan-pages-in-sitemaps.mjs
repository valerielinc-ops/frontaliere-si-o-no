#!/usr/bin/env node
/**
 * audit-orphan-pages-in-sitemaps.mjs
 *
 * Detect "orphaned pages in sitemaps" — URLs listed in any of the live
 * sitemap-*.xml files but with NO internal link pointing to them anywhere
 * in the site graph. Semrush flags these (currently 4,936 on
 * frontaliereticino.ch) because they consume crawl budget without site-
 * structure support and tend to rank worse.
 *
 * Phase 1 deliverable: this is a REPORTING script. It always exits 0 on
 * orphans (the regression gate comes in Phase 3 via a `--gate=baseline`
 * flag — see `compareAgainstBaseline()` below).
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
 *      Mode A (preferred): scan dist/**\/*.html for <a href="…">
 *      Mode B (fallback):  scan source files (App.tsx, components/,
 *                          services/, build-plugins/, scripts/) for
 *                          string/template literals shaped like internal
 *                          paths ('/foo/bar' or `/foo/${slug}`).
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
 *   inflating the orphan count. The ratchet baseline shipped from this run
 *   is therefore a Mode-B baseline; once CI runs Mode A on a real dist/,
 *   regenerate via --rebaseline.
 * - Trailing slashes: both `/foo/` and `/foo` are normalised to the
 *   no-trailing-slash form on BOTH sides before set-diffing (so we never
 *   classify a page as orphan due to a slash mismatch).
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
 */

import { readdir, readFile, stat, writeFile, access } from 'node:fs/promises';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

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
  const indexUrl = `${HOST}/sitemap.xml`;
  process.stderr.write(`[audit] Fetching index ${indexUrl}\n`);
  const indexXml = await fetchText(indexUrl);
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
    process.stderr.write(`[audit]   Fetching ${name} ...\n`);
    let xml;
    try {
      xml = await fetchText(childUrl);
    } catch (e) {
      throw new Error(`Failed to fetch child sitemap ${childUrl}: ${e.message}`);
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
// Mode A: dist/**\/*.html scan.
// ---------------------------------------------------------------------------

async function* walkFiles(dir, predicate) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full, predicate);
    } else if (entry.isFile() && predicate(full, entry.name)) {
      yield full;
    }
  }
}

async function distHasEnoughHtml() {
  try {
    await access(DIST);
  } catch {
    return false;
  }
  let count = 0;
  for await (const _ of walkFiles(DIST, (_, name) => name.endsWith('.html'))) {
    count += 1;
    if (count >= 10) return true;
  }
  return false;
}

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
    let p = h;
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  }
  return null;
}

async function collectLinkedUrlsModeA() {
  /** @type {Set<string>} */
  const linked = new Set();
  const hrefRe = /href\s*=\s*"([^"]+)"|href\s*=\s*'([^']+)'/gi;
  for await (const file of walkFiles(DIST, (_, name) => name.endsWith('.html'))) {
    let html;
    try {
      html = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    let m;
    while ((m = hrefRe.exec(html)) !== null) {
      const href = m[1] ?? m[2];
      const p = normaliseInternalPath(href);
      if (p) linked.add(p);
    }
    hrefRe.lastIndex = 0;
  }
  return linked;
}

// ---------------------------------------------------------------------------
// Mode B: source-tree scan for path-shaped string/template literals.
// ---------------------------------------------------------------------------

const SOURCE_ROOTS = ['App.tsx', 'components', 'services', 'build-plugins', 'scripts'];
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mjs', '.js', '.jsx', '.cjs']);

function looksLikeInternalSlugLiteral(s) {
  // Must start with `/` and not be a protocol-relative URL or filesystem path
  // marker like `/* */` (which won't appear inside a string anyway).
  if (!s.startsWith('/')) return false;
  if (s.startsWith('//')) return false;
  // Reject obvious non-URL paths.
  if (/^\/(?:Users|home|tmp|var|opt|usr|etc)(?:\/|$)/.test(s)) return false;
  // Reject regex-like or escape-heavy literals.
  if (s.includes('\\')) return false;
  // Allowed slug characters: letters, digits, hyphen, underscore, slash, dot,
  // plus `${...}` template placeholders (which we'll fold to a wildcard match
  // — but for the purposes of computing "is this path internally linked?"
  // we keep the literal prefix).
  if (!/^\/[A-Za-z0-9._\-/${}]*$/.test(s)) return false;
  // Length sanity — sitemap paths are realistically 1..200 chars.
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
      // Pure literal path: register both the form and its trailing-slash-stripped form.
      let p = lit;
      if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
      linked.add(p);
    } else {
      // Template path with at least one ${...} placeholder. Take the prefix
      // up to the first placeholder as a prefix-match key. This treats any
      // sitemap path beginning with that prefix (and at least one extra
      // segment) as "potentially linked dynamically".
      const prefix = lit.slice(0, dollar);
      // Strip trailing slash to keep the prefix consistent with linked-path normalisation.
      let pre = prefix;
      if (pre.length > 1 && pre.endsWith('/')) pre = pre.slice(0, -1);
      // Require the prefix to contain at least one slash beyond the leading one
      // — `/${slug}` alone is too generic and would match every URL on the site.
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
    // path is "linked dynamically" if it starts with `${pre}/` AND has at
    // least one more segment beyond the prefix.
    if (path === pre) return true;
    if (path.startsWith(pre + '/')) return true;
  }
  return false;
}

function computeOrphans(sitemapsToUrls, linked, linkedPrefixes, canonicalToOriginal) {
  /** @type {Record<string, { total: number; orphans: number; examples: string[] }>} */
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

  // Examples per sitemap (only those with ≥1 orphan).
  for (const [name, row] of rows) {
    if (row.orphans === 0) continue;
    lines.push('');
    lines.push(`# ${name} — top ${Math.min(LIMIT, row.examples.length)} orphan examples`);
    for (const ex of row.examples) lines.push(`  ${ex}`);
  }

  process.stdout.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Baseline / ratchet plumbing — wired but not enforced (Phase 3).
// ---------------------------------------------------------------------------

async function readBaseline() {
  try {
    const txt = await readFile(BASELINE_PATH, 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

// Phase 3 will wire `--gate=baseline` to call this. Returning a result
// object now keeps the structure stable.
// eslint-disable-next-line no-unused-vars
function compareAgainstBaseline(current, baseline) {
  if (!baseline) return { regressed: false, regressions: [] };
  const regressions = [];
  for (const [name, row] of Object.entries(current.perSitemap)) {
    const prev = baseline.perSitemap?.[name];
    if (!prev) continue;
    if (row.orphans > prev.orphans) {
      regressions.push({ sitemap: name, prev: prev.orphans, current: row.orphans });
    }
  }
  return { regressed: regressions.length > 0, regressions };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const { sitemapsToUrls, canonicalToOriginal } = await fetchAllSitemaps();

  const useModeA = !FORCE_SOURCE_MODE && (await distHasEnoughHtml());
  const mode = useModeA ? 'html' : 'source';
  process.stderr.write(`[audit] Using Mode ${useModeA ? 'A (dist HTML scan)' : 'B (source scan)'}\n`);

  let linked;
  let linkedPrefixes;
  if (useModeA) {
    linked = await collectLinkedUrlsModeA();
    linkedPrefixes = new Set();
  } else {
    const r = await collectLinkedUrlsModeB();
    linked = r.linked;
    linkedPrefixes = r.linkedPrefixes;
  }

  process.stderr.write(`[audit] Linked set: ${linked.size} exact paths, ${linkedPrefixes.size} dynamic prefixes\n`);

  const report = computeOrphans(sitemapsToUrls, linked, linkedPrefixes, canonicalToOriginal);

  const json = {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode,
    totalSitemapUrls: report.totalSitemapUrls,
    totalOrphans: report.totalOrphans,
    perSitemap: report.perSitemap,
  };

  await writeFile(OUT_PATH, JSON.stringify(json, null, 2) + '\n', 'utf8');
  process.stderr.write(`[audit] Wrote report → ${relative(ROOT, OUT_PATH)}\n`);

  // Baseline handling.
  const existing = await readBaseline();
  if (REBASELINE || !existing) {
    await writeFile(BASELINE_PATH, JSON.stringify(json, null, 2) + '\n', 'utf8');
    process.stderr.write(
      `[audit] ${REBASELINE ? 'Rebaselined' : 'Seeded baseline'} → ${relative(ROOT, BASELINE_PATH)}\n`,
    );
  }

  printTable(report, mode);
}

main().catch((err) => {
  process.stderr.write(`[audit] FATAL: ${err.stack || err.message}\n`);
  process.exit(1);
});
