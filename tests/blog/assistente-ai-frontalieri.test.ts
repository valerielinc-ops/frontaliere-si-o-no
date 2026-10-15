/**
 * Regression test for the "Assistente AI per frontalieri" pillar article (E5b).
 *
 * Verifies:
 * 1. All 4 locales resolve (body file + meta translation entries exist).
 * 2. Each locale's slug matches buildPath({ blogArticle }, locale).
 * 3. The FAQ schema payload is present and well-formed JSON with ≥10 Q&A pairs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPath, preloadBlogData } from '@/services/router';
import { ALL_BLOG_ARTICLE_IDS, BLOG_SLUGS } from '@/services/routerBlogData';
import { ARTICLES } from '@/data/blog-articles-data';

const ARTICLE_ID = 'assistente-ai-frontalieri';

const EXPECTED_SLUGS = {
  it: 'assistente-ai-frontalieri',
  en: 'ai-assistant-cross-border-workers',
  de: 'ki-assistent-grenzgaenger',
  fr: 'assistant-ia-frontaliers',
} as const;

const LOCALE_SECTION_SLUG = {
  it: 'articoli-frontaliere',
  en: 'cross-border-articles',
  de: 'grenzgaenger-artikel',
  fr: 'articles-frontalier',
} as const;

function readBodyFile(locale: 'it' | 'en' | 'de' | 'fr'): string {
  const p = resolve(
    __dirname,
    '..',
    '..',
    'services',
    'locales',
    'blog-body',
    locale,
    `${ARTICLE_ID}.ts`,
  );
  return readFileSync(p, 'utf-8');
}

function readMetaFile(locale: 'it' | 'en' | 'de' | 'fr'): string {
  const p = resolve(__dirname, '..', '..', 'services', 'locales', `blog-meta-${locale}.ts`);
  return readFileSync(p, 'utf-8');
}

await preloadBlogData();

describe('Assistente AI per frontalieri (E5b)', () => {
  it('article is registered in ALL_BLOG_ARTICLE_IDS and ARTICLES', () => {
    expect(ALL_BLOG_ARTICLE_IDS).toContain(ARTICLE_ID);
    const entry = ARTICLES.find(a => a.id === ARTICLE_ID);
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('pratico');
    expect(entry?.date).toBe('2026-04-24');
  });

  it('resolves for all 4 locales with body file + meta entries present', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const body = readBodyFile(locale);
      expect(body).toContain(`blog.article.${ARTICLE_ID}.body1`);
      expect(body).toContain(`blog.article.${ARTICLE_ID}.faq`);

      const meta = readMetaFile(locale);
      expect(meta).toContain(`blog.article.${ARTICLE_ID}.title`);
      expect(meta).toContain(`blog.article.${ARTICLE_ID}.excerpt`);
      expect(meta).toContain(`blog.article.${ARTICLE_ID}.imageAlt`);
    }
  });

  it('slug routing matches each locale buildPath output', () => {
    expect(BLOG_SLUGS[ARTICLE_ID]).toEqual(EXPECTED_SLUGS);

    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const path = buildPath({ activeTab: 'blog', blogArticle: ARTICLE_ID }, locale);
      const expectedSlug = EXPECTED_SLUGS[locale];
      expect(
        path.includes(`/${LOCALE_SECTION_SLUG[locale]}/${expectedSlug}`),
        `buildPath('${locale}') = "${path}" should include /${LOCALE_SECTION_SLUG[locale]}/${expectedSlug}`,
      ).toBe(true);
    }
  });

  it('FAQ schema payload contains ≥10 well-formed Q&A pairs (Italian body)', () => {
    const body = readBodyFile('it');
    // Extract the JSON string stored in the .faq translation value. The key is a
    // JS single-quoted string literal with escaped apostrophes, so we pick the
    // content from the first `'[{` to the matching `}]'` on the same line.
    const match = body.match(/\.faq': '(\[(?:.|\n)*?\])',?\n/);
    expect(match, 'Italian body should declare a .faq key with a JSON array').not.toBeNull();
    const jsonRaw = match![1].replace(/\\'/g, "'");
    const parsed = JSON.parse(jsonRaw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(10);
    for (const pair of parsed) {
      expect(typeof pair.q).toBe('string');
      expect(typeof pair.a).toBe('string');
      expect(pair.q.length).toBeGreaterThan(10);
      expect(pair.a.length).toBeGreaterThan(20);
    }
  });
});
