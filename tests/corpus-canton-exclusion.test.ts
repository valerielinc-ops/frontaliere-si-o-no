/**
 * scripts/pull-articles-corpus.mjs must not bring the canton article sections
 * into packages/articles/content/: they are served from R2 by the Worker and
 * would otherwise enter the SPA bundle and every sync PR. The exclusion is
 * derived from the generated section core and applied to the copy AND to the
 * counts that gate it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CANTON_CONTENT_DIRS,
  CANTON_META_PREFIXES,
  countFiles,
  isCantonCorpusPath,
  mirrorTree,
} from '../scripts/lib/corpus-canton-exclusion.mjs';
import { CANTON_ARTICLE_SECTION_CORE } from '../packages/articles/engine/shared/cantonArticleSectionCore.generated.mjs';
import { ARTICLE_SECTION_CORE } from '../packages/articles/engine/shared/articleSectionCore.mjs';

let tmp: string;

function write(root: string, rel: string, body = 'x') {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-canton-exclusion-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('isCantonCorpusPath', () => {
  it('is derived from every canton entry of the core', () => {
    expect(CANTON_CONTENT_DIRS).toContain('cantons');
    for (const e of Object.values(CANTON_ARTICLE_SECTION_CORE)) {
      expect(CANTON_CONTENT_DIRS).toContain(e.bodyDir);
      expect(CANTON_META_PREFIXES).toContain(`${e.metaPrefix}-`);
    }
  });

  it.each([
    'cantons',
    'cantons/canton-ti/registry.ts',
    'cantons/canton-basilea/slugs.ts',
    'blog-body-canton-ti/it/un-articolo.ts',
    'blog-meta-canton-ti-it.ts',
    'blog-meta-canton-appenzello-fr.ts',
  ])('excludes %s', (rel) => {
    expect(isCantonCorpusPath(rel)).toBe(true);
  });

  it('keeps every file of the two historical sections', () => {
    for (const e of Object.values(ARTICLE_SECTION_CORE)) {
      expect(isCantonCorpusPath(`${e.bodyDir}/it/x.ts`)).toBe(false);
      expect(isCantonCorpusPath(`${e.metaPrefix}-it.ts`)).toBe(false);
    }
    for (const rel of ['routerBlogData.ts', 'routerSwissData.ts', 'seo/seo-blog.ts', 'image-credits/x.json', 'blog-body/cantons/x.ts']) {
      expect(isCantonCorpusPath(rel), rel).toBe(false);
    }
  });
});

describe('mirrorTree / countFiles with the canton exclusion', () => {
  it('copies the site corpus, skips the canton sections, and counts the same tree', () => {
    const src = path.join(tmp, 'src');
    const dst = path.join(tmp, 'dst');
    write(src, 'routerBlogData.ts');
    write(src, 'blog-body/it/a.ts');
    write(src, 'blog-meta-it.ts');
    write(src, 'cantons/canton-ti/registry.ts');
    write(src, 'blog-body-canton-ti/it/b.ts');
    write(src, 'blog-meta-canton-ti-it.ts');

    const opts = { exclude: isCantonCorpusPath };
    expect(countFiles(src, opts)).toBe(3);
    expect(countFiles(src)).toBe(6);

    mirrorTree(src, dst, opts);
    expect(listFiles(dst)).toEqual(['blog-body/it/a.ts', 'blog-meta-it.ts', 'routerBlogData.ts']);
    expect(countFiles(dst, opts)).toBe(countFiles(src, opts));
  });

  it('removes canton files that a previous unfiltered sync left in the destination', () => {
    const src = path.join(tmp, 'src');
    const dst = path.join(tmp, 'dst');
    write(src, 'routerBlogData.ts');
    write(dst, 'routerBlogData.ts');
    write(dst, 'cantons/canton-ti/registry.ts');
    write(dst, 'blog-meta-canton-ti-it.ts');

    mirrorTree(src, dst, { exclude: isCantonCorpusPath });
    expect(listFiles(dst)).toEqual(['routerBlogData.ts']);
  });

  it('without an exclusion behaves as the plain mirror it replaced', () => {
    const src = path.join(tmp, 'src');
    const dst = path.join(tmp, 'dst');
    write(src, 'a/b.ts', 'new');
    write(dst, 'a/b.ts', 'old');
    write(dst, 'stale.ts');
    fs.mkdirSync(path.join(dst, '.git'));
    mirrorTree(src, dst);
    expect(fs.readFileSync(path.join(dst, 'a/b.ts'), 'utf-8')).toBe('new');
    expect(fs.existsSync(path.join(dst, 'stale.ts'))).toBe(false);
    expect(fs.existsSync(path.join(dst, '.git'))).toBe(true);
  });
});
