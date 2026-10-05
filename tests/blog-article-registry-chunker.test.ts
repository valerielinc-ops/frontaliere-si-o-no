import { describe, expect, it } from 'vitest';

import { chunkBlogArticleRegistry } from '../scripts/lib/blog-article-registry-chunker.mjs';

describe('chunkBlogArticleRegistry', () => {
  it('types bounded chunks and preserves every raw article row', () => {
    const source = `interface Article { id: string; category: string; date: string }
const RAW_ARTICLES = [
  { id: 'one', category: 'novita', date: '2026-10-01' },
  { id: 'two', category: 'novita', date: '2026-10-02' },
  { id: 'three', category: 'novita', date: '2026-10-03' },
];
export const ARTICLES = RAW_ARTICLES satisfies Article[];
`;

    const result = chunkBlogArticleRegistry(source, 2);

    expect(result.chunkCount).toBe(2);
    expect(result.source).toContain('const RAW_ARTICLES_CHUNK_01: Article[] = [');
    expect(result.source).toContain('const RAW_ARTICLES_CHUNK_02: Article[] = [');
    expect(result.source).toContain("\n  { id: 'one'");
    expect(result.source).toContain('const RAW_ARTICLES: Article[] = [');
    expect(result.source).toContain('...RAW_ARTICLES_CHUNK_01');
    expect(result.source).toContain('...RAW_ARTICLES_CHUNK_02');
    for (const id of ['one', 'two', 'three']) {
      expect(result.source).toContain(`id: '${id}'`);
    }
  });

  it('is idempotent for an already chunked registry', () => {
    const source = `const RAW_ARTICLES_CHUNK_01: Article[] = [];
const RAW_ARTICLES: Article[] = [...RAW_ARTICLES_CHUNK_01] satisfies Article[];
`;

    expect(chunkBlogArticleRegistry(source)).toEqual({ source, chunkCount: 0 });
  });

  it('rejects a non-positive chunk size', () => {
    expect(() => chunkBlogArticleRegistry('const RAW_ARTICLES = [];', 0))
      .toThrow('chunkSize must be a positive integer');
  });
});
