/**
 * Shared freshness-bump helpers for EVERGREEN blog articles (stable id, body
 * rewritten periodically instead of a new article per run — see AGENTS.md §6:
 * a construct duplicated across ≥2 scripts must live in one module).
 *
 * Extracted from generate-events-digest-article.mjs (issue #2963) so the
 * dogane-ranking digest (and any future evergreen digest) reuses the exact
 * same regex-scoped rewrite logic instead of a copy-pasted sibling.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Bump (or insert) `updatedAt` on the ARTICLES entry so sitemap lastmod reflects the refresh. */
export function bumpUpdatedAt(id, todayIso, repoRoot = DEFAULT_REPO_ROOT) {
  const file = path.join(repoRoot, 'data', 'blog-articles-data.ts');
  let src = readFileSync(file, 'utf-8');
  const entryRe = new RegExp(`(\\n([ \\t]*)id: '${id}',[\\s\\S]*?)(\\n[ \\t]*\\},)`);
  const m = src.match(entryRe);
  if (!m) return false;
  const indent = m[2];
  let block = m[1];
  // updatedAt is stored date-only (no time-of-day); if the entry's original
  // `date` timestamp falls later the same calendar day (article registered
  // earlier today), a midnight-anchored updatedAt would parse as *before* it —
  // an incoherent freshness signal (google-news-compliance.test.ts). Same
  // clamp rationale as bumpDateModified below; skip the bump in that
  // same-day case instead of writing a value that can never be >= `date`.
  const dateMatch = block.match(/\n[ \t]*date: '([^']*)',/);
  if (dateMatch && Date.parse(`${todayIso}T00:00:00Z`) < Date.parse(dateMatch[1])) {
    return true;
  }
  if (/updatedAt:/.test(block)) {
    block = block.replace(/updatedAt: '[^']*'/, `updatedAt: '${todayIso}'`);
  } else {
    block = block.replace(/(\n[ \t]*date: '[^']*',)/, `$1\n${indent}updatedAt: '${todayIso}',`);
  }
  if (block === m[1]) return false;
  src = src.replace(m[1], block);
  writeFileSync(file, src);
  return true;
}

/**
 * Bump the NewsArticle `dateModified` on the article's blog-SEO entry so the
 * freshness signal tracks the periodic body refresh (datePublished is left at
 * the original publish date). Scoped to this article's block only.
 *
 * `seoFile` defaults to the "frontaliere" section's active SEO shard — must
 * match `SECTION.seoFile` in create-article.mjs for whichever section the
 * article was registered under (both events and border-wait digests are
 * "frontaliere" section, so the default is correct for both).
 */
export function bumpDateModified(
  id,
  isoDateTime,
  repoRoot = DEFAULT_REPO_ROOT,
  seoFile = 'services/seo/seo-blog-5.ts',
) {
  const file = path.join(repoRoot, seoFile);
  const src = readFileSync(file, 'utf-8');
  const startIdx = src.indexOf(`'blog-${id}':`);
  if (startIdx < 0) return false;
  // Scope the rewrite to THIS entry's block (stop at the next top-level entry
  // key) so a future nested object can never make us touch a sibling's date.
  const after = src.slice(startIdx);
  const nextKey = after.slice(1).search(/\n {2}'[^']+':\s*\{/);
  const blockEnd = nextKey < 0 ? after.length : nextKey + 1;
  const block = after.slice(0, blockEnd);
  const dmRe = /"dateModified":\s*"[^"]*"/;
  if (!dmRe.test(block)) return false;
  // dateModified must never precede datePublished: on the publish day a fixed
  // midnight stamp falls before the publish time → an incoherent freshness
  // signal in the indexed NewsArticle JSON-LD. Clamp up to datePublished when earlier.
  const pub = block.match(/"datePublished":\s*"([^"]*)"/);
  const effective = pub && Date.parse(pub[1]) > Date.parse(isoDateTime) ? pub[1] : isoDateTime;
  const replaced = block.replace(dmRe, `"dateModified": "${effective}"`);
  writeFileSync(file, src.slice(0, startIdx) + replaced + after.slice(blockEnd));
  return true;
}

/** Bump the `<lastmod>` on the article's sitemap-blog.xml entry to match the refresh date. */
export function bumpSitemapLastmod(
  slug,
  isoDate,
  repoRoot = DEFAULT_REPO_ROOT,
  sitemapFile = 'public/sitemap-blog.xml',
) {
  const file = path.join(repoRoot, sitemapFile);
  let src = readFileSync(file, 'utf-8');
  // Match the <url> block whose <loc> ends /<slug>/ and rewrite ITS <lastmod>.
  // The negative lookahead keeps the match inside the url block, so a missing
  // lastmod can never make it bump a different article's date.
  const urlBlockRe = new RegExp(
    `(<url>\\s*<loc>[^<]*/${slug}/</loc>(?:(?!</url>)[\\s\\S])*?<lastmod>)[^<]*(</lastmod>)`,
  );
  const m = src.match(urlBlockRe);
  if (!m) return false;
  src = src.replace(urlBlockRe, `$1${isoDate}$2`);
  writeFileSync(file, src);
  return true;
}
