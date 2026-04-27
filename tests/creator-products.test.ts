import { describe, it, expect } from 'vitest';
import { getCreatorProductsForContext } from '@/services/creatorProductsService';

/**
 * Verifies Amazon affiliate product cards always link to direct product pages
 * (/dp/ASIN) and never to search result pages (/s?k=...).
 *
 * Background: search URLs can return empty results for niche queries (e.g.
 * "porta vignetta autostradale svizzera"), giving users a dead-end experience.
 * Direct product URLs always resolve to the correct product page.
 */
describe('creatorProductsService', () => {
  const CONTEXT_SAMPLES = [
    'cambio valuta chf eur frontalieri stipendio',
    'tasse irpef dichiarazione frontaliere credito',
    'traffico frontiera auto pendolare trasporto',
    'lavoro colloquio cv svizzera career job',
    'budget risparmio spese stipendio euro franchi',
    'salute assicurazione lamal cassa malati',
    'smart working produttività ufficio laptop',
    'viaggio frontiera svizzera italia documenti',
    'pensione previdenza avs lpp pilastro',
    'vignetta autostradale svizzera pendolare auto',
    '',
  ];

  it('all product URLs must be direct /dp/ASIN links (never search /s?k= URLs)', () => {
    const searchUrlProducts: string[] = [];

    for (const ctx of CONTEXT_SAMPLES) {
      const suggestions = getCreatorProductsForContext({
        contextText: ctx,
        maxCards: 50,
      });

      for (const s of suggestions) {
        if (!s.url.includes('/dp/')) {
          searchUrlProducts.push(
            `"${s.title}" (${s.asin}) → ${s.url} [context: "${ctx.slice(0, 40)}..."]`,
          );
        }
      }
    }

    expect(
      searchUrlProducts,
      `Products linking to search pages instead of product pages:\n${searchUrlProducts.join('\n')}`,
    ).toHaveLength(0);
  });

  it('all product URLs contain the affiliate tag', () => {
    const suggestions = getCreatorProductsForContext({
      contextText: 'frontalieri svizzera italia lavoro tasse',
      maxCards: 50,
    });

    for (const s of suggestions) {
      expect(s.url).toContain('tag=');
      expect(s.url).toContain('luigi066-21');
    }
  });

  it('all product URLs are valid amazon.it URLs', () => {
    const suggestions = getCreatorProductsForContext({
      contextText: 'frontalieri svizzera italia lavoro tasse',
      maxCards: 50,
    });

    for (const s of suggestions) {
      const url = new URL(s.url);
      expect(url.hostname).toContain('amazon.it');
      expect(url.pathname).toMatch(/^\/dp\/[A-Z0-9]+$/i);
    }
  });

  it('all products have a non-empty imageUrl', () => {
    const suggestions = getCreatorProductsForContext({
      contextText: 'frontalieri svizzera italia',
      maxCards: 50,
    });

    for (const s of suggestions) {
      expect(s.imageUrl, `Missing image for ${s.asin}`).toBeTruthy();
      expect(s.imageUrl).toContain('m.media-amazon.com/images/I/');
    }
  });

});
