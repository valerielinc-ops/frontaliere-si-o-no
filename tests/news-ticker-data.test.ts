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
import os from 'node:os';

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

  /** Parse the payload back out of the emitted module source. */
  const payloadOf = (src: string) => {
    expect(src).toContain('export const TICKER_ARTICLES');
    const m = src.match(/TICKER_ARTICLES: TickerArticle\[\] = (\[.*\]);/s);
    expect(m).toBeTruthy();
    return JSON.parse(m![1]);
  };

  it('emits a syntactically valid module whose payload round-trips as JSON', () => {
    const parsed = payloadOf(generateNewsTickerModule(fs, np, ROOT));
    expect(parsed).toHaveLength(5);
    expect(parsed[0]).toHaveProperty('id');
    expect(parsed[0]).toHaveProperty('date');
    expect(parsed[0].title).toHaveProperty('it');
    expect(parsed[0].slug).toHaveProperty('fr');
  });

  it('emits the published payload when public/news-ticker-live.json is present', () => {
    // Since #4974 item 2 the published file is committed, so this is the path
    // the real build takes. Pinned explicitly: without it the assertion above
    // could be satisfied by either source and nobody would notice which.
    const published = JSON.parse(
      fs.readFileSync(np.resolve(ROOT, 'public', 'news-ticker-live.json'), 'utf-8'),
    );
    const parsed = payloadOf(generateNewsTickerModule(fs, np, ROOT));
    expect(parsed.map((a: { id: string }) => a.id)).toEqual(
      published.articles.map((a: { id: string }) => a.id),
    );
  });

  it('falls back to the in-tree corpus when the published payload is absent', () => {
    // The committed file makes the fallback unreachable from ROOT, so this
    // builds a root where it does not exist: `public/` is symlinked in (the
    // readers need the rest of it), everything else points back at the repo.
    // Without this, the fallback branch ships untested — which is exactly the
    // branch that keeps `npm run dev` working in a checkout that never pulled.
    const scratch = fs.mkdtempSync(np.join(os.tmpdir(), 'ticker-fallback-'));
    for (const entry of fs.readdirSync(ROOT)) {
      if (entry === 'public') continue;
      try {
        fs.symlinkSync(np.join(ROOT, entry), np.join(scratch, entry));
      } catch {
        /* unreadable entries are irrelevant to the readers */
      }
    }
    fs.mkdirSync(np.join(scratch, 'public'));
    expect(fs.existsSync(np.join(scratch, 'public', 'news-ticker-live.json'))).toBe(false);

    const parsed = payloadOf(generateNewsTickerModule(fs, np, scratch));
    expect(parsed).toHaveLength(5);
    // Computed, not read: matches what computeTickerArticles produces directly.
    expect(parsed).toEqual(computeTickerArticles(fs, np, ROOT));
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
