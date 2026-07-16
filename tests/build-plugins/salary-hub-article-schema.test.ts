import { describe, expect, it } from 'vitest';
import {
  EVERGREEN_ARTICLES,
  generateArticleHtml,
  type ScenarioDataMap,
} from '../../build-plugins/salaryHubArticles';

// generateArticleHtml resolves SPA entry assets from `distDir`; a non-existent
// path is handled gracefully (resolveEntryAssets try/catch → empty strings), so
// no prior Vite build is needed for these unit assertions.
const NO_DIST = '/tmp/nonexistent-dist-for-article-schema-test';
const EMPTY_DATA: ScenarioDataMap = { scenarios: [], results: new Map() };
const LOCALES = ['it', 'en', 'de', 'fr'] as const;

/** Extract every application/ld+json payload from a rendered page as objects. */
function extractJsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const rx = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html)) !== null) {
    // The template escapes `<` → <; JSON.parse decodes it back.
    out.push(JSON.parse(m[1]) as Record<string, unknown>);
  }
  return out;
}

function articleSchemaOf(html: string): Record<string, unknown> | undefined {
  return extractJsonLd(html).find((s) => s['@type'] === 'Article');
}

const taxHub = EVERGREEN_ARTICLES.find((a) => a.id === 'hub-fiscale-frontalieri')!;

describe('salary-hub evergreen articles — Article JSON-LD', () => {
  it('the tax-guide hub emits a complete Article schema in every locale', () => {
    expect(taxHub).toBeDefined();
    for (const locale of LOCALES) {
      const html = generateArticleHtml(taxHub, locale, EMPTY_DATA, NO_DIST);
      const article = articleSchemaOf(html);
      expect(article, `Article schema present for ${locale}`).toBeDefined();

      // Core Article rich-result fields.
      expect(article!['@context']).toBe('https://schema.org');
      expect(article!.headline).toBe(taxHub.titles[locale]);
      expect(article!.description).toBe(taxHub.descriptions[locale]);
      expect(article!.inLanguage).toBe(locale);
      expect(typeof article!.image).toBe('string');
      expect(article!.image).toMatch(/\/og-image\.png$/);

      // url + mainEntityOfPage must agree with the canonical locale URL.
      const url = article!.url as string;
      expect(url).toMatch(/^https?:\/\//);
      expect((article!.mainEntityOfPage as Record<string, unknown>)['@id']).toBe(url);

      // Dates present and ISO — day-truncated so they don't churn per deploy.
      expect(article!.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
      expect(article!.dateModified).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);

      // Explicit author + publisher E-E-A-T signal.
      const author = article!.author as Record<string, unknown>;
      expect(author['@type']).toBe('Organization');
      expect(author.name).toBe('Frontaliere Ticino');

      const publisher = article!.publisher as Record<string, unknown>;
      expect(publisher['@type']).toBe('Organization');
      expect(publisher.name).toBe('Frontaliere Ticino');

      // Publisher logo must be a licensable ImageObject (GSC image gate).
      const logo = publisher.logo as Record<string, unknown>;
      expect(logo['@type']).toBe('ImageObject');
      for (const field of ['acquireLicensePage', 'copyrightNotice', 'license', 'creator', 'creditText']) {
        expect(logo[field], `logo.${field} present`).toBeTruthy();
      }
    }
  });

  it('FAQPage and BreadcrumbList schemas still ship alongside Article (no regression)', () => {
    const html = generateArticleHtml(taxHub, 'it', EMPTY_DATA, NO_DIST);
    const types = extractJsonLd(html).map((s) => s['@type']);
    expect(types).toContain('Article');
    expect(types).toContain('FAQPage');
    expect(types).toContain('BreadcrumbList');
  });

  it('every evergreen article (not just the tax hub) emits an Article schema', () => {
    for (const article of EVERGREEN_ARTICLES) {
      const html = generateArticleHtml(article, 'it', EMPTY_DATA, NO_DIST);
      const schema = articleSchemaOf(html);
      expect(schema, `Article schema present for ${article.id}`).toBeDefined();
      expect(schema!.headline).toBe(article.titles.it);
    }
  });

  it('omits the description field instead of emitting "" for a blank locale entry', () => {
    const blankDescArticle = { ...taxHub, descriptions: { ...taxHub.descriptions, it: '   ' } };
    const html = generateArticleHtml(blankDescArticle, 'it', EMPTY_DATA, NO_DIST);
    const schema = articleSchemaOf(html)!;
    expect('description' in schema).toBe(false);
  });

  it('caps an over-length description at the JSON-LD practical limit', () => {
    const longDescArticle = { ...taxHub, descriptions: { ...taxHub.descriptions, it: 'a'.repeat(6000) } };
    const html = generateArticleHtml(longDescArticle, 'it', EMPTY_DATA, NO_DIST);
    const schema = articleSchemaOf(html)!;
    expect((schema.description as string).length).toBe(5000);
  });
});
