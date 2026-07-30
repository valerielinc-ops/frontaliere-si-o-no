/**
 * scripts/lib/seo-pages-article-list.mjs
 *
 * Comma-safe helpers for editing the "Articoli Frontaliere" breadcrumb
 * ItemList in services/seo/seo-pages.ts.
 *
 * Incident (issue #2834, hotfixed by PR #2833): a foreign in-place
 * slug-rename edit string-spliced this array directly and left the OLD-slug
 * ListItem entry behind, with NO trailing comma between it and its neighbor
 * (`} {`). esbuild then failed to transform seo-pages.ts
 * ("Expected \"]\" but found \"{\""), which broke every test/suite importing
 * services/seoService.ts and turned the vitest gate RED on main for every
 * branch.
 *
 * Both helpers below always rebuild the ONE entry (and its own trailing
 * comma) they touch from regex capture groups — never a blind substring
 * splice that assumes where a comma belongs — so this class of
 * missing-comma corruption is structurally impossible for code that goes
 * through this module. Every match is additionally bounded to the
 * "Articoli Frontaliere" `itemListElement` block only (see
 * locateItemListBlock below) — seo-pages.ts is a ~10k-line file with
 * several other unrelated ItemList/HowTo-step arrays sharing the same
 * single-line `{ ... "url": ... }` shape; an unbounded regex can match one
 * of THOSE first and corrupt unrelated structured data (this was caught in
 * PR review of this very fix, against the real committed file, before an
 * earlier unbounded version merged). `upsertArticleListItem` is the
 * rename-safe entry point: any future slug-rename/migration tooling MUST
 * use it (with `renameFromUrl`) instead of hand-rolled regex/string-splice,
 * so a rename REPLACES the existing entry in place rather than leaving a
 * duplicate.
 */

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Raw control-code points (0..31, plus DEL=127), built from charCodes
// rather than a literal backslash-escape range written directly in this
// source file's regex literal.
const CONTROL_CHARS_RE = new RegExp(
  '[' +
    Array.from({ length: 33 }, (_, i) => (i === 32 ? 127 : i))
      .map((c) => String.fromCharCode(c))
      .join('') +
    ']+',
);

// Strips raw control characters (newline/tab/etc.) from a string before it
// is embedded as a JSON string value inside the single-line JS/JSON-LD
// object literals this module emits. A JS template literal tolerates a raw
// newline (esbuild parses it fine), but the emitted text is JSON-LD later
// parsed as strict JSON by browsers/crawlers, where an unescaped control
// character is invalid. Article headlines/titles are single-line by
// contract, so stripping (not backslash-escaping) is the correct fix.
export function escapeJsonString(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(CONTROL_CHARS_RE, ' ')
    .trim();
}

export const NUMBER_OF_ITEMS_RE = /("name": "Articoli Frontaliere",\s*"numberOfItems": )(\d+)/;

/**
 * How many ListItem entries this list keeps. Mirrors `ITEM_LIST_CAP` in
 * build-plugins/staticPagesPlugin.ts, which truncates the emitted JSON-LD to
 * the same number — so anything stored past this point is parsed, bundled and
 * shipped to clients, then thrown away at render time.
 *
 * The list had reached 3619 entries, 649 KB of seo-pages.ts and ~630 KB of the
 * 1.13 MB `assets/seo-pages.js` chunk, all of it for items no page ever shows.
 *
 * `numberOfItems` is NOT capped: it states how large the collection is, not how
 * many entries are listed, and the emission cap already depends on that
 * distinction ("keep numberOfItems accurate (reflects total list size)").
 */
export const ARTICLE_ITEM_LIST_CAP = 100;

/**
 * Locate the "Articoli Frontaliere" `itemListElement` array within the full
 * seo-pages.ts source, so every regex match below can be bounded to it
 * instead of scanning the whole file. Returns `{ blockStart, blockEnd }` —
 * the array's items live in `pagesSrc.slice(blockStart, blockEnd)` — or
 * `null` if the header (and thus the whole ItemList) can't be found.
 *
 * Relies on the array's known, consistent shape (verified against the real
 * committed file): every ListItem entry is a single line ending in `}` or
 * `},`, with no nested arrays/multi-line objects inside an entry, so the
 * first line after the header that is *only* a closing bracket (optionally
 * with trailing `,`/`;`) is unambiguously the array's own closing `]` — the
 * same single-line-entry assumption the original inline regex in
 * scripts/create-article.mjs already relied on, just now made explicit and
 * bounded instead of implicit and unbounded.
 */
export function locateItemListBlock(pagesSrc) {
  const headerMatch = pagesSrc.match(NUMBER_OF_ITEMS_RE);
  if (!headerMatch) return null;
  const blockStart = headerMatch.index + headerMatch[0].length;
  const closeMatch = /\n[ \t]*\][,;]?/.exec(pagesSrc.slice(blockStart));
  if (!closeMatch) return null;
  const blockEnd = blockStart + closeMatch.index + closeMatch[0].length;
  return { blockStart, blockEnd };
}

// Matches the LAST ListItem entry in the array — i.e. one immediately
// followed (modulo whitespace) by the closing `]` of `itemListElement` — and
// captures its own "position" value (group 1). Applied only within the
// bounds returned by locateItemListBlock() below — never against the full
// file — so it cannot match an unrelated array elsewhere in seo-pages.ts.
const LAST_ITEM_RE = /"position":\s*(\d+)(,\s*"name":(?:[^}])*"url": `[^`]*` \})\s*\n(\s*\])/;

/**
 * Append a new ListItem at the end of the array, incrementing
 * numberOfItems. Returns the new full source string, or `null` if the
 * ItemList shape could not be found — callers MUST treat `null` as "left
 * untouched" and log a warning rather than silently dropping the write.
 *
 * The new position is derived from the LAST item's own "position" value
 * (+1), never from the `numberOfItems` header — a prior registration could
 * leave the header lagging one behind the real last position (seen in the
 * wild: header said 3085 while the last ListItem already read
 * "position": 3086), and trusting the header there duplicates a position
 * instead of continuing the sequence. Deriving from the real last item also
 * self-heals that header drift on every subsequent append.
 *
 * @param {string} pagesSrc - current services/seo/seo-pages.ts source
 * @param {{ name: string, url: string }} item - `url` is the raw template-
 *   literal body, e.g. `` `${BASE_URL}/articoli-frontaliere/my-slug` ``
 *   (without the surrounding backticks).
 */
export function appendArticleListItem(pagesSrc, { name, url }) {
  if (!NUMBER_OF_ITEMS_RE.test(pagesSrc)) return null;

  const block = locateItemListBlock(pagesSrc);
  if (!block) return null;
  const blockSrc = pagesSrc.slice(block.blockStart, block.blockEnd);
  const lastItemMatch = blockSrc.match(LAST_ITEM_RE);
  if (!lastItemMatch) return null;

  // At the cap, bump the count and stop there. staticPagesPlugin truncates the
  // emitted JSON-LD to ARTICLE_ITEM_LIST_CAP entries, so an appended item past
  // that point never reaches a page — it only grows the file and the client
  // chunk. `numberOfItems` still moves, because it reports the size of the
  // collection rather than the length of the list.
  //
  // Counted from the HEADER here, not from the last item's `position` the way
  // the uncapped path below does. Once the list is capped the two stop being
  // the same number — the last listed position is 100 while the collection is
  // in the thousands — so deriving from the position would walk the header
  // backwards to 101 on the next publish and keep it there.
  const listed = (blockSrc.match(/\{ "@type": "ListItem"/g) ?? []).length;
  if (listed >= ARTICLE_ITEM_LIST_CAP) {
    const declared = parseInt(pagesSrc.match(NUMBER_OF_ITEMS_RE)[2], 10);
    return pagesSrc.replace(NUMBER_OF_ITEMS_RE, `$1${declared + 1}`);
  }

  const newCount = parseInt(lastItemMatch[1], 10) + 1;
  const newListItem = `          { "@type": "ListItem", "position": ${newCount}, "name": "${escapeJsonString(name)}", "url": \`${url}\` }`;
  // Replacer FUNCTION, not a template string — `name` is an AI-generated
  // article title and a literal "$" + digit in it (e.g. "$14.4 billion")
  // would otherwise be re-expanded as a $1/$2/$3 capture-group backreference
  // by String.prototype.replace(). Same bug class as create-article.mjs's
  // replaceCaptureSafe (docs/AGENTS-HISTORY.md#blog-meta-replace-backref).
  const newBlockSrc = blockSrc.replace(LAST_ITEM_RE, (_m, g1, g2, g3) => `"position": ${g1}${g2},\n${newListItem}\n${g3}`);

  let next = pagesSrc.slice(0, block.blockStart) + newBlockSrc + pagesSrc.slice(block.blockEnd);
  next = next.replace(NUMBER_OF_ITEMS_RE, `$1${newCount}`);
  return next;
}

/**
 * Rename-safe insert-or-replace. If a ListItem whose url === renameFromUrl
 * exists (searched only within the "Articoli Frontaliere" ItemList block —
 * see locateItemListBlock), REPLACE it in place — same position, same
 * trailing comma (or lack thereof) read directly off the matched entry,
 * never assumed — so renaming an article can never leave a duplicate
 * old-slug entry behind, and can never mistakenly rewrite an unrelated
 * `"url": ...` occurrence elsewhere in the file that happens to share the
 * same string. If the old entry can't be found within the block (already
 * cleaned up / never existed), falls back to appendArticleListItem so the
 * item is never silently dropped.
 *
 * @param {string} pagesSrc
 * @param {{ name: string, url: string, renameFromUrl?: string }} item
 * @returns {string|null} new source, or null if the ItemList shape wasn't found
 */
export function upsertArticleListItem(pagesSrc, { name, url, renameFromUrl }) {
  if (renameFromUrl) {
    const block = locateItemListBlock(pagesSrc);
    if (block) {
      const findRe = new RegExp(
        '\\{\\s*"@type":\\s*"ListItem",\\s*"position":\\s*(\\d+),\\s*"name":\\s*"(?:[^"\\\\]|\\\\.)*",\\s*"url":\\s*`' +
          escapeRegex(renameFromUrl) +
          '`\\s*\\}(,?)'
      );
      const blockSrc = pagesSrc.slice(block.blockStart, block.blockEnd);
      const m = blockSrc.match(findRe);
      if (m) {
        const position = m[1];
        const trailingComma = m[2] || '';
        const replacement = `{ "@type": "ListItem", "position": ${position}, "name": "${escapeJsonString(name)}", "url": \`${url}\` }${trailingComma}`;
        const absoluteIndex = block.blockStart + m.index;
        return (
          pagesSrc.slice(0, absoluteIndex) +
          replacement +
          pagesSrc.slice(absoluteIndex + m[0].length)
        );
      }
    }
    // Old entry not found (or block not located) — fall through to append
    // so the rename is never silently dropped.
  }
  return appendArticleListItem(pagesSrc, { name, url });
}
