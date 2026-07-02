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
 * through this module. `upsertArticleListItem` is the rename-safe entry
 * point: any future slug-rename/migration tooling MUST use it (with
 * `renameFromUrl`) instead of hand-rolled regex/string-splice, so a rename
 * REPLACES the existing entry in place rather than leaving a duplicate.
 */

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeJsonString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const NUMBER_OF_ITEMS_RE = /("name": "Articoli Frontaliere",\s*"numberOfItems": )(\d+)/;

// Matches the LAST ListItem entry in the array — i.e. one immediately
// followed (modulo whitespace) by the closing `]` of `itemListElement`.
const LAST_ITEM_RE = /("url": `[^`]*` \})\s*\n(\s*\])/;

/**
 * Append a new ListItem at the end of the array, incrementing
 * numberOfItems. Returns the new full source string, or `null` if the
 * ItemList shape could not be found — callers MUST treat `null` as "left
 * untouched" and log a warning rather than silently dropping the write.
 *
 * @param {string} pagesSrc - current services/seo/seo-pages.ts source
 * @param {{ name: string, url: string }} item - `url` is the raw template-
 *   literal body, e.g. `` `${BASE_URL}/articoli-frontaliere/my-slug` ``
 *   (without the surrounding backticks).
 */
export function appendArticleListItem(pagesSrc, { name, url }) {
  const countMatch = pagesSrc.match(NUMBER_OF_ITEMS_RE);
  if (!countMatch) return null;
  const newCount = parseInt(countMatch[2], 10) + 1;
  let next = pagesSrc.replace(NUMBER_OF_ITEMS_RE, `$1${newCount}`);

  if (!LAST_ITEM_RE.test(next)) return null;
  const newListItem = `          { "@type": "ListItem", "position": ${newCount}, "name": "${escapeJsonString(name)}", "url": \`${url}\` }`;
  next = next.replace(LAST_ITEM_RE, `$1,\n${newListItem}\n$2`);
  return next;
}

/**
 * Rename-safe insert-or-replace. If a ListItem whose url === renameFromUrl
 * exists, REPLACE it in place — same position, same trailing comma (or
 * lack thereof) read directly off the matched entry, never assumed — so
 * renaming an article can never leave a duplicate old-slug entry behind.
 * If the old entry can't be found (already cleaned up / never existed),
 * falls back to appendArticleListItem so the item is never silently
 * dropped.
 *
 * @param {string} pagesSrc
 * @param {{ name: string, url: string, renameFromUrl?: string }} item
 * @returns {string|null} new source, or null if the ItemList shape wasn't found
 */
export function upsertArticleListItem(pagesSrc, { name, url, renameFromUrl }) {
  if (renameFromUrl) {
    const findRe = new RegExp(
      '\\{\\s*"@type":\\s*"ListItem",\\s*"position":\\s*(\\d+),\\s*"name":\\s*"(?:[^"\\\\]|\\\\.)*",\\s*"url":\\s*`' +
        escapeRegex(renameFromUrl) +
        '`\\s*\\}(,?)'
    );
    const m = pagesSrc.match(findRe);
    if (m) {
      const position = m[1];
      const trailingComma = m[2] || '';
      const replacement = `{ "@type": "ListItem", "position": ${position}, "name": "${escapeJsonString(name)}", "url": \`${url}\` }${trailingComma}`;
      return pagesSrc.slice(0, m.index) + replacement + pagesSrc.slice(m.index + m[0].length);
    }
    // Old entry not found — fall through to append so the rename is never
    // silently dropped.
  }
  return appendArticleListItem(pagesSrc, { name, url });
}
