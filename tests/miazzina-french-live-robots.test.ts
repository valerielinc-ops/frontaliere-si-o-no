import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hasArticleBodyPromptPlaceholder } from '../packages/articles/engine/shared/articleBodyQuality';
import miazzinaFrenchBody from '../packages/articles/content/blog-body/fr/miazzina-pendolare-fisco-ticino';
import { renderArticlePages } from '../build-plugins/ogPagesPlugin';

const rootDir = process.cwd();
let distDir: string | undefined;

afterEach(() => {
  if (distDir) fs.rmSync(distDir, { recursive: true, force: true });
  distDir = undefined;
});

describe('Miazzina French live article regression', () => {
  it('keeps the French sections substantive and free of prompt placeholders', () => {
    const body = {
      body1: miazzinaFrenchBody['blog.article.miazzina-pendolare-fisco-ticino.body1'],
      body2: miazzinaFrenchBody['blog.article.miazzina-pendolare-fisco-ticino.body2'],
      body3: miazzinaFrenchBody['blog.article.miazzina-pendolare-fisco-ticino.body3'],
    };

    expect(hasArticleBodyPromptPlaceholder(body)).toBe(false);
    expect(body.body2.trim().split(/\s+/).length).toBeGreaterThan(50);
    expect(body.body3.trim().split(/\s+/).length).toBeGreaterThan(50);
    expect(body.body2).toContain('nav:exchange');
    expect(body.body2).toContain('nav:banks');
    expect(body.body3).toContain('nav:payslip');
  });

  it('keeps the repaired French page indexable and in the article sitemap', async () => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-miazzina-indexable-robots-'));
    const result = await renderArticlePages({
      rootDir,
      distDir,
      section: 'frontaliere',
      onlyArticleId: 'miazzina-pendolare-fisco-ticino',
    });

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    const frenchHtml = fs.readFileSync(path.join(distDir, entry.paths.fr), 'utf8');
    expect(frenchHtml).toContain('content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1"');
    expect(frenchHtml).not.toContain('content="noindex,follow"');
    expect(frenchHtml).toContain('Pour comparer un salaire et un logement');
    expect(frenchHtml).toContain('Un budget de résidence ne se résume pas');
    expect(frenchHtml).toContain(`<link rel="canonical" href="${entry.urls.fr}">`);

    const sitemap = fs.readFileSync(path.join(rootDir, 'public/sitemap-blog.xml'), 'utf8');
    expect(sitemap).toContain(
      '<xhtml:link rel="alternate" hreflang="fr" href="https://frontaliereticino.ch/fr/articles-frontalier/miazzina-tessin-frontalier/" />',
    );
  }, 120_000);
});
