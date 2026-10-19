import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bodyRevisionFingerprint, renderArticlePages } from '../build-plugins/ogPagesPlugin';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('bodyRevisionFingerprint', () => {
  it('is stable across replay, file order, NFC, LF and trailing spaces', () => {
    const first = bodyRevisionFingerprint({
      body2: 'Seconda sezione  \r\n',
      body1: 'Cafe\u0301  \r\nPrima riga\t\r\n',
    });
    const replay = bodyRevisionFingerprint({
      body1: 'Café\nPrima riga\n',
      body2: 'Seconda sezione\n',
    });

    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(first).toBe(replay);
  });

  it('changes when a word in body2 changes', () => {
    const original = bodyRevisionFingerprint({ body1: 'Uno', body2: 'Seconda parola' });
    const changed = bodyRevisionFingerprint({ body1: 'Uno', body2: 'Seconda frase' });

    expect(changed).not.toBe(original);
  });

  it('depends only on body text, not on date or image metadata', () => {
    const bodies = { body1: 'Uno', body2: 'Due' };
    const firstPage = { bodies, date: '2026-10-01', image: '/images/one.webp' };
    const replayedPage = { bodies, date: '2026-10-19', image: '/images/two.webp' };

    expect(bodyRevisionFingerprint(firstPage.bodies)).toBe(bodyRevisionFingerprint(replayedPage.bodies));
  });
});

describe('renderArticlePages body revision marker', () => {
  it('emits one marker in the localized page head', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-body-revision-marker-'));
    temporaryRoots.push(rootDir);
    const write = (file: string, contents: string) => {
      const target = path.join(rootDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    };

    write('data/blog-articles-data.ts', `const RAW_ARTICLES = [
      {id:'body-revision-marker', category:'pensione', date:'2026-10-01'},
    ];`);
    write('services/seo/seo-blog.ts', `export const entries = {
      'blog-body-revision-marker': {
        title: 'Titolo di prova', description: 'Descrizione di prova per l’articolo.',
        canonicalPath: '/articoli-frontaliere/body-revision-marker/',
        structuredData: {"@context":"https://schema.org","@type":"Article","headline":"Titolo di prova"},
      },
    };`);
    write('services/routerBlogData.ts', `export const BLOG_SLUGS = ${JSON.stringify({
      'body-revision-marker': { it: 'body-revision-marker', en: 'body-revision-marker', de: 'body-revision-marker', fr: 'body-revision-marker' },
    })};`);
    write('services/locales/blog-body/it/body-revision-marker.ts', `export default {
      'blog.article.body-revision-marker.body2': 'Dettagli operativi',
      'blog.article.body-revision-marker.body1': 'Contesto iniziale',
    };`);

    const distDir = path.join(rootDir, 'dist');
    const result = await renderArticlePages({
      rootDir,
      distDir,
      section: 'frontaliere',
      onlyArticleId: 'body-revision-marker',
    });
    expect(result.entries).toHaveLength(1);

    const html = fs.readFileSync(path.join(distDir, result.entries[0].paths.it), 'utf8');
    const expected = bodyRevisionFingerprint({
      body1: 'Contesto iniziale',
      body2: 'Dettagli operativi',
    });
    const marker = `<meta name="frontaliere-body-rev" content="${expected}">`;
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>') + '</head>'.length);

    expect(head.match(/<meta name="frontaliere-body-rev" content="[0-9a-f]{16}">/g)).toEqual([marker]);
    expect(html.match(/<meta name="frontaliere-body-rev" content="[0-9a-f]{16}">/g)).toEqual([marker]);
  });
});
