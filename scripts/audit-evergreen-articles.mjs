#!/usr/bin/env node
/**
 * Audit evergreen blog articles for staleness.
 *
 * Reads data/blog-articles-data.ts, filters to evergreen categories
 * (fiscale, pratico, pensione), and flags articles whose freshness
 * date (updatedAt ?? date) is older than 6 months.
 *
 * Output: JSON on stdout with { totalEvergreen, staleCount, stale[] }.
 * Used by the evergreen-refresh-audit GitHub Actions workflow.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Section selection (--section=frontaliere|svizzera, default frontaliere) ──
function _sectionArg() {
  let section = 'frontaliere';
  for (const a of process.argv.slice(2)) {
    const m = /^--section=(.+)$/.exec(a);
    if (m) section = m[1];
  }
  if (!['frontaliere', 'svizzera'].includes(section)) {
    console.error(`Invalid --section="${section}". Valid: frontaliere, svizzera`);
    process.exit(1);
  }
  return section;
}
const SECTION = _sectionArg();
const ARTICLES_PATH = SECTION === 'svizzera'
  ? resolve(__dirname, '..', 'data', 'swiss-articles-data.ts')
  : resolve(__dirname, '..', 'data', 'blog-articles-data.ts');
const ARTICLES_CONST = SECTION === 'svizzera' ? 'SWISS_ARTICLES' : 'ARTICLES';

const EVERGREEN_CATEGORIES = new Set(['fiscale', 'pratico', 'pensione']);
const STALE_THRESHOLD_MONTHS = 6;

// Remove every top-level `export interface Name { ... }` block using
// brace-depth counting rather than a `[^}]*` regex. The naive regex stops at
// the FIRST `}`, but JSDoc comments inside the interface body can contain
// balanced braces of their own (e.g. a route-pattern doc-comment mentioning
// `/autori/{authorSlug}/`) — that closes the match early and leaves the rest
// of the interface body as dangling text, which breaks `new Function` with a
// confusing "Invalid regular expression: missing /" syntax error (#3203).
function stripInterfaceBlocks(src) {
  const startRe = /^export\s+interface\s+\w+\s*\{/gm;
  let result = '';
  let cursor = 0;
  let match;
  while ((match = startRe.exec(src))) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    result += src.slice(cursor, match.index);
    cursor = i;
    startRe.lastIndex = i;
  }
  result += src.slice(cursor);
  return result;
}

// ── Parse the TypeScript articles array ────────────────────────────
function parseArticles() {
  const raw = readFileSync(ARTICLES_PATH, 'utf-8');

  // Strip TypeScript-only syntax so we can eval as plain JS.
  const stripped = stripInterfaceBlocks(raw)
    .replace(/^import\s+.*$/gm, '')
    .replace(/^export\s+type\s+.*$/gm, '')
    .replace(/export\s+const/g, 'const')
    .replace(/:\s*Article\[\]/g, '')
    // Remove "as const" assertions
    .replace(/as\s+const/g, '')
    // Remove trailing type annotations on properties (e.g. `id: 'foo' as BlogArticleId`)
    .replace(/as\s+BlogArticleId/g, '')
    // Remove `satisfies Article[]` (TS 4.9+ const-satisfies check on RAW_ARTICLES)
    .replace(/satisfies\s+\w+(\[\])?/g, '');

  // Value imports (e.g. `cdnBlogImage`, used to rewrite the `image` field to
  // a CDN URL) are stripped along with the rest above since this file is
  // evaluated standalone, outside the real module graph. The audit only
  // reads `id`/`category`/`date`/`updatedAt`, so a passthrough stub is a
  // faithful stand-in — no need to wire up the real CDN helper.
  const shims = 'const cdnBlogImage = (src) => src;\n';

  // Wrap in a function that returns the section's articles array.
  const fn = new Function(`${shims}${stripped}; return ${ARTICLES_CONST};`);
  return fn();
}

// ── Compute months between two dates ───────────────────────────────
function monthsBetween(older, newer) {
  return (
    (newer.getFullYear() - older.getFullYear()) * 12 +
    (newer.getMonth() - older.getMonth())
  );
}

// ── Main ───────────────────────────────────────────────────────────
const now = new Date();
const articles = parseArticles();

const evergreen = articles.filter((a) => EVERGREEN_CATEGORIES.has(a.category));

const stale = evergreen
  .map((a) => {
    const freshnessDate = new Date(a.updatedAt || a.date);
    const ageMonths = monthsBetween(freshnessDate, now);
    return { id: a.id, category: a.category, date: a.date, updatedAt: a.updatedAt ?? null, ageMonths };
  })
  .filter((a) => a.ageMonths > STALE_THRESHOLD_MONTHS)
  .sort((a, b) => b.ageMonths - a.ageMonths); // oldest first

const result = {
  totalEvergreen: evergreen.length,
  staleCount: stale.length,
  stale,
};

console.log(JSON.stringify(result));
