import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseArticleUrlSlugs } from '../packages/articles/engine/shared/articleReaderSource.mjs';
import { readBlogUrlSlugs } from '../packages/articles/engine/shared/articleReaders';

const ROOT = path.resolve(import.meta.dirname, '..');

const REORDERED_SOURCE = `
  export const BLOG_SLUGS: Record<string, Record<string, string>> = {
  'article-1': {
    fr: 'article-1-fr',
    it: 'article-1-it',
    de: 'article-1-de',
    en: 'article-1-en',
  },
};
`;

describe('parseArticleUrlSlugs', () => {
  it('reads locale properties by key, independently of their source order', () => {
    expect(parseArticleUrlSlugs(REORDERED_SOURCE, 'BLOG_SLUGS')).toEqual({
      'article-1': {
        it: 'article-1-it',
        en: 'article-1-en',
        de: 'article-1-de',
        fr: 'article-1-fr',
      },
    });
  });

  it('rejects a non-string source instead of silently treating it as an empty map', () => {
    expect(() => parseArticleUrlSlugs(null, 'BLOG_SLUGS')).toThrow(TypeError);
    expect(() => parseArticleUrlSlugs({} as never, 'BLOG_SLUGS')).toThrow(/source.*string/i);
  });

  it('rejects a non-string or empty constant name', () => {
    expect(() => parseArticleUrlSlugs(REORDERED_SOURCE, null)).toThrow(TypeError);
    expect(() => parseArticleUrlSlugs(REORDERED_SOURCE, '')).toThrow(TypeError);
  });

  it('rejects empty or whitespace-only source and constant names', () => {
    expect(() => parseArticleUrlSlugs('', 'BLOG_SLUGS')).toThrow(/source.*non-empty string/i);
    expect(() => parseArticleUrlSlugs(' \n\t', 'BLOG_SLUGS')).toThrow(/source.*non-empty string/i);
    expect(() => parseArticleUrlSlugs(REORDERED_SOURCE, '   ')).toThrow(/slugConst.*non-empty string/i);
  });

  it('signals a slug entry whose locale map is partial', () => {
    const partial = REORDERED_SOURCE.replace("fr: 'article-1-fr',", '');
    expect(() => parseArticleUrlSlugs(partial, 'BLOG_SLUGS')).toThrow(/article-1.*fr/i);
  });

  it('rejects duplicate top-level article ids instead of overwriting the first URL map', () => {
    expect(() => parseArticleUrlSlugs(
      `const BLOG_SLUGS = {
        "article": { it: "italiano-1", en: "english-1", de: "deutsch-1", fr: "francais-1" },
        "article": { it: "italiano-2", en: "english-2", de: "deutsch-2", fr: "francais-2" }
      };`,
      'BLOG_SLUGS',
    )).toThrow(/duplicate article id/i);
  });

  it('does not let the shared reader swallow a parser contract error', () => {
    const fakeFs = {
      existsSync: () => true,
      readFileSync: () => REORDERED_SOURCE,
    };
    const fakePath = { resolve: (...parts: string[]) => parts.join('/') };

    expect(() => readBlogUrlSlugs(
      fakeFs as never,
      fakePath as never,
      '/tmp',
      'routerBlogData.ts',
      null as never,
    )).toThrow(TypeError);
  });

  it('rejects a missing or malformed declaration instead of returning an empty fallback', () => {
    expect(() => parseArticleUrlSlugs('export const OTHER = {};', 'BLOG_SLUGS'))
      .toThrow(/missing slug map declaration/i);
    expect(() => parseArticleUrlSlugs(
      `export const BLOG_SLUGS = {
        "article": { it: "italiano", en: "english", de: "deutsch", fr: "francais" }
      `,
      'BLOG_SLUGS',
    )).toThrow(/missing slug map declaration/i);
  });

  it('rejects an existing empty declaration instead of falling back to article ids', () => {
    expect(() => parseArticleUrlSlugs('export const BLOG_SLUGS = {};', 'BLOG_SLUGS'))
      .toThrow(/empty slug map/i);
  });

  it('rejects comment-only maps and top-level content outside the entry grammar', () => {
    expect(() => parseArticleUrlSlugs(`const BLOG_SLUGS = {
      /* generated registry is empty */
    };`, 'BLOG_SLUGS')).toThrow(/empty(?: or malformed)? slug map/i);
    expect(() => parseArticleUrlSlugs(`const BLOG_SLUGS = {
      'article': { it: 'it', en: 'en', de: 'de', fr: 'fr' },
      malformed: true,
    };`, 'BLOG_SLUGS')).toThrow(/malformed slug map/i);
  });

  it('does not treat a complete entry inside a comment as a slug registry row', () => {
    expect(() => parseArticleUrlSlugs(`const BLOG_SLUGS = {
      // 'stale': { it: 'it', en: 'en', de: 'de', fr: 'fr' },
    };`, 'BLOG_SLUGS')).toThrow(/empty(?: or malformed)? slug map/i);
  });
});

describe('ogPagesPlugin standalone module graph', () => {
  it('uses the explicit ESM extension for the shared parser import', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'packages/articles/engine/ogPagesPlugin.ts'),
      'utf8',
    );
    expect(source).toContain("from './shared/articleReaderSource.mjs'");
  });
});
