import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(__dirname, '../scripts/pull-articles-corpus.mjs'), 'utf8');

describe('article corpus sync site-owned contract', () => {
  it('rethrows unreadable snapshots while allowing only a missing first-sync file', () => {
    expect(SOURCE).toMatch(
      /catch \(error\) \{\s*if \(error\?\.code === ['"]ENOENT['"]\) return null;\s*throw error;\s*\}/u,
    );
    expect(SOURCE).toMatch(/site-owned Article provenance field missing before corpus mirror/u);
  });

  it('restores the declaration immediately after the corpus mirror', () => {
    expect(SOURCE).toMatch(
      /const siteOwnedArticleFields = readSiteOwnedArticleFields\(\);[\s\S]*?mirrorTree\(src, DEST,[\s\S]*?restoreSiteOwnedArticleFields\(siteOwnedArticleFields\);/u,
    );
  });
});
