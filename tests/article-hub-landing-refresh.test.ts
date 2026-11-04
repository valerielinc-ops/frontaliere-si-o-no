// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
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
import { refreshArticleHubLandings, stripCloudflareJsDetection } from '../scripts/lib/refresh-article-hub-landings.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

function writeFixture(root: string, omitItNewestTitle = false) {
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'public'), { recursive: true });
  mkdirSync(join(root, 'services', 'locales'), { recursive: true });
  writeFileSync(
    join(root, 'public', 'sitemap-blog.xml'),
    '<urlset><url><loc>https://example.test/articoli-frontaliere/newest-it/</loc></url><url><loc>https://example.test/articoli-frontaliere/older-it/</loc></url><url><loc>https://example.test/articoli-frontaliere/</loc></url></urlset>',
  );

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

const cfSnippet = (ray: string) =>
  `<script>(function(){function c(){var b=a.contentDocument;if(b){var d=b.createElement('script');d.innerHTML="window.__CF$cv$params={r:'${ray}',t:'MTc5'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);";b.getElementsByTagName('head')[0].appendChild(d)}}})();</script>`;

describe('stripCloudflareJsDetection', () => {
  it('removes every accumulated copy and nothing else', () => {
    const html = `<head><script>window.dataLayer=[];</script></head><body><script type="application/ld+json">{"a":1}</script>${cfSnippet('r1')}${cfSnippet('r2')}${cfSnippet('r3')}</body>`;
    expect(stripCloudflareJsDetection(html)).toBe(
      '<head><script>window.dataLayer=[];</script></head><body><script type="application/ld+json">{"a":1}</script></body>',
    );
  });

  it('leaves a page without the snippet byte-identical', () => {
    const html = '<body><script src="/assets/index-entry.js"></script></body>';
    expect(stripCloudflareJsDetection(html)).toBe(html);
  });
});

describe('refreshArticleHubLandings', () => {
  it('never stores the snippet Cloudflare added to the live shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'article-hub-landing-'));
    const dist = join(root, 'dist');
    try {
      writeFixture(root);
      const shell = `${SHELL}${cfSnippet('a4ba8a77cfeaa0f3')}${cfSnippet('a4ba8a77cfeaa0f4')}`;
      expect(shell).toContain('__CF$cv$params');
      const result = await refreshArticleHubLandings({
        rootDir: root,
        distDir: dist,
        section: 'frontaliere',
        siteBase: 'https://example.test',
        fetchImpl: fakeFetch(shell, []),
      });
      expect(result.errors).toEqual([]);
      expect(readFileSync(join(dist, 'articoli-frontaliere/index.html'), 'utf-8')).not.toContain('__CF$cv$params');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries a transient live-shell timeout before refusing the landing', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const root = mkdtempSync(join(tmpdir(), 'article-hub-landing-retry-'));
    try {
      writeFixture(root);
      let attempts = 0;
      const fetchImpl = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
          });
        }
        return { ok: true, status: 200, text: async () => SHELL };
      });

      const pending = refreshArticleHubLandings({
        rootDir: root,
        distDir: join(root, 'dist'),
        section: 'frontaliere',
        locales: ['it'],
        siteBase: 'https://example.test',
        fetchImpl,
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.errors).toEqual([]);
      expect(result.written).toBe(1);
      expect(attempts).toBe(2);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it('reconciles the live hub count and separates telework from the 45-day return rule', async () => {
    const root = mkdtempSync(join(tmpdir(), 'article-hub-claims-'));
    const dist = join(root, 'dist');
    try {
      writeFixture(root);
      const shell = `${SHELL}<p class="s-6g7z41"><strong>Articoli Frontaliere</strong> è l'hub editoriale di Frontaliere Ticino con oltre 870 articoli di approfondimento dedicati ai lavoratori transfrontalieri tra Italia e Svizzera. Le novità includono la ratifica definitiva del telelavoro fino a 45 giorni.</p>`;
      const result = await refreshArticleHubLandings({
        rootDir: root,
        distDir: dist,
        section: 'frontaliere',
        locales: ['it'],
        siteBase: 'https://example.test',
        now: new Date('2026-11-03T12:00:00Z'),
        fetchImpl: fakeFetch(shell, []),
      });

      expect(result.errors).toEqual([]);
      const html = readFileSync(join(dist, 'articoli-frontaliere/index.html'), 'utf-8');
      expect(html).toContain('2 — URL italiane canoniche di dettaglio nella sezione Frontaliere; hub escluso; conteggio al 2026-11-03');
      expect(html).toContain('Protocollo sul telelavoro fino al 25%');
      expect(html).toContain('45 giorni previsti dall’Accordo riguardano i mancati rientri');
      expect(html).not.toContain('oltre 870 articoli');
      expect(html).not.toContain('ratifica definitiva del telelavoro fino a 45 giorni');
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
