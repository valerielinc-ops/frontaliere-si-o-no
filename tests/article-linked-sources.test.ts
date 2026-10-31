import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ARTICLE_BYLINE_PREFIX, hasLinkedSources } from '@/packages/articles/engine/shared/aiDisclosure';

describe('hasLinkedSources: la frase "fonti linkate" deve essere vera', () => {
  it('riconosce un link Markdown e un href HTML verso un sito esterno', () => {
    expect(hasLinkedSources('Fonte: [VareseNews](https://www.varesenews.it/2026/10/x/)')).toBe(true);
    expect(hasLinkedSources('<p><a href="https://www.fedlex.admin.ch/eli/oc/2023/429/it">Fedlex</a></p>')).toBe(true);
    expect(hasLinkedSources(['senza link', '[Agenzia](https://www.agenziaentrate.gov.it/portale/)'])).toBe(true);
  });

  it('non conta link interni, nav:, immagini e crediti immagine', () => {
    expect(hasLinkedSources('usa il [calcolatore](nav:calculator)')).toBe(false);
    expect(hasLinkedSources('[guida](https://frontaliereticino.ch/guida-frontaliere/)')).toBe(false);
    expect(hasLinkedSources('[guida](https://www.frontaliereticino.ch/guida-frontaliere/)')).toBe(false);
    expect(hasLinkedSources('![copertina](https://upload.wikimedia.org/x.jpg)')).toBe(false);
    expect(hasLinkedSources('<a href="https://commons.wikimedia.org/wiki/File:X.jpg">autore</a>')).toBe(false);
    expect(hasLinkedSources('<a href="https://creativecommons.org/licenses/by-sa/4.0/">CC</a>')).toBe(false);
  });

  it('un testo senza link, vuoto o assente non afferma fonti', () => {
    expect(hasLinkedSources('Testo piano che cita https://example.com senza link.')).toBe(false);
    expect(hasLinkedSources('')).toBe(false);
    expect(hasLinkedSources(undefined)).toBe(false);
    expect(hasLinkedSources(null)).toBe(false);
  });

  it('il render statico e la SPA passano dallo stesso predicato', () => {
    const staticEngine = readFileSync('packages/articles/engine/ogPagesPlugin.ts', 'utf8');
    const spa = readFileSync('components/community/BlogArticles.tsx', 'utf8');
    expect(staticEngine).toContain('hasLinkedSources(bodyHtml)');
    expect(spa).toContain('hasLinkedSources(collectArticleBodySegments(article.id, t))');
    expect(staticEngine).not.toMatch(/\$\{esc\(statement\)\} \$\{esc\(tr\.sources\)\}/);
  });
});

describe('byline statica localizzata', () => {
  it('coincide con blog.bylinePrefix delle quattro lingue', () => {
    for (const [locale, prefix] of Object.entries(ARTICLE_BYLINE_PREFIX)) {
      const file = readFileSync(`services/locales/${locale}-stats.ts`, 'utf8');
      expect(file).toContain(`'blog.bylinePrefix': '${prefix}'`);
    }
  });

  it('il render statico non scrive piu\' la preposizione italiana fissa', () => {
    const staticEngine = readFileSync('packages/articles/engine/ogPagesPlugin.ts', 'utf8');
    expect(staticEngine).not.toContain('<p class="article-byline s-L_lk4l">Di ');
    expect(staticEngine).toContain('ARTICLE_BYLINE_PREFIX[disclosureLocale(locale)]');
  });
});
