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
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * An article whose SLUG names a specific calendar day is about that day, and
 * no amount of refreshing makes it evergreen again.
 *
 * Category is not the property this audit actually needs. `pratico` covers
 * both "how the G permit works" (true evergreen, worth refreshing) and
 * "manutenzione-ustat-servizi-chiusure-31-12-2025" (a service-closure notice
 * for one date, permanently in the past). The second kind gets flagged every
 * month forever, because the only way to make it "fresh" is to bump its date
 * without touching a word — which is precisely the freshness manipulation
 * Google penalises. So the audit must stop asking for it.
 *
 * Matches an explicit DD-MM-YYYY or YYYY-MM-DD run in the slug. A bare
 * trailing year is deliberately NOT matched: `costo-vita-svizzera-2026` and
 * `premi-cassa-malati-svizzera-2026` are annual editions, and refreshing them
 * each year is exactly the job. No "is it in the past" test either — a slug
 * naming next Tuesday is just as ephemeral, and a comparison against today
 * would put a calendar dependency in the classifier.
 */
const DATED_SLUG_RE = /(^|-)(?:(?:[0-2]?\d|3[01])-(?:0?[1-9]|1[0-2])-(?:19|20)\d{2}|(?:19|20)\d{2}-(?:0?[1-9]|1[0-2])-(?:[0-2]?\d|3[01]))(-|$)/;

/** True when the article's id names one specific calendar day. */
export function isDatedAnnouncement(id) {
  return DATED_SLUG_RE.test(String(id || ''));
}

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

// ── Audit ──────────────────────────────────────────────────────────
/**
 * Split a set of articles into the evergreen pool, the stale subset of it,
 * and the dated announcements that were never evergreen to begin with.
 *
 * Takes the articles rather than reading them, so a test can exercise the
 * classification without standing up the TypeScript registry parse — and so
 * importing this module never has a side effect.
 */
export function auditEvergreen(articles, now = new Date()) {
  const inEvergreenCategory = articles.filter((a) => EVERGREEN_CATEGORIES.has(a.category));
  // Reported, not dropped in silence: an article disappearing from the count
  // with no trace is how a classifier change becomes invisible.
  const datedExcluded = inEvergreenCategory
    .filter((a) => isDatedAnnouncement(a.id))
    .map((a) => ({ id: a.id, category: a.category, date: a.date }));
  const datedIds = new Set(datedExcluded.map((a) => a.id));
  const evergreen = inEvergreenCategory.filter((a) => !datedIds.has(a.id));

  const stale = evergreen
    .map((a) => {
      const freshnessDate = new Date(a.updatedAt || a.date);
      const ageMonths = monthsBetween(freshnessDate, now);
      return { id: a.id, category: a.category, date: a.date, updatedAt: a.updatedAt ?? null, ageMonths };
    })
    .filter((a) => a.ageMonths > STALE_THRESHOLD_MONTHS)
    .sort((a, b) => b.ageMonths - a.ageMonths); // oldest first

  return {
    totalEvergreen: evergreen.length,
    staleCount: stale.length,
    stale,
    datedExcludedCount: datedExcluded.length,
    datedExcluded,
  };
}

// ── Main ───────────────────────────────────────────────────────────
// Only when run directly: importing this module (tests) must not parse the
// registry or print anything.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(auditEvergreen(parseArticles())));
}
