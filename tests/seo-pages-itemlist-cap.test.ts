import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendArticleListItem,
  locateItemListBlock,
  ARTICLE_ITEM_LIST_CAP,
} from '../scripts/lib/seo-pages-article-list.mjs';

/**
 * The "Articoli Frontaliere" ItemList must not grow past what a page shows.
 *
 * `staticPagesPlugin.ts` truncates the emitted JSON-LD to `ITEM_LIST_CAP = 100`
 * — its own comment explains why: the list "grows by ~1 entry per published
 * article and now exceeds 900 items — that single inline JSON-LD weighs ~170 KB
 * and pushes the section index page over the 200 KB Semrush page-weight budget.
 * Google only needs the first ~100 items."
 *
 * It had reached 3619. Everything past the hundredth was parsed, bundled and
 * shipped in `assets/seo-pages.js` (1.13 MB), then discarded at render time.
 * Trimming the source to exactly what emission keeps left the served HTML
 * byte-identical and took ~665 KB out of the file.
 *
 * Two things have to stay true for that to hold: the stored list stays at the
 * cap, and the appender stops adding entries past it (while still moving
 * `numberOfItems`, which reports collection size, not list length).
 */

const ROOT = path.resolve(__dirname, '..');
const PAGES = fs.readFileSync(path.join(ROOT, 'services', 'seo', 'seo-pages.ts'), 'utf-8');

describe('seo-pages article ItemList stays at the emission cap (#4974)', () => {
  it('stores no more entries than the page emits', () => {
    const block = locateItemListBlock(PAGES);
    expect(block, 'the "Articoli Frontaliere" ItemList could not be located').toBeTruthy();

    const listed = (
      PAGES.slice(block!.blockStart, block!.blockEnd).match(/\{ "@type": "ListItem"/g) ?? []
    ).length;

    expect(
      listed,
      `the ItemList holds ${listed} entries but only the first ${ARTICLE_ITEM_LIST_CAP} are ever ` +
        `emitted (staticPagesPlugin ITEM_LIST_CAP). The rest ship to clients in the ` +
        `seo-pages chunk and are discarded at render.`,
    ).toBeLessThanOrEqual(ARTICLE_ITEM_LIST_CAP);
  });

  it('keeps the cap aligned with the emitter, not just hardcoded here', () => {
    const plugin = fs.readFileSync(
      path.join(ROOT, 'build-plugins', 'staticPagesPlugin.ts'),
      'utf-8',
    );
    const emitted = plugin.match(/const ITEM_LIST_CAP = (\d+)/)?.[1];
    expect(emitted, 'ITEM_LIST_CAP is gone from staticPagesPlugin').toBeTruthy();
    expect(
      Number(emitted),
      'the stored cap and the emitted cap disagree — storing fewer than the page ' +
        'emits would silently shorten the ItemList in the served JSON-LD',
    ).toBe(ARTICLE_ITEM_LIST_CAP);
  });

  it('numberOfItems still reports the whole collection, not the listed slice', () => {
    const declared = Number(
      PAGES.match(/"name": "Articoli Frontaliere",\s*"numberOfItems": (\d+)/)?.[1],
    );
    expect(declared).toBeGreaterThan(ARTICLE_ITEM_LIST_CAP);
  });

  it('appending at the cap bumps numberOfItems without adding an entry', () => {
    const before = Number(
      PAGES.match(/"name": "Articoli Frontaliere",\s*"numberOfItems": (\d+)/)?.[1],
    );
    const next = appendArticleListItem(PAGES, {
      name: 'Un articolo nuovo',
      url: '${BASE_URL}/articoli-frontaliere/un-articolo-nuovo',
    });
    expect(next, 'appendArticleListItem returned null — the ItemList shape moved').toBeTruthy();

    const after = Number(
      next!.match(/"name": "Articoli Frontaliere",\s*"numberOfItems": (\d+)/)?.[1],
    );
    expect(after).toBe(before + 1);

    const block = locateItemListBlock(next!);
    const listed = (
      next!.slice(block!.blockStart, block!.blockEnd).match(/\{ "@type": "ListItem"/g) ?? []
    ).length;
    expect(listed, 'an entry was appended past the cap').toBe(ARTICLE_ITEM_LIST_CAP);
    expect(next).not.toContain('un-articolo-nuovo');
  });
});

/**
 * A rename is not a new article.
 *
 * `upsertArticleListItem` falls back to `appendArticleListItem` when it cannot
 * find the entry it was asked to rename — correct before the cap, when "not
 * found" really did mean "not there". Past the cap the entry is simply not
 * stored, so that fallback would treat every rename of one of the culled
 * articles as a fresh publication and bump `numberOfItems` for it. Once per
 * rename, permanently, with nothing to correct it.
 *
 * The module's own docblock names `upsertArticleListItem` as "the rename-safe
 * entry point: any future slug-rename/migration tooling MUST use it", so this
 * would have gone off the first time such a tool was wired up.
 */
describe('renaming a culled article does not inflate numberOfItems (#4974)', () => {
  const read = () =>
    fs.readFileSync(path.join(ROOT, 'services', 'seo', 'seo-pages.ts'), 'utf-8');
  const countOf = (s: string) =>
    Number(s.match(/"name": "Articoli Frontaliere",\s*"numberOfItems": (\d+)/)?.[1]);

  it('leaves the source untouched when the renamed entry is past the cap', async () => {
    const { upsertArticleListItem } = await import('../scripts/lib/seo-pages-article-list.mjs');
    const src = read();

    const next = upsertArticleListItem(src, {
      name: 'Titolo rinominato',
      url: '${BASE_URL}/articoli-frontaliere/slug-nuovo',
      // An article well past position 100 — culled from the stored list.
      renameFromUrl: '${BASE_URL}/articoli-frontaliere/un-articolo-molto-vecchio',
    });

    expect(countOf(next), 'a rename must not count as a new article').toBe(countOf(src));
    expect(next).toBe(src);
  });

  it('still renames in place when the entry is within the cap', async () => {
    const { upsertArticleListItem } = await import('../scripts/lib/seo-pages-article-list.mjs');
    const src = read();
    const block = locateItemListBlock(src)!;
    const firstUrl = src
      .slice(block.blockStart, block.blockEnd)
      .match(/"url": `([^`]+)`/)?.[1];
    expect(firstUrl, 'no ListItem url found to rename').toBeTruthy();

    const next = upsertArticleListItem(src, {
      name: 'Titolo rinominato',
      url: '${BASE_URL}/articoli-frontaliere/slug-rinominato',
      renameFromUrl: firstUrl!,
    });

    expect(countOf(next), 'an in-place rename must not move the count').toBe(countOf(src));
    expect(next).toContain('slug-rinominato');
    expect(next).not.toContain(firstUrl!);
  });
});
