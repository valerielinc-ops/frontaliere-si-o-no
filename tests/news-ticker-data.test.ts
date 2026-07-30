/**
 * News-ticker slim payload gate (#3528 / #3532).
 *
 * The homepage NewsFeed ticker renders from `data/news-ticker-data.ts`, a
 * placeholder module whose content is replaced at build/dev time by
 * `build-plugins/newsTickerDataPlugin.ts`. The committed placeholder exports
 * an empty list (ticker renders its skeleton), so a broken/missing plugin
 * would silently ship an empty ticker to production. These tests are the
 * loud gate:
 *  1. the generator produces a valid 5-article payload from the real
 *     registry/meta/slug sources,
 *  2. the plugin is actually registered in vite.config.ts,
 *  3. NewsFeed actually consumes the payload module (no regression back to
 *     the ~1.9 MB runtime blog-meta/registry/slug-map loads).
 */
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import np from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  computeTickerArticles,
  generateNewsTickerModule,
} from '../build-plugins/newsTickerDataPlugin';
import { ARTICLES } from '../data/blog-articles-data';

const ROOT = np.resolve(__dirname, '..');
const LOCALES = ['it', 'en', 'de', 'fr'] as const;

describe('newsTickerDataPlugin generator', () => {
  const articles = computeTickerArticles(fs, np, ROOT);

  it('produces exactly 5 articles, newest first (same ordering as the old runtime sort)', () => {
    expect(articles).toHaveLength(5);
    const expectedIds = [...ARTICLES]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 5)
      .map((a) => a.id);
    expect(articles.map((a) => a.id)).toEqual(expectedIds);
    for (let i = 1; i < articles.length; i++) {
      expect(new Date(articles[i - 1].date).getTime()).toBeGreaterThanOrEqual(
        new Date(articles[i].date).getTime(),
      );
    }
  });

  it('resolves real titles and slugs for every locale (no raw i18n keys, no empty slugs)', () => {
    for (const art of articles) {
      for (const locale of LOCALES) {
        // Titles fall back locale → IT → literal key; the 5 newest articles
        // come from the publishing pipeline which writes blog-meta-it in the
        // same commit, so at minimum the IT fallback must be a real title.
        expect(art.title[locale]).toBeTruthy();
        expect(art.title[locale]).not.toBe(`blog.article.${art.id}.title`);
        expect(art.slug[locale]).toBeTruthy();
      }
    }
  });

  it('emits a syntactically valid module whose payload round-trips as JSON', () => {
    const src = generateNewsTickerModule(fs, np, ROOT);
    expect(src).toContain('export const TICKER_ARTICLES');
    const m = src.match(/TICKER_ARTICLES: TickerArticle\[\] = (\[.*\]);/s);
    expect(m).toBeTruthy();
    const parsed = JSON.parse(m![1]);
    expect(parsed).toHaveLength(5);
    expect(parsed[0]).toHaveProperty('id');
    expect(parsed[0]).toHaveProperty('date');
    expect(parsed[0].title).toHaveProperty('it');
    expect(parsed[0].slug).toHaveProperty('fr');
  });
});

describe('news-ticker payload is computable outside the site (issue #4974 item 2)', () => {
  // The articles repository publishes this payload from the corpus it owns. It
  // has no site shell to read `hubLocales` from and no `services/locales` tree —
  // the corpus sits under `content/`. Both are now call-time inputs, so the same
  // function serves both callers. This asserts the publisher's exact call shape
  // produces the site's exact payload; if it ever stops doing so, the ticker on
  // the live homepage and the published one have silently diverged.
  const PACKAGE_ROOT = np.resolve(ROOT, 'packages', 'articles');

  it('matches the site payload when given the package layout and explicit locales', () => {
    const sitePayload = computeTickerArticles(fs, np, ROOT);
    const publisherPayload = computeTickerArticles(fs, np, PACKAGE_ROOT, undefined, {
      hubLocales: ['it', 'en', 'de', 'fr'],
      metaDir: 'content',
      slugDataFile: 'content/routerBlogData.ts',
    });

    expect(publisherPayload).toHaveLength(5);
    expect(publisherPayload).toEqual(sitePayload);
  });

  it('honours a narrowed locale list without touching the site shell', () => {
    const payload = computeTickerArticles(fs, np, PACKAGE_ROOT, undefined, {
      hubLocales: ['it'],
      metaDir: 'content',
      slugDataFile: 'content/routerBlogData.ts',
    });
    expect(payload).toHaveLength(5);
    for (const art of payload) {
      expect(Object.keys(art.title)).toEqual(['it']);
      expect(art.title.it).toBeTruthy();
      expect(art.title.it).not.toBe(`blog.article.${art.id}.title`);
    }
  });
});

describe('news-ticker payload wiring (silent-regression guards)', () => {
  it('vite.config.ts registers newsTickerDataPlugin', () => {
    const cfg = readFileSync(np.resolve(ROOT, 'vite.config.ts'), 'utf-8');
    expect(cfg).toContain("import { newsTickerDataPlugin } from './build-plugins/newsTickerDataPlugin'");
    expect(cfg).toContain('newsTickerDataPlugin(__dirname)');
  });

  it('NewsFeed consumes the slim payload and no longer pulls the heavy blog chunks', () => {
    const src = readFileSync(
      np.resolve(ROOT, 'components', 'community', 'NewsFeed.tsx'),
      'utf-8',
    );
    expect(src).toContain("from '@/data/news-ticker-data'");
    // Regression guards: these three imports were the ~385 KB tx homepage cost.
    expect(src).not.toContain('loadBlogMeta');
    expect(src).not.toContain("import('@/data/blog-articles-data')");
    expect(src).not.toContain('blogArticle: art.id');
  });
});
