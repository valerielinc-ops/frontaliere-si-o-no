import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderArticlePages } from '../build-plugins/ogPagesPlugin';

const rootDir = process.cwd();
let distDir: string | undefined;

afterEach(() => {
  if (distDir) fs.rmSync(distDir, { recursive: true, force: true });
  distDir = undefined;
});

describe('article prompt-placeholder robots protection', () => {
  it('quarantines the known placeholder translation in every affected locale', async () => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-placeholder-robots-'));
    const result = await renderArticlePages({
      rootDir,
      distDir,
      section: 'frontaliere',
      onlyArticleId: 'como-fai-giornate-autunno',
    });

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    for (const locale of ['en', 'de', 'fr'] as const) {
      const html = fs.readFileSync(path.join(distDir, entry.paths[locale]), 'utf8');
      expect(html).toContain('<meta name="robots" content="noindex,follow">');
    }

    const italian = fs.readFileSync(path.join(distDir, entry.paths.it), 'utf8');
    expect(italian).toContain('content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1"');
  }, 120_000);

  it('recovers the repaired Savoy and fuel translations on their self-canonicals', async () => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-recovered-robots-'));
    const cases = [
      ['savoia-avanti-ticino-lavoro', 'de'],
      ['carburanti-prezzi-tasse-ticino', 'fr'],
    ] as const;

    for (const [articleId, locale] of cases) {
      const result = await renderArticlePages({
        rootDir,
        distDir,
        section: 'frontaliere',
        onlyArticleId: articleId,
      });
      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];
      const html = fs.readFileSync(path.join(distDir, entry.paths[locale]), 'utf8');
      expect(html).toContain('content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1"');
      expect(html).not.toContain('content="noindex,follow"');
      expect(html).toContain(`<link rel="canonical" href="${entry.urls[locale]}">`);
    }
  }, 120_000);
});
