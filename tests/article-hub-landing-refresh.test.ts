// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshArticleHubLandings } from '../scripts/lib/refresh-article-hub-landings.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

function writeFixture(root: string, omitItNewestTitle = false) {
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'services', 'locales'), { recursive: true });

  writeFileSync(
    join(root, 'data', 'blog-articles-data.ts'),
    `export const ARTICLES = [
      { id: 'newest', category: 'novita', date: '2026-10-16', image: '/images/blog/newest.webp' },
      { id: 'older', category: 'pratico', date: '2026-10-15', image: '/images/blog/older.webp' },
    ];
`,
  );
  writeFileSync(
    join(root, 'services', 'routerBlogData.ts'),
    `const BLOG_SLUGS = {
      'newest': { it: 'newest-it', en: 'newest-en', de: 'newest-de', fr: 'newest-fr' },
      'older': { it: 'older-it', en: 'older-en', de: 'older-de', fr: 'older-fr' },
    };
`,
  );

  for (const locale of LOCALES) {
    const newestTitle = locale === 'it' && omitItNewestTitle ? '' : `${locale} newest title`;
    const metadata = [
      ['blog.article.newest.title', newestTitle],
      ['blog.article.newest.excerpt', `${locale} newest excerpt`],
      ['blog.article.older.title', `${locale} older title`],
      ['blog.article.older.excerpt', `${locale} older excerpt`],
    ].map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`).join('\n');
    writeFileSync(
      join(root, 'services', 'locales', `blog-meta-${locale}.ts`),
      `const META: Record<string, string> = {\n${metadata}\n};\nexport default META;\n`,
    );
  }
}

const SHELL =
  '<div class="s-wWmcGm"><article><h1>Editorial shell</h1></article>' +
  '<p><a href="https://www.estv.admin.ch">ESTV</a> · ' +
  '<a href="https://www.agenziaentrate.gov.it">Agenzia</a> · ' +
  '<a href="https://www.bfs.admin.ch">BFS</a></p>' +
  '<div style="min-height:38rem"></div><nav class="s-eazYqN">nav</nav></div>';

function fakeFetch(html: string, seen: string[]) {
  return async (url: string) => {
    seen.push(url);
    return { ok: true, status: 200, text: async () => html };
  };
}

describe('refreshArticleHubLandings', () => {
  it('creates and refreshes all localized root grids, then returns their push paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'article-hub-landing-'));
    const dist = join(root, 'dist');
    const seen: string[] = [];
    try {
      writeFixture(root);
      const result = await refreshArticleHubLandings({
        rootDir: root,
        distDir: dist,
        section: 'frontaliere',
        siteBase: 'https://example.test',
        fetchImpl: fakeFetch(SHELL, seen),
      });

      expect(result.errors).toEqual([]);
      expect(result.written).toBe(4);
      expect(seen).toEqual([
        'https://example.test/articoli-frontaliere/',
        'https://example.test/en/cross-border-articles/',
        'https://example.test/de/grenzgaenger-artikel/',
        'https://example.test/fr/articles-frontalier/',
      ]);

      for (const locale of LOCALES) {
        const prefix = locale === 'it' ? '' : `${locale}/`;
        const slug = locale === 'it' ? 'articoli-frontaliere' : {
          en: 'cross-border-articles',
          de: 'grenzgaenger-artikel',
          fr: 'articles-frontalier',
        }[locale];
        const rel = `${prefix}${slug}/index.html`;
        expect(result.pathsByLocale[locale]).toEqual([rel]);
        const html = readFileSync(join(dist, rel), 'utf-8');
        expect(html).toContain('<div class="ssg-article-grid">');
        expect(html).toContain(`href="/${prefix}${slug}/newest-${locale}/"`);
        expect(html).toContain('https://cdn.frontaliereticino.ch/images/blog/newest.webp');
        expect(html).not.toContain('src="/images/blog/');
        expect(html).toContain(`https://www.estv.admin.ch/${locale}`);
        expect(html).toContain(`https://www.agenziaentrate.gov.it/portale/`);
        expect(html).toContain(`https://www.bfs.admin.ch/${locale}/`);
        expect(html).not.toContain('href="https://www.estv.admin.ch"');
        expect(html).not.toContain('href="https://www.agenziaentrate.gov.it"');
        expect(html).not.toContain('href="https://www.bfs.admin.ch"');
        expect(html).toContain('<nav class="s-eazYqN">nav</nav>');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a locale with incomplete metadata instead of falling back to an invented card', async () => {
    const root = mkdtempSync(join(tmpdir(), 'article-hub-landing-meta-'));
    try {
      writeFixture(root, true);
      const result = await refreshArticleHubLandings({
        rootDir: root,
        distDir: join(root, 'dist'),
        section: 'frontaliere',
        locales: ['it'],
        siteBase: 'https://example.test',
        fetchImpl: fakeFetch(SHELL, []),
      });

      expect(result.written).toBe(0);
      expect(result.errors[0]).toContain('metadata coverage is incomplete');
      expect(existsSync(join(root, 'dist', 'articoli-frontaliere', 'index.html'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an unbalanced live grid without replacing the shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'article-hub-landing-grid-'));
    try {
      writeFixture(root);
      const broken = '<div class="ssg-article-grid"><a>broken</a><nav class="s-eazYqN">nav</nav>';
      const result = await refreshArticleHubLandings({
        rootDir: root,
        distDir: join(root, 'dist'),
        section: 'frontaliere',
        locales: ['it'],
        siteBase: 'https://example.test',
        fetchImpl: fakeFetch(broken, []),
      });

      expect(result.written).toBe(0);
      expect(result.errors[0]).toContain('no balanced article grid');
      expect(existsSync(join(root, 'dist', 'articoli-frontaliere', 'index.html'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
