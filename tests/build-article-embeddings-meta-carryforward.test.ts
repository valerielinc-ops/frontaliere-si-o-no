import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SKIP_LIVE_DATA } from './helpers/live-data';
import { parseEmbeddingArticleMetadata } from '../scripts/build-article-embeddings.mjs';

/**
 * Regression guard for the evidence-embeddings builder (#main-red 2026-06-11).
 *
 * The two degraded "meta-only" exit paths in build-article-embeddings.mjs
 * (no provider key configured / provider chain exhausted at request time) leave
 * the committed `data/article-embeddings.bin` store untouched. They MUST keep
 * the existing `perArticle` hash→slug map in the rewritten meta — otherwise
 * embeddingMatcher.findTopK resolves every neighbour slug to null and
 * tests/scripts/lib/scoring/embeddingStoreBinary.test.ts goes red on a bot
 * direct-to-main evidence refresh with no culprit PR.
 *
 * Source-check (the builder is a monolithic main() with process.exit + network,
 * not cleanly importable): assert both degraded paths carry `perArticle`
 * forward, mirroring the committed meta of the unchanged store.
 */
describe('build-article-embeddings — degraded paths preserve perArticle', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../scripts/build-article-embeddings.mjs'),
    'utf8',
  );

  it('captures the existing meta perArticle map before the degraded writes', () => {
    expect(src).toMatch(/existingPerArticle\s*=\s*m\.perArticle/);
  });

  it('carries perArticle forward in BOTH meta-only degraded exit paths', () => {
    const occurrences = src.match(/perArticle:\s*existingPerArticle/g) || [];
    // One per degraded path: "no provider key" + "provider chain exhausted".
    expect(occurrences.length).toBe(2);
  });

  it.skipIf(SKIP_LIVE_DATA)('the committed meta sidecar actually has a non-empty perArticle map', () => {
    const meta = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../data/article-embeddings-meta.json'), 'utf8'),
    );
    expect(meta.perArticle).toBeTypeOf('object');
    expect(Object.keys(meta.perArticle).length).toBe(meta.count);
  });
});

describe('build-article-embeddings metadata source reader', () => {
  it('projects title and excerpt from a complete static module and rejects malformed source', () => {
    const source = [
      'const blogMetaIt: Record<string, string> = {',
      "  'blog.article.alpha.title': 'Alpha title',",
      "  'blog.article.alpha.excerpt': 'Alpha excerpt',",
      "  'blog.article.invalid_id.title': 'Not an embedding slug',",
      "  'other': 'Ignored',",
      '};',
      'export default blogMetaIt;',
    ].join('\n');

    expect(parseEmbeddingArticleMetadata(source, 'fixture-blog-meta-it.ts')).toEqual(new Map([
      ['alpha', { title: 'Alpha title', excerpt: 'Alpha excerpt' }],
    ]));
    expect(() => parseEmbeddingArticleMetadata('const blogMetaIt = {', 'fixture-blog-meta-it.ts'))
      .toThrow(/TypeScript syntax error/u);
  });
});
