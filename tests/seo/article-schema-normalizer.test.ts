import { describe, expect, it } from 'vitest';

import { ORGANIZATION_ID } from '@/services/seo/organizationLd';
import { normalizeArticleStructuredData } from '@/services/seo/schema-normalizers';

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

    expect(normalized.author.name).toBe('Frontaliere Ticino');
    expect(normalized.author.url).toBe('https://frontaliereticino.ch/');
    expect(normalized.publisher.name).toBe('Frontaliere Ticino');
    expect(normalized.publisher.logo['@type']).toBe('ImageObject');
    expect(normalized.image.contentUrl).toBe(normalized.image.url);
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
});
