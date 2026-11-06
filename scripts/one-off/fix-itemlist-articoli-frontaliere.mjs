#!/usr/bin/env node
/**
 * One-off fix for GitHub issue #3358: data corruption in the "Articoli
 * Frontaliere" ItemList JSON-LD block inside services/seo/seo-pages.ts.
 *
 * Corruption found:
 *  - 78 ListItem entries have a `name` field that contains a raw, truncated
 *    JSON fragment instead of the real article title. Two shapes seen:
 *      - a full JSON-LD dump, e.g. `{\"@context\":\"https://schema.org\",...`
 *      - a locale-object dump, e.g. `{\"it\":\"Daverio: i pazienti...`
 *    This happened because a prior generation step accidentally serialized
 *    a whole object into the `name` field for some articles.
 *  - `numberOfItems` (3085) does not match the true number of ListItem
 *    entries in the block (3058 before this fix).
 *  - A couple of `position` values are reused by two different articles
 *    (numbering drift), and there are gaps in the position sequence.
 *
 * Fix:
 *  1. Locate the "Articoli Frontaliere" ItemList block using the SAME
 *     block-locating helper already used by
 *     scripts/lib/seo-pages-article-list.mjs (`locateItemListBlock`), so
 *     there is exactly one implementation of "how to bound this array"
 *     in the repo instead of a second, potentially drifting, copy.
 *  2. For each ListItem entry with a corrupted `name`, look up the real
 *     title via the URL slug in services/locales/blog-meta-it.ts
 *     (`blog.article.<slug>.title`).
 *  3. Entries whose slug has no recoverable title anywhere (confirmed dead
 *     / orphaned articles) are removed entirely rather than fabricated.
 *  4. Renumber `position` sequentially 1..N in original array order (minus
 *     removed entries), and set `numberOfItems` to the true final count N.
 *
 * Usage: node scripts/one-off/fix-itemlist-articoli-frontaliere.mjs
 * Safe to re-run: if the block is already clean, it is a no-op (idempotent).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  locateItemListBlock,
  escapeJsonString,
  NUMBER_OF_ITEMS_RE,
} from '../lib/seo-pages-article-list.mjs';
import { unescapeTsString } from '../lib/unescape-ts-string.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const seoPagesPath = path.join(repoRoot, 'services', 'seo', 'seo-pages.ts');
const blogMetaPath = path.join(repoRoot, 'services', 'locales', 'blog-meta-it.ts');

// Matches a `name` value that is actually an escaped JSON fragment instead
// of a plain article title. Two shapes seen in the wild:
//   "name": "{\"@context\":\"https://schema.org\",\"@type\":\"Artic...",     (full JSON-LD dump)
//   "name": "{\"@context\": \"http://schema.org\", \"@type\": \"Art...",     (same, spaced)
//   "name": "{\"it\":\"Daverio: i pazienti si spostano a Gazzad...",         (locale-object dump)
// Both start with an escaped `{` followed by an escaped-quoted JSON key,
// which no real article title would ever start with.
const CORRUPTED_NAME_RE = /^\{\s*\\"[a-zA-Z@][a-zA-Z0-9_]*\\"\s*:/;

// Entries confirmed dead/orphaned (no `blog-meta-it.ts` title, no
// `legacy-aliases.json` redirect target, and/or a live 404) via the
// investigation behind issue #3358. See PR description for the per-slug
// evidence. Do NOT add slugs here without the same level of confirmation.
const KNOWN_DEAD_SLUGS = new Set([
  'governo-tavolo-frontalieri-2026',
  'kebab-case-3-5-words-max-40-chars',
  'varese-soroptimist-studio-fibrosi-polmonare',
]);

function loadBlogTitles(blogMetaSrc) {
  const titles = new Map();
  // 'blog.article.<slug>.title': 'Some title with \' escaped quotes',
  const re = /'blog\.article\.([a-z0-9-]+)\.title':\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(blogMetaSrc))) {
    const [, slug, rawTitle] = m;
    // Un-escape the single-quoted JS string literal (\' -> ', \\ -> \).
    const title = unescapeTsString(rawTitle, { "'": "'", '\\': '\\' });
    titles.set(slug, title);
  }
  return titles;
}

function extractSlugFromUrl(urlExpr) {
  // urlExpr looks like: `${BASE_URL}/articoli-frontaliere/<slug>`
  const m = urlExpr.match(/\/articoli-frontaliere\/([a-z0-9-]+)`?\s*$/);
  return m ? m[1] : null;
}

// Matches one ListItem entry line, in the exact shape used throughout the
// block: `{ "@type": "ListItem", "position": N, "name": "...", "url": `...` }`
// optionally followed by a trailing comma.
const ENTRY_LINE_RE =
  /^(\s*)\{\s*"@type":\s*"ListItem",\s*"position":\s*(\d+),\s*"name":\s*"((?:[^"\\]|\\.)*)",\s*"url":\s*(`\$\{BASE_URL\}[^`]*`)\s*\}(,?)\s*$/;

function main() {
  const src = fs.readFileSync(seoPagesPath, 'utf8');
  const blogMetaSrc = fs.readFileSync(blogMetaPath, 'utf8');
  const blogTitles = loadBlogTitles(blogMetaSrc);

  const block = locateItemListBlock(src);
  if (!block) {
    throw new Error('Could not locate the "Articoli Frontaliere" ItemList block.');
  }
  const { blockStart, blockEnd } = block;
  const blockSrc = src.slice(blockStart, blockEnd);

  // Sanity check: the next structured-data block right after this one
  // should be the unrelated FAQPage block (confirms we bounded the right
  // array and didn't drift into a neighboring ItemList/HowTo array).
  const tailAfterBlock = src.slice(blockEnd, blockEnd + 200);
  if (!tailAfterBlock.includes('FAQPage')) {
    throw new Error(
      'Sanity check failed: expected FAQPage block shortly after the "Articoli Frontaliere" ItemList.'
    );
  }

  const arrayOpenMatch = blockSrc.match(/"itemListElement":\s*\[\s*\n/);
  if (!arrayOpenMatch) {
    throw new Error('Could not find "itemListElement": [ opening inside the located block.');
  }
  const entriesStart = arrayOpenMatch.index + arrayOpenMatch[0].length;

  const closeMatch = blockSrc.match(/\n[ \t]*\][,;]?$/);
  if (!closeMatch) {
    throw new Error('Could not find the closing "]" at the end of the located block.');
  }
  const entriesEnd = closeMatch.index + 1; // keep the leading "\n" as part of the suffix

  const prefix = blockSrc.slice(0, entriesStart);
  const entriesText = blockSrc.slice(entriesStart, entriesEnd);
  const suffix = blockSrc.slice(entriesEnd);

  const entryLines = entriesText.split('\n');
  const parsedEntries = [];
  for (const line of entryLines) {
    if (line.trim() === '') continue;
    const m = line.match(ENTRY_LINE_RE);
    if (!m) {
      throw new Error(`Unrecognized ListItem entry line format: ${JSON.stringify(line)}`);
    }
    const [, indent, position, name, urlExpr] = m;
    parsedEntries.push({ indent, position: Number(position), name, urlExpr });
  }

  const totalEntries = parsedEntries.length;
  const corruptedEntries = parsedEntries.filter((e) => CORRUPTED_NAME_RE.test(e.name));

  console.log(`Total ListItem entries found in block: ${totalEntries}`);
  console.log(`Corrupted-name entries found: ${corruptedEntries.length}`);

  const positionCounts = new Map();
  for (const e of parsedEntries) {
    positionCounts.set(e.position, (positionCounts.get(e.position) || 0) + 1);
  }
  const collisions = [...positionCounts.entries()].filter(([, count]) => count > 1);
  if (collisions.length) {
    console.log(
      `Position collisions detected (will be resolved by renumbering): ${collisions
        .map(([pos, count]) => `${pos}(x${count})`)
        .join(', ')}`
    );
  }

  const recovered = [];
  const removed = [];
  const unresolved = [];

  const fixedEntries = [];
  for (const entry of parsedEntries) {
    if (!CORRUPTED_NAME_RE.test(entry.name)) {
      fixedEntries.push(entry);
      continue;
    }

    const slug = extractSlugFromUrl(entry.urlExpr);
    const title = slug ? blogTitles.get(slug) : undefined;

    if (title) {
      recovered.push({ slug, title });
      fixedEntries.push({ ...entry, name: escapeJsonString(title) });
    } else if (slug && KNOWN_DEAD_SLUGS.has(slug)) {
      removed.push({ slug, reason: 'confirmed dead/orphaned article, no recoverable title' });
      // Drop this entry (do not push to fixedEntries).
    } else {
      // No recoverable title and not in the known-dead cohort: keep as-is
      // and flag loudly rather than guessing a title or silently deleting.
      unresolved.push({ slug: slug ?? '(unparseable url)', urlExpr: entry.urlExpr });
      fixedEntries.push(entry);
    }
  }

  if (unresolved.length) {
    console.log('\nWARNING: entries with corrupted name and NO recoverable title, kept as-is:');
    for (const u of unresolved) console.log(`  - slug=${u.slug} url=${u.urlExpr}`);
  }

  // Renumber positions sequentially.
  const finalEntries = fixedEntries.map((entry, idx) => ({ ...entry, position: idx + 1 }));
  const finalCount = finalEntries.length;

  const rebuiltEntryLines = finalEntries.map(
    (e) =>
      `${e.indent}{ "@type": "ListItem", "position": ${e.position}, "name": "${e.name}", "url": ${e.urlExpr} }${
        e.position < finalCount ? ',' : ''
      }`
  );

  const newBlockSrc = prefix + rebuiltEntryLines.join('\n') + '\n' + suffix;
  const newSrc =
    src.slice(0, blockStart) + newBlockSrc + src.slice(blockEnd);

  const finalSrc = newSrc.replace(NUMBER_OF_ITEMS_RE, `$1${finalCount}`);

  fs.writeFileSync(seoPagesPath, finalSrc, 'utf8');

  console.log(`\nRecovered titles: ${recovered.length}`);
  console.log(`Removed dead entries: ${removed.length}`);
  for (const r of removed) console.log(`  - ${r.slug}: ${r.reason}`);
  console.log(`Unresolved (kept, needs manual review): ${unresolved.length}`);
  console.log(`\nFinal entry count: ${finalCount}`);
  console.log(`numberOfItems set to: ${finalCount}`);
}

main();
