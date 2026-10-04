#!/usr/bin/env node
/**
 * Audit evergreen blog articles for staleness.
 *
 * Reads data/blog-articles-data.ts (or `--registry=<path>`), filters to
 * evergreen categories (fiscale, pratico, pensione), and flags articles whose
 * freshness date — the latest of updatedAt, verifiedAt and date — is older
 * than 6 months.
 *
 * Output: JSON on stdout with { totalEvergreen, staleCount, staleByType,
 * stale[], datedExcluded*, newsExcluded*, invalidVerifiedAt }.
 * Used by the evergreen-refresh-audit GitHub Actions workflow; the corpus may
 * run it as a process and read the JSON, so it imports only `node:` builtins.
 *
 * CLI: --section=frontaliere|svizzera  --registry=<path>  --now=<ISO date>
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI options ─────────────────────────────────────────────────────
// Parsed only when the script runs directly: importing the module (tests)
// must never read argv, the registry or exit.
function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseCliArgs(argv) {
  let section = 'frontaliere';
  let registry = null;
  let nowArg = null;
  for (const a of argv) {
    let m;
    if ((m = /^--section=(.+)$/.exec(a))) section = m[1];
    else if ((m = /^--registry=(.*)$/.exec(a))) registry = m[1];
    else if ((m = /^--now=(.*)$/.exec(a))) nowArg = m[1];
  }
  if (!['frontaliere', 'svizzera'].includes(section)) {
    fail(`Invalid --section="${section}". Valid: frontaliere, svizzera`);
  }
  const articlesPath = registry !== null
    ? resolve(process.cwd(), registry)
    : section === 'svizzera'
      ? resolve(__dirname, '..', 'data', 'swiss-articles-data.ts')
      : resolve(__dirname, '..', 'data', 'blog-articles-data.ts');
  if (registry !== null) {
    let isFile = false;
    try { isFile = registry !== '' && statSync(articlesPath).isFile(); } catch { /* reported below */ }
    if (!isFile) fail(`Invalid --registry="${registry}": not a readable file`);
  }
  let now = new Date();
  if (nowArg !== null) {
    now = new Date(nowArg);
    if (nowArg === '' || Number.isNaN(now.getTime())) {
      fail(`Invalid --now="${nowArg}". Expected an ISO date, e.g. 2026-10-03T18:00:00Z`);
    }
  }
  return {
    articlesPath,
    articlesConst: section === 'svizzera' ? 'SWISS_ARTICLES' : 'ARTICLES',
    now,
  };
}

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
function parseArticles(articlesPath, articlesConst) {
  const raw = readFileSync(articlesPath, 'utf-8');

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
  // reads `id`/`category`/`date`/`updatedAt`/`verifiedAt`/`articleType`, so a passthrough stub is a
  // faithful stand-in — no need to wire up the real CDN helper.
  const shims = 'const cdnBlogImage = (src) => src;\n';

  // Wrap in a function that returns the section's articles array.
  const fn = new Function(`${shims}${stripped}; return ${articlesConst};`);
  return fn();
}

// ── Compute months between two dates ───────────────────────────────
function monthsBetween(older, newer) {
  return (
    (newer.getFullYear() - older.getFullYear()) * 12 +
    (newer.getMonth() - older.getMonth())
  );
}

/** Start of a date's UTC calendar day; registry dates are ISO timestamps. */
function utcDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** The calendar date `months` before `date`, clamped to the target month's end. */
function calendarMonthsAgo(date, months) {
  const targetMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, 1));
  const lastTargetDay = new Date(Date.UTC(
    targetMonth.getUTCFullYear(),
    targetMonth.getUTCMonth() + 1,
    0,
  )).getUTCDate();

  return Date.UTC(
    targetMonth.getUTCFullYear(),
    targetMonth.getUTCMonth(),
    Math.min(date.getUTCDate(), lastTargetDay),
  );
}

const ISO_DATE_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})(?=$|T|[ \t])/;

/** A parsed Date, or null when the value is missing, malformed, or not a date. */
function parseDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    const match = ISO_DATE_PREFIX_RE.exec(value.trim());
    if (match) {
      const datePart = match[0];
      const roundTripped = new Date(`${datePart}T00:00:00.000Z`);
      if (Number.isNaN(roundTripped.getTime()) || roundTripped.toISOString().slice(0, 10) !== datePart) {
        return null;
      }
    }
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The article's freshness: the LATEST of `updatedAt` (facts changed),
 * `verifiedAt` (facts re-checked and unchanged — the way off this list that
 * does not bump a date) and `date`. A maximum, so an old `verifiedAt` never
 * makes an article look older than its `updatedAt`. Unparsable values are
 * skipped; a `verifiedAt` after `now` is a claim from the future, so it is not
 * used and the caller reports it.
 *
 * Ties keep the first source in this order: updatedAt, verifiedAt, date.
 */
function freshnessOf(article, now) {
  let best = null;
  let source = null;
  let futureVerifiedAt = false;
  for (const key of ['updatedAt', 'verifiedAt', 'date']) {
    const d = parseDate(article[key]);
    if (!d) continue;
    if (key === 'verifiedAt' && d.getTime() > now.getTime()) {
      futureVerifiedAt = true;
      continue;
    }
    if (!best || d.getTime() > best.getTime()) {
      best = d;
      source = key;
    }
  }
  return { freshnessDate: best, freshnessSource: source, futureVerifiedAt };
}

// ── Audit ──────────────────────────────────────────────────────────
/**
 * Split a set of articles into the evergreen pool, the stale subset of it,
 * and the articles that were never evergreen to begin with: dated
 * announcements (by slug) and articles the registry types as `news`.
 *
 * Every article in an evergreen category lands in exactly one of
 * `totalEvergreen`, `datedExcluded` or `newsExcluded` — exclusions are listed,
 * never dropped in silence. An article WITHOUT `articleType` stays in the pool
 * and in `stale` (counted under `staleByType.unclassified`): treating the
 * untyped stock as "not evergreen" would silence the alarm for nearly all of
 * it.
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
  const notDated = inEvergreenCategory.filter((a) => !datedIds.has(a.id));
  // Typed news in an evergreen category (cronaca filed under `pratico`):
  // excluded from the pool, and listed like the dated announcements.
  const newsExcluded = notDated
    .filter((a) => a.articleType === 'news')
    .map((a) => ({ id: a.id, category: a.category, date: a.date }));
  const evergreen = notDated.filter((a) => a.articleType !== 'news');
  // Month age remains the display/sort value; membership uses the full date.
  const staleBefore = calendarMonthsAgo(now, STALE_THRESHOLD_MONTHS);

  const invalidVerifiedAt = [];
  const stale = evergreen
    .map((a) => {
      const fresh = freshnessOf(a, now);
      if (fresh.futureVerifiedAt) invalidVerifiedAt.push(a.id);
      const ageMonths = fresh.freshnessDate ? monthsBetween(fresh.freshnessDate, now) : null;
      return { article: a, ...fresh, ageMonths };
    })
    // No usable date at all is not "fresh": it stays on the list.
    .filter(({ freshnessDate }) => !freshnessDate || utcDay(freshnessDate) < staleBefore)
    .map(({ article, ageMonths, freshnessSource }) => ({
      id: article.id,
      category: article.category,
      date: article.date,
      updatedAt: article.updatedAt ?? null,
      ageMonths,
      articleType: article.articleType === 'evergreen' ? 'evergreen' : null,
      freshnessSource,
    }))
    // Oldest first; an article with no usable date sorts before everything.
    .sort((a, b) => (b.ageMonths ?? Infinity) - (a.ageMonths ?? Infinity));

  const typedEvergreen = stale.filter((a) => a.articleType === 'evergreen').length;

  return {
    totalEvergreen: evergreen.length,
    staleCount: stale.length,
    staleByType: { evergreen: typedEvergreen, unclassified: stale.length - typedEvergreen },
    stale,
    datedExcludedCount: datedExcluded.length,
    datedExcluded,
    newsExcludedCount: newsExcluded.length,
    newsExcluded,
    invalidVerifiedAt,
  };
}

// ── Main ───────────────────────────────────────────────────────────
// Only when run directly: importing this module (tests) must not parse the
// registry or print anything. argv[1] is compared by real path: run through a
// symlinked directory (macOS /tmp, /var/folders) the two URLs differ and the
// script used to exit 0 with no output at all.
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const { articlesPath, articlesConst, now } = parseCliArgs(process.argv.slice(2));
  console.log(JSON.stringify(auditEvergreen(parseArticles(articlesPath, articlesConst), now)));
}
