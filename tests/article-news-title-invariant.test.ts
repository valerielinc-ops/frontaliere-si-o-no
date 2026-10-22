import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  countArticlesByTitleKey,
  createArticleTitleResolver,
  normalizeArticleTitle,
  renderArticlePages,
  resolveArticleTitle,
} from '../build-plugins/ogPagesPlugin';
import {
  SITE_RENDERED_ARTICLE_SECTION_DESCRIPTORS,
  blogKeyToArticleId,
  extractBlogEntryPositions,
} from '../packages/articles/engine/shared/articleSectionDescriptors';
import { decodeTsStringEscapes } from '../packages/articles/engine/shared/tsStringEscapes';

const rootDir = process.cwd();

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
type Locale = (typeof LOCALES)[number];
type SectionName = 'frontaliere' | 'svizzera';

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

/** The three places a headline must agree in, plus the social title. */
function readTitles(html: string) {
  return {
    title: decodeHtml(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''),
    h1: decodeHtml(html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? ''),
    headline: String(extractNewsArticle(html).headline ?? ''),
    ogTitle: decodeHtml(html.match(/<meta property="og:title" content="([^"]*)">/)?.[1] ?? ''),
    ogImageAlt: decodeHtml(html.match(/<meta property="og:image:alt" content="([^"]*)">/)?.[1] ?? ''),
  };
}

interface TitleSource {
  id: string;
  /** How many SEO entries carry this id (the frontaliere chunks overlap). */
  listed: number;
  type: string;
  ogTitle: string;
  /** False when the ogTitle carries an escape: counted, never picked as a case. */
  plain: boolean;
  headline: Partial<Record<Locale, string>>;
}

/**
 * Title sources of a section, read from the content the engine renders.
 *
 * The rendering tests below take their expectations from here, never from a
 * string typed in this file: the content is a copy of the corpus that every
 * sync replaces, and a headline pinned here would turn the next editorial fix
 * (a truncated ogTitle repaired, a duplicate article retired) into a red test.
 * Headlines go through the engine's own decoder; an entry whose ogTitle
 * carries an escape is never picked as a case, so that the SEO-entry decoder
 * is not mirrored here.
 */
function readTitleSources(sectionName: SectionName): TitleSource[] {
  const section = SITE_RENDERED_ARTICLE_SECTION_DESCRIPTORS.find((candidate) => candidate.name === sectionName);
  if (!section) throw new Error(`no descriptor for section ${sectionName}`);
  const seoSource = section.seoFiles
    .map((file) => {
      const full = path.join(rootDir, file);
      return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
    })
    .join('\n');
  const headlines = {} as Record<Locale, Map<string, string>>;
  for (const locale of LOCALES) {
    const source = fs.readFileSync(path.join(rootDir, `services/locales/${section.metaPrefix}-${locale}.ts`), 'utf8');
    headlines[locale] = new Map(
      [...source.matchAll(/'blog\.article\.([^']+)\.title'\s*:\s*'((?:[^'\\]|\\.)*)'/g)]
        .map((match) => [match[1], decodeTsStringEscapes(match[2], { newlineAs: ' ' })]),
    );
  }
  const byId = new Map<string, TitleSource>();
  for (const position of extractBlogEntryPositions(seoSource)) {
    const id = blogKeyToArticleId(position.key);
    const known = byId.get(id);
    if (known) {
      known.listed += 1;
      continue;
    }
    const block = seoSource.slice(position.start, position.end);
    const quoted = (key: string) =>
      block.match(new RegExp(`${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'm'))?.[1]
      ?? block.match(new RegExp(`${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm'))?.[1];
    // Same order as the engine: the ogTitle, else the SEO title.
    const ogTitle = quoted('ogTitle') || quoted('title') || '';
    const headline: Partial<Record<Locale, string>> = {};
    for (const locale of LOCALES) headline[locale] = headlines[locale].get(id);
    byId.set(id, {
      id,
      listed: 1,
      type: block.match(/"@type":\s*"([^"]+)"/)?.[1] ?? '',
      ogTitle,
      plain: Boolean(ogTitle) && !ogTitle.includes('\\'),
      headline,
    });
  }
  return [...byId.values()];
}

/** Sources whose Italian headline no other article of the section is shown under. */
function withUniqueItalianHeadline(sources: TitleSource[]): TitleSource[] {
  const articlesByHeadline = countArticlesByTitleKey(
    sources.map((source) => ({ articleId: source.id, key: normalizeArticleTitle(source.headline.it || source.ogTitle) })),
    (entry) => entry.key,
  );
  return sources.filter((source) => source.headline.it
    && articlesByHeadline.get(normalizeArticleTitle(source.headline.it)) === 1);
}

async function renderTitles(section: SectionName, ids: string[]) {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogpages-title-'));
  try {
    const result = await renderArticlePages({ rootDir, distDir, section, onlyArticleIds: ids });
    const titles = new Map<string, Record<Locale, ReturnType<typeof readTitles>>>();
    for (const entry of result.entries) {
      const perLocale = {} as Record<Locale, ReturnType<typeof readTitles>>;
      for (const locale of LOCALES) {
        perLocale[locale] = readTitles(fs.readFileSync(path.join(distDir, entry.paths[locale]), 'utf8'));
      }
      titles.set(entry.articleId, perLocale);
    }
    return titles;
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
}

// Event pages carry brand and disambiguator in <title>: the invariant under
// test is the NewsArticle one.
const isNews = (source: TitleSource) => source.type !== 'Event' && source.plain;
const frontaliere = readTitleSources('frontaliere');
const svizzera = readTitleSources('svizzera');
const isTranslated = (source: TitleSource) => Boolean(source.headline.en && source.headline.de && source.headline.fr);
const differsFromSocialTitle = (source: TitleSource) =>
  normalizeArticleTitle(source.headline.it ?? '') !== normalizeArticleTitle(source.ogTitle);

// An Italian headline that is not the social title: the page must show the
// former and keep the latter for the social card.
const realHeadlineCase = withUniqueItalianHeadline(frontaliere)
  .find((source) => isNews(source) && source.listed === 1 && differsFromSocialTitle(source) && isTranslated(source));
// The frontaliere chunks overlap: 983 of 4 165 ids were listed twice on
// 2026-10-07. Such an article is one page and must not collide with itself.
const listedTwiceCase = withUniqueItalianHeadline(frontaliere)
  .find((source) => isNews(source) && source.listed > 1 && differsFromSocialTitle(source));
// Two different articles under one Italian headline, with distinct social titles.
const sharedHeadlinePair = (() => {
  const byHeadline = new Map<string, TitleSource[]>();
  for (const source of frontaliere) {
    if (!source.headline.it) continue;
    const key = normalizeArticleTitle(source.headline.it);
    byHeadline.set(key, [...(byHeadline.get(key) ?? []), source]);
  }
  return [...byHeadline.values()].find((group) => group.length === 2
    && group.every(isNews)
    && normalizeArticleTitle(group[0].ogTitle) !== normalizeArticleTitle(group[1].ogTitle)
    && group.every((source) => normalizeArticleTitle(source.ogTitle) !== normalizeArticleTitle(source.headline.it ?? '')));
})();
const longHeadlineCase = withUniqueItalianHeadline(svizzera)
  .find((source) => isNews(source) && normalizeArticleTitle(source.headline.it ?? '').length > 66);

describe('NewsArticle title invariant', () => {
  it('finds in the content the cases the rendering tests need', () => {
    // A missing overlap or a missing shared headline is good news for the
    // content and skips its test; these two can only disappear with the corpus.
    expect(realHeadlineCase, 'no Italian headline that differs from its ogTitle').toBeDefined();
    expect(longHeadlineCase, 'no Swiss Italian headline longer than 66 characters').toBeDefined();
  });

  it('keeps title, H1 and headline identical for a long headline', async () => {
    // A headline over 66 characters exercises the exact path that used to cap
    // htmlPageTitle before the title invariant was enforced.
    const source = longHeadlineCase!;
    const titles = (await renderTitles('svizzera', [source.id])).get(source.id)!.it;

    expect(titles.headline.length).toBeGreaterThan(66);
    expect(titles.headline).toBe(normalizeArticleTitle(source.headline.it!));
    expect(titles.title).toBe(titles.headline);
    expect(titles.h1).toBe(titles.headline);
  }, 120_000);

  it('shows the real Italian headline and keeps the ogTitle for the social card', async () => {
    const source = realHeadlineCase!;
    const titles = (await renderTitles('frontaliere', [source.id])).get(source.id)!;
    const headline = normalizeArticleTitle(source.headline.it!);
    const socialTitle = normalizeArticleTitle(source.ogTitle);

    expect(headline).not.toBe(socialTitle);
    expect(titles.it.title).toBe(headline);
    expect(titles.it.h1).toBe(headline);
    expect(titles.it.headline).toBe(headline);
    expect(titles.it.ogTitle).toBe(socialTitle);
    expect(titles.it.ogImageAlt).toBe(socialTitle);
    // The other three locales already read their own headline: unchanged.
    for (const locale of ['en', 'de', 'fr'] as const) {
      const localized = normalizeArticleTitle(source.headline[locale]!);
      expect(titles[locale].title).toBe(localized);
      expect(titles[locale].h1).toBe(localized);
      expect(titles[locale].headline).toBe(localized);
      expect(titles[locale].ogTitle).toBe(localized);
    }
  }, 120_000);

  (listedTwiceCase ? it : it.skip)('shows the real headline of an article listed in two SEO chunks', async () => {
    const source = listedTwiceCase!;
    const titles = (await renderTitles('frontaliere', [source.id])).get(source.id)!.it;
    const headline = normalizeArticleTitle(source.headline.it!);

    expect(titles.title).toBe(headline);
    expect(titles.h1).toBe(headline);
    expect(titles.headline).toBe(headline);
  }, 120_000);

  (sharedHeadlinePair ? it : it.skip)('keeps two articles that share an Italian headline on their own ogTitle', async () => {
    const pair = sharedHeadlinePair!;
    const titles = await renderTitles('frontaliere', pair.map((source) => source.id));

    for (const source of pair) {
      const shown = titles.get(source.id)!.it;
      expect(shown.title).toBe(normalizeArticleTitle(source.ogTitle));
      expect(shown.h1).toBe(shown.title);
      expect(shown.headline).toBe(shown.title);
    }
    expect(titles.get(pair[0].id)!.it.title).not.toBe(titles.get(pair[1].id)!.it.title);
  }, 120_000);
});

describe('article title resolver', () => {
  const entry = (articleId: string, ogT: string) => ({ articleId, ogT });
  const resolverFor = (
    entries: Array<{ articleId: string; ogT: string }>,
    headlines: Record<string, string | undefined>,
    requireUniqueHeadline = true,
  ) => createArticleTitleResolver(entries, (article) => headlines[article.articleId], requireUniqueHeadline);

  it('counts articles, not SEO entries', () => {
    const listedTwice = [entry('a', 'A'), entry('a', 'A'), entry('b', 'B')];
    expect([...countArticlesByTitleKey(listedTwice, (article) => article.ogT)]).toEqual([['A', 1], ['B', 1]]);

    const sharedByTwo = [entry('a', 'T'), entry('b', 'T'), entry('b', 'T')];
    expect(countArticlesByTitleKey(sharedByTwo, (article) => article.ogT).get('T')).toBe(2);
  });

  it('shows the real headline of an article listed twice: it does not collide with itself', () => {
    const entries = [entry('a', 'Social A'), entry('a', 'Social A'), entry('b', 'Social B')];
    const titleOf = resolverFor(entries, { a: 'Titolo vero di A', b: 'Titolo vero di B' });

    expect(entries.map(titleOf)).toEqual(['Titolo vero di A', 'Titolo vero di A', 'Titolo vero di B']);
  });

  it('keeps each article on its own ogTitle when two share a headline', () => {
    const entries = [entry('a', 'Social A'), entry('b', 'Social B | Frontaliere Ticino'), entry('c', 'Social C')];
    const titleOf = resolverFor(entries, {
      a: 'Stesso titolo',
      b: 'Stesso titolo | Frontaliere Ticino',
      c: 'Titolo unico',
    });

    expect(entries.map(titleOf)).toEqual(['Social A', 'Social B', 'Titolo unico']);
  });

  it('counts the ogTitle an article without headline is shown under', () => {
    // `b` has no headline and is shown under its ogTitle: `a` cannot take the
    // same words as its headline.
    const entries = [entry('a', 'Social A'), entry('b', 'Titolo conteso')];
    const titleOf = resolverFor(entries, { a: 'Titolo conteso' });

    expect(entries.map(titleOf)).toEqual(['Social A', 'Titolo conteso']);
  });

  it('falls back to the ogTitle when the headline is missing', () => {
    const entries = [entry('a', 'Social A | Frontaliere Ticino')];

    expect(resolverFor(entries, {})(entries[0])).toBe('Social A');
    expect(resolverFor(entries, {}, false)(entries[0])).toBe('Social A');
  });

  it('leaves the other locales as they were: a shared localized headline is still shown', () => {
    const entries = [entry('a', 'Social A'), entry('b', 'Social B')];
    const titleOf = resolverFor(entries, { a: 'Same headline', b: 'Same headline' }, false);

    expect(entries.map(titleOf)).toEqual(['Same headline', 'Same headline']);
  });

  it('strips the publisher suffix whichever source wins', () => {
    expect(resolveArticleTitle(undefined, 'Social fallback | Frontaliere Ticino')).toBe('Social fallback');
    expect(resolveArticleTitle('Titolo vero', 'Social fallback')).toBe('Titolo vero');
    expect(resolveArticleTitle('Titolo vero', 'Social fallback', true)).toBe('Social fallback');
    expect(normalizeArticleTitle('Titolo vero | Frontaliere Ticino')).toBe('Titolo vero');
  });

  it('feeds the title-collision map and the page from the same resolver', () => {
    // The map decides which Event pages get a disambiguator; keyed by another
    // formula than the one html() shows, it answers for a title no page has.
    const source = fs.readFileSync(path.join(rootDir, 'packages/articles/engine/ogPagesPlugin.ts'), 'utf8');

    expect(source).toContain('const localizedTitle = articleTitleFor[articleLocale](en);');
    expect(source).toContain('(article) => buildTitleWithBrand(articleTitleFor[locale](article)),');
    expect(source).not.toMatch(/\.title\s*\|\|\s*(?:en|article)\.ogT/);
  });
});
