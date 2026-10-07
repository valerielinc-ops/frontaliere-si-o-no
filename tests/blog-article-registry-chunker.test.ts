import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  ARTICLE_REGISTRY_CHUNK_CONFIGS,
  chunkArticleRegistry,
} from '../scripts/lib/blog-article-registry-chunker.mjs';

const CHUNK_SIZE = 250;

function sourceWithArticles(declarationName: string, count: number) {
  const rows = Array.from(
    { length: count },
    (_, index) => `  { id: 'article-${index}' },`,
  ).join('\n');
  return `const ${declarationName}: Article[] = [\n${rows}\n];\n`;
}

function literalArraySizes(source: string, declarationName: string, chunkPrefix: string) {
  const sourceFile = ts.createSourceFile(
    'article-registry.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const sizes: number[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node)) {
      const name = node.name.getText(sourceFile);
      if (name === declarationName || name.startsWith(`${chunkPrefix}_`)) {
        let initializer = node.initializer;
        while (
          initializer
          && (ts.isSatisfiesExpression(initializer)
            || ts.isAsExpression(initializer)
            || ts.isParenthesizedExpression(initializer))
        ) {
          initializer = initializer.expression;
        }
        if (initializer && ts.isArrayLiteralExpression(initializer)) {
          sizes.push(initializer.elements.length);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return sizes;
}

describe('chunkArticleRegistry', () => {
  it('types bounded blog chunks and preserves every raw article row', () => {
    const source = `interface Article { id: string; category: string; date: string }
const RAW_ARTICLES = [
  { id: 'one', category: 'novita', date: '2026-10-01' },
  { id: 'two', category: 'novita', date: '2026-10-02' },
  { id: 'three', category: 'novita', date: '2026-10-03' },
];
export const ARTICLES = RAW_ARTICLES satisfies Article[];
`;

    const result = chunkArticleRegistry(source, {
      fileName: 'blog-articles-data.ts',
      declarationName: 'RAW_ARTICLES',
      chunkPrefix: 'RAW_ARTICLES_CHUNK',
      chunkSize: 2,
    });

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

  it('uses a distinct chunk namespace for the Swiss registry', () => {
    const source = sourceWithArticles('RAW_SWISS_ARTICLES', 3);
    const result = chunkArticleRegistry(source, {
      fileName: 'swiss-articles-data.ts',
      declarationName: 'RAW_SWISS_ARTICLES',
      chunkPrefix: 'RAW_SWISS_ARTICLES_CHUNK',
      chunkSize: 2,
    });

    expect(result.chunkCount).toBe(2);
    expect(result.source).toContain('const RAW_SWISS_ARTICLES_CHUNK_01: Article[] = [');
    expect(result.source).toContain('const RAW_SWISS_ARTICLES_CHUNK_02: Article[] = [');
    expect(result.source).toContain('const RAW_SWISS_ARTICLES: Article[] = [');
    expect(result.source).not.toContain('RAW_ARTICLES_CHUNK_01');
  });

  it('is idempotent for each mirrored article registry', () => {
    for (const config of ARTICLE_REGISTRY_CHUNK_CONFIGS) {
      const source = `const ${config.chunkPrefix}_01: Article[] = [];
const ${config.declarationName}: Article[] = [...${config.chunkPrefix}_01] satisfies Article[];
`;

      expect(chunkArticleRegistry(source, { ...config, fileName: config.file })).toEqual({
        source,
        chunkCount: 0,
      });
    }
  });

  it('observes the size invariant for every mirrored registry', () => {
    expect(ARTICLE_REGISTRY_CHUNK_CONFIGS.map(({ file }) => file)).toEqual([
      'blog-articles-data.ts',
      'swiss-articles-data.ts',
    ]);

    for (const config of ARTICLE_REGISTRY_CHUNK_CONFIGS) {
      const source = sourceWithArticles(config.declarationName, CHUNK_SIZE + 1);
      const result = chunkArticleRegistry(source, {
        ...config,
        fileName: config.file,
        chunkSize: CHUNK_SIZE,
      });
      const sizes = literalArraySizes(result.source, config.declarationName, config.chunkPrefix);

      expect(sizes.length).toBeGreaterThan(1);
      expect(sizes.every((size) => size <= CHUNK_SIZE)).toBe(true);
    }
  });

  it('rejects a missing declaration with the file and name', () => {
    expect(() => chunkArticleRegistry('const OTHER = [];', {
      fileName: 'swiss-articles-data.ts',
      declarationName: 'RAW_SWISS_ARTICLES',
      chunkPrefix: 'RAW_SWISS_ARTICLES_CHUNK',
    })).toThrow('RAW_SWISS_ARTICLES array not found in swiss-articles-data.ts');
  });

  it('rejects a non-positive chunk size', () => {
    expect(() => chunkArticleRegistry('const RAW_ARTICLES = [];', {
      fileName: 'blog-articles-data.ts',
      declarationName: 'RAW_ARTICLES',
      chunkPrefix: 'RAW_ARTICLES_CHUNK',
      chunkSize: 0,
    })).toThrow('chunkSize must be a positive integer');
  });
});
