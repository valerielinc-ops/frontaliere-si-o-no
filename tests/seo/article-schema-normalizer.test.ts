import { describe, expect, it } from 'vitest';

import { ORGANIZATION_ID, WEBSITE_ID } from '@/services/seo/organizationLd';
import { normalizeArticleStructuredData, normalizeStructuredData } from '@/services/seo/schema-normalizers';

describe('static Article JSON-LD safety net', () => {
  it('expands organization references and supplies legacy Article defaults', () => {
    const normalized = normalizeArticleStructuredData({
      '@context': 'https://schema.org',
      '@type': 'Article',
      author: { '@id': ORGANIZATION_ID },
      publisher: { '@id': ORGANIZATION_ID },
      image: {
        '@type': 'ImageObject',
        url: 'https://frontaliereticino.ch/images/legacy.webp',
      },
    }) as Record<string, any>;

    expect(normalized['@type']).toBe('WebPage');
    expect(normalized.author.name).toBe('Frontaliere Ticino');
    expect(normalized.author.url).toBe('https://frontaliereticino.ch/');
    expect(normalized.publisher.name).toBe('Frontaliere Ticino');
    expect(normalized.publisher.logo['@type']).toBe('ImageObject');
    expect(normalized.image.contentUrl).toBe(normalized.image.url);
  });

  it('keeps Article semantics when an editorial publication date is present', () => {
    const normalized = normalizeArticleStructuredData({
      '@type': 'Article',
      headline: 'Dated article',
      datePublished: '2026-10-01',
    }) as Record<string, any>;

    expect(normalized['@type']).toBe('Article');
    expect(normalized.datePublished).toBe('2026-10-01');
  });

  it.each([
    { '@id': 'https://example.com/#newsroom' },
    {},
  ])('keeps external same-name identities external through both normalization passes: %j', (identity) => {
    const external = Object.freeze({ '@type': 'Organization', name: 'Frontaliere Ticino', ...identity });
    const normalized = normalizeStructuredData(normalizeArticleStructuredData({
      '@type': 'NewsArticle', author: external, publisher: external,
    }));
    for (const entity of [normalized.author, normalized.publisher]) {
      expect(entity).toEqual(external);
      expect(entity).not.toHaveProperty('url');
    }
    expect(external).not.toHaveProperty('url');
  });

  it('adds a safe image when a legacy Article omitted one', () => {
    const normalized = normalizeArticleStructuredData({ '@type': 'NewsArticle' }) as Record<string, any>;
    expect(normalized.image).toBe('https://frontaliereticino.ch/og-image.png');
    expect(normalized.author.name).toBe('Frontaliere Ticino');
    expect(normalized.publisher.logo).toBeDefined();
  });

  it('does not invent Article fields on unrelated schema types', () => {
    const normalized = normalizeArticleStructuredData({ '@type': 'FAQPage' }) as Record<string, any>;
    expect(normalized).toEqual({ '@type': 'FAQPage' });
  });

  it('stabilizes the shared WebSite and customs-department identities', () => {
    const normalized = normalizeStructuredData({
      '@type': 'WebPage',
      isPartOf: {
        '@type': 'WebSite',
        name: 'Frontaliere Ticino',
        url: 'https://frontaliereticino.ch/',
      },
      image: {
        '@type': 'ImageObject',
        creator: {
          '@type': 'Organization',
          name: 'Dipartimento del territorio – Canton Ticino',
        },
      },
    }) as Record<string, any>;

    expect(normalized.isPartOf['@id']).toBe(WEBSITE_ID);
    expect(normalized.image.creator).toMatchObject({
      '@id': 'https://www.ti.ch/webcam',
      url: 'https://www.ti.ch/webcam',
    });
  });

  it('does not assign site identities to an external WebSite', () => {
    const normalized = normalizeStructuredData({
      '@type': 'WebPage',
      isPartOf: { '@type': 'WebSite', name: 'Partner site', url: 'https://example.com/' },
    }) as Record<string, any>;

    expect(normalized.isPartOf).not.toHaveProperty('@id', WEBSITE_ID);
  });
});
