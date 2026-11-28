import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CROSS_SECTION_MAX_LINKS,
  CROSS_SECTION_MIN_SCORE,
  RELATED_TOTAL_MAX,
  pickCrossSectionRelated,
  tokenize,
  type CrossSectionCandidate,
  type CrossSectionSource,
} from '../packages/articles/engine/relatedArticlesIndex';
import {
  buildKeywordProfile,
  createContentKeywordMatcher,
  scoreSharedKeywords,
} from '../packages/articles/engine/shared/contentKeywordMatcher.mjs';

const cantonSource: CrossSectionSource = {
  articleId: 'ti-1',
  section: 'canton-ti',
  locale: 'it',
  title: 'Cassa malati in Ticino: come scegliere la franchigia',
  excerpt: 'Premi e franchigia della cassa malati per chi lavora in Ticino.',
};

const national = (over: Partial<CrossSectionCandidate> & { title?: string; href?: string } = {}): CrossSectionCandidate => ({
  articleId: over.articleId ?? 'fr-1',
  section: over.section ?? 'frontaliere',
  datePub: over.datePub ?? '2026-11-20',
  indexable: over.indexable,
  locales: over.locales ?? {
    it: { title: over.title ?? 'Cassa malati frontalieri: la scelta del 2027', href: over.href ?? '/blog/cassa-malati-2027/' },
    en: { title: 'Health insurance for cross-border workers: the 2027 choice', href: '/en/blog/health-insurance-2027/' },
  },
});

describe('pickCrossSectionRelated', () => {
  it('links a canton article to a pertinent national article by shared keyword', () => {
    const links = pickCrossSectionRelated(cantonSource, [national()]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ articleId: 'fr-1', section: 'frontaliere', href: '/blog/cassa-malati-2027/' });
    expect(links[0].shared).toContain('e:health');
    expect(links[0].score).toBeGreaterThanOrEqual(CROSS_SECTION_MIN_SCORE);
  });

  it('emits nothing when no candidate clears the relevance floor (never a filler)', () => {
    const offTopic = national({ title: 'Traffico ai valichi: code di sabato', href: '/blog/code/' });
    const siteWords = national({ articleId: 'fr-2', title: 'Frontalieri in Ticino: novita della settimana', href: '/blog/novita/' });
    expect(pickCrossSectionRelated(cantonSource, [offTopic, siteWords])).toEqual([]);
    expect(pickCrossSectionRelated(cantonSource, [])).toEqual([]);
  });

  it('does not count words that name the whole site as shared keywords', () => {
    const source = { ...cantonSource, title: 'Frontalieri Ticino Svizzera lavoro novita' };
    const cand = national({ title: 'Frontalieri Ticino Svizzera lavoro novita', href: '/blog/x/' });
    expect(pickCrossSectionRelated(source, [cand])).toEqual([]);
  });

  it('excludes noindex, non-canonical, same-section and external destinations', () => {
    expect(pickCrossSectionRelated(cantonSource, [national({ indexable: false })])).toEqual([]);
    const nonCanonical = national();
    nonCanonical.locales.it = { ...nonCanonical.locales.it!, canonical: '/blog/altra-pagina/' };
    expect(pickCrossSectionRelated(cantonSource, [nonCanonical])).toEqual([]);
    expect(pickCrossSectionRelated(cantonSource, [national({ section: 'canton-ti' })])).toEqual([]);
    expect(pickCrossSectionRelated(cantonSource, [national({ href: 'https://example.com/x/' })])).toEqual([]);
  });

  it('keeps the four languages coherent: same-locale version only', () => {
    const en = pickCrossSectionRelated(
      { ...cantonSource, locale: 'en', title: 'Health insurance in Ticino: choosing the deductible', excerpt: 'Premiums and deductible.' },
      [national()],
    );
    expect(en).toHaveLength(1);
    expect(en[0].href).toBe('/en/blog/health-insurance-2027/');
    expect(en[0].title).toMatch(/Health insurance/);
    expect(pickCrossSectionRelated({ ...cantonSource, locale: 'de', title: 'Krankenversicherung im Tessin: die Franchise' }, [national()])).toEqual([]);
  });

  it('caps links per article and takes at most one per target section', () => {
    const cands = [
      national({ articleId: 'a', href: '/blog/a/' }),
      national({ articleId: 'b', href: '/blog/b/', datePub: '2026-11-25' }),
      national({ articleId: 'c', section: 'svizzera', href: '/svizzera/c/' }),
      national({ articleId: 'd', section: 'canton-gr', href: '/gr/d/' }),
    ];
    const links = pickCrossSectionRelated(cantonSource, cands);
    expect(links.length).toBeLessThanOrEqual(CROSS_SECTION_MAX_LINKS);
    expect(new Set(links.map((l) => l.section)).size).toBe(links.length);
    expect(links.find((l) => l.section === 'frontaliere')?.articleId).toBe('b');
  });

  it('is deterministic whatever the input order', () => {
    const cands = [
      national({ articleId: 'a', href: '/blog/a/' }),
      national({ articleId: 'c', section: 'svizzera', href: '/svizzera/c/' }),
    ];
    expect(pickCrossSectionRelated(cantonSource, cands)).toEqual(pickCrossSectionRelated(cantonSource, [...cands].reverse()));
  });

  it('keeps total related items within the ceiling', () => {
    expect(RELATED_TOTAL_MAX).toBe(7);
    expect(CROSS_SECTION_MAX_LINKS).toBeLessThanOrEqual(2);
  });
});

describe('keyword profile and score', () => {
  it('requires an anchor: a shared keyword visible in the target title', () => {
    const match = createContentKeywordMatcher([{ id: 'pension', aliases: { it: ['pensione'] } }]);
    const source = buildKeywordProfile({ title: 'La pensione in Svizzera' }, { match, locale: 'it', tokenize });
    const hidden = buildKeywordProfile({ title: 'Guida completa', excerpt: 'Tutto sulla pensione' }, { match, locale: 'it', tokenize });
    const result = scoreSharedKeywords(source, hidden);
    expect(result.shared).toContain('e:pension');
    expect(result.anchored).toBe(false);
  });

  it('caps loose token overlap so a long title cannot pass on words alone', () => {
    const t = 'ristrutturazione appartamento vecchio quartiere giardino terrazza';
    const a = buildKeywordProfile({ title: t }, { tokenize });
    const b = buildKeywordProfile({ title: t }, { tokenize });
    expect(scoreSharedKeywords(a, b).score).toBe(4);
  });
});

describe('render wiring', () => {
  const src = readFileSync(resolve(__dirname, '../packages/articles/engine/ogPagesPlugin.ts'), 'utf-8');
  it('takes the candidates as an explicit option and never imports the corpus', () => {
    expect(src).toMatch(/crossSectionCandidates\?: CrossSectionCandidate\[\]/);
    expect(src).not.toMatch(/from ['"][^'"]*frontaliere-articles/);
  });
  it('trims the same-section picks to the total ceiling', () => {
    expect(src).toMatch(/RELATED_TOTAL_MAX - \(hubItem \? 1 : 0\) - crossLinks\.length/);
  });
});
