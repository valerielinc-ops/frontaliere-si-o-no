import { afterEach, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderArticlePages } from '../build-plugins/ogPagesPlugin';
import {
  clampMetaDescription,
  META_DESCRIPTION_MAX_CHARS,
  META_DESCRIPTION_MIN_CHARS,
  TITLE_MAX_CHARS,
} from '../build-plugins/shared/titleSuffix';

const temporaryRoots: string[] = [];
afterEach(() => temporaryRoots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

const ARTICLE_ID = 'frontaliere-educatore-ticino-stipendio-requisiti';
const EXPECTED_VISIBLE_EXCERPT = 'Stipendi lordi LIS 2026 per educatori dell’infanzia: classi 12–14, tredicesima, titolo SSS o equivalente, candidatura, permesso G e statuto fiscale.';
const EXPECTED_SEO_DESCRIPTION = 'Stipendi lordi LIS 2026 per educatori dell’infanzia: classi 12–14, tredicesima, titolo SSS o equivalente, candidatura, permesso G e statuto fiscale.';
const EXPECTED_CANONICAL = `https://frontaliereticino.ch/articoli-frontaliere/${ARTICLE_ID}/`;

type JsonLdRecord = Record<string, unknown>;

function visibleExcerpt(html: string): string | null {
  const article = new JSDOM(html).window.document.querySelector('main.seo-static-content article.ft-blog-article');
  return article?.querySelector(':scope > figure + p')?.textContent ?? null;
}

function jsonLdRecords(html: string): JsonLdRecord[] {
  const document = new JSDOM(html).window.document;
  return Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map(script => JSON.parse(script.textContent ?? '') as JsonLdRecord);
}

it('renders the Italian editorial excerpt while keeping SEO description and canonical unchanged', async () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-pages-visible-excerpt-'));
  temporaryRoots.push(distDir);

  const result = await renderArticlePages({
    rootDir: process.cwd(),
    distDir,
    section: 'frontaliere',
    onlyArticleId: ARTICLE_ID,
  });
  expect(result.entries).toHaveLength(1);

  const html = fs.readFileSync(path.join(distDir, result.entries[0].paths.it), 'utf8');
  const document = new JSDOM(html).window.document;
  expect(visibleExcerpt(html)).toBe(EXPECTED_VISIBLE_EXCERPT);
  expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(EXPECTED_SEO_DESCRIPTION);
  expect(document.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(EXPECTED_SEO_DESCRIPTION);
  const articleSchema = jsonLdRecords(html).find(schema => schema['@type'] === 'NewsArticle' || schema['@type'] === 'WebPage');
  expect(articleSchema?.description).toBe(EXPECTED_SEO_DESCRIPTION);
  expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(EXPECTED_CANONICAL);
  expect(document.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(EXPECTED_CANONICAL);

  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    const localePath = result.entries[0].paths[locale];
    expect(localePath, `missing ${locale} article path`).toBeTruthy();
    const localeDocument = new JSDOM(fs.readFileSync(path.join(distDir, localePath), 'utf8')).window.document;
    const description = localeDocument.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
    expect(description.length, `${locale} meta description`).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_CHARS);
    expect(description.length, `${locale} meta description`).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);

    const schema = jsonLdRecords(localeDocument.documentElement.outerHTML)
      .find(candidate => candidate['@type'] === 'NewsArticle' || candidate['@type'] === 'WebPage');
    const title = localeDocument.querySelector('title')?.textContent ?? '';
    if (title.length > TITLE_MAX_CHARS) {
      expect(schema?.['@type'], `${locale} over-budget title schema`).toBe('NewsArticle');
      expect(title, `${locale} NewsArticle title/headline invariant`).toBe(schema?.headline);
    }
  }
}, 120_000);

it.each([
  ['evergreen', 'Article'],
  ['news', 'NewsArticle'],
  [undefined, 'NewsArticle'],
])('types a dated article declared %s as %s', async (articleType, expectedType) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-pages-article-type-'));
  temporaryRoots.push(rootDir);
  const write = (relativePath: string, value: string) => {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value);
  };
  const id = 'article-type-contract';
  const excerpt = 'Una breve descrizione editoriale per verificare il tipo dichiarato della scheda.';
  const declared = articleType ? `, articleType: '${articleType}'` : '';
  write('data/blog-articles-data.ts', `const RAW_ARTICLES = [{ id: '${id}', category: 'pratico', date: '2026-01-15'${declared} }];`);
  write('services/seo/seo-blog.ts', `export const entries = {
  'blog-${id}': {
    title: 'Titolo', description: '${excerpt}', keywords: 'test',
    ogTitle: 'Titolo', ogDescription: '${excerpt}',
    canonicalPath: '/articoli-frontaliere/${id}/',
    structuredData: {"@context":"https://schema.org","@type":"NewsArticle","headline":"Titolo","datePublished":"2026-01-15","description":"${excerpt}"},
  },
};`);
  write('services/routerBlogData.ts', `export const BLOG_SLUGS = ${JSON.stringify({ [id]: {
    it: id, en: `en-${id}`, de: `de-${id}`, fr: `fr-${id}`,
  } })};`);
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    write(`services/locales/blog-meta-${locale}.ts`, `const translations: Record<string, string> = ${JSON.stringify({
      [`blog.article.${id}.title`]: 'Titolo della scheda',
      [`blog.article.${id}.excerpt`]: excerpt,
    })};\nexport default translations;\n`);
  }
  const distDir = path.join(rootDir, 'dist');
  const result = await renderArticlePages({ rootDir, distDir, section: 'frontaliere' });
  const html = fs.readFileSync(path.join(distDir, result.entries[0].paths.it), 'utf8');
  const types = jsonLdRecords(html).map((record) => record['@type']);
  expect(types).toContain(expectedType);
  expect(types).not.toContain(expectedType === 'Article' ? 'NewsArticle' : 'Article');
});

it('caps evergreen article titles per locale without truncating the WebPage headline', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-pages-head-contract-'));
  temporaryRoots.push(rootDir);
  const write = (relativePath: string, value: string) => {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value);
  };
  const translationModule = (entries: Record<string, string>) =>
    `const translations: Record<string, string> = ${JSON.stringify(entries)};\nexport default translations;\n`;
  const id = 'evergreen-title-contract';
  const longTitles = {
    it: 'Guida completa per lavorare in Svizzera da frontaliere: tasse, permesso G e strumenti pratici aggiornati',
    en: 'Complete guide to working in Switzerland as a cross-border worker: taxes, permits and practical tools',
    de: 'Kompletter Leitfaden für Grenzgänger in der Schweiz: Steuern, Bewilligungen und praktische Werkzeuge',
    fr: 'Guide complet pour travailler en Suisse comme frontalier: impôts, permis et outils pratiques',
  } as const;
  const excerpt = 'Una breve descrizione editoriale per verificare il contratto della meta description.';

  write('data/blog-articles-data.ts', `const RAW_ARTICLES = [{ id: '${id}', category: 'pratico', date: '' }];`);
  write('services/seo/seo-blog.ts', `export const entries = {
  'blog-${id}': {
    title: 'Fallback title', description: '${excerpt}', keywords: 'test',
    ogTitle: 'Social title', ogDescription: '${excerpt}',
    canonicalPath: '/articoli-frontaliere/${id}/',
    structuredData: {"@context":"https://schema.org","@type":"Article","headline":"Fallback title","description":"${excerpt}"},
  },
};`);
  write('services/routerBlogData.ts', `export const BLOG_SLUGS = ${JSON.stringify({ [id]: {
    it: id, en: `en-${id}`, de: `de-${id}`, fr: `fr-${id}`,
  } })};`);
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    write(`services/locales/blog-meta-${locale}.ts`, translationModule({
      [`blog.article.${id}.title`]: longTitles[locale],
      [`blog.article.${id}.excerpt`]: excerpt,
    }));
  }

  const distDir = path.join(rootDir, 'dist');
  const result = await renderArticlePages({ rootDir, distDir, section: 'frontaliere' });
  expect(result.entries).toHaveLength(1);

  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    const html = fs.readFileSync(path.join(distDir, result.entries[0].paths[locale]), 'utf8');
    const document = new JSDOM(html).window.document;
    const title = document.querySelector('title')?.textContent ?? '';
    const schema = jsonLdRecords(html).find(candidate => candidate['@type'] === 'WebPage');
    const description = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';

    expect(schema?.headline, `${locale} WebPage headline`).toBe(longTitles[locale]);
    expect(title, `${locale} emitted title`).not.toBe(longTitles[locale]);
    expect(title.length, `${locale} emitted title`).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(description.length, `${locale} meta description`).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_CHARS);
    expect(description.length, `${locale} meta description`).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);
  }
}, 120_000);

it('preserves an explicitly empty excerpt, falls back only when it is absent, and normalizes a non-IT excerpt like the SPA', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-pages-excerpt-contract-'));
  temporaryRoots.push(rootDir);
  const write = (relativePath: string, value: string) => {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value);
  };
  const translationModule = (entries: Record<string, string>) =>
    `const translations: Record<string, string> = ${JSON.stringify(entries)};\nexport default translations;\n`;

  const ids = ['excerpt-empty', 'excerpt-absent'];
  write('data/blog-articles-data.ts', `const RAW_ARTICLES = [${ids.map(id => `{ id: '${id}', category: 'pratico', date: '2026-10-01' }`).join(',')}];`);
  const seoEntry = (id: string) => `
  'blog-${id}': {
    title: 'Titolo ${id}', description: 'Descrizione SEO fixture.', keywords: 'test',
    ogTitle: 'Titolo social ${id}', ogDescription: 'Descrizione SEO fixture.',
    canonicalPath: '/articoli-frontaliere/${id}/',
    structuredData: {"@context":"https://schema.org","@type":"Article","headline":"Titolo ${id}","description":"Descrizione SEO fixture."},
  },`;
  write('services/seo/seo-blog.ts', `export const entries = {${ids.map(seoEntry).join('')}\n};`);
  write('services/routerBlogData.ts', `export const BLOG_SLUGS = ${JSON.stringify(Object.fromEntries(ids.map(id => [id, { it: id, en: `en-${id}`, de: `de-${id}`, fr: `fr-${id}` }])))};`);
  write('services/locales/blog-meta-it.ts', translationModule({
    'blog.article.excerpt-empty.excerpt': '',
  }));
  write('services/locales/blog-meta-en.ts', translationModule({
    'blog.article.excerpt-empty.title': 'English\r\n\n\tTitle',
    'blog.article.excerpt-empty.excerpt': 'In short: **Questions the board has prepared answers for**',
  }));

  const distDir = path.join(rootDir, 'dist');
  const result = await renderArticlePages({ rootDir, distDir, section: 'frontaliere' });
  expect(result.entries).toHaveLength(ids.length);

  const htmlFor = (id: string, locale: 'it' | 'en') => {
    const entry = result.entries.find(candidate => candidate.articleId === id);
    expect(entry).toBeDefined();
    return fs.readFileSync(path.join(distDir, entry!.paths[locale]), 'utf8');
  };
  expect(visibleExcerpt(htmlFor('excerpt-empty', 'it'))).toBe('');
  expect(visibleExcerpt(htmlFor('excerpt-absent', 'it'))).toBe('Descrizione SEO fixture.');
  expect(visibleExcerpt(htmlFor('excerpt-empty', 'en'))).toBe('Questions the board has prepared answers for');
  expect(new JSDOM(htmlFor('excerpt-empty', 'en')).window.document.querySelector('h1')?.textContent)
    .toBe('English \tTitle');
  const emptyItDocument = new JSDOM(htmlFor('excerpt-empty', 'it')).window.document;
  const absentItDocument = new JSDOM(htmlFor('excerpt-absent', 'it')).window.document;
  const emptySeoDescription = emptyItDocument.querySelector('meta[property="og:description"]')?.getAttribute('content');
  const absentSeoDescription = absentItDocument.querySelector('meta[property="og:description"]')?.getAttribute('content');
  expect(emptySeoDescription).toBe(absentSeoDescription);
  expect(emptySeoDescription).toBe(clampMetaDescription('Descrizione SEO fixture.', undefined, 'it'));
});
