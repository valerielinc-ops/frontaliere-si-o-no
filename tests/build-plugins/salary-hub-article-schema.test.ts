import { describe, expect, it } from 'vitest';
import {
  EVERGREEN_ARTICLES,
  generateArticleHtml,
  type ScenarioDataMap,
} from '../../build-plugins/salaryHubArticles';
import { META_DESCRIPTION_MAX_CHARS } from '../../build-plugins/shared/titleSuffix';

// generateArticleHtml resolves SPA entry assets from `distDir`, but
// resolveEntryAssets returns the fixed filenames unconditionally (no disk
// check), so a non-existent path works fine — no prior Vite build is needed
// for these unit assertions.
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

function pageSchemaOf(html: string): Record<string, unknown> | undefined {
  return extractJsonLd(html).find((s) => s['@type'] === 'WebPage');
}

const taxHub = EVERGREEN_ARTICLES.find((a) => a.id === 'hub-fiscale-frontalieri')!;

describe('salary-hub evergreen guides — WebPage JSON-LD', () => {
  it('keeps Italian guide snippets within the SERP description budget', () => {
    for (const article of EVERGREEN_ARTICLES) {
      expect(
        article.descriptions.it.length,
        `${article.id}: Italian description length`,
      ).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);
    }
  });

  it('the tax-guide hub emits a complete WebPage schema in every locale', () => {
    expect(taxHub).toBeDefined();
    for (const locale of LOCALES) {
      const html = generateArticleHtml(taxHub, locale, EMPTY_DATA, NO_DIST);
      const article = pageSchemaOf(html);
      expect(article, `WebPage schema present for ${locale}`).toBeDefined();

      // Core page fields; this evergreen guide has no editorial publication date.
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

      // Optional dates need editorial provenance; a rebuild is not publication.
      expect(article).not.toHaveProperty('datePublished');
      expect(article).not.toHaveProperty('dateModified');

      // Explicit author + publisher E-E-A-T signal.
      const author = article!.author as Record<string, unknown>;
      expect(author['@type']).toBe('Organization');
      expect(author['@id']).toBe('https://frontaliereticino.ch/#organization');
      expect(author.name).toBe('Frontaliere Ticino');

      const publisher = article!.publisher as Record<string, unknown>;
      expect(publisher['@type']).toBe('Organization');
      expect(publisher['@id']).toBe('https://frontaliereticino.ch/#organization');
      expect(publisher.name).toBe('Frontaliere Ticino');

      // Publisher logo must be a licensable ImageObject (GSC image gate).
      const logo = publisher.logo as Record<string, unknown>;
      expect(logo['@type']).toBe('ImageObject');
      for (const field of ['acquireLicensePage', 'copyrightNotice', 'license', 'creator', 'creditText']) {
        expect(logo[field], `logo.${field} present`).toBeTruthy();
      }
    }
  });

  it('FAQPage and BreadcrumbList schemas still ship alongside WebPage (no regression)', () => {
    const html = generateArticleHtml(taxHub, 'it', EMPTY_DATA, NO_DIST);
    const types = extractJsonLd(html).map((s) => s['@type']);
    expect(types).toContain('WebPage');
    expect(types).toContain('FAQPage');
    expect(types).toContain('BreadcrumbList');
  });

  it('every evergreen guide (not just the tax hub) emits a WebPage schema', () => {
    for (const article of EVERGREEN_ARTICLES) {
      const html = generateArticleHtml(article, 'it', EMPTY_DATA, NO_DIST);
      const schema = pageSchemaOf(html);
      expect(schema, `WebPage schema present for ${article.id}`).toBeDefined();
      expect(schema!.headline).toBe(article.titles.it);
    }
  });

  it('omits the description field instead of emitting "" for a blank locale entry', () => {
    const blankDescArticle = { ...taxHub, descriptions: { ...taxHub.descriptions, it: '   ' } };
    const html = generateArticleHtml(blankDescArticle, 'it', EMPTY_DATA, NO_DIST);
    const schema = pageSchemaOf(html)!;
    expect('description' in schema).toBe(false);
  });

  it('caps an over-length description at the JSON-LD practical limit', () => {
    const longDescArticle = { ...taxHub, descriptions: { ...taxHub.descriptions, it: 'a'.repeat(6000) } };
    const html = generateArticleHtml(longDescArticle, 'it', EMPTY_DATA, NO_DIST);
    const schema = pageSchemaOf(html)!;
    expect((schema.description as string).length).toBe(5000);
  });
});
