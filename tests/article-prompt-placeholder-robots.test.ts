import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderArticlePages } from '../build-plugins/ogPagesPlugin';

const rootDir = process.cwd();
let distDir: string | undefined;
let fixtureRoot: string | undefined;

afterEach(() => {
  if (distDir) fs.rmSync(distDir, { recursive: true, force: true });
  distDir = undefined;
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

describe('article prompt-placeholder robots protection', () => {
  it('quarantines a synthetic placeholder translation in every affected locale', async () => {
    // Keep the placeholder synthetic: the live corpus entry is repaired over
    // time, so it cannot serve as a stable negative fixture.
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'article-placeholder-fixture-'));
    distDir = path.join(fixtureRoot, 'dist');
    const articleId = 'placeholder-render-robots-fixture';
    const write = (relativePath: string, contents: string) => {
      const target = path.join(fixtureRoot!, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    };

    write('data/blog-articles-data.ts', `const RAW_ARTICLES = [
      { id: '${articleId}', category: 'pratico', date: '2026-10-01' },
    ];`);
    write('services/seo/seo-blog.ts', `export const entries = {
      'blog-${articleId}': {
        title: 'Placeholder renderer fixture',
        description: 'A synthetic article for robots coverage.',
        canonicalPath: '/articoli-frontaliere/${articleId}/',
        structuredData: {"@context":"https://schema.org","@type":"Article","headline":"Placeholder renderer fixture"},
      },
    };`);
    write('services/routerBlogData.ts', `export const BLOG_SLUGS = ${JSON.stringify({
      [articleId]: { it: articleId, en: articleId, de: articleId, fr: articleId },
    })};`);

    const italianBody = 'Contenuto dimostrativo per mantenere la pagina indicizzabile. '.repeat(35);
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const body = locale === 'it' ? italianBody : '...';
      write(`services/locales/blog-body/${locale}/${articleId}.ts`, `export const body = {
        'blog.article.${articleId}.body1': \`${body}\`,
      };`);
    }

    const result = await renderArticlePages({
      rootDir: fixtureRoot,
      distDir,
      section: 'frontaliere',
      onlyArticleId: articleId,
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
