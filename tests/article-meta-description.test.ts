import { describe, expect, it } from 'vitest';

import {
  ARTICLE_META_DESCRIPTION_MIN_CHARS,
  bodySentenceCandidates,
  composeArticleMetaDescription,
  splitSentences,
} from '../packages/articles/engine/shared/articleMetaDescription';
import {
  clampMetaDescription,
  META_DESCRIPTION_MAX_CHARS,
  META_DESCRIPTION_MIN_CHARS,
  TITLE_MAX_CHARS,
} from '../build-plugins/shared/titleSuffix';

const MAX = META_DESCRIPTION_MAX_CHARS;

// Live EN body of /en/cross-border-articles/naspi-frontier-worker-requirements/
// (2026-10-24): a TL;DR, then key-fact rows left in Italian.
const NASPI_BODY = [
  '### TL;DR\n- NASpI supports Italian cross-border workers in Switzerland who lose their job involuntarily.\n- Requires 13 weeks of contributions in 4 years; the 30-workday rule no longer applies since 2022.\n- NASpI amount is calculated based on average salary, with a maximum of €1,584.70 monthly in 2026.',
  '### Key facts\n- **Beneficio**: NASpI (Nuova Assicurazione Sociale per l\'Impiego)\n- **Gestito da**: INPS (Istituto Nazionale della Previdenza Sociale)',
];
const NASPI_LEDE = 'Discover the requirements for NASpI in Italy, how to calculate it, and the differences with Swiss unemployment benefits.';

describe('composeArticleMetaDescription', () => {
  it('shares the Bing floor with the site constant', () => {
    expect(ARTICLE_META_DESCRIPTION_MIN_CHARS).toBe(META_DESCRIPTION_MIN_CHARS);
  });

  it('completes a short lede with the article\'s own sentences, not a boilerplate', () => {
    const out = composeArticleMetaDescription(NASPI_LEDE, NASPI_BODY, { max: MAX });
    expect(out.startsWith(NASPI_LEDE)).toBe(true);
    expect(out.length).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_CHARS);
    expect(out.length).toBeLessThanOrEqual(MAX);
    expect(out).not.toMatch(/Practical guide and free/);
    expect(out).toMatch(/[.!?]$/);
    // the untranslated fact rows never reach an English snippet
    expect(out).not.toMatch(/Beneficio|Gestito da/);
    // and the final clamp leaves it intact: no ellipsis, no generic tail
    expect(clampMetaDescription(out, MAX, 'en')).toBe(out);
  });

  it('ends an over-long lede on its last complete sentence instead of an ellipsis', () => {
    const lede = 'Il 6 ottobre si corrono la Tre Valli Women\'s Race e la 105a Tre Valli Varesine con partenza da Busto Arsizio. Arrivo in via Sacco a Varese. Sei giri del circuito finale con chiusure strade dalle 9.';
    expect(lede.length).toBeGreaterThan(MAX);
    const out = composeArticleMetaDescription(lede, [], { max: MAX });
    expect(out).toBe('Il 6 ottobre si corrono la Tre Valli Women\'s Race e la 105a Tre Valli Varesine con partenza da Busto Arsizio. Arrivo in via Sacco a Varese.');
  });

  it('keeps the lede when no whole sentence prefix reaches the floor', () => {
    const lede = 'Una frase sola, lunghissima, che supera il budget senza alcun punto intermedio e quindi non offre un confine di frase utilizzabile per chiudere bene lo snippet';
    expect(composeArticleMetaDescription(lede, [], { max: MAX })).toBe(lede);
  });

  it('keeps a complete prefix even when it is shorter than the floor', () => {
    const lede = 'Una frase completa di circa cento caratteri che termina prima del limite. Una seconda frase che fa superare il budget massimo dello snippet.';
    const out = composeArticleMetaDescription(lede, [], { max: 120, min: 120 });
    expect(out).toBe('Una frase completa di circa cento caratteri che termina prima del limite.');
    expect(out.length).toBeLessThan(120);
    expect(out).toMatch(/[.!?…]$/);
  });

  it('returns the lede unchanged when the body has nothing usable', () => {
    const lede = 'Breve descrizione.';
    expect(composeArticleMetaDescription(lede, ['## Titolo', '| a | b |', '- **Voce**: valore'], { max: MAX })).toBe(lede);
  });

  it('does not repeat a sentence the lede already says', () => {
    const lede = 'NASpI supports Italian cross-border workers in Switzerland who lose their job involuntarily.';
    const out = composeArticleMetaDescription(lede, NASPI_BODY, { max: MAX });
    expect(out.split('who lose their job involuntarily').length).toBe(2);
  });

  it('splits sentences without breaking decimals or amounts', () => {
    expect(splitSentences('Massimo €1.584,70 al mese. Dal 2026 cambia. ok')).toEqual(['Massimo €1.584,70 al mese.', 'Dal 2026 cambia. ok']);
    expect(bodySentenceCandidates(['- Requires 13 weeks of contributions in the last four years'])).toEqual([
      'Requires 13 weeks of contributions in the last four years.',
    ]);
  });

  it('keeps closing punctuation attached to a sentence boundary', () => {
    expect(splitSentences('Una frase tra parentesi (completa). Seconda frase!')).toEqual([
      'Una frase tra parentesi (completa).',
      'Seconda frase!',
    ]);
    expect(splitSentences('Una frase tra virgolette "completa." Terza frase.')).toEqual([
      'Una frase tra virgolette "completa."',
      'Terza frase.',
    ]);
  });
});

describe('clampMetaDescription enrichment ends on a clause boundary', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('%s: never ends on a bare verb fragment', (locale) => {
    // Live IT example (2026-10-24): "…budget mensile reale 2026. Scopri"
    const short = 'Quanto costa vivere a Lugano da frontaliere: affitto, LAMal, tasse, trasporti e spesa, budget mensile reale 2026.';
    const out = clampMetaDescription(short, MAX, locale);
    expect(out.length).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_CHARS);
    expect(out.length).toBeLessThanOrEqual(MAX);
    expect(out).toMatch(/[.…]$/);
    expect(out).not.toMatch(/\s(Scopri|Explore|Entdecke|Découvrez)$/);
  });

  it('keeps the Bing floor when clause peeling would over-amputate', () => {
    const description = 'Praktischer Leitfaden für italienische Grenzgänger: Steuern, G-Genehmigung, KVG, Verbindungen und Lebenshaltungskosten auf italienisch-schweizerischer Seite.';
    const out = clampMetaDescription(description, MAX, 'de');
    expect(out.length).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_CHARS);
    expect(out.length).toBeLessThanOrEqual(MAX);
    expect(out).toMatch(/…$/);
  });
});

describe('dated evergreen article title identity', () => {
  it('caps an Article title while leaving the source headline complete', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { renderArticlePages } = await import('../build-plugins/ogPagesPlugin');
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-evergreen-title-'));
    const published = new Date().toISOString().slice(0, 10);
    const headline = 'Guida evergreen datata per frontalieri con requisiti, costi e procedura completa';
    const description = 'Una descrizione editoriale abbastanza lunga per verificare il limite Bing senza perdere il contesto utile della guida per i lavoratori frontalieri.';
    const write = (file: string, body: string) => {
      const target = path.join(rootDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    };
    try {
      write('data/blog-articles-data.ts', `const RAW_ARTICLES = [
        { id: 'dated-evergreen', category: 'pratico', date: '${published}', articleType: 'evergreen' },
      ];`);
      write('services/seo/seo-blog.ts', `export const entries = {
        'blog-dated-evergreen': {
          title: ${JSON.stringify(headline)},
          description: ${JSON.stringify(description)},
          canonicalPath: '/articoli-frontaliere/dated-evergreen/',
          structuredData: ${JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Article',
            headline,
            datePublished: `${published}T00:00:00+00:00`,
          })},
        },
      };`);
      write('services/routerBlogData.ts', `export const BLOG_SLUGS = ${JSON.stringify({
        'dated-evergreen': { it: 'dated-evergreen', en: 'dated-evergreen', de: 'dated-evergreen', fr: 'dated-evergreen' },
      })};`);
      const distDir = path.join(rootDir, 'dist');
      const result = await renderArticlePages({ rootDir, distDir, section: 'frontaliere' });
      expect(result.entries).toHaveLength(1);
      const html = fs.readFileSync(path.join(distDir, result.entries[0].paths.it), 'utf8');
      const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
      const descriptions = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
      const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map(([, json]) => JSON.parse(json));
      const article = schemas.find((schema) => schema['@type'] === 'Article');
      expect(title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
      expect(descriptions.length).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_CHARS);
      expect(descriptions.length).toBeLessThanOrEqual(MAX);
      expect(article).toBeDefined();
      expect(article!.headline).toBe(headline);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('rendered article pages carry the composed description', () => {
  it('NASpI EN/DE/FR: own sentences, no boilerplate tail, no Italian keywords', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { renderArticlePages } = await import('../build-plugins/ogPagesPlugin');
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-meta-desc-'));
    try {
      const { entries } = await renderArticlePages({
        rootDir: process.cwd(),
        distDir,
        section: 'frontaliere',
        onlyArticleId: 'naspi-frontaliere-italia-requisiti',
      });
      expect(entries).toHaveLength(1);
      for (const locale of ['en', 'de', 'fr'] as const) {
        const html = fs.readFileSync(path.join(distDir, entries[0].paths[locale]), 'utf8');
        const desc = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
        expect(desc.length, `${locale}: ${desc}`).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_CHARS);
        expect(desc.length, `${locale}: ${desc}`).toBeLessThanOrEqual(MAX);
        expect(desc, locale).not.toMatch(/Practical guide and free|Praxisratgeber und kostenlose|Guide pratique et outils gratuits/);
        expect(desc, locale).not.toMatch(/\s(Scopri|Explore|Entdecke|Découvrez)$/);
        expect(html, locale).not.toMatch(/"keywords":\["NASpI frontalieri"/);
      }
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }, 300_000);
});
