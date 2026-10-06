import { describe, expect, it } from 'vitest';

import { ORGANIZATION_ID, stableOrganizationId, WEBSITE_ID } from '@/services/seo/organizationLd';
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

  it('consolidates repeated external organizations by URL or exact name', () => {
    const normalized = normalizeStructuredData({
      '@type': 'NewsArticle',
      image: {
        '@type': 'ImageObject',
        creator: { '@type': 'Organization', name: 'European Commission (Christophe Licoppe)' },
      },
      about: [
        { '@type': 'Organization', name: 'EOC', url: 'https://www.eoc.ch' },
        { '@type': 'Organization', name: 'EOC', url: 'https://www.eoc.ch' },
      ],
    }) as Record<string, any>;

    expect(normalized.image.creator['@id']).toBe(
      'https://frontaliereticino.ch/#organization-european-commission-christophe-licoppe',
    );
    expect(normalized.about[0]['@id']).toBe('https://www.eoc.ch/');
    expect(normalized.about[1]['@id']).toBe(normalized.about[0]['@id']);
  });

  it('collapses first-party locale URLs onto the canonical publisher id', () => {
    const normalized = normalizeStructuredData({
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: 'https://frontaliereticino.ch/de/',
    }) as Record<string, any>;
    expect(normalized['@id']).toBe('https://frontaliereticino.ch/#organization');
  });

  it('preserves a same-name external newsroom when it has an explicit id', () => {
    const external = {
      '@type': 'Organization',
      '@id': 'https://example.com/#newsroom',
      name: 'Frontaliere Ticino',
    };
    const normalized = normalizeStructuredData({ '@type': 'NewsArticle', creator: external }) as Record<string, any>;
    expect(normalized.creator).toEqual(external);
  });

  it('keeps long name-only organizations distinct after the readable key limit', () => {
    const prefix = 'External Organization '.repeat(6);
    const first = stableOrganizationId({ name: `${prefix}Alpha` });
    const second = stableOrganizationId({ name: `${prefix}Beta` });
    const readablePrefix = 'external-organization-'.repeat(6).slice(0, 96);

    expect(first).toMatch(new RegExp(`organization-${readablePrefix}-[0-9a-f]{16}$`));
    expect(second).toMatch(new RegExp(`organization-${readablePrefix}-[0-9a-f]{16}$`));
    expect(first).not.toBe(second);
  });
});
