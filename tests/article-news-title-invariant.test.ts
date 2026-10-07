import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeArticleTitle,
  renderArticlePages,
  resolveArticleTitle,
} from '../build-plugins/ogPagesPlugin';

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
  it('keeps title, H1 and headline identical for a long localized headline', async () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogpages-news-title-'));

    try {
      const result = await renderArticlePages({
        rootDir,
        distDir,
        section: 'svizzera',
        // This source title is >66 chars, exercising the exact path that used
        // to cap htmlPageTitle before the title invariant was enforced.
        onlyArticleId: 'iniziative-casse-malati-2026',
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

  it('uses blog-meta-it for visible Italian titles while retaining ogTitle for social cards', async () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogpages-it-title-'));

    try {
      const result = await renderArticlePages({
        rootDir,
        distDir,
        section: 'frontaliere',
        onlyArticleId: 'stop-export-materiale-bellico',
      });

      expect(result.entries).toHaveLength(1);
      const html = fs.readFileSync(path.join(distDir, result.entries[0].paths.it), 'utf8');
      const trueTitle = 'Ticino sospende esportazioni di materiale bellico verso gli USA';
      const socialTitle = 'Ticino sospende esportazioni di materiale bellico verso gli';
      const title = decodeHtml(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
      const h1 = decodeHtml(html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? '');
      const headline = String(extractNewsArticle(html).headline ?? '');
      const ogTitle = decodeHtml(html.match(/<meta property="og:title" content="([^"]*)">/)?.[1] ?? '');
      const ogImageAlt = decodeHtml(html.match(/<meta property="og:image:alt" content="([^"]*)">/)?.[1] ?? '');

      expect(title).toBe(trueTitle);
      expect(h1).toBe(trueTitle);
      expect(headline).toBe(trueTitle);
      expect(ogTitle).toBe(socialTitle);
      expect(ogImageAlt).toBe(socialTitle);
      expect(html).toContain(`content="${socialTitle}"`);
      expect(html).not.toContain(`property="og:title" content="${trueTitle}"`);
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('keeps the existing localized title output for en, de and fr', async () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogpages-non-it-title-'));
    const expected = {
      en: 'Ticino Suspends Arms Exports to the USA',
      de: 'Tessin setzt Waffenexporte in die USA aus',
      fr: "Tessin suspend ses exportations d'armes vers les États-Unis",
    } as const;

    try {
      const result = await renderArticlePages({
        rootDir,
        distDir,
        section: 'frontaliere',
        onlyArticleId: 'stop-export-materiale-bellico',
      });

      const entry = result.entries[0];
      for (const locale of Object.keys(expected) as Array<keyof typeof expected>) {
        const html = fs.readFileSync(path.join(distDir, entry.paths[locale]), 'utf8');
        const title = decodeHtml(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
        const h1 = decodeHtml(html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? '');
        const headline = String(extractNewsArticle(html).headline ?? '');
        const ogTitle = decodeHtml(html.match(/<meta property="og:title" content="([^"]*)">/)?.[1] ?? '');

        expect(title).toBe(expected[locale]);
        expect(h1).toBe(expected[locale]);
        expect(headline).toBe(expected[locale]);
        expect(ogTitle).toBe(expected[locale]);
      }
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('keeps distinct ogTitles when equal Italian true titles collide', async () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogpages-it-collision-'));
    const ids = [
      'bandiera-svizzera-scarpe-on-controversia',
      'controversia-bandiera-svizzera-scarpe-on',
    ];

    try {
      const result = await renderArticlePages({
        rootDir,
        distDir,
        section: 'frontaliere',
        onlyArticleIds: ids,
      });

      expect(new Set(result.entries.map((entry) => entry.articleId))).toEqual(new Set(ids));
      const renderedTitles = new Map<string, string>();
      for (const id of ids) {
        const entry = result.entries.find((candidate) => candidate.articleId === id)!;
        const html = fs.readFileSync(path.join(distDir, entry.paths.it), 'utf8');
        const title = decodeHtml(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
        renderedTitles.set(id, title);
      }

      expect(renderedTitles.get(ids[0])).toBe('Controversia bandiera svizzera su scarpe On | Frontaliere');
      expect(renderedTitles.get(ids[1])).toBe('Controversia bandiera svizzera scarpe On');
      expect(renderedTitles.get(ids[0])).not.toBe(renderedTitles.get(ids[1]));
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('uses ogTitle when the Italian localized title is missing or explicitly colliding', () => {
    expect(resolveArticleTitle(undefined, 'Social fallback | Frontaliere Ticino')).toBe('Social fallback');
    expect(resolveArticleTitle('Titolo vero', 'Social fallback')).toBe('Titolo vero');
    expect(resolveArticleTitle('Titolo vero', 'Social fallback', true)).toBe('Social fallback');
    expect(normalizeArticleTitle('Titolo vero | Frontaliere Ticino')).toBe('Titolo vero');
  });
});
