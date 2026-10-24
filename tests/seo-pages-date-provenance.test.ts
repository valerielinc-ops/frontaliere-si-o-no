import { describe, expect, it } from 'vitest';
import pages from '../services/seo/seo-pages';

function* objects(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const child of value) yield* objects(child);
  } else if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    yield node;
    for (const child of Object.values(node)) yield* objects(child);
  }
}

const nodes = [...objects(pages)];

describe('registry publication provenance', () => {
  it('ships no self-reviewed Claim nodes (removed with the in-house ClaimReview markup)', () => {
    expect(nodes.filter(node => node['@type'] === 'Claim')).toHaveLength(0);
  });

  it('keeps dataset coverage and distribution without invented publication/update events', () => {
    const datasets = nodes.filter(node => node['@type'] === 'Dataset');
    // cron-count-ok: authored Dataset definitions, not rows of a refreshed dataset.
    expect(datasets).toHaveLength(9);
    for (const dataset of datasets) {
      expect(dataset).not.toHaveProperty('datePublished');
      expect(dataset).not.toHaveProperty('dateModified');
      expect(dataset.temporalCoverage).toMatch(/^\d{4}\/\d{4}$/);
      expect(dataset.creator).toBeTruthy();
      expect(dataset.distribution).toBeTruthy();
      expect(dataset.name).toEqual(expect.any(String));
    }
  });

  it('preserves independently maintained article publication dates', () => {
    // Self-authored ClaimReview nodes were removed (E-E-A-T P0): none may return.
    expect(nodes.filter(node => node['@type'] === 'ClaimReview')).toHaveLength(0);
    const articles = nodes.filter(node => ['Article', 'NewsArticle'].includes(String(node['@type'])));
    const datedArticles = articles.filter(article => Object.hasOwn(article, 'datePublished'));
    // cron-count-ok: authored article publication metadata, not imported corpus counts.
    expect(datedArticles).toHaveLength(65);
    for (const article of datedArticles) expect(article.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}/);
    const borderArticle = articles.find(article => article.url === 'https://frontaliereticino.ch/traffico-dogane/');
    expect(borderArticle).toBeDefined();
    expect(borderArticle).not.toHaveProperty('datePublished');
    expect(borderArticle?.dateModified).toEqual(expect.any(String));
  });
});
