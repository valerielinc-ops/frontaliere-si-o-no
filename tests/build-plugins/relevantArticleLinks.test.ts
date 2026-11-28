import { describe, expect, it } from 'vitest';
import {
  CAREER_LANDING_TOPICS,
  MAX_RELEVANT_ARTICLE_LINKS,
  PROFESSION_LANDING_TOPICS,
  renderRelevantArticlesBlock,
  selectRelevantArticles,
  type ArticleLinkIndex,
  type LinkArticle,
} from '../../build-plugins/shared/relevantArticleLinks';
import { assembleArticleLinkIndex, sitemapPaths } from '../../build-plugins/shared/publishedArticleLinkIndex';

const art = (id: string, section: string, title: string, date: string, canton: string | null = null): LinkArticle => ({
  id, section, canton, title, date, href: `/articoli/${id}/`,
});

const itPool: LinkArticle[] = [
  art('inf1', 'frontaliere', 'Infermieri frontalieri in Ticino: stipendio e requisiti', '2026-11-20'),
  art('inf2', 'canton-ti', 'Ospedale Civico di Lugano cerca personale', '2026-11-25', 'TI'),
  art('inf3', 'canton-zh', 'Spital Zurigo assume infermieri', '2026-11-26', 'ZH'),
  art('cantiere', 'frontaliere', 'Edilizia: nuovi cantieri a Mendrisio', '2026-11-27'),
  art('ristorni', 'frontaliere', 'Ristorni frontalieri in calo', '2026-11-28'),
  art('ti-a', 'canton-ti', 'Guasto sulla linea Como-Chiasso', '2026-11-24', 'TI'),
  art('ti-b', 'canton-ti', 'Nuova strada a Bellinzona', '2026-11-23', 'TI'),
  art('f-a', 'frontaliere', 'Cambio franco euro oggi', '2026-11-22'),
  art('f-b', 'frontaliere', 'Tredicesima frontalieri 2026', '2026-11-21'),
  art('s-a', 'svizzera', 'Voto federale di novembre', '2026-11-19'),
];
const index: ArticleLinkIndex = { commit: 'x', byLocale: { it: itPool, en: [], de: [], fr: [] } };

describe('selectRelevantArticles', () => {
  it('nurse offer in Lugano gets canton + health articles first, never another canton', () => {
    const sel = selectRelevantArticles(index, { locale: 'it', canton: 'TI', title: 'Infermiere/a 80-100%' });
    expect(sel.map((s) => s.article.id).slice(0, 2)).toEqual(['inf2', 'inf1']);
    expect(sel.filter((s) => s.relevant)).toHaveLength(2);
    expect(sel.some((s) => s.article.id === 'inf3')).toBe(false);
    expect(sel.length).toBeLessThanOrEqual(MAX_RELEVANT_ARTICLE_LINKS);
  });

  it('does not treat "ristorni" as hospitality', () => {
    const sel = selectRelevantArticles(index, { locale: 'it', canton: 'TI', title: 'Cuoco di ristorante' });
    expect(sel.filter((s) => s.relevant)).toHaveLength(0);
  });

  it('offer without relevant articles falls back to canton latest, then frontaliere', () => {
    const sel = selectRelevantArticles(index, { locale: 'it', canton: 'TI', title: 'Business Analyst' });
    expect(sel.every((s) => !s.relevant)).toBe(true);
    expect(sel.map((s) => s.article.id)).toEqual(['inf2', 'ti-a', 'ti-b', 'ristorni', 'cantiere']);
  });

  it('a single shared generic word is not enough', () => {
    const idx: ArticleLinkIndex = {
      commit: 'x',
      byLocale: { it: [art('t', 'frontaliere', 'Tassa sulla salute per frontalieri', '2026-11-01')], en: [], de: [], fr: [] },
    };
    const sel = selectRelevantArticles(idx, { locale: 'it', canton: 'TI', title: 'Specialista Salute Ambulatori' });
    expect(sel.filter((s) => s.relevant)).toHaveLength(0);
  });

  it('is deterministic and category is not evidence', () => {
    const a = selectRelevantArticles(index, { locale: 'it', canton: 'TI', title: 'Muratore', category: 'health' });
    const b = selectRelevantArticles(index, { locale: 'it', canton: 'TI', title: 'Muratore', category: 'finance' });
    expect(a).toEqual(b);
    expect(a[0].article.id).toBe('cantiere');
  });

  it('returns [] for a locale without index so callers keep the old block', () => {
    expect(selectRelevantArticles(index, { locale: 'en', canton: 'TI', title: 'Nurse' })).toEqual([]);
    expect(selectRelevantArticles(null, { locale: 'it' })).toEqual([]);
  });

  it('landings declare their own topic', () => {
    const sel = selectRelevantArticles(index, {
      locale: 'it', canton: 'TI',
      groups: PROFESSION_LANDING_TOPICS.muratore.groups,
    });
    expect(sel[0].article.id).toBe('cantiere');
    expect(Object.keys(CAREER_LANDING_TOPICS)).toHaveLength(4);
  });
});

describe('renderRelevantArticlesBlock', () => {
  it('uses the article title as anchor text and the host classes', () => {
    const sel = selectRelevantArticles(index, { locale: 'it', canton: 'TI', title: 'Infermiere' });
    const html = renderRelevantArticlesBlock(sel, 'Articoli correlati', {
      sectionClass: 'sec', listClass: 'ul', itemClass: 'li', linkClass: 'a',
    }, (s) => String(s).replace(/&/g, '&amp;'));
    expect(html).toContain('<a class="a" href="/articoli/inf2/">Ospedale Civico di Lugano cerca personale</a>');
    expect((html.match(/<li /g) ?? []).length).toBe(sel.length);
    expect(renderRelevantArticlesBlock([], 'x', { sectionClass: 's', listClass: 'u', itemClass: 'l' }, String)).toBe('');
  });
});

describe('assembleArticleLinkIndex', () => {
  it('keeps only indexable urls, in the page language', () => {
    const idx = assembleArticleLinkIndex({
      commit: 'abc',
      slugs: {
        blog: { a: { it: 'uno', en: 'one', de: 'eins', fr: 'un' }, b: { it: 'due', en: 'two', de: 'zwei', fr: 'deux' } },
        cantons: { 'canton-ti': { c: { it: 'tre', en: 'three', de: 'drei', fr: 'trois' } } },
      },
      entries: {
        frontaliere: {
          it: [{ id: 'a', title: 'Uno', date: '2026-11-01' }, { id: 'b', title: 'Due', date: '2026-11-02' }],
          en: [{ id: 'a', title: 'One', date: '2026-11-01' }],
        },
        'canton-ti': { it: [{ id: 'c', title: 'Tre', date: '2026-11-03' }] },
      },
      indexable: new Set(['/articoli-frontaliere/uno/', '/en/cross-border-articles/one/', '/articoli-ticino/tre/']),
    });
    expect(idx.byLocale.it.map((x) => x.href)).toEqual(['/articoli-ticino/tre/', '/articoli-frontaliere/uno/']);
    expect(idx.byLocale.it[0].canton).toBe('TI');
    expect(idx.byLocale.en[0]).toMatchObject({ title: 'One', href: '/en/cross-border-articles/one/' });
  });

  it('reads loc and hreflang paths from a sitemap', () => {
    const xml = '<loc>https://x.ch/a/</loc><xhtml:link rel="alternate" hreflang="en" href="https://x.ch/en/a/" />';
    expect([...sitemapPaths(xml)]).toEqual(['/a/', '/en/a/']);
  });
});
