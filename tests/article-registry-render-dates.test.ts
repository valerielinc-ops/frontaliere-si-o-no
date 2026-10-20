import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderArticlePages } from '../build-plugins/ogPagesPlugin';

const temporaryRoots: string[] = [];
afterEach(() => temporaryRoots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it('renders each article revision independently in all four locales', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-revision-fixture-'));
  temporaryRoots.push(rootDir);
  const write = (file: string, body: string) => {
    const target = path.join(rootDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  const ids = ['previous-without-revision', 'ticino-rimborso-lpp-2024'];
  write('data/blog-articles-data.ts', `const RAW_ARTICLES = [
    {id:'previous-without-revision', category:'pensione', date:'2026-10-01'},
    {id:'ticino-rimborso-lpp-2024', category:'pensione', date:'2026-10-01', updatedAt:'2026-10-03'},
  ];`);
  const entry = (id: string) => `
    'blog-${id}': {
      title: 'Pensione: ${id}', description: 'Guida alla previdenza per i frontalieri.',
      canonicalPath: '/articoli-frontaliere/${id}/',
      structuredData: {"@context":"https://schema.org","@type":"Article",
        "headline":"Pensione"${id === 'ticino-rimborso-lpp-2024' ? ', "datePublished":"2026-10-01"' : ''}, "dateModified":"2026-10-02"},
    },`;
  write('services/seo/seo-blog.ts', `export const entries = {${ids.map(entry).join('\n')}};`);
  write('services/routerBlogData.ts', `export const BLOG_SLUGS = ${JSON.stringify(Object.fromEntries(ids.map(id => [id, {it:id,en:id,de:id,fr:id}])))};`);
  const distDir = path.join(rootDir, 'dist');
  const result = await renderArticlePages({ rootDir, distDir, section: 'frontaliere' });
  expect(result.entries).toHaveLength(2);
  for (const output of result.entries) {
    expect(Object.values(output.paths)).toHaveLength(4);
    for (const file of Object.values(output.paths)) {
    const html = fs.readFileSync(path.join(distDir, file), 'utf8');
    const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
    const article = schemas.find(schema => ['Article','NewsArticle','BlogPosting','WebPage'].includes(schema['@type']));
    expect(article).toBeDefined();
    expect(article['@id']).toBe(`${article.url}#article`);
    expect(article.datePublished).toMatch(/^2026-10-01/);
    const expected = output.articleId === 'ticino-rimborso-lpp-2024' ? '2026-10-03' : '2026-10-02';
    expect(article.dateModified.slice(0,10)).toBe(expected);
    expect(html).toContain(`itemprop="dateModified"`);
    expect(html).toContain(`datetime="${expected}"`);
    }
  }
});

it('scopes Event identity to the page URL', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-event-identity-fixture-'));
  temporaryRoots.push(rootDir);
  const write = (file: string, body: string) => {
    const target = path.join(rootDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  write('data/blog-articles-data.ts', `const RAW_ARTICLES = [
    {id:'event-identity', category:'eventi', date:'2026-10-01'},
  ];`);
  write('services/seo/seo-blog.ts', `export const entries = {
    'blog-event-identity': {
      title: 'Mostra di prova', description: 'Un evento di prova per il test.',
      canonicalPath: '/articoli-frontaliere/event-identity/',
      structuredData: {"@context":"https://schema.org","@type":"Event",
        "name":"Mostra di prova", "startDate":"2026-10-10T18:00:00+02:00"},
    },
  };`);
  write('services/routerBlogData.ts', `export const BLOG_SLUGS = ${JSON.stringify({ 'event-identity': { it: 'event-identity', en: 'event-identity', de: 'event-identity', fr: 'event-identity' } })};`);
  const distDir = path.join(rootDir, 'dist');
  const result = await renderArticlePages({ rootDir, distDir, section: 'frontaliere' });
  expect(result.entries).toHaveLength(1);
  const html = fs.readFileSync(path.join(distDir, result.entries[0].paths.it), 'utf8');
  const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, json]) => JSON.parse(json));
  const event = schemas.find((schema) => schema['@type'] === 'Event');
  expect(event).toBeDefined();
  expect(event['@id']).toBe(`${event.url}#event`);
});

it.each([
  { datePublished: '2026-02-18T11:45:01+00:00', dateModified: '2026-02-19T12:15:00+00:00' },
  { datePublished: '2026-02-18T11:45:01+00:00', dateModified: undefined },
  { datePublished: undefined, dateModified: '2026-02-19T12:15:00+00:00' },
])('preserves known dates and omits unknown dates in four locales: %j', async (dates) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-unknown-date-fixture-'));
  temporaryRoots.push(rootDir);
  const write = (file: string, body: string) => {
    const target = path.join(rootDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  const ids = ['known-dates', 'unknown-dates'];
  write('data/blog-articles-data.ts', `const RAW_ARTICLES = [
    {id:'known-dates', category:'pratico'},
    {id:'unknown-dates', category:'pratico', date:''},
  ];`);
  write('services/seo/seo-blog.ts', `export const entries = {${ids.map(id => `
    'blog-${id}': {
      title: 'Guida: ${id}', description: 'Informazioni per i frontalieri.',
      canonicalPath: '/articoli-frontaliere/${id}/',
      structuredData: ${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline: 'Guida', ...(id === 'known-dates' ? dates : {}) })},
    },`).join('\n')}};`);
  write('services/routerBlogData.ts', `export const BLOG_SLUGS = ${JSON.stringify(Object.fromEntries(ids.map(id => [id, {it:id,en:id,de:id,fr:id}])))};`);
  const distDir = path.join(rootDir, 'dist');
  const result = await renderArticlePages({ rootDir, distDir, section: 'frontaliere' });
  expect(result.entries).toHaveLength(2);
  for (const output of result.entries) {
    expect(Object.values(output.paths)).toHaveLength(4);
    const expected: { datePublished?: string; dateModified?: string } = output.articleId === 'known-dates' ? dates : {};
    for (const file of Object.values(output.paths)) {
      const html = fs.readFileSync(path.join(distDir, file), 'utf8');
      const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
      const article = schemas.find(schema => ['Article', 'NewsArticle', 'BlogPosting', 'WebPage'].includes(schema['@type']));
      expect(article).toBeDefined();
      expect(article!['@type']).toBe(expected.datePublished ? 'NewsArticle' : 'WebPage');
      const byline = html.match(/<p class="article-byline[^\"]*">([\s\S]*?)<\/p>/)?.[1];
      expect(byline).toBeDefined();
      for (const [key, property] of [['datePublished', 'article:published_time'], ['dateModified', 'article:modified_time']] as const) {
        const value = expected[key];
        if (value) {
          expect(article[key]).toBe(value);
          expect(html).toContain(`<meta property="${property}" content="${value}">`);
          expect(byline).toContain(`itemprop="${key}"`);
          expect(byline).toContain(`datetime="${value.slice(0,10)}"`);
        } else {
          expect(article).not.toHaveProperty(key);
          expect(html).not.toContain(`property="${property}"`);
          expect(byline).not.toContain(`itemprop="${key}"`);
        }
      }
      expect(byline).not.toMatch(/·\s*$/);
      if (output.articleId === 'unknown-dates') expect(byline).not.toContain('<time');
    }
  }
});
