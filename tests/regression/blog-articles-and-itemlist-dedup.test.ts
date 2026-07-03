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
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

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

    expect(urls.length, 'sanity check: expected to find a substantial number of ListItem urls').toBeGreaterThan(100);

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
