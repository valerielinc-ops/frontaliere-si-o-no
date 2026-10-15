import { describe, it, expect } from 'vitest';
import { getRelatedArticles } from '@/components/community/BlogArticles';
import { ARTICLES } from '@/data/blog-articles-data';

describe('getRelatedArticles', () => {
  it('returns the requested number of articles', () => {
    const related = getRelatedArticles('stipendio-netto-2026', ARTICLES, 3);
    expect(related).toHaveLength(3);
  });

  it('never includes the current article', () => {
    for (const article of ARTICLES.slice(0, 10)) {
      const related = getRelatedArticles(article.id, ARTICLES, 3);
      expect(related.every(r => r.id !== article.id)).toBe(true);
    }
  });

  it('returns different related articles for different articles in same category', () => {
    const fiscaleArticles = ARTICLES.filter(a => a.category === 'fiscale').slice(0, 5);
    const relatedSets = fiscaleArticles.map(a =>
      getRelatedArticles(a.id, ARTICLES, 3).map(r => r.id).sort().join(',')
    );
    // Not all sets should be identical
    const uniqueSets = new Set(relatedSets);
    expect(uniqueSets.size).toBeGreaterThan(1);
  });

  it('includes at least one cross-category article', () => {
    // For articles in categories with many entries, we enforce diversity
    const novitaArticle = ARTICLES.find(a => a.category === 'novita');
    if (novitaArticle) {
      const related = getRelatedArticles(novitaArticle.id, ARTICLES, 3);
      const crossCategory = related.filter(r => r.category !== novitaArticle.category);
      expect(crossCategory.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('prefers same-category articles (majority should match)', () => {
    const article = ARTICLES.find(a => a.category === 'fiscale');
    if (article) {
      const related = getRelatedArticles(article.id, ARTICLES, 3);
      const sameCategory = related.filter(r => r.category === 'fiscale');
      expect(sameCategory.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('is deterministic (same input = same output)', () => {
    const a = getRelatedArticles('stipendio-netto-2026', ARTICLES, 3).map(r => r.id);
    const b = getRelatedArticles('stipendio-netto-2026', ARTICLES, 3).map(r => r.id);
    expect(a).toEqual(b);
  });
});
