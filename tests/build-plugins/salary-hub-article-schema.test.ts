import { describe, expect, it } from 'vitest';
import {
  EVERGREEN_ARTICLES,
  generateArticleHtml,
  type ScenarioDataMap,
} from '../../build-plugins/salaryHubArticles';
import { buildFullPath, type SalaryHubScenario } from '../../build-plugins/salaryHubScenarios';
import type { SimulationResult } from '../../types';
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
      expect(article!.image).toBe('https://frontaliereticino.ch/assets/guide-editorial/salary-desk.jpg');

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

  it('keeps the withholding-tax guide title within the SERP target', () => {
    const article = EVERGREEN_ARTICLES.find((candidate) => candidate.id === 'tabelle-imposta-fonte-ticino')!;
    const html = generateArticleHtml(article, 'it', EMPTY_DATA, NO_DIST);
    const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';

    expect(title).toContain('Imposta alla fonte Ticino: tabelle 2026');
    expect(title.length).toBeLessThanOrEqual(60);
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

describe('20 km salary guide comparison', () => {
  const distanceGuide = EVERGREEN_ARTICLES.find((article) => article.id === 'distanza-confine-20km-frontaliere')!;
  const within: SalaryHubScenario = {
    salary: 80_000,
    frontierType: 'NEW',
    maritalStatus: 'SINGLE',
    children: 0,
    distanceZone: 'WITHIN_20KM',
  };
  const over: SalaryHubScenario = { ...within, distanceZone: 'OVER_20KM' };
  const results = new Map<SalaryHubScenario, SimulationResult>([
    [within, { itResident: { netIncomeAnnual: 48_123 } } as unknown as SimulationResult],
    [over, { itResident: { netIncomeAnnual: 47_456 } } as unknown as SimulationResult],
  ]);
  const comparisonData: ScenarioDataMap = { scenarios: [within, over], results };

  it('puts the localized comparison after the hero and before the contents index', () => {
    const expected = {
      it: ['Confronto diretto: cosa cambia con i 20 km', 'Comune nella fascia dei 20 km', 'l’elenco ufficiale dei Comuni'],
      en: ['Direct comparison: what changes at 20 km', 'Municipality in the 20 km zone', 'official municipality list'],
      de: ['Direkter Vergleich: Was sich bei 20 km ändert', 'Gemeinde innerhalb der 20-km-Zone', 'offizielle Gemeindeliste'],
      fr: ['Comparaison directe : ce qui change à 20 km', 'Commune dans la zone des 20 km', 'liste officielle des communes'],
    };

    for (const locale of LOCALES) {
      const html = generateArticleHtml(distanceGuide, locale, comparisonData, NO_DIST);
      const heroAt = html.indexOf('class=guide-dossier-hero>');
      const comparisonAt = html.indexOf('id=distance-comparison-title');
      const contentsAt = html.indexOf('class=guide-dossier-index');

      expect(html).toContain(expected[locale][0]);
      expect(html).toContain(expected[locale][1]);
      expect(html).toContain(expected[locale][2]);
      expect(heroAt).toBeGreaterThanOrEqual(0);
      expect(comparisonAt).toBeGreaterThan(heroAt);
      expect(contentsAt).toBeGreaterThan(comparisonAt);
    }
  });

  it('uses the matching zone result and links to each exact salary scenario', () => {
    const html = generateArticleHtml(distanceGuide, 'it', comparisonData, NO_DIST);
    const withinNet = (48_123).toLocaleString('de-CH');
    const overNet = (47_456).toLocaleString('de-CH');

    expect(html).toContain(`CHF ${withinNet}`);
    expect(html).toContain(`CHF ${overNet}`);
    expect(html).toContain(`href="${buildFullPath(within, 'it')}"`);
    expect(html).toContain(`href="${buildFullPath(over, 'it')}"`);
    expect(html).toContain(`<a class=!text-on-accent href="${buildFullPath(within, 'it')}">Apri la simulazione entro 20 km</a>`);
    expect(html).toContain(`<a class=!text-on-accent href="${buildFullPath(over, 'it')}">Apri la simulazione oltre 20 km</a>`);
    expect(html).toContain('Apri la simulazione entro 20 km');
    expect(html).toContain('Apri la simulazione oltre 20 km');
    expect(html).toContain('l’elenco ufficiale dei Comuni');
    expect(html).toContain('Non dipende dalla fascia dei 20 km');
    expect(html).toContain('https://documenti.camera.it/leg19/dossier/testi/FI0093.htm');
  });
});
