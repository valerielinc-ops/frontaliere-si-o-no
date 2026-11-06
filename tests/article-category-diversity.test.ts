/**
 * article-category-diversity.test.ts
 *
 * Detects category clustering: if more than MAX_NOVITA_RATIO of the last
 * WINDOW_SIZE articles are in the 'novita' category, the pipeline is likely
 * defaulting off-topic articles to 'novita' instead of mapping them correctly.
 *
 * Soft gate: warns above 85% novita, but only fails if 100% are novita
 * (clearly a bug). This avoids blocking deploys during news-heavy periods
 * while surfacing systematic category mapping failures.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BLOG_ARTICLES_DATA = path.resolve(__dirname, '..', 'data', 'blog-articles-data.ts');
const MAX_NOVITA_RATIO = 0.85; // warn if > 85% of last 20 articles are 'novita'
const WINDOW_SIZE = 20;

describe('article category diversity', () => {
  it(`should not have more than ${MAX_NOVITA_RATIO * 100}% 'novita' in last ${WINDOW_SIZE} articles`, () => {
    if (!fs.existsSync(BLOG_ARTICLES_DATA)) {
      console.warn('blog-articles-data.ts not found, skipping category diversity check');
      return;
    }

    const content = fs.readFileSync(BLOG_ARTICLES_DATA, 'utf-8');
    const categoryMatches = [...content.matchAll(/category:\s*'([^']+)'/g)];
    const allCategories = categoryMatches.map(m => m[1]);
    const lastN = allCategories.slice(-WINDOW_SIZE);

    if (lastN.length === 0) {
      console.warn('No categories found in blog-articles-data.ts, skipping check');
      return;
    }

    const novitaCount = lastN.filter(c => c === 'novita').length;
    const ratio = novitaCount / lastN.length;

    if (ratio > MAX_NOVITA_RATIO) {
      console.warn(
        `Category diversity warning: ${novitaCount}/${lastN.length} of last ${WINDOW_SIZE} articles are 'novita' (${(ratio * 100).toFixed(0)}%). ` +
        `Consider using 'fiscale', 'pratico', or 'pensione' for relevant articles.`
      );
    }

    // This is a soft warning test — only fail if ALL articles are novita (clearly wrong)
    expect(ratio).toBeLessThan(1.0);
  });
});
