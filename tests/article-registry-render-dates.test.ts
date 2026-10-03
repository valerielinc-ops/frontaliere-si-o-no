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
        "headline":"Pensione", "datePublished":"2026-10-01", "dateModified":"2026-10-02"},
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
    const article = schemas.find(schema => ['Article','NewsArticle','BlogPosting'].includes(schema['@type']));
    expect(article).toBeDefined();
    const expected = output.articleId === 'ticino-rimborso-lpp-2024' ? '2026-10-03' : '2026-10-02';
    expect(article.dateModified.slice(0,10)).toBe(expected);
    expect(html).toContain(`itemprop="dateModified"`);
    expect(html).toContain(`datetime="${expected}"`);
    }
  }
});
