/**
 * scripts/lib/dedupe-growing-container-closer.mjs
 *
 * Issue #3617 (JSON) found that a SECOND chained rebase-conflict cycle on
 * the same append-only file within one push's retry loop (git-push-with-retry.sh
 * --max-attempts, raised 3→5 by PR #3613) can produce a duplicated root
 * closer: both sides' "keep both" hunks independently include the
 * container's own closing token, so naive marker-stripping leaves that
 * token twice with the other side's new entry orphaned in between.
 *
 * Several non-JSON append-only targets written by scripts/create-article.mjs /
 * scripts/lib/seo-pages-article-list.mjs anchor their insertion regex on the
 * container's closing token itself (not on the preceding entry), which is
 * the SAME anchor shape that let the JSON corruption above happen:
 *   - data/blog-articles-data.ts   (`const RAW_ARTICLES = [ ... ]`)
 *   - data/swiss-articles-data.ts  (`const RAW_SWISS_ARTICLES = [ ... ]`)
 *   - services/seo/seo-pages.ts    ("Articoli Frontaliere" ItemList block)
 *   - services/locales/blog-meta-{it,en,de,fr}.ts and blog-meta-ch-*.ts
 *     (`Record<string, string>` meta-key objects)
 *   - public/sitemap-blog.xml, sitemap-blog-ch.xml, sitemap-news.xml,
 *     sitemap.xml (`<urlset>...</urlset>`)
 *
 * Real end-to-end reproduction via chained git rebase (PR #3622 follow-up,
 * tests/resolve-append-conflicts-idempotency.test.ts) found this shape does
 * NOT actually reach these targets: the array-of-object siblings hit a
 * different, already-handled failure (an aligned inner-field conflict,
 * safely rejected rather than silently merged), and the single-line-entry
 * siblings resolve cleanly across chained cycles with no duplication at all.
 * The repairs below are kept as defense-in-depth — a no-op on
 * already-correct input — in case a future insertion-anchor change or a
 * different conflict shape does produce this corruption for these targets.
 *
 * `services/routerBlogData.ts`/`services/routerSwissData.ts`'s BLOG_SLUGS /
 * SWISS_SLUGS maps are NOT in this list: their insertion anchors on the
 * PRECEDING entry line, never touching the map's closing `};`, so two
 * concurrent appends conflict at the entry line only — closing brace stays
 * single-occurrence, no repair needed there (verified against
 * modifyRouterTs in scripts/create-article.mjs).
 *
 * Each repair here is scoped to the specific known container (an anchor
 * regex to find its start, plus either a known "next declaration" bound or
 * a self-terminating entry/closer line scan) — never a whole-file scan —
 * so it can't misfire on unrelated brackets elsewhere in the file.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Dedupe a duplicated closer within [openRe match end, endRe match start).
 * Keeps only the LAST closer occurrence, drops earlier ones (each occurrence
 * is dropped along with one trailing newline, to avoid a stray blank line).
 * Returns null if there's nothing to repair (0 or 1 closer occurrences).
 */
export function dedupeBounded(text, openRe, closerRe, endRe) {
  const openMatch = openRe.exec(text);
  if (!openMatch) return null;
  const startIdx = openMatch.index + openMatch[0].length;

  let endIdx = text.length;
  if (endRe) {
    const rest = text.slice(startIdx);
    const endMatch = endRe.exec(rest);
    if (endMatch) endIdx = startIdx + endMatch.index;
  }

  const region = text.slice(startIdx, endIdx);
  const matches = [...region.matchAll(closerRe)];
  if (matches.length <= 1) return null;

  const dropList = matches.slice(0, -1);
  let out = '';
  let cursor = 0;
  for (const m of dropList) {
    out += region.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    if (region[cursor] === '\n') cursor++;
  }
  out += region.slice(cursor);
  return text.slice(0, startIdx) + out + text.slice(endIdx);
}

/**
 * Dedupe a duplicated closer in a container whose entries are single-line
 * and whose end can't be bounded by a fixed "next declaration" anchor
 * (e.g. one ItemList among many similarly-shaped ones in a huge file).
 * Scans line-by-line from the opener: every line must be either an entry
 * line or a closer line (or blank); the region ends at the first line that
 * is neither — that's always real, unrelated content, since neither entries
 * nor closer lines ever look like it. Any closer line seen along the way is
 * recorded; if more than one is found, only the last survives.
 */
export function dedupeSelfBounded(text, openRe, entryRe, closerRe) {
  const openMatch = openRe.exec(text);
  if (!openMatch) return null;
  const startIdx = openMatch.index + openMatch[0].length;
  const rest = text.slice(startIdx);
  const lines = rest.split('\n');

  const closerLineIdx = [];
  let stopAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (closerRe.test(line)) { closerLineIdx.push(i); continue; }
    if (entryRe.test(line)) continue;
    if (line.trim() === '') continue;
    stopAt = i;
    break;
  }

  if (closerLineIdx.length <= 1) return null;
  const dropSet = new Set(closerLineIdx.slice(0, -1));
  const newLines = lines.slice(0, stopAt).filter((_, i) => !dropSet.has(i)).concat(lines.slice(stopAt));
  return text.slice(0, startIdx) + newLines.join('\n');
}

const ARRAY_CLOSER_RE = /^\]\s*(?:satisfies\s+Article\[\])?;[ \t]*$/gm;

/**
 * Applies the matching repair for `file` (by basename) to `src`. Returns the
 * repaired source, or null if this file isn't a known target or nothing
 * needed repair.
 */
export function repairGrowingContainerCloser(file, src) {
  const base = basename(file);

  if (base === 'blog-articles-data.ts') {
    return dedupeBounded(src, /const RAW_ARTICLES\s*(?::[^=]+)?=\s*\[/, ARRAY_CLOSER_RE, /^export const ARTICLES\b/m);
  }
  if (base === 'swiss-articles-data.ts') {
    return dedupeBounded(src, /const RAW_SWISS_ARTICLES\s*(?::[^=]+)?=\s*\[/, ARRAY_CLOSER_RE, /^export const SWISS_ARTICLES\b/m);
  }
  if (base === 'seo-pages.ts') {
    return dedupeSelfBounded(
      src,
      /"name":\s*"Articoli Frontaliere",\s*\n\s*"numberOfItems":\s*\d+,\s*\n\s*"itemListElement":\s*\[/,
      /^\s*\{\s*"@type":\s*"ListItem"/,
      /^\s*\][,;]?\s*$/,
    );
  }
  if (/^blog-meta(-ch)?-(it|en|de|fr)\.ts$/.test(base)) {
    return dedupeBounded(src, /:\s*Record<string,\s*string>\s*=\s*\{/, /^\};[ \t]*$/gm, null);
  }
  if (/^sitemap(-blog(-ch)?|-news)?\.xml$/.test(base)) {
    return dedupeBounded(src, /<urlset[^>]*>/, /^<\/urlset>[ \t]*$/gm, null);
  }
  return null;
}

// CLI entry point: `node dedupe-growing-container-closer.mjs <file>` — used
// by scripts/lib/resolve-append-conflicts.sh. Exits 0 always (this is a
// best-effort repair pass; the caller's own parse/validation checks after
// this runs are what actually gate the push).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const file = process.argv[2];
  const src = readFileSync(file, 'utf8');
  const repaired = repairGrowingContainerCloser(file, src);
  if (repaired !== null) {
    writeFileSync(file, repaired);
    console.log(`  🔁 ${file}: deduped premature container closer (chained rebase-conflict cycle, issue #3617-class)`);
  }
}
