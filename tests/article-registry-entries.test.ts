import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArticleRegistryEntries } from '../packages/articles/engine/shared/articleRegistryEntries';
import { renderArticleHubCards } from '../packages/articles/engine/articlesHubCards';
import { compareArticleSourceDates } from '../services/articleSourceDates';
import { SKIP_LIVE_DATA } from './helpers/live-data';

/**
 * The article registries (`blog-articles-data.ts`, `swiss-articles-data.ts`)
 * do not keep a fixed field order: an entry may carry `updatedAt` between
 * `date` and `image`, or before `category`. Every build-time reader used to
 * be a regex that spelled the order out, so on 2026-10-05 306 blog and 60
 * svizzera entries never reached the hub cards. These tests pin the parser
 * that replaced them, and the guard at the bottom keeps the order-encoding
 * regex from coming back.
 */

const isoDaysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const NEWEST = isoDaysAgo(1);
const OLDER = isoDaysAgo(10);
const OLDEST = isoDaysAgo(20);

const REGISTRY_SOURCE = `
export interface Article {
 id: string;
 category: 'fiscale' | 'pratico';
 date: string;
 updatedAt?: string;
 image: string;
}

const RAW_ARTICLES = [
 {
 id: 'plain-entry',
 category: 'fiscale',
 date: '${OLDER}',
 image: '/images/blog/plain-entry.webp',
 hasCalculator: true,
 },
 {
 id: 'updated-between-date-and-image',
 category: 'pratico',
 date: '${NEWEST}',
 updatedAt: '${NEWEST}',
 image: '/images/blog/updated-between-date-and-image.webp',
 hasCalculator: true,
 },
 {
 id: 'updated-before-category',
 updatedAt: '${OLDER}',
 category: 'novita',
 date: '${OLDEST}',
 image: '/images/blog/updated-before-category.webp',
 hasCalculator: true,
 },
 {
 id: 'unknown-date',
 category: 'fiscale',
 date: '',
 image: '/images/blog/unknown-date.webp',
 hasCalculator: true,
 },
] satisfies Article[];
`;

const cardsFor = (source: string): string => {
  const articles = parseArticleRegistryEntries(source)
    .map(({ id, category, date, image }) => ({ id, category, date, image }))
    .sort(compareArticleSourceDates);
  return renderArticleHubCards({
    articles,
    locale: 'it',
    sectionSlug: 'articoli-frontaliere',
    localePrefix: '',
    resolveSlug: () => undefined,
    resolveMeta: () => null,
  });
};

describe('parseArticleRegistryEntries', () => {
  it('reads every entry whatever the field order, skipping the interface body', () => {
    const entries = parseArticleRegistryEntries(REGISTRY_SOURCE);
    expect(entries.map((e) => e.id)).toEqual([
      'plain-entry',
      'updated-between-date-and-image',
      'updated-before-category',
      'unknown-date',
    ]);
    expect(entries[1]).toEqual({
      id: 'updated-between-date-and-image',
      category: 'pratico',
      date: NEWEST,
      updatedAt: NEWEST,
      image: '/images/blog/updated-between-date-and-image.webp',
    });
    expect(entries[2]).toMatchObject({ category: 'novita', date: OLDEST, updatedAt: OLDER });
  });

  // A field name inside another field's quoted value is data, not a field:
  // a regex over the raw object text read `image: 'wrong.jpg'` out of the title.
  it.each([
    ['double-quoted title', `{ id: 'a', category: 'fiscale', title: "Promo image: 'wrong.jpg'", date: '2026-01-01', image: '/images/right.jpg' }`],
    ['single-quoted title with escaped quotes', `{ id: 'a', category: 'fiscale', title: 'Promo image: \\'wrong.jpg\\'', date: '2026-01-01', image: '/images/right.jpg' }`],
    ['apostrophe in a double-quoted title', `{ id: 'a', category: 'fiscale', title: "L'offerta, image: 'wrong.jpg'", date: '2026-01-01', image: '/images/right.jpg' }`],
    ['fake fields before the real ones', `{ title: "id: 'z', image: 'wrong.jpg', date: 'x'", id: 'a', category: 'fiscale', date: '2026-01-01', image: '/images/right.jpg' }`],
  ])('reads only top-level fields, not text inside a quoted value (%s)', (_name, src) => {
    expect(parseArticleRegistryEntries(src)).toEqual([
      { id: 'a', category: 'fiscale', date: '2026-01-01', image: '/images/right.jpg' },
    ]);
  });

  // The real registries open with a prose header ("doesn't", `@/`): read as
  // quotes, an apostrophe or backtick in a comment swallowed the whole file.
  it('skips comments that contain apostrophes and backticks', () => {
    const src = [
      "/** The module isn't imported: the `@/` alias breaks config load. */",
      "// it's appended, not sorted",
      `{ id: 'a', category: 'fiscale', date: '2026-01-01', image: '/images/a.webp' }, // l'ultimo`,
      "/* `b` */ { id: 'b', category: 'pratico', date: '', image: '/images/b.webp' }",
    ].join('\n');
    expect(parseArticleRegistryEntries(src).map((e) => e.id)).toEqual(['a', 'b']);
  });

  describe.skipIf(SKIP_LIVE_DATA)('live registry coverage', () => {
    // CI has the full checkout; a sparse worktree may not materialize the corpus.
    it.each(['packages/articles/content/blog-articles-data.ts', 'packages/articles/content/swiss-articles-data.ts'])(
      'reads every entry of the real registry %s',
      (rel) => {
        const abs = path.resolve(__dirname, '..', rel);
        if (!fs.existsSync(abs)) return;
        const src = fs.readFileSync(abs, 'utf8');
        const declared = (src.match(/^\s*\{\s*id:\s*'/gm) ?? []).length;
        expect(declared).toBeGreaterThan(0);
        expect(parseArticleRegistryEntries(src)).toHaveLength(declared);
      },
    );
  });

  it('never pairs an id with the next entry image', () => {
    const src = "{ id: 'a', category: 'fiscale', date: '' },\n{ id: 'b', category: 'fiscale', date: '', image: '/b.webp' }";
    expect(parseArticleRegistryEntries(src).map((e) => [e.id, e.image])).toEqual([['b', '/b.webp']]);
  });

  it('keeps braces inside quoted fields within the entry', () => {
    const entries = parseArticleRegistryEntries(
      "{ id: 'a', category: 'fiscale', date: '2026-01-01', title: 'Aliquota { speciale }', image: '/images/a.jpg' }",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'a', image: '/images/a.jpg' });
  });
});

describe('hub cards built from the registry', () => {
  const html = cardsFor(REGISTRY_SOURCE);

  it('include the article with updatedAt between date and image, newest first', () => {
    expect(html).toContain('href="/articoli-frontaliere/updated-between-date-and-image/"');
    expect(html.indexOf('updated-between-date-and-image')).toBeLessThan(html.indexOf('plain-entry'));
  });

  it('include the article with updatedAt before category', () => {
    expect(html).toContain('href="/articoli-frontaliere/updated-before-category/"');
  });

  it('render an unknown date as no date, never "Invalid Date"', () => {
    const card = html.split('<a ').find((c) => c.includes('/unknown-date/')) ?? '';
    expect(card).not.toBe('');
    expect(card).not.toContain('ssg-art-date');
    expect(html).not.toContain('Invalid Date');
  });
});

/**
 * Observer: no build-time reader may encode the registry field order again.
 * A regex literal that chains two registry fields with only `',\s*` between
 * them (`date:\s*'…',\s*image:`) is exactly the construct that dropped the
 * entries above. Read the registry with `parseArticleRegistryEntries`.
 */
describe('registry readers do not encode the field order', () => {
  const ROOT = path.resolve(__dirname, '..');
  const DIRS = ['build-plugins', 'packages/articles/engine', 'scripts'];
  const ORDER_ENCODING = /',\\s\*(?:category|date|updatedAt|image):\\s\*'/;

  const sourceFiles = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (abs: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(abs, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(?:[cm]?js|ts)$/.test(e.name) && !/\.test\.[cm]?[jt]s$/.test(e.name)) out.push(p);
      }
    };
    walk(path.join(ROOT, dir));
    return out;
  };

  it('finds the order-encoding construct in a sample', () => {
    const sample = String.raw`/\{\s*id:\s*'([^']+)',\s*category:\s*'([^']+)',\s*date:\s*'([^']*)',\s*image:\s*'([^']+)'/gs`;
    expect(ORDER_ENCODING.test(sample)).toBe(true);
  });

  it('is absent from build-plugins, the article engine and scripts', () => {
    const files = DIRS.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .filter((f) => {
        try {
          return ORDER_ENCODING.test(fs.readFileSync(f, 'utf8'));
        } catch {
          return false; // dangling symlink in a sparse checkout
        }
      })
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
