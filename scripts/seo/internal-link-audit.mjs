#!/usr/bin/env node
/**
 * internal-link-audit.mjs — Workstream D.1
 *
 * Crawls every HTML file in `dist/`, builds a directed link graph
 * (node = URL path, edge = `<a href>` between them), computes inbound /
 * outbound counts and iterative PageRank, and flags:
 *   - orphan pages (0 inbound links)
 *   - over-linked pages (appear in site-wide footer / mega nav)
 *   - top-20 "under-linked" pages (high PageRank candidates with few
 *     inbound links — ideal internal-link targets)
 *
 * Output (idempotent per date):
 *   - reports/internal-link-audit-YYYY-MM-DD.json   (machine-readable)
 *   - reports/internal-link-audit-YYYY-MM-DD.md     (human summary)
 *
 * Safe to run locally. Exits 0 with a stub report when `dist/` is empty
 * or missing (so CI / pre-build invocations do not fail).
 *
 * Usage:
 *   node scripts/seo/internal-link-audit.mjs
 *   node scripts/seo/internal-link-audit.mjs --dist=./dist --out=./reports
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const CANONICAL_HOST = 'frontaliereticino.ch';
const PAGERANK_ITERATIONS = 40;
const PAGERANK_DAMPING = 0.85;
const OVERLINK_PERCENTILE = 0.99; // top 1% inbound-count pages treated as "site-wide"
const UNDERLINK_TOP = 20;

function parseArgs(argv) {
  const args = { dist: join(ROOT, 'dist'), out: join(ROOT, 'reports') };
  for (const a of argv) {
    if (a.startsWith('--dist=')) args.dist = resolve(a.slice(7));
    else if (a.startsWith('--out=')) args.out = resolve(a.slice(6));
  }
  return args;
}

function isoDate(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function walkHtml(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        // Skip asset-only subdirs (safe to keep, but pointless).
        if (e.name === 'assets') continue;
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.html')) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Turn a file-system path into a canonical site URL path.
 * `/foo/bar/index.html` → `/foo/bar/`
 * `/foo/bar.html`       → `/foo/bar.html` (only dist root /index.html → `/`)
 */
function fileToUrlPath(filePath, distRoot) {
  const rel = '/' + relative(distRoot, filePath).split('\\').join('/');
  if (rel === '/index.html') return '/';
  if (rel.endsWith('/index.html')) return rel.slice(0, -'index.html'.length);
  return rel;
}

/**
 * Normalize a link `href` to the same URL-path space as `fileToUrlPath`.
 * Returns null for off-site or non-HTTP(S) links.
 */
function normalizeHref(href, fromUrlPath) {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#')) return null;
  if (trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) return null;
  if (trimmed.startsWith('javascript:')) return null;
  if (/^(data|blob):/i.test(trimmed)) return null;

  // Absolute URL
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      if (!u.hostname.endsWith(CANONICAL_HOST)) return null;
      return cleanPath(u.pathname);
    } catch {
      return null;
    }
  }

  // Protocol-relative
  if (trimmed.startsWith('//')) {
    try {
      const u = new URL('https:' + trimmed);
      if (!u.hostname.endsWith(CANONICAL_HOST)) return null;
      return cleanPath(u.pathname);
    } catch {
      return null;
    }
  }

  // Relative / root-relative
  try {
    const base = `https://${CANONICAL_HOST}${fromUrlPath}`;
    const u = new URL(trimmed, base);
    if (!u.hostname.endsWith(CANONICAL_HOST)) return null;
    return cleanPath(u.pathname);
  } catch {
    return null;
  }
}

function cleanPath(p) {
  if (!p) return '/';
  // Drop query strings are already stripped by URL API; drop #hash via URL pathname.
  if (p === '') return '/';
  // Normalize /foo/index.html -> /foo/
  if (p.endsWith('/index.html')) return p.slice(0, -'index.html'.length);
  return p;
}

/**
 * Extract internal <a href> targets from HTML.
 * Tolerant regex — good enough for an audit pass without pulling in jsdom.
 */
function extractLinks(html) {
  const hrefs = [];
  const re = /<a\b[^>]*\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    hrefs.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return hrefs;
}

function computePagerank(nodes, outbound) {
  const N = nodes.length;
  if (N === 0) return {};
  const index = new Map(nodes.map((n, i) => [n, i]));
  let rank = new Array(N).fill(1 / N);
  const out = nodes.map((n) => (outbound.get(n) || []).map((t) => index.get(t)).filter((v) => v !== undefined));
  const outDeg = out.map((arr) => arr.length);
  const base = (1 - PAGERANK_DAMPING) / N;

  for (let iter = 0; iter < PAGERANK_ITERATIONS; iter++) {
    const next = new Array(N).fill(base);
    let dangling = 0;
    for (let i = 0; i < N; i++) {
      if (outDeg[i] === 0) dangling += rank[i];
    }
    const danglingShare = (PAGERANK_DAMPING * dangling) / N;
    for (let i = 0; i < N; i++) next[i] += danglingShare;
    for (let i = 0; i < N; i++) {
      if (outDeg[i] === 0) continue;
      const share = (PAGERANK_DAMPING * rank[i]) / outDeg[i];
      for (const j of out[i]) next[j] += share;
    }
    rank = next;
  }
  const result = {};
  nodes.forEach((n, i) => {
    result[n] = rank[i];
  });
  return result;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function buildSummary(report) {
  const lines = [];
  lines.push(`# Internal Link Audit — ${report.date}`);
  lines.push('');
  lines.push(`- Pages crawled: **${report.totals.pages}**`);
  lines.push(`- Internal links: **${report.totals.edges}**`);
  lines.push(`- Unique targets: **${report.totals.uniqueTargets}**`);
  lines.push(`- Orphan pages (0 inbound): **${report.orphans.length}**`);
  lines.push(`- Over-linked pages (>=p${Math.round(OVERLINK_PERCENTILE * 100)} inbound): **${report.overLinked.length}**`);
  lines.push('');
  lines.push('## Top 20 under-linked pages (high PageRank / low inbound)');
  lines.push('');
  if (report.underLinked.length === 0) {
    lines.push('_No under-linked pages detected._');
  } else {
    lines.push('| # | URL | PageRank | Inbound | Outbound |');
    lines.push('|---|-----|---------:|--------:|---------:|');
    report.underLinked.forEach((p, i) => {
      lines.push(`| ${i + 1} | \`${p.url}\` | ${p.pagerank.toExponential(3)} | ${p.inbound} | ${p.outbound} |`);
    });
  }
  lines.push('');
  lines.push('## Orphan pages (first 30)');
  lines.push('');
  if (report.orphans.length === 0) {
    lines.push('_No orphan pages detected._');
  } else {
    report.orphans.slice(0, 30).forEach((u) => lines.push(`- \`${u}\``));
    if (report.orphans.length > 30) lines.push(`- _…and ${report.orphans.length - 30} more_`);
  }
  lines.push('');
  lines.push('## Over-linked pages (site-wide links)');
  lines.push('');
  if (report.overLinked.length === 0) {
    lines.push('_No over-linked pages detected._');
  } else {
    report.overLinked.slice(0, 20).forEach((p) => lines.push(`- \`${p.url}\` — ${p.inbound} inbound`));
  }
  lines.push('');
  return lines.join('\n');
}

function writeStubReport(args, reason) {
  mkdirSync(args.out, { recursive: true });
  const today = isoDate();
  const stub = {
    version: 1,
    date: today,
    generatedAt: new Date().toISOString(),
    distRoot: args.dist,
    reason,
    totals: { pages: 0, edges: 0, uniqueTargets: 0 },
    pages: {},
    orphans: [],
    overLinked: [],
    underLinked: [],
  };
  writeFileSync(join(args.out, `internal-link-audit-${today}.json`), JSON.stringify(stub, null, 2));
  writeFileSync(join(args.out, `internal-link-audit-${today}.md`), buildSummary(stub));
  console.log(`[internal-link-audit] ${reason} — wrote stub to ${args.out}/internal-link-audit-${today}.json`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dist)) {
    writeStubReport(args, `dist-missing (${args.dist})`);
    return;
  }
  const files = walkHtml(args.dist);
  if (files.length === 0) {
    writeStubReport(args, 'dist-empty');
    return;
  }

  const inbound = new Map();   // url → count
  const outbound = new Map();  // url → Array<url>
  const outboundCount = new Map();
  const allPages = new Set();

  for (const f of files) {
    const urlPath = fileToUrlPath(f, args.dist);
    allPages.add(urlPath);
    if (!inbound.has(urlPath)) inbound.set(urlPath, 0);
    let html;
    try {
      html = readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    const links = extractLinks(html);
    const resolvedOut = [];
    const seenOnPage = new Set();
    for (const href of links) {
      const target = normalizeHref(href, urlPath);
      if (!target) continue;
      if (target === urlPath) continue; // self-link — ignore
      // Only count one edge per (from, to) pair — avoids nav duplication skew.
      const key = `${urlPath}→${target}`;
      if (seenOnPage.has(key)) continue;
      seenOnPage.add(key);
      resolvedOut.push(target);
    }
    outbound.set(urlPath, resolvedOut);
    outboundCount.set(urlPath, resolvedOut.length);
  }

  // Accumulate inbound counts (only for targets that exist in dist).
  let edgeCount = 0;
  const uniqueTargets = new Set();
  for (const [, targets] of outbound) {
    for (const t of targets) {
      uniqueTargets.add(t);
      if (allPages.has(t)) {
        inbound.set(t, (inbound.get(t) || 0) + 1);
        edgeCount++;
      }
    }
  }

  const nodes = Array.from(allPages).sort();
  const pagerank = computePagerank(nodes, outbound);

  // Orphans = pages with 0 inbound, excluding the homepage (by definition a root).
  const orphans = nodes
    .filter((n) => n !== '/' && (inbound.get(n) || 0) === 0)
    .sort();

  // Over-linked: inbound count at or above 99th percentile (site-wide nav/footer).
  const inboundSorted = nodes.map((n) => inbound.get(n) || 0).sort((a, b) => a - b);
  const overLinkThreshold = percentile(inboundSorted, OVERLINK_PERCENTILE);
  const overLinked = nodes
    .filter((n) => (inbound.get(n) || 0) >= overLinkThreshold && (inbound.get(n) || 0) > 0)
    .map((n) => ({ url: n, inbound: inbound.get(n) || 0, outbound: outboundCount.get(n) || 0, pagerank: pagerank[n] || 0 }))
    .sort((a, b) => b.inbound - a.inbound);

  // Under-linked: rank pages by PageRank desc, pick those with inbound < median.
  const inboundMedian = percentile(inboundSorted, 0.5) || 1;
  const underLinked = nodes
    .map((n) => ({ url: n, inbound: inbound.get(n) || 0, outbound: outboundCount.get(n) || 0, pagerank: pagerank[n] || 0 }))
    .filter((p) => p.inbound <= inboundMedian)
    .sort((a, b) => b.pagerank - a.pagerank)
    .slice(0, UNDERLINK_TOP);

  const pages = {};
  for (const n of nodes) {
    pages[n] = {
      inbound: inbound.get(n) || 0,
      outbound: outboundCount.get(n) || 0,
      pagerank: pagerank[n] || 0,
    };
  }

  mkdirSync(args.out, { recursive: true });
  const today = isoDate();
  const report = {
    version: 1,
    date: today,
    generatedAt: new Date().toISOString(),
    distRoot: args.dist,
    config: {
      pagerankIterations: PAGERANK_ITERATIONS,
      pagerankDamping: PAGERANK_DAMPING,
      overlinkPercentile: OVERLINK_PERCENTILE,
      overlinkThreshold: overLinkThreshold,
      inboundMedian,
    },
    totals: {
      pages: nodes.length,
      edges: edgeCount,
      uniqueTargets: uniqueTargets.size,
    },
    pages,
    orphans,
    overLinked,
    underLinked,
  };

  const jsonPath = join(args.out, `internal-link-audit-${today}.json`);
  const mdPath = join(args.out, `internal-link-audit-${today}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, buildSummary(report));

  console.log(`[internal-link-audit] ${nodes.length} pages, ${edgeCount} edges → ${jsonPath}`);
  console.log(`[internal-link-audit] orphans=${orphans.length} overLinked=${overLinked.length} underLinked=${underLinked.length}`);
}

// Only execute main() when invoked as a script — keeps utilities importable
// from tests without side effects.
const invokedDirectly = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('internal-link-audit.mjs');
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    // Fail soft so a missing dist or malformed HTML never breaks upstream pipelines.
    console.error('[internal-link-audit] fatal:', err);
    try {
      const args = parseArgs(process.argv.slice(2));
      writeStubReport(args, `fatal: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      /* last-resort: silent */
    }
    process.exit(0);
  }
}

export {
  extractLinks,
  normalizeHref,
  fileToUrlPath,
  computePagerank,
};
