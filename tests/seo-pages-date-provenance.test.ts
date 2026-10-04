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
  it('does not attribute unverified source/effective dates to original claims, including the three already undated', () => {
    const claims = nodes.filter(node => node['@type'] === 'Claim');
    // cron-count-ok: authored Claim registry cardinality, independent of imported exchange-rate data.
    expect(claims).toHaveLength(33);
    for (const claim of claims) {
      expect(claim).not.toHaveProperty('datePublished');
      expect(claim.author).toBeTruthy();
      expect(claim.appearance).toMatchObject({ '@type': 'CreativeWork', url: expect.any(String) });
    }
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

  it('preserves independently maintained review and article publication dates and review evidence', () => {
    const reviews = nodes.filter(node => node['@type'] === 'ClaimReview');
    // cron-count-ok: authored review registry cardinality, independent of cron snapshots.
    expect(reviews).toHaveLength(33);
    for (const review of reviews) {
      expect(review.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(review.claimReviewed).toEqual(expect.any(String));
      expect(review.reviewRating).toBeTruthy();
    }
    const articles = nodes.filter(node => ['Article', 'NewsArticle'].includes(String(node['@type'])));
    const datedArticles = articles.filter(article => Object.hasOwn(article, 'datePublished'));
    // cron-count-ok: authored article publication metadata, not imported corpus counts.
    expect(datedArticles).toHaveLength(65);
    for (const article of datedArticles) expect(article.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}/);
    const borderArticle = articles.find(article => article.url === 'https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/');
    expect(borderArticle).toBeDefined();
    expect(borderArticle).not.toHaveProperty('datePublished');
    expect(borderArticle?.dateModified).toEqual(expect.any(String));
  });
});
