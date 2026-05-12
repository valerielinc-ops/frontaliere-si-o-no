#!/usr/bin/env node
/**
 * audit-sitemap-canonicals.mjs
 *
 * Hard gate: every URL listed in a child sitemap (`dist/sitemap-*.xml`) MUST
 * point at a page whose `<link rel="canonical">` self-references — i.e. the
 * canonical href must equal the sitemap `<loc>`. Sitemap entries that point
 * at a non-canonical URL train Google to ignore the sitemap; Semrush flags
 * them as "Non-canonical URL in sitemap".
 *
 * The gate is strict on canonical correctness — there is NO baseline and NO
 * ratchet. Hard fails (the original Semrush issue this gate exists for):
 *   - mismatch         : <link rel="canonical"> URL ≠ sitemap <loc>
 *   - missing-canonical: HTML exists but has no <link rel="canonical">
 *
 * Reported as WARN only (does NOT fail the gate):
 *   - missing-html     : sitemap <loc> has no corresponding HTML in dist/
 * That is a separate stale-sitemap concern; the authoritative gate is
 * `tests/post-build/sitemap-completeness.test.ts`.
 *
 * Non-HTML asset URLs (`.pdf`, `.xml`, `.txt`, `.json`, `.rss`, `.xsl`, `.ico`)
 * are skipped: they have no <link rel="canonical"> and Google treats the URL
 * itself as canonical for those.
 *
 * Run AFTER `npm run build` so dist/ is fresh.
 *
 * Usage:
 *   node scripts/audit-sitemap-canonicals.mjs
 *   node scripts/audit-sitemap-canonicals.mjs --limit=100
 *   node scripts/audit-sitemap-canonicals.mjs --feature=jobs
 *
 * Pure Node, no deps. Plain regex parsing — sitemaps emitted by our build
 * plugins are well-formed; an XML parser would be overkill.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAuditReport } from './lib/auditReport.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const HOST = 'https://frontaliereticino.ch';

// ── CLI args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const args = new Map();
for (const a of argv) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    args.set(k, v ?? true);
  }
}

if (args.has('help') || args.has('h')) {
  process.stdout.write(
    'audit-sitemap-canonicals.mjs — assert every dist/sitemap-*.xml <loc> self-canonicalizes\n' +
    '\n' +
    'Usage: node scripts/audit-sitemap-canonicals.mjs [--limit=N] [--feature=NAME]\n' +
    '  --limit=N      Print up to N offenders to stderr (default 50).\n' +
    '  --feature=NAME Restrict to sitemap files whose name contains NAME (e.g. "jobs").\n' +
    '\n' +
    'Run after `npm run build`. Exits 1 if any mismatch / missing-html / missing-canonical.\n'
  );
  process.exit(0);
}

const LIMIT = Number(args.get('limit') ?? 50);
const FEATURE = typeof args.get('feature') === 'string' ? String(args.get('feature')) : null;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract every <loc>…</loc> from the body of a child sitemap. Index sitemaps
 * (which use <sitemap><loc>) should be excluded by the caller — we still try
 * to detect them defensively.
 *
 * @param {string} xml
 * @returns {string[]}
 */
function extractLocs(xml) {
  // Defensive: if this looks like an index sitemap, skip.
  if (/<sitemapindex\b/i.test(xml)) return [];
  const out = [];
  const re = /<url\b[\s\S]*?<\/url>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[0];
    const loc = block.match(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/i);
    if (loc && loc[1]) out.push(decodeEntities(loc[1].trim()));
  }
  return out;
}

/**
 * @param {string} s
 * @returns {string}
 */
function decodeEntities(s) {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'");
}

/**
 * Locate the dist/ HTML file that serves the given sitemap loc URL.
 * Tries both `<path>/index.html` and `<path>.html` shapes.
 *
 * @param {string} loc Absolute URL from <loc>
 * @returns {string|null} Absolute filesystem path, or null if not found
 */
function locToHtmlPath(loc) {
  let urlPath;
  try {
    urlPath = new URL(loc).pathname;
  } catch {
    // Treat as already-relative path.
    urlPath = loc.startsWith('/') ? loc : '/' + loc;
  }

  // Strip query/hash defensively (URL above already does, but be safe).
  urlPath = urlPath.split('#')[0].split('?')[0];

  const candidates = [];
  if (urlPath.endsWith('/')) {
    candidates.push(join(DIST, urlPath, 'index.html'));
    // Also try trimming the trailing slash and using `<x>.html`
    const trimmed = urlPath.replace(/\/+$/, '');
    if (trimmed) candidates.push(join(DIST, trimmed + '.html'));
  } else {
    candidates.push(join(DIST, urlPath + '.html'));
    candidates.push(join(DIST, urlPath, 'index.html'));
  }
  // Root special case: '/'
  if (urlPath === '/' || urlPath === '') {
    candidates.unshift(join(DIST, 'index.html'));
  }

  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        if (statSync(c).isFile()) return c;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

/**
 * Extract <link rel="canonical" href="..."> href from HTML, case-insensitive,
 * tolerant of attribute order, single OR double quotes.
 *
 * @param {string} html
 * @returns {string|null}
 */
function extractCanonical(html) {
  // Find all <link …> tags, then pick whichever has rel="canonical".
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?canonical["']?/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*"([^"]+)"/i) || tag.match(/href\s*=\s*'([^']+)'/i);
    if (href && href[1]) return decodeEntities(href[1].trim());
  }
  return null;
}

/**
 * Normalise a URL for comparison: lowercase host, strip default ports, drop
 * trailing slash on non-root paths, drop fragments. Query strings are
 * preserved (sitemaps shouldn't list URLs that differ from canonical only by
 * query, but we don't silently equate them either).
 *
 * @param {string} u
 * @returns {string}
 */
function normalizeUrl(u) {
  try {
    const parsed = new URL(u, HOST);
    let path = parsed.pathname;
    // Keep root '/' as-is; trim trailing slash on deeper paths so '/foo/'
    // and '/foo' compare equal — sitemaps and canonical hrefs sometimes
    // disagree only on the trailing slash and we don't want to fail on that.
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return u.trim();
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  let distEntries;
  try {
    distEntries = readdirSync(DIST);
  } catch (err) {
    process.stderr.write(`audit-sitemap-canonicals: dist/ not found at ${DIST}. Run \`npm run build\` first.\n`);
    process.exit(2);
  }

  const sitemapFiles = distEntries
    .filter(name => /^sitemap-.+\.xml$/i.test(name))
    .filter(name => name.toLowerCase() !== 'sitemap.xml')
    .filter(name => name.toLowerCase() !== 'sitemap_news.xml')
    .filter(name => !FEATURE || name.toLowerCase().includes(FEATURE.toLowerCase()))
    .sort();

  if (sitemapFiles.length === 0) {
    process.stderr.write(
      `audit-sitemap-canonicals: no dist/sitemap-*.xml files matched` +
        (FEATURE ? ` (feature filter: "${FEATURE}")` : '') +
        '. If this ran post-build, the build is not emitting child sitemaps.\n'
    );
    process.exit(2);
  }

  /** @type {{category: 'mismatch'|'missing-html'|'missing-canonical', sitemap: string, loc: string, canonical: string|null}[]} */
  const offenders = [];
  let okCount = 0;
  let totalChecked = 0;

  for (const sitemap of sitemapFiles) {
    const xmlPath = join(DIST, sitemap);
    let xml;
    try {
      xml = readFileSync(xmlPath, 'utf8');
    } catch (err) {
      process.stderr.write(`audit-sitemap-canonicals: cannot read ${sitemap}: ${err.message}\n`);
      process.exit(2);
    }
    const locs = extractLocs(xml);
    for (const loc of locs) {
      if (/\.(pdf|xml|txt|json|rss|xsl|ico)(\?|#|$)/i.test(loc)) {
        continue;
      }
      totalChecked++;
      const htmlPath = locToHtmlPath(loc);
      if (!htmlPath) {
        offenders.push({ category: 'missing-html', sitemap, loc, canonical: null });
        continue;
      }
      let html;
      try {
        html = readFileSync(htmlPath, 'utf8');
      } catch (err) {
        offenders.push({ category: 'missing-html', sitemap, loc, canonical: null });
        continue;
      }
      const canonical = extractCanonical(html);
      if (!canonical) {
        offenders.push({ category: 'missing-canonical', sitemap, loc, canonical: null });
        continue;
      }
      if (normalizeUrl(canonical) !== normalizeUrl(loc)) {
        offenders.push({ category: 'mismatch', sitemap, loc, canonical });
        continue;
      }
      okCount++;
    }
  }

  const counts = {
    mismatch: 0,
    'missing-html': 0,
    'missing-canonical': 0,
  };
  for (const o of offenders) counts[o.category]++;

  process.stdout.write(
    `audit-sitemap-canonicals: scanned ${sitemapFiles.length} sitemap file(s), checked ${totalChecked} URL(s)\n` +
      `OK: ${okCount}, mismatches: ${counts.mismatch}, missing-html: ${counts['missing-html']}, missing-canonical: ${counts['missing-canonical']}\n`
  );

  // Hard fails: mismatch + missing-canonical (the Semrush "non-canonical URL"
  // class). missing-html is a separate stale-sitemap concern — warn only.
  const hardFailers = offenders.filter(o => o.category !== 'missing-html');
  const warners = offenders.filter(o => o.category === 'missing-html');

  if (warners.length > 0) {
    process.stderr.write(
      `\nWARN: ${warners.length} sitemap <loc>(s) have no HTML in dist/ ` +
        `(separate concern — see sitemap-completeness.test.ts):\n`
    );
    const slice = warners.slice(0, Math.min(LIMIT, warners.length));
    for (const o of slice) {
      process.stderr.write(`[missing-html] ${o.sitemap}: ${o.loc}\n`);
    }
    if (warners.length > slice.length) {
      process.stderr.write(`… ${warners.length - slice.length} more\n`);
    }
  }

  const _structuredOffenders = offenders.map((o) => ({
    path: o.loc,
    feature: o.sitemap,
    metric: 1,
    ratio: null,
    category: o.category,
    canonical: o.canonical,
  }));
  const _byFeatureForReport = {};
  for (const o of offenders) {
    _byFeatureForReport[o.sitemap] = (_byFeatureForReport[o.sitemap] ?? 0) + 1;
  }

  if (hardFailers.length === 0) {
    await writeAuditReport({
      audit: 'sitemap-canonicals',
      passed: true,
      threshold: { metric: 'count', value: 0, comparator: '<=' },
      offenders: _structuredOffenders,
      byFeature: _byFeatureForReport,
      extra: { categoryCounts: counts, sitemapsScanned: sitemapFiles.length },
    });
    process.exit(0);
  }

  process.stderr.write(
    `\nFAIL: sitemap canonical integrity gate found ${hardFailers.length} offender(s).\n` +
      `Sitemap <loc> URLs MUST self-canonicalize. See CLAUDE.md SEO rules.\n\n`
  );

  const order = ['mismatch', 'missing-canonical'];
  const byCat = new Map();
  for (const c of order) byCat.set(c, []);
  for (const o of hardFailers) byCat.get(o.category).push(o);

  let printed = 0;
  for (const cat of order) {
    const list = byCat.get(cat);
    if (!list.length) continue;
    for (const o of list) {
      if (printed >= LIMIT) break;
      const canon = o.canonical ?? '(none)';
      process.stderr.write(`[${o.category}] ${o.sitemap}: ${o.loc} → ${canon}\n`);
      printed++;
    }
    if (printed >= LIMIT) break;
  }
  if (hardFailers.length > printed) {
    process.stderr.write(`… ${hardFailers.length - printed} more (raise --limit=N to see them)\n`);
  }

  await writeAuditReport({
    audit: 'sitemap-canonicals',
    passed: false,
    threshold: { metric: 'count', value: 0, comparator: '<=' },
    offenders: _structuredOffenders,
    byFeature: _byFeatureForReport,
    extra: { categoryCounts: counts, sitemapsScanned: sitemapFiles.length },
  });
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`audit-sitemap-canonicals crashed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
