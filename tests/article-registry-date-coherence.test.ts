import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAmbiguousPrePublicationUpdates } from '../scripts/lib/article-registry-date-coherence.mjs';

const PULL_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../scripts/pull-articles-corpus.mjs'),
  'utf8',
);

describe('article registry date coherence', () => {
  it('drops only a date-only update that cannot follow a timestamped publication', () => {
    const source = `const RAW_ARTICLES = [
  {
    id: 'ambiguous',
    category: 'novita',
    date: '2026-10-31T08:27:33.922Z',
    updatedAt: '2026-10-31',
    image: '/ambiguous.webp',
  },
  {
    id: 'older-publication',
    category: 'novita',
    date: '2026-10-30T08:27:33.922Z',
    updatedAt: '2026-10-31',
    image: '/older.webp',
  },
];
`;

    const result = stripAmbiguousPrePublicationUpdates(source, 'fixture.ts');

    expect(result.removedIds).toEqual(['ambiguous']);
    expect(result.source).not.toContain("updatedAt: '2026-10-31',\n    image: '/ambiguous.webp'");
    expect(result.source).toContain("date: '2026-10-30T08:27:33.922Z',\n    updatedAt: '2026-10-31'");
  });

  it('preserves date-only publications and full-precision updates', () => {
    const source = `const RAW_ARTICLES = [
  { id: 'date-only-publication', date: '2026-10-31', updatedAt: '2026-10-31', image: '/a.webp' },
  { id: 'timestamped-update', date: '2026-10-31T08:27:33.922Z', updatedAt: '2026-10-31T09:00:00.000Z', image: '/b.webp' },
];
`;

    const result = stripAmbiguousPrePublicationUpdates(source, 'fixture.ts');

    expect(result.removedIds).toEqual([]);
    expect(result.source).toBe(source);
  });

  it('handles chunked registries without touching nested lookalikes', () => {
    const source = `const RAW_ARTICLES_CHUNK_01 = [{
  id: 'ambiguous', date: '2026-10-31T08:00:00.000Z', updatedAt: '2026-10-31', image: '/a.webp',
  metadata: { date: '2026-10-31T01:00:00.000Z', updatedAt: '2026-10-31' },
}];
const RAW_ARTICLES = [...RAW_ARTICLES_CHUNK_01];
`;

    const result = stripAmbiguousPrePublicationUpdates(source, 'fixture.ts');

    expect(result.removedIds).toEqual(['ambiguous']);
    expect(result.source).toContain("metadata: { date: '2026-10-31T01:00:00.000Z', updatedAt: '2026-10-31' }");
  });

  it('wires the projection after the mirror so both configured registries are covered', () => {
    expect(PULL_SOURCE).toContain("from './lib/article-registry-date-coherence.mjs'");
    expect(PULL_SOURCE).toMatch(
      /restoreSiteOwnedArticleFields\(siteOwnedArticleFields\);\s*normalizeMirroredArticleDates\(DEST\);/u,
    );
    expect(PULL_SOURCE).toContain('for (const { file } of ARTICLE_REGISTRY_CHUNK_CONFIGS)');
  });
});
