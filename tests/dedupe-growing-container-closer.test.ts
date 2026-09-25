/**
 * Unit coverage for scripts/lib/dedupe-growing-container-closer.mjs's
 * per-target repair (PR #3622 review follow-up to issue #3617's JSON-only
 * duplicated-root-closer fix). These tests feed the repair functions the
 * documented corrupted shape directly and check the repair logic in
 * isolation — they do not assert that real concurrent-writer git mechanics
 * produce that shape for every target. End-to-end reproduction via real
 * chained rebase (tests/resolve-append-conflicts-idempotency.test.ts) found
 * that only JSON files reach a duplicated closer this way: the array-of-
 * object siblings (blog-articles-data.ts, swiss-articles-data.ts) instead
 * hit a different, already-handled failure (aligned inner-field conflict,
 * safely rejected by the pre-existing article-registry check), and the
 * single-line-entry siblings (blog-meta-*.ts, sitemap*.xml, seo-pages.ts's
 * ItemList) resolve cleanly across chained cycles with no duplication at
 * all. This module is kept as defense-in-depth for the documented shape —
 * a no-op on already-correct input — not as a fix for a confirmed-reachable
 * bug in these targets.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { dedupeBounded, dedupeSelfBounded, repairGrowingContainerCloser } from '../scripts/lib/dedupe-growing-container-closer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_SCRIPT = path.join(ROOT, 'scripts', 'lib', 'dedupe-growing-container-closer.mjs');

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('repairGrowingContainerCloser — blog-articles-data.ts (satisfies-suffixed closer)', () => {
  it('drops the premature `] satisfies Article[];` and keeps the true final one', () => {
    const src = [
      "const RAW_ARTICLES = [",
      "  { id: 'a1', title: 'One' },",
      "] satisfies Article[];",
      "  { id: 'a2', title: 'Two' },",
      "] satisfies Article[];",
      '',
      'export const ARTICLES: Article[] = RAW_ARTICLES.map((a) => ({ ...a, image: cdnBlogImage(a.image) }));',
      '',
    ].join('\n');

    const out = repairGrowingContainerCloser('blog-articles-data.ts', src);
    expect(out).not.toBeNull();
    expect((out as string).match(/\] satisfies Article\[\];/g)?.length).toBe(1);
    expect(out).toContain("{ id: 'a1', title: 'One' },");
    expect(out).toContain("{ id: 'a2', title: 'Two' },");
    expect(out).toContain('export const ARTICLES');
  });

  it('returns null when there is only one closer (nothing to repair)', () => {
    const src = ["const RAW_ARTICLES = [", "  { id: 'a1' },", "] satisfies Article[];", '', 'export const ARTICLES: Article[] = RAW_ARTICLES;', ''].join(
      '\n',
    );
    expect(repairGrowingContainerCloser('blog-articles-data.ts', src)).toBeNull();
  });
});

describe('repairGrowingContainerCloser — swiss-articles-data.ts (plain `];` closer)', () => {
  it('drops the premature plain `];` and keeps the true final one', () => {
    const src = [
      "const RAW_SWISS_ARTICLES: Article[] = [",
      "  { id: 's1' },",
      '];',
      "  { id: 's2' },",
      '];',
      '',
      'export const SWISS_ARTICLES: Article[] = RAW_SWISS_ARTICLES.map((a) => ({ ...a, image: cdnBlogImage(a.image) }));',
      '',
    ].join('\n');

    const out = repairGrowingContainerCloser('swiss-articles-data.ts', src);
    expect(out).not.toBeNull();
    expect((out as string).match(/^\];[ \t]*$/gm)?.length).toBe(1);
    expect(out).toContain("{ id: 's1' },");
    expect(out).toContain("{ id: 's2' },");
  });
});

describe('repairGrowingContainerCloser — blog-meta-*.ts (`};` object closer)', () => {
  it('drops the premature `};` for the Record<string,string> meta map', () => {
    const src = [
      "const blogMetaIt: Record<string, string> = {",
      "  'article-1': 'Title one',",
      '};',
      "  'article-2': 'Title two',",
      '};',
      '',
      'export default blogMetaIt;',
      '',
    ].join('\n');

    const out = repairGrowingContainerCloser('blog-meta-it.ts', src);
    expect(out).not.toBeNull();
    expect((out as string).match(/^\};[ \t]*$/gm)?.length).toBe(1);
    expect(out).toContain("'article-1': 'Title one',");
    expect(out).toContain("'article-2': 'Title two',");
    expect(out).toContain('export default blogMetaIt;');
  });
});

describe('repairGrowingContainerCloser — sitemap*.xml (`</urlset>` root closer)', () => {
  it('drops the premature `</urlset>` and keeps the true final one', () => {
    const src = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '<url><loc>https://frontaliereticino.ch/blog/a1/</loc></url>',
      '</urlset>',
      '<url><loc>https://frontaliereticino.ch/blog/a2/</loc></url>',
      '</urlset>',
      '',
    ].join('\n');

    const out = repairGrowingContainerCloser('sitemap-blog.xml', src);
    expect(out).not.toBeNull();
    expect((out as string).match(/<\/urlset>/g)?.length).toBe(1);
    expect(out).toContain('blog/a1/');
    expect(out).toContain('blog/a2/');
  });
});

describe('repairGrowingContainerCloser — seo-pages.ts (self-bounded ItemList closer)', () => {
  it('drops the premature itemListElement `]` and keeps the true final one', () => {
    const src = [
      '"name": "Articoli Frontaliere",',
      '"numberOfItems": 2,',
      '"itemListElement": [',
      '  { "@type": "ListItem", "position": 1 },',
      '],',
      '  { "@type": "ListItem", "position": 2 },',
      '],',
      'other unrelated trailing content',
      '',
    ].join('\n');

    const out = repairGrowingContainerCloser('seo-pages.ts', src);
    expect(out).not.toBeNull();
    expect((out as string).match(/^\][,;]?\s*$/gm)?.length).toBe(1);
    expect(out).toContain('"position": 1');
    expect(out).toContain('"position": 2');
    expect(out).toContain('other unrelated trailing content');
  });
});

describe('repairGrowingContainerCloser — no-op for unrelated files', () => {
  it('returns null for a file name it does not recognize', () => {
    expect(repairGrowingContainerCloser('router.ts', 'export const X = 1;\n')).toBeNull();
  });
});

describe('dedupeBounded / dedupeSelfBounded — direct unit coverage', () => {
  it('dedupeBounded returns null when openRe does not match', () => {
    expect(dedupeBounded('no opener here', /const RAW_ARTICLES\s*=\s*\[/, /^\];$/gm, null)).toBeNull();
  });

  it('dedupeSelfBounded returns null when openRe does not match', () => {
    expect(dedupeSelfBounded('no opener here', /"itemListElement":\s*\[/, /^\{/, /^\]/)).toBeNull();
  });
});

describe('CLI entry point', () => {
  it('rewrites the file in place only when a repair was applied', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dedupe-cli-'));
    cleanupDirs.push(dir);

    const dupFile = path.join(dir, 'swiss-articles-data.ts');
    writeFileSync(
      dupFile,
      ["const RAW_SWISS_ARTICLES: Article[] = [", "  { id: 's1' },", '];', "  { id: 's2' },", '];', '', 'export const SWISS_ARTICLES = RAW_SWISS_ARTICLES;', ''].join(
        '\n',
      ),
    );
    execFileSync('node', [CLI_SCRIPT, dupFile], { encoding: 'utf-8' });
    const repaired = readFileSync(dupFile, 'utf-8');
    expect(repaired.match(/^\];[ \t]*$/gm)?.length).toBe(1);

    const cleanFile = path.join(dir, 'router.ts');
    const cleanContent = "export const ALL_BLOG_ARTICLE_IDS: string[] = ['a'];\n";
    writeFileSync(cleanFile, cleanContent);
    execFileSync('node', [CLI_SCRIPT, cleanFile], { encoding: 'utf-8' });
    expect(readFileSync(cleanFile, 'utf-8')).toBe(cleanContent);
  });
});
