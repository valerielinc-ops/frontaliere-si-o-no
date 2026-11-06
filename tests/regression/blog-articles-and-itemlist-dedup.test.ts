/**
 * Regression: no duplicate ids / ListItem URLs (issue #3294)
 *
 * Deferred cleanup from PR #3293 (which fixed #2834's comma-corruption
 * class of bug). Two confirmed-live duplicate defects were found:
 *
 *  1. `data/blog-articles-data.ts` — the entire "Evergreen SEO articles —
 *     March 2026" block (149 entries) had been appended TWICE, producing
 *     149 duplicate `id:` values (e.g. `guida-cambio-franco-euro-frontaliere`
 *     ×2). Fixed by removing the second (stale-author) copy.
 *  2. `services/seo/seo-pages.ts` — the "Articoli Frontaliere" ItemList
 *     JSON-LD registered the same URL
 *     (`/articoli-frontaliere/ristorni-fiscali-frontaliere`) twice under two
 *     different `position`/`name` pairs. Fixed by removing the stale,
 *     truncated-title entry and keeping the one matching the live
 *     `blog-meta-it.ts` title.
 *
 * Nothing previously asserted id-uniqueness for either source, so this test
 * guards against both duplicate classes recurring (e.g. a future
 * copy-paste of an evergreen batch, or `create-article.mjs` being invoked
 * twice for the same slug).
 *
 * Regression: ItemList position/numberOfItems/name-corruption (issue #3358)
 *
 * A separate, more severe corruption was found in the same "Articoli
 * Frontaliere" ItemList block: 78 `ListItem` entries had their `name` field
 * overwritten with a raw, truncated JSON fragment (either a full JSON-LD
 * dump like `{\"@context\":\"https://schema.org\",...` or a locale-object
 * dump like `{\"it\":\"Daverio: i pazienti...`) instead of the real article
 * title, two `position` numbers were reused by two different articles, and
 * `numberOfItems` (3085) didn't match the true entry count (3058, later
 * 3055 once 3 unrecoverable dead entries were removed). Fixed by
 * `scripts/one-off/fix-itemlist-articoli-frontaliere.mjs`: recovered names
 * from `blog-meta-it.ts` titles, removed the 3 confirmed-dead entries, and
 * renumbered `position` sequentially. This test guards against the same
 * class of corruption recurring undetected.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { locateItemListBlock, ARTICLE_ITEM_LIST_CAP } from '../../scripts/lib/seo-pages-article-list.mjs';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Extracts every `ListItem` entry (position + name + url) from the
 * "Articoli Frontaliere" `itemListElement` array in the given seo-pages.ts
 * source, using the same block-locating helper the production append/rename
 * tooling relies on (`locateItemListBlock`), so this test is bounded to the
 * exact same array instead of re-implementing a second, potentially
 * drifting "find the block" heuristic.
 */
function extractArticoliFrontaliereListItems(source: string) {
  const block = locateItemListBlock(source);
  expect(block, '"Articoli Frontaliere" ItemList block not found').not.toBeNull();
  const blockSrc = source.slice(block!.blockStart, block!.blockEnd);

  const numberOfItemsMatch = source
    .slice(Math.max(0, block!.blockStart - 200), block!.blockStart)
    .match(/"numberOfItems":\s*(\d+)\s*$/);
  expect(numberOfItemsMatch, 'numberOfItems value not found immediately before the block').not.toBeNull();
  const numberOfItems = Number(numberOfItemsMatch![1]);

  const ENTRY_RE =
    /\{\s*"@type":\s*"ListItem",\s*"position":\s*(\d+),\s*"name":\s*"((?:[^"\\]|\\.)*)",\s*"url":\s*`([^`]*)`\s*\}/g;
  const entries: Array<{ position: number; name: string; url: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = ENTRY_RE.exec(blockSrc))) {
    entries.push({ position: Number(m[1]), name: m[2], url: m[3] });
  }

  return { entries, numberOfItems };
}

describe('blog-articles-data.ts — no duplicate ids', () => {
  it('every `id:` field in RAW_ARTICLES is unique', () => {
    const filePath = path.join(ROOT, 'data/blog-articles-data.ts');
    const source = fs.readFileSync(filePath, 'utf-8');

    // Matches the `id: 'slug'` field on its own line inside each article
    // object literal (see `interface Article` in the same file).
    const ID_FIELD_RE = /^\s*id:\s*'([^']+)'/gm;
    const ids: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = ID_FIELD_RE.exec(source))) {
      ids.push(m[1]);
    }

    expect(ids.length, 'sanity check: expected to find a substantial number of article ids').toBeGreaterThan(100);

    const seen = new Map<string, number>();
    for (const id of ids) {
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1);

    expect(
      duplicates,
      `duplicate article id(s) found in data/blog-articles-data.ts: ${JSON.stringify(duplicates)}`,
    ).toEqual([]);
  });
});

describe('seo-pages.ts — "Articoli Frontaliere" ItemList has no duplicate URLs', () => {
  it('every ListItem "url" within the ItemList block is unique', () => {
    const filePath = path.join(ROOT, 'services/seo/seo-pages.ts');
    const source = fs.readFileSync(filePath, 'utf-8');

    // Same bounding strategy as scripts/lib/seo-pages-article-list.mjs:
    // locate the "Articoli Frontaliere" ItemList header, then its own
    // `itemListElement` array, so we never scan unrelated ItemList/HowTo
    // arrays elsewhere in this ~10k-line file.
    const NUMBER_OF_ITEMS_RE = /"name": "Articoli Frontaliere",\s*"numberOfItems": (\d+)/;
    const headerMatch = source.match(NUMBER_OF_ITEMS_RE);
    expect(headerMatch, '"Articoli Frontaliere" ItemList header not found').not.toBeNull();

    const blockStart = headerMatch!.index! + headerMatch![0].length;
    const closeMatch = /\n[ \t]*\][,;]?/.exec(source.slice(blockStart));
    expect(closeMatch, 'closing "]" of itemListElement array not found').not.toBeNull();
    const blockEnd = blockStart + closeMatch!.index! + closeMatch![0].length;
    const block = source.slice(blockStart, blockEnd);

    const URL_RE = /"url":\s*`([^`]*)`/g;
    const urls: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(block))) {
      urls.push(m[1]);
    }

    // The list is capped at ARTICLE_ITEM_LIST_CAP entries (#4974) — the same
    // number staticPagesPlugin emits — so this is an equality, not a floor.
    expect(urls.length, 'sanity check: expected the ItemList to be at its cap').toBe(
      ARTICLE_ITEM_LIST_CAP,
    );

    const seen = new Map<string, number>();
    for (const url of urls) {
      seen.set(url, (seen.get(url) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1);

    expect(
      duplicates,
      `duplicate ListItem url(s) found in "Articoli Frontaliere" ItemList: ${JSON.stringify(duplicates)}`,
    ).toEqual([]);
  });
});

describe('seo-pages.ts — "Articoli Frontaliere" ItemList position/numberOfItems/name integrity (issue #3358)', () => {
  // Matches a `name` value that is actually an escaped JSON fragment
  // instead of a plain article title — the corruption class fixed by
  // scripts/one-off/fix-itemlist-articoli-frontaliere.mjs. Two shapes seen:
  //   "{\"@context\":\"https://schema.org\",\"@type\":\"Artic..."  (JSON-LD dump)
  //   "{\"it\":\"Daverio: i pazienti si spostano a Gazzad..."      (locale-object dump)
  const CORRUPTED_NAME_RE = /^\{\s*\\"[a-zA-Z@][a-zA-Z0-9_]*\\"\s*:/;

  it('every ListItem "position" equals its 1-based index in array order, with no gaps or duplicates', () => {
    const filePath = path.join(ROOT, 'services/seo/seo-pages.ts');
    const source = fs.readFileSync(filePath, 'utf-8');
    const { entries } = extractArticoliFrontaliereListItems(source);

    expect(entries.length, 'sanity check: expected the ItemList to be at its cap').toBe(
      ARTICLE_ITEM_LIST_CAP,
    );

    const seen = new Map<number, number>();
    for (const e of entries) {
      seen.set(e.position, (seen.get(e.position) ?? 0) + 1);
    }
    const duplicatePositions = [...seen.entries()].filter(([, count]) => count > 1);
    expect(
      duplicatePositions,
      `duplicate ListItem position(s) found: ${JSON.stringify(duplicatePositions)}`,
    ).toEqual([]);

    const positions = entries.map((e) => e.position);
    const expected = entries.map((_, idx) => idx + 1);
    expect(
      positions,
      'ListItem "position" values must be exactly 1..N in array order, with no gaps',
    ).toEqual(expected);
  });

  /**
   * `numberOfItems` used to have to equal the entry count. Since #4974 the list
   * is capped at ARTICLE_ITEM_LIST_CAP — the same number staticPagesPlugin
   * emits — while `numberOfItems` keeps reporting the size of the whole
   * collection. That is not a weakening: it is the shape the LIVE page has
   * always served (measured on /articoli-frontaliere/: `numberOfItems` 3619
   * with 100 `itemListElement`), because the emitter truncated the array
   * without touching the header. The source now simply stores what it serves.
   *
   * The check is correspondingly stricter, not looser: the entry count must be
   * EXACTLY the cap (not merely ≤ it, which a truncation bug would also
   * satisfy), and the header must still exceed it — a header that fell to the
   * cap would mean the append path stopped counting the collection.
   */
  it('"numberOfItems" reports the whole collection while the list stays at the cap', () => {
    const filePath = path.join(ROOT, 'services/seo/seo-pages.ts');
    const source = fs.readFileSync(filePath, 'utf-8');
    const { entries, numberOfItems } = extractArticoliFrontaliereListItems(source);

    expect(entries.length, 'the stored list must sit exactly at the emission cap').toBe(
      ARTICLE_ITEM_LIST_CAP,
    );
    expect(
      numberOfItems,
      'numberOfItems must still count the whole collection — if it fell to the cap, ' +
        'appendArticleListItem stopped tracking published articles',
    ).toBeGreaterThan(ARTICLE_ITEM_LIST_CAP);
  });

  it('no ListItem "name" is a corrupted escaped-JSON fragment', () => {
    const filePath = path.join(ROOT, 'services/seo/seo-pages.ts');
    const source = fs.readFileSync(filePath, 'utf-8');
    const { entries } = extractArticoliFrontaliereListItems(source);

    const corrupted = entries.filter((e) => CORRUPTED_NAME_RE.test(e.name));
    expect(
      corrupted,
      `ListItem entries with a corrupted JSON-fragment "name" found: ${JSON.stringify(
        corrupted.map((e) => ({ position: e.position, url: e.url, name: e.name.slice(0, 60) })),
      )}`,
    ).toEqual([]);
  });
});
