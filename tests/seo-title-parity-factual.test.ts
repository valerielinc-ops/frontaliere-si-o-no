import { describe, expect, it } from 'vitest';

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
  ogTitle?: string;
  structuredData?: { headline?: string };
};

type Meta = Record<string, string>;

type ParityCase = {
  name: string;
  seo: Record<string, SeoEntry>;
  meta: Meta;
  seoKey: string;
  articleId: string;
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
}));

describe('article SEO title parity', () => {
  it.each([...frontaliereCases, ...swissCases])('$name keeps static and hydrated titles identical', ({ seo, meta, seoKey, articleId }) => {
    const entry = seo[seoKey];
    expect(entry, `missing static SEO entry ${seoKey}`).toBeDefined();
    const localizedTitle = meta[`blog.article.${articleId}.title`];
    expect(localizedTitle, `missing localized title for ${articleId}`).toBeTruthy();
    expect(entry.title).toBe(localizedTitle);
    expect(entry.ogTitle).toBe(localizedTitle);
    expect(entry.structuredData?.headline).toBe(localizedTitle);
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
