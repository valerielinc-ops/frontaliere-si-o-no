import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { renderArticlePages } from '../build-plugins/ogPagesPlugin';
import seoBlog from '../services/seo/seo-blog';
import seoBlog2 from '../services/seo/seo-blog-2';
import seoBlogCh from '../services/seo/seo-blog-ch';
import blogMetaIt from '../services/locales/blog-meta-it';
import blogMetaChDe from '../services/locales/blog-meta-ch-de';
import blogMetaChEn from '../services/locales/blog-meta-ch-en';
import blogMetaChFr from '../services/locales/blog-meta-ch-fr';
import blogMetaChIt from '../services/locales/blog-meta-ch-it';

type SeoEntry = {
  title: string;
};

type Meta = Record<string, string>;
type ArticleSection = 'frontaliere' | 'svizzera';

type ParityCase = {
  name: string;
  seo: Record<string, SeoEntry>;
  meta: Meta;
  seoKey: string;
  articleId: string;
  section: ArticleSection;
};

const frontaliereCases: ParityCase[] = [
  ['sostituzione-caldaia-ticino-2026', seoBlog],
  ['rsi-mostra-storia-ticino', seoBlog],
  ['tredicesima-avs-stipendio-iva', seoBlog],
  ['tredicesima-avs-stipendi-iva', seoBlog],
  ['frontalieri-ticino-dati-ingannevoli', seoBlog],
  ['lugano-manifestazioni-regole-polemica', seoBlog],
  ['sicurezza-lavoro-controlli-svizzera', seoBlog],
  ['startup-investimenti-boom-ticino', seoBlog],
  ['fonderie-svizzere-crisi-2025', seoBlog],
  ['salario-minimo-ticino-accordo', seoBlog],
  ['trasporti-pubblici-crescita-svizzera', seoBlog],
  ['iniziativa-salari-ticino', seoBlog2],
  ['iniziativa-anti-dumping-voto', seoBlog2],
  ['mercato-auto-febbraio-2026', seoBlog2],
].map(([articleId, seo]) => ({
  name: `frontaliere/${articleId}`,
  seo: seo as Record<string, SeoEntry>,
  meta: blogMetaIt,
  seoKey: `blog-${articleId}`,
  articleId,
  section: 'frontaliere',
}));

const swissCases: ParityCase[] = [
  'iniziative-casse-malati-2026',
  'cern-future-collider-ticino',
  'festivita-ticino-2026',
  'frontalieri-svizzera',
  'premi-di-cassa-malati-ticino',
  'givaudan-licenziamenti',
  'banca-svizzera-segreto',
  'frontaliere-scelta-svizzera-lavoro-stipendio-tasse-traffico-confronto-italia',
  'voto-elettronico-svizzeri-estero-nicolas-kolly',
  'mc-27-mostra-lugano-2026',
  'diritti-frontaliere-genitorialit',
  'congedo-parentale-frontalieri',
  'guess-stabio-lavoro-merchandiser',
].map((articleId) => ({
  name: `svizzera/${articleId}`,
  seo: seoBlogCh as Record<string, SeoEntry>,
  meta: blogMetaChIt,
  seoKey: `blog-${articleId}`,
  articleId,
  section: 'svizzera',
}));

type RenderedTitles = {
  title: string;
  schemaType?: string;
  headline?: string;
};

const decodeHtml = (value: string): string => value
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>');

function readRenderedTitles(html: string): RenderedTitles {
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  const articleSchema = scripts
    .map(([, json]) => JSON.parse(json) as Record<string, unknown>)
    .find((json) => ['Article', 'BlogPosting', 'Event', 'NewsArticle'].includes(String(json['@type'])));
  return {
    title: decodeHtml(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''),
    schemaType: typeof articleSchema?.['@type'] === 'string' ? articleSchema['@type'] : undefined,
    headline: typeof articleSchema?.headline === 'string' ? articleSchema.headline : undefined,
  };
}

async function renderStaticTitles(cases: ParityCase[]): Promise<Map<string, RenderedTitles>> {
  const bySection = new Map<ArticleSection, string[]>();
  for (const testCase of cases) {
    const ids = bySection.get(testCase.section) ?? [];
    ids.push(testCase.articleId);
    bySection.set(testCase.section, ids);
  }

  const rendered = new Map<string, RenderedTitles>();
  await Promise.all([...bySection].map(async ([section, articleIds]) => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-title-parity-'));
    try {
      const result = await renderArticlePages({
        rootDir: process.cwd(),
        distDir,
        section,
        onlyArticleIds: articleIds,
      });
      for (const entry of result.entries) {
        const htmlPath = path.join(distDir, entry.paths.it);
        rendered.set(`${section}/${entry.articleId}`, readRenderedTitles(fs.readFileSync(htmlPath, 'utf8')));
      }
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }));
  return rendered;
}

describe('article SEO title parity', () => {
  const cases = [...frontaliereCases, ...swissCases];
  let staticTitles: Map<string, RenderedTitles>;

  beforeAll(async () => {
    staticTitles = await renderStaticTitles(cases);
  }, 120_000);

  it.each(cases)('$name keeps static and hydrated titles identical', ({ seo, meta, seoKey, articleId, section }) => {
    const entry = seo[seoKey];
    expect(entry, `missing static SEO entry ${seoKey}`).toBeDefined();
    const localizedTitle = meta[`blog.article.${articleId}.title`];
    expect(localizedTitle, `missing localized title for ${articleId}`).toBeTruthy();
    const rendered = staticTitles.get(`${section}/${articleId}`);
    expect(rendered, `missing rendered static page for ${section}/${articleId}`).toBeDefined();
    expect(rendered?.title).toBe(localizedTitle);
    if (['Article', 'BlogPosting', 'NewsArticle'].includes(rendered?.schemaType ?? '')) {
      expect(rendered.headline).toBe(localizedTitle);
    }
  });

  it('keeps the Givaudan location in Vernier, Geneva', () => {
    const title = seoBlogCh['blog-givaudan-licenziamenti'].title;
    expect(title).toMatch(/Vernier/);
    expect(title).toMatch(/Ginevra/);
    expect(title).not.toMatch(/Ticino/);
  });

  it.each([
    ['it', blogMetaChIt['blog.article.givaudan-licenziamenti.title']],
    ['en', blogMetaChEn['blog.article.givaudan-licenziamenti.title']],
    ['fr', blogMetaChFr['blog.article.givaudan-licenziamenti.title']],
    ['de', blogMetaChDe['blog.article.givaudan-licenziamenti.title']],
  ])('keeps Givaudan location in Vernier across %s metadata', (_locale, title) => {
    expect(title).toMatch(/Vernier/);
    expect(title).not.toMatch(/Ticino/);
  });

  it('labels the Ticino minimum wage as a proposal', () => {
    expect(seoBlog['blog-salario-minimo-ticino-accordo'].title).toMatch(/proposta/i);
  });

  it('keeps the AVS salary impact as an open question', () => {
    expect(seoBlog['blog-tredicesima-avs-stipendi-iva'].title).toMatch(/\?$/);
  });
});
