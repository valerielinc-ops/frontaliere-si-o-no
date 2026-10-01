import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderArticlePages } from '../build-plugins/ogPagesPlugin';

const rootDir = process.cwd();

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractNewsArticle(html: string): Record<string, unknown> {
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  const newsScript = scripts
    .map(([, json]) => JSON.parse(json) as Record<string, unknown>)
    .find((json) => json['@type'] === 'NewsArticle');
  expect(newsScript, 'rendered page has no NewsArticle JSON-LD').toBeDefined();
  return newsScript!;
}

describe('NewsArticle title invariant', () => {
  it('keeps title, H1 and headline identical for a long colliding headline', async () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogpages-news-title-'));

    try {
      const result = await renderArticlePages({
        rootDir,
        distDir,
        section: 'svizzera',
        // This source title is >66 chars and collides with another Swiss
        // article, exercising the exact path that used to cap htmlPageTitle.
        onlyArticleId: 'affitti-svizzera-mercato-immobiliare-2026',
      });

      expect(result.entries).toHaveLength(1);
      const html = fs.readFileSync(path.join(distDir, result.entries[0].paths.it), 'utf8');
      const title = decodeHtml(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
      const h1 = decodeHtml(html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? '');
      const headline = String(extractNewsArticle(html).headline ?? '');

      expect(headline.length).toBeGreaterThan(66);
      expect(title).toBe(headline);
      expect(h1).toBe(headline);
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }, 120_000);
});
