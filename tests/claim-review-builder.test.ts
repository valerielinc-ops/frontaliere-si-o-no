// Unit tests for the ClaimReview JSON-LD builder (AE-8).
//
// Verifies schema.org shape, rating bucket mapping, immutability and
// the multi-entry helper.

import { describe, it, expect } from 'vitest';
import { buildClaimReview, buildClaimReviews } from '../services/seo/claim-review';

const BASE_INPUT = Object.freeze({
  pageUrl: 'https://frontaliereticino.ch/tasse-e-pensione/nuova-legge-frontalieri-2026',
  claimReviewed: 'La franchigia IRPEF per i nuovi frontalieri è di 10.000 euro annui',
  datePublished: '2026-04-23',
  sourceUrl: 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2023-06-13;83',
  sourceName: 'Legge 13 giugno 2023 n. 83 — Ratifica Accordo Italia-Svizzera',
});

describe('buildClaimReview', () => {
  it('produces a schema.org ClaimReview with all mandatory fields', () => {
    const cr = buildClaimReview({ ...BASE_INPUT, rating: 'true' });

    expect(cr['@context']).toBe('https://schema.org');
    expect(cr['@type']).toBe('ClaimReview');
    expect(cr.url).toBe(BASE_INPUT.pageUrl);
    expect(cr.claimReviewed).toBe(BASE_INPUT.claimReviewed);
    expect(cr.datePublished).toBe(BASE_INPUT.datePublished);
  });

  it('author is Frontaliere Ticino Organization with canonical URL', () => {
    const cr = buildClaimReview({ ...BASE_INPUT, rating: 'true' });
    expect(cr.author['@type']).toBe('Organization');
    expect(cr.author.name).toBe('Frontaliere Ticino');
    expect(cr.author.url).toBe('https://frontaliereticino.ch');
  });

  it('maps rating "true" → 5/5 Vero', () => {
    const cr = buildClaimReview({ ...BASE_INPUT, rating: 'true' });
    expect(cr.reviewRating.ratingValue).toBe('5');
    expect(cr.reviewRating.bestRating).toBe('5');
    expect(cr.reviewRating.worstRating).toBe('1');
    expect(cr.reviewRating.alternateName).toBe('Vero');
  });

  it('maps rating "mostly-true" → 4/5 Generalmente vero', () => {
    const cr = buildClaimReview({ ...BASE_INPUT, rating: 'mostly-true' });
    expect(cr.reviewRating.ratingValue).toBe('4');
    expect(cr.reviewRating.alternateName).toBe('Generalmente vero');
  });

  it('maps rating "mixed" → 3/5 Dipende', () => {
    const cr = buildClaimReview({ ...BASE_INPUT, rating: 'mixed' });
    expect(cr.reviewRating.ratingValue).toBe('3');
    expect(cr.reviewRating.alternateName).toBe('Dipende');
  });

  it('maps rating "mostly-false" → 2/5 Parzialmente falso', () => {
    const cr = buildClaimReview({ ...BASE_INPUT, rating: 'mostly-false' });
    expect(cr.reviewRating.ratingValue).toBe('2');
    expect(cr.reviewRating.alternateName).toBe('Parzialmente falso');
  });

  it('maps rating "false" → 1/5 Falso', () => {
    const cr = buildClaimReview({ ...BASE_INPUT, rating: 'false' });
    expect(cr.reviewRating.ratingValue).toBe('1');
    expect(cr.reviewRating.alternateName).toBe('Falso');
  });

  it('throws on unsupported rating', () => {
    expect(() =>
      buildClaimReview({
        ...BASE_INPUT,
        // @ts-expect-error — intentional invalid input
        rating: 'somewhat-true',
      }),
    ).toThrow(/unsupported rating/i);
  });

  it('itemReviewed.appearance cites the authoritative source', () => {
    const cr = buildClaimReview({ ...BASE_INPUT, rating: 'true' });
    expect(cr.itemReviewed['@type']).toBe('Claim');
    expect(cr.itemReviewed.appearance['@type']).toBe('CreativeWork');
    expect(cr.itemReviewed.appearance.url).toBe(BASE_INPUT.sourceUrl);
    expect(cr.itemReviewed.appearance.name).toBe(BASE_INPUT.sourceName);
  });

  it('claimAuthor and claimDatePublished default to page + review date', () => {
    const cr = buildClaimReview({ ...BASE_INPUT, rating: 'true' });
    expect(cr.itemReviewed.author.name).toBe(BASE_INPUT.pageUrl);
    expect(cr.itemReviewed.datePublished).toBe(BASE_INPUT.datePublished);
  });

  it('explicit claimAuthor / claimDatePublished override defaults', () => {
    const cr = buildClaimReview({
      ...BASE_INPUT,
      rating: 'true',
      claimAuthor: 'Opinione comune',
      claimDatePublished: '2024-01-01',
    });
    expect(cr.itemReviewed.author.name).toBe('Opinione comune');
    expect(cr.itemReviewed.datePublished).toBe('2024-01-01');
  });

  it('omits reviewBody when not provided', () => {
    const cr = buildClaimReview({ ...BASE_INPUT, rating: 'true' });
    expect(cr).not.toHaveProperty('reviewBody');
  });

  it('includes reviewBody when provided', () => {
    const cr = buildClaimReview({
      ...BASE_INPUT,
      rating: 'true',
      reviewBody: 'Verificato sulla Legge 83/2023 art. 2.',
    });
    expect(cr.reviewBody).toBe('Verificato sulla Legge 83/2023 art. 2.');
  });

  it('does not mutate input (pure)', () => {
    const input = { ...BASE_INPUT, rating: 'true' as const };
    const snapshot = JSON.stringify(input);
    buildClaimReview(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('buildClaimReviews', () => {
  it('builds multiple ClaimReview blocks sharing common fields', () => {
    const out = buildClaimReviews(
      {
        pageUrl: 'https://frontaliereticino.ch/tasse-e-pensione/nuova-legge-frontalieri-2026',
        datePublished: '2026-04-23',
      },
      [
        {
          claimReviewed: 'Franchigia IRPEF 10.000 €',
          rating: 'true',
          sourceUrl: 'https://example.test/legge-83',
          sourceName: 'Legge 83/2023',
        },
        {
          claimReviewed: 'Limite telelavoro 25%',
          rating: 'true',
          sourceUrl: 'https://example.test/accordo-telelavoro',
          sourceName: 'Accordo telelavoro 23/12/2023',
        },
      ],
    );

    expect(out).toHaveLength(2);
    expect(out[0].url).toBe(out[1].url);
    expect(out[0].datePublished).toBe(out[1].datePublished);
    expect(out[0].claimReviewed).not.toBe(out[1].claimReviewed);
  });

  it('per-entry overrides win over common base', () => {
    const out = buildClaimReviews(
      { pageUrl: 'https://frontaliereticino.ch/a', datePublished: '2026-04-23' },
      [
        {
          pageUrl: 'https://frontaliereticino.ch/b',
          claimReviewed: 'c',
          rating: 'true',
          sourceUrl: 'https://example.test/s',
          sourceName: 's',
        },
      ],
    );
    expect(out[0].url).toBe('https://frontaliereticino.ch/b');
  });
});
