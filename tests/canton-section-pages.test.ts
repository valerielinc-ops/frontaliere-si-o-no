// Canton article sections, P7a: the engine renders EVERY page of a canton
// section — landing, `/tutti/` archive + page-N, the 6 thematic hubs (D17),
// article pages and RSS — in the 4 locales, without the site.
//
// Two canton sections are switched ON for this file only, by mocking the
// generated activation list: the core keeps `ACTIVE_CANTON_SECTIONS = []` in
// production (no consumer changes behaviour until a canton is activated), and
// the renderers that read the corpus — article pages, archive, RSS — work on
// active sections, exactly as they will once a canton is turned on. canton-ti
// and canton-basilea cover the plain case and a half-canton URL group whose
// French name carries a diacritic (Bâle).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../packages/articles/engine/shared/cantonArticleSectionCore.generated.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ACTIVE_CANTON_SECTIONS: ['canton-basilea', 'canton-ti'] };
});

import '../build-plugins/articlesSiteShellBootstrap';
import { renderArticlePages } from '../packages/articles/engine/ogPagesPlugin';
import { renderArticleHubPages } from '../packages/articles/engine/articleHubPagesPlugin';
import { buildSectionFeeds, rssSectionForId, RSS_SECTIONS } from '../packages/articles/engine/rssFeeds.mjs';
import {
  renderCantonSectionLanding,
  renderCantonSectionLandingPages,
  renderCantonTopicHub,
  corpusSectionEdgeKey,
  offloadCorpusPageAssets,
  CANTON_HUB_MIN_CONTENT_WORDS,
  type CantonTopicHubInput,
} from '../packages/articles/engine/cantonSectionPages';
import {
  CANTON_ARCHIVE_ALL_SLUG,
  CANTON_HUB_TOPIC_CLUSTERS,
  cantonSectionLabel,
} from '../packages/articles/engine/shared/cantonSectionCopy.mjs';
import { ARTICLE_SECTION_CORE, ARTICLE_SECTION_CORE_ALL } from '../packages/articles/engine/shared/articleSectionCore.mjs';
import { CANTON_HUB_TOPIC_KEYS } from '../packages/articles/engine/shared/cantonArticleSectionCore.generated.mjs';
import { CANTON_DISPLAY_NAMES } from '../packages/articles/engine/shared/cantonDisplayNames.mjs';
import { CANTON_DISPLAY } from '../build-plugins/shared/cantonDisplay';
import { TOPIC_CLUSTERS } from '../packages/articles/engine/topicTaxonomy';
import { corpusSectionCdnKey } from '../infra/cloudflare-worker/locale-router.js';
import { repairSerpSnippet } from '../build-plugins/shared/clauseTail.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
type Loc = (typeof LOCALES)[number];
const BASE = 'https://frontaliereticino.ch';
const SECTIONS = ['canton-ti', 'canton-basilea'] as const;
/** Any URL of the national section — what a canton page must never point at as its own. */
const SVIZZERA_URL_RX = /\/(?:articoli-svizzera|swiss-articles|schweiz-artikel|articles-suisse)\//g;

function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

interface FixtureArticle { id: string; slugs: Record<Loc, string>; date: string }

const ARTICLES: FixtureArticle[] = [
  { id: 'orari-sportelli-cantonali', slugs: { it: 'orari-sportelli-cantonali', en: 'cantonal-office-hours', de: 'oeffnungszeiten-kantonale-schalter', fr: 'horaires-guichets-cantonaux' }, date: daysAgoIso(1) },
  { id: 'cantiere-strada-cantonale', slugs: { it: 'cantiere-strada-cantonale', en: 'cantonal-road-works', de: 'baustelle-kantonsstrasse', fr: 'chantier-route-cantonale' }, date: daysAgoIso(3) },
  { id: 'prezzi-benzina-settimana', slugs: { it: 'prezzi-benzina-settimana', en: 'weekly-petrol-prices', de: 'benzinpreise-woche', fr: 'prix-essence-semaine' }, date: daysAgoIso(5) },
];

const PARA = 'Il servizio cantonale pubblica orari, sedi e contatti aggiornati; la pagina riassume cosa cambia per residenti e lavoratori, con i riferimenti ufficiali da consultare prima di muoversi e le scadenze da tenere a mente.';

/** Corpus files of one canton section, at the paths its core entry and descriptors name (site layout). */
function writeCantonCorpus(root: string, section: string): void {
  const core = ARTICLE_SECTION_CORE_ALL[section];
  const itPrefix = `/${core.indexSlug.it}/`;
  const seo = ARTICLES.map((a) => `  'blog-${a.id}': {
    title: 'Titolo ${a.id}',
    description: 'Descrizione di ${a.id} per i lettori della sezione cantonale, con tutti i dettagli utili.',
    keywords: 'cantone, servizi',
    ogTitle: 'Titolo ${a.id}',
    ogDescription: 'Descrizione di ${a.id} per i lettori della sezione cantonale, con tutti i dettagli utili.',
    canonicalPath: '${itPrefix}${a.slugs.it}/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Titolo ${a.id}",
      "description": "Descrizione di ${a.id} per i lettori della sezione cantonale.",
      "image": { "@type": "ImageObject", "url": \`\${BASE_URL}/images/blog/${a.id}.webp\`, "width": 1200, "height": 675 },
      "datePublished": "${a.date}",
      "dateModified": "${a.date}",
      "inLanguage": "it",
      "author": { "@type": "Person", "@id": "https://frontaliereticino.ch/autori/redazione/#person", "name": "Redazione Frontaliere Ticino", "url": "https://frontaliereticino.ch/autori/redazione/" },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": \`\${BASE_URL}${itPrefix}${a.slugs.it}/\`
    }
  },
`).join('\n');
  const seoFile = path.join(root, 'services/seo', `seo-blog-${section}.ts`);
  fs.mkdirSync(path.dirname(seoFile), { recursive: true });
  fs.writeFileSync(seoFile, `const BASE_URL = 'https://frontaliereticino.ch';\nexport const CANTON_SEO = {\n${seo}\n};\n`);

  const registry = ARTICLES.map((a) => `  {
    id: '${a.id}',
    category: 'pratico',
    date: '${a.date}',
    image: '/images/blog/${a.id}.webp',
    canton: ['${core.canton}'],
    authorSlug: 'redazione',
    authorName: 'Redazione Frontaliere Ticino',
  },`).join('\n');
  fs.mkdirSync(path.dirname(path.join(root, core.registryFile)), { recursive: true });
  fs.writeFileSync(path.join(root, core.registryFile), `export const CANTON_ARTICLES = [\n${registry}\n];\n`);

  const slugs = ARTICLES.map((a) => `  '${a.id}': { it: '${a.slugs.it}', en: '${a.slugs.en}', de: '${a.slugs.de}', fr: '${a.slugs.fr}' },`).join('\n');
  fs.writeFileSync(path.join(root, core.slugDataFile), `export const CANTON_SLUGS = {\n${slugs}\n};\n`);

  for (const locale of LOCALES) {
    const meta = ARTICLES.map((a) => ` 'blog.article.${a.id}.title': 'Titolo ${a.id} ${locale}',\n 'blog.article.${a.id}.excerpt': 'Estratto ${a.id} ${locale}, abbastanza lungo da comparire nella scheda.',`).join('\n');
    const metaFile = path.join(root, 'services/locales', `${core.metaPrefix}-${locale}.ts`);
    fs.mkdirSync(path.dirname(metaFile), { recursive: true });
    fs.writeFileSync(metaFile, `const meta = {\n${meta}\n};\nexport default meta;\n`);
    const bodyDir = path.join(root, 'services/locales', core.bodyDir, locale);
    fs.mkdirSync(bodyDir, { recursive: true });
    for (const a of ARTICLES) {
      fs.writeFileSync(
        path.join(bodyDir, `${a.id}.ts`),
        `const body: Record<string, string> = {\n    'blog.article.${a.id}.body1': '${PARA} ${PARA}',\n    'blog.article.${a.id}.body2': '${PARA} ${PARA} ${PARA}',\n};\nexport default body;\n`,
      );
    }
  }
}

let root = '';
let dist = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'canton-section-'));
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'canton-section-dist-'));
  for (const section of SECTIONS) writeCantonCorpus(root, section);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

function hreflangs(html: string): Record<string, string> {
  return Object.fromEntries(
    [...html.matchAll(/<link rel="alternate" hreflang="([a-z-]+)" href="([^"]+)">/g)].map((m) => [m[1], m[2]]),
  );
}
function canonical(html: string): string | undefined {
  return html.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
}
function robots(html: string): string | undefined {
  return html.match(/<meta name="robots" content="([^"]+)">/)?.[1];
}
function jsonLd(html: string): Array<Record<string, any>> {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}
function h1(html: string): string | undefined {
  return html.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1];
}

function landingPath(section: string, locale: Loc): string {
  const slug = ARTICLE_SECTION_CORE_ALL[section].indexSlug[locale];
  return locale === 'it' ? `/${slug}/` : `/${locale}/${slug}/`;
}

/** A hub input that clears the content floor on intro + data alone (no news). */
function hubInput(canton: string, topic: string, locale: Loc, over: Partial<CantonTopicHubInput> = {}): CantonTopicHubInput {
  return {
    canton,
    topic,
    locale,
    intro: `${PARA}\n\nSeconda parte dell'introduzione evergreen con il contesto del tema.`,
    keyFacts: [{ label: 'Benzina 95', value: '1,79 CHF/l', note: 'media cantonale', sourceName: 'Fonte ufficiale', sourceUrl: 'https://www.example.ch/prezzi/' }],
    dataBlocks: [{
      id: 'prezzi',
      title: 'Prezzi alla pompa',
      description: 'Prezzi medi rilevati nelle stazioni del cantone.',
      items: [{ label: 'Benzina 95', value: '1,79 CHF/l', date: daysAgoIso(1) }, { label: 'Diesel', value: '1,85 CHF/l' }],
      sourceName: 'Rilevazione prezzi',
      sourceUrl: 'https://www.example.ch/dataset/',
      updatedAt: daysAgoIso(1),
    }],
    curatedArticles: [],
    links: [{ label: 'Calcolatore stipendio netto', url: '/calcola-stipendio/' }],
    updatedAt: daysAgoIso(1),
    ...over,
  };
}

describe('canton section core data', () => {
  it('the canton display names are ONE table shared by the site and the engine', () => {
    expect(CANTON_DISPLAY).toBe(CANTON_DISPLAY_NAMES);
    for (const entry of Object.values(ARTICLE_SECTION_CORE_ALL)) {
      if (entry.kind !== 'canton') continue;
      for (const locale of LOCALES) expect(CANTON_DISPLAY_NAMES[entry.canton!]?.[locale], `${entry.section} ${locale}`).toBeTruthy();
    }
  });

  it('the archive slug and hub-topic clusters agree with the engine tables they mirror', () => {
    expect(CANTON_ARCHIVE_ALL_SLUG).toEqual({ it: 'tutti', en: 'all', de: 'alle', fr: 'tous' });
    const known = new Set(TOPIC_CLUSTERS.map((t) => t.key));
    expect(Object.keys(CANTON_HUB_TOPIC_CLUSTERS)).toEqual([...CANTON_HUB_TOPIC_KEYS]);
    for (const keys of Object.values(CANTON_HUB_TOPIC_CLUSTERS)) for (const k of keys) expect(known.has(k), k).toBe(true);
  });

  it('the edge key is exactly the Worker key, minus its leading slash', () => {
    for (const p of ['/articoli-ticino/', '/en/basel-articles/fuel/', '/fr/articles-bale/tous/page-2/']) {
      expect(`/${corpusSectionEdgeKey(p)}`).toBe(corpusSectionCdnKey(p));
    }
    expect(() => corpusSectionEdgeKey('/articoli-ticino')).toThrow();
  });

  it('the mock activates the two sections for this file only (production list stays empty)', () => {
    expect(Object.keys(ARTICLE_SECTION_CORE)).toEqual(['frontaliere', 'svizzera', 'canton-basilea', 'canton-ti']);
  });
});

describe('every canton section (all 24 URL groups, 4 locales)', () => {
  it('renders a landing and a hub whose title, H1 and description carry the canton, unclamped', () => {
    const cantonSections = Object.values(ARTICLE_SECTION_CORE_ALL).filter((e) => e.kind === 'canton');
    expect(cantonSections).toHaveLength(24);
    for (const entry of cantonSections) {
      for (const locale of LOCALES) {
        const name = CANTON_DISPLAY_NAMES[entry.canton!][locale];
        const landing = renderCantonSectionLanding({ section: entry.section, locale, articles: [] }).html;
        expect(h1(landing)).toBe(cantonSectionLabel(entry.section, locale));
        expect(h1(landing)).toContain(name);
        const desc = landing.match(/<meta name="description" content="([^"]+)">/)![1];
        expect(desc.endsWith('…'), `${entry.section} ${locale}: ${desc}`).toBe(false);
        expect(desc).toContain(name);
        expect(landing.match(SVIZZERA_URL_RX)).toBeNull();
        const hub = renderCantonTopicHub(hubInput(entry.canton!, 'pensioni', locale)).html;
        expect(h1(hub)).toContain(name);
        expect(hub).not.toMatch(/noindex/i);
      }
    }
  });
});

describe.each(SECTIONS)('%s landing', (section) => {
  it('renders 4 reciprocal, self-canonical, indexable landings owned by the corpus', async () => {
    const pages = await renderCantonSectionLandingPages({ rootDir: root, section });
    expect(pages.map((p) => p.locale)).toEqual([...LOCALES]);
    const expectedAlternates = {
      ...Object.fromEntries(LOCALES.map((l) => [l, `${BASE}${landingPath(section, l)}`])),
      'x-default': `${BASE}${landingPath(section, 'it')}`,
    };
    for (const page of pages) {
      const { html, locale } = page;
      expect(page.canonicalPath).toBe(landingPath(section, locale));
      expect(page.edgeKey).toBe(`edge/sections${landingPath(section, locale)}index.html`);
      expect(canonical(html)).toBe(`${BASE}${landingPath(section, locale)}`);
      expect(hreflangs(html)).toEqual(expectedAlternates);
      expect(robots(html)).toMatch(/^index, follow/);
      expect(html).not.toMatch(/noindex/i);
      expect(html).toContain('<meta name="ft-route-owner" content="corpus">');
      expect(html).toContain(`<html lang="${locale}">`);
      expect(h1(html)).toBe(cantonSectionLabel(section, locale));
      expect(html).toContain('src="https://cdn.frontaliereticino.ch/assets/index-entry.js"');
      expect(html).not.toMatch(/(?:src|href)="\/assets\//);
      expect(html.match(SVIZZERA_URL_RX)).toBeNull();
      // 3 articles, newest first, at this section's own URLs.
      const cards = [...html.matchAll(/<a href="([^"]+)" class="ssg-art-card">/g)].map((m) => m[1]);
      expect(cards).toEqual(ARTICLES.map((a) => `${landingPath(section, locale)}${a.slugs[locale]}/`));
      // The 6 hubs + the archive.
      for (const topic of CANTON_HUB_TOPIC_KEYS) {
        const slug = ARTICLE_SECTION_CORE_ALL[section].topicHubs![topic][locale];
        expect(html).toContain(`href="${landingPath(section, locale)}${slug}/"`);
      }
      expect(html).toContain(`href="${landingPath(section, locale)}${CANTON_ARCHIVE_ALL_SLUG[locale]}/"`);
      const ld = jsonLd(html);
      expect(ld.map((x) => x['@type'])).toEqual(['BreadcrumbList', 'CollectionPage']);
      expect(ld[0].itemListElement.map((i: any) => i.name)).toEqual(['Home', cantonSectionLabel(section, locale)]);
      expect(ld[1].mainEntity.itemListElement).toHaveLength(3);
    }
  });

  it('localizes the H1 with the canton name from the core', () => {
    const expected: Record<string, Record<Loc, string>> = {
      'canton-ti': { it: 'Articoli Ticino', en: 'Ticino articles', de: 'Tessin-Artikel', fr: 'Articles Tessin' },
      'canton-basilea': { it: 'Articoli Basilea', en: 'Basel articles', de: 'Basel-Artikel', fr: 'Articles Bâle' },
    };
    for (const locale of LOCALES) {
      const page = renderCantonSectionLanding({ section, locale, articles: [] });
      expect(h1(page.html)).toBe(expected[section][locale]);
      // An empty section still renders a full, indexable landing.
      expect(robots(page.html)).toMatch(/^index, follow/);
    }
  });
});

describe.each(SECTIONS)('%s archive', (section) => {
  it('renders /tutti/ in 4 locales with the canton copy and the 6 canton hubs, not svizzera\'s', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'canton-archive-'));
    try {
      const res = await renderArticleHubPages({ rootDir: root, distDir: out, section: section as never });
      for (const locale of LOCALES) {
        const archive = `${landingPath(section, locale)}${CANTON_ARCHIVE_ALL_SLUG[locale]}/`;
        expect(res.pathsByLocale[locale]).toEqual([`${archive.slice(1)}index.html`]);
        const html = fs.readFileSync(path.join(out, archive, 'index.html'), 'utf-8');
        expect(canonical(html)).toBe(`${BASE}${archive}`);
        const alt = hreflangs(html);
        for (const l of LOCALES) expect(alt[l]).toBe(`${BASE}${landingPath(section, l)}${CANTON_ARCHIVE_ALL_SLUG[l]}/`);
        expect(alt['x-default']).toBe(alt.it);
        expect(html).not.toMatch(/noindex/i);
        const label = cantonSectionLabel(section, locale);
        expect(jsonLd(html)[0].itemListElement[1].name).toBe(label);
        // The only national-section URL is the declared twin cross-link.
        expect(html.match(SVIZZERA_URL_RX)).toHaveLength(1);
        expect(html).not.toContain('/argomenti/');
        for (const topic of CANTON_HUB_TOPIC_KEYS) {
          const slug = ARTICLE_SECTION_CORE_ALL[section].topicHubs![topic][locale];
          expect(html).toContain(`href="${landingPath(section, locale)}${slug}/" class="hp"`);
        }
        // Canton methodology, not the frontaliere-in-Ticino accordion.
        expect(html).not.toContain('Accordo fiscale');
        for (const a of ARTICLES) expect(html).toContain(`href="${landingPath(section, locale)}${a.slugs[locale]}/"`);
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

describe.each(SECTIONS)('%s article pages', (section) => {
  it('canonical, hreflang and breadcrumb name the canton section, never svizzera', async () => {
    const res = await renderArticlePages({ rootDir: root, distDir: dist, section: section as never });
    expect(res.entries.map((e) => e.articleId).sort()).toEqual(ARTICLES.map((a) => a.id).sort());
    for (const entry of res.entries) {
      const a = ARTICLES.find((x) => x.id === entry.articleId)!;
      for (const locale of LOCALES) {
        const url = `${BASE}${landingPath(section, locale)}${a.slugs[locale]}/`;
        expect(entry.urls[locale]).toBe(url);
        const html = fs.readFileSync(path.join(dist, entry.paths[locale]), 'utf-8');
        expect(canonical(html)).toBe(url);
        const alt = hreflangs(html);
        for (const l of LOCALES) expect(alt[l]).toBe(`${BASE}${landingPath(section, l)}${a.slugs[l]}/`);
        expect(alt['x-default']).toBe(alt.it);
        expect(html).toContain('<meta name="ft-route-owner" content="corpus">');
        expect(html).not.toMatch(/noindex/i);
        const crumbs = jsonLd(html).find((x) => x['@type'] === 'BreadcrumbList')!.itemListElement;
        expect(crumbs[1]).toMatchObject({ name: cantonSectionLabel(section, locale), item: `${BASE}${landingPath(section, locale)}` });
        expect(html.match(SVIZZERA_URL_RX)).toBeNull();
        expect(html).not.toContain('/argomenti/');
      }
    }
  });
});

describe.each(SECTIONS)('%s RSS', (section) => {
  it('builds the section\'s own 4 locale feeds + main feed at canton URLs', () => {
    const row = rssSectionForId(section);
    const core = ARTICLE_SECTION_CORE_ALL[section];
    const res = buildSectionFeeds({
      fs,
      path,
      rootDir: root,
      section: row,
      registry: ARTICLES.map((a) => ({ id: a.id, image: `/images/blog/${a.id}.webp`, date: a.date })),
      repairSerpSnippet,
    });
    expect(res.feeds.map(([name]) => name)).toEqual([
      `rss-${section}-it.xml`, `rss-${section}.xml`, `rss-${section}-en.xml`, `rss-${section}-de.xml`, `rss-${section}-fr.xml`,
    ]);
    for (const [name, xml] of res.feeds) {
      const locale = (name.match(/-(it|en|de|fr)\.xml$/)?.[1] ?? 'it') as Loc;
      expect(xml).toContain(`<title>Frontaliere Ticino — ${cantonSectionLabel(section, locale).replace(/&/g, '&amp;')}</title>`);
      expect(xml).toContain(`<language>${locale}</language>`);
      const links = [...xml.matchAll(/<link>([^<]+)<\/link>/g)].map((m) => m[1]).filter((l) => l !== BASE);
      expect(links).toEqual(ARTICLES.map((a) => `${BASE}${landingPath(section, locale)}${a.slugs[locale]}/`));
      expect(xml.match(SVIZZERA_URL_RX)).toBeNull();
    }
    expect(core.kind).toBe('canton');
  });

  it('the active RSS table lists the activated cantons after the two historical sections', () => {
    expect(RSS_SECTIONS.map((s: { id: string }) => s.id)).toEqual(['frontaliere', 'svizzera', 'canton-basilea', 'canton-ti']);
  });
});

describe.each(SECTIONS)('%s thematic hubs', (section) => {
  const canton = ARTICLE_SECTION_CORE_ALL[section].canton!;

  it('renders every (topic, locale) with reciprocal hreflang, breadcrumb section -> topic, and NO noindex', () => {
    for (const topic of CANTON_HUB_TOPIC_KEYS) {
      const paths = Object.fromEntries(LOCALES.map((l) => [l, `${landingPath(section, l)}${ARTICLE_SECTION_CORE_ALL[section].topicHubs![topic][l]}/`]));
      for (const locale of LOCALES) {
        // No curated news at all: still indexable (owner decision 2026-10-05).
        const page = renderCantonTopicHub(hubInput(canton, topic, locale));
        const { html } = page;
        expect(page.canonicalPath).toBe(paths[locale]);
        expect(page.edgeKey).toBe(`edge/sections${paths[locale]}index.html`);
        expect(canonical(html)).toBe(`${BASE}${paths[locale]}`);
        expect(hreflangs(html)).toEqual({
          ...Object.fromEntries(LOCALES.map((l) => [l, `${BASE}${paths[l]}`])),
          'x-default': `${BASE}${paths.it}`,
        });
        expect(robots(html)).toMatch(/^index, follow/);
        expect(html).not.toMatch(/noindex/i);
        expect(html).toContain('<meta name="ft-route-owner" content="corpus">');
        expect(html.match(SVIZZERA_URL_RX)).toBeNull();
        const ld = jsonLd(html);
        expect(ld.map((x) => x['@type'])).toEqual(['BreadcrumbList', 'CollectionPage', 'Dataset']);
        expect(ld[0].itemListElement.map((i: any) => i.item)).toEqual([
          `${BASE}/`, `${BASE}${landingPath(section, locale)}`, `${BASE}${paths[locale]}`,
        ]);
        expect(ld[0].itemListElement[1].name).toBe(cantonSectionLabel(section, locale));
        // The other 5 hubs are linked, the current one is not linked from its own nav.
        for (const other of CANTON_HUB_TOPIC_KEYS) {
          const href = `${landingPath(section, locale)}${ARTICLE_SECTION_CORE_ALL[section].topicHubs![other][locale]}/`;
          expect(html.includes(`href="${href}"`), `${topic} -> ${other}`).toBe(other !== topic);
        }
      }
    }
  });

  it('lists the curated news (also from other sections) as an ItemList and skips Dataset without data rows', () => {
    const page = renderCantonTopicHub(hubInput(canton, 'fisco', 'it', {
      dataBlocks: [],
      curatedArticles: [
        { title: 'Notizia della sezione', url: `${landingPath(section, 'it')}orari-sportelli-cantonali/`, excerpt: 'Estratto.', date: daysAgoIso(2) },
        { title: 'Notizia nazionale sul cantone', url: '/articoli-svizzera/una-notizia/' },
      ],
    }));
    const ld = jsonLd(page.html);
    expect(ld.map((x) => x['@type'])).toEqual(['BreadcrumbList', 'CollectionPage']);
    expect(ld[1].mainEntity.itemListElement.map((i: any) => i.url)).toEqual([
      `${BASE}${landingPath(section, 'it')}orari-sportelli-cantonali/`,
      `${BASE}/articoli-svizzera/una-notizia/`,
    ]);
  });

  it('refuses unsafe links, unknown topics and content too thin to stand on its own', () => {
    expect(() => renderCantonTopicHub(hubInput(canton, 'meteo', 'it'))).toThrow(/tema/);
    expect(() => renderCantonTopicHub(hubInput(canton, 'fisco', 'it', { links: [{ label: 'x', url: 'javascript:alert(1)' }] }))).toThrow(/URL/);
    expect(() => renderCantonTopicHub(hubInput(canton, 'fisco', 'it', { links: [{ label: 'x', url: '/calcola-stipendio' }] }))).toThrow(/slash/);
    expect(() => renderCantonTopicHub(hubInput(canton, 'fisco', 'it', { intro: 'Breve.', keyFacts: [], dataBlocks: [] }))).toThrow(
      new RegExp(`< ${CANTON_HUB_MIN_CONTENT_WORDS}`),
    );
    expect(() => renderCantonTopicHub(hubInput(canton, 'fisco', 'it', { updatedAt: 'ieri' }))).toThrow(/data/);
    expect(() => renderCantonTopicHub(hubInput('XX', 'fisco', 'it'))).toThrow();
  });

  it('escapes every input string', () => {
    const page = renderCantonTopicHub(hubInput(canton, 'eventi', 'de', {
      keyFacts: [{ label: '<script>x</script>', value: '"1"' }],
    }));
    expect(page.html).not.toContain('<script>x</script>');
    expect(page.html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});

describe('offloadCorpusPageAssets', () => {
  it('rewrites asset references but not the print-swap selector', () => {
    const html = '<link href="/assets/a.css"><script src="/assets/b.js"></script><script>q(\'link[media="print"][href*="/assets/"]\')</script>';
    expect(offloadCorpusPageAssets(html)).toBe(
      '<link href="https://cdn.frontaliereticino.ch/assets/a.css"><script src="https://cdn.frontaliereticino.ch/assets/b.js"></script><script>q(\'link[media="print"][href*="/assets/"]\')</script>',
    );
  });
});
