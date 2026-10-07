import { describe, expect, it } from 'vitest';
import {
  buildSeoHeroPreload,
  buildSeoPageHtml,
  normalizeStaticJsonLdScripts,
} from '../../build-plugins/shared/seoPageShell';
import { inlineScriptJson } from '../../build-plugins/shared/inlineJsonScript';
import {
  TICINO_CUSTOMS_DEPARTMENT_ID,
  WEBSITE_ID,
} from '../../services/seo/organizationLd';

describe('static SEO JSON-LD identities', () => {
  it('gives the repeated site WebSite one stable id', () => {
    const [serialized] = normalizeStaticJsonLdScripts([
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        isPartOf: {
          '@type': 'WebSite',
          name: 'Frontaliere Ticino',
          url: 'https://frontaliereticino.ch/',
        },
      }),
    ]);

    expect(JSON.parse(serialized).isPartOf['@id']).toBe(WEBSITE_ID);
  });

  it('identifies the Ticino customs department used as webcam creator', () => {
    const [serialized] = normalizeStaticJsonLdScripts([
      JSON.stringify({
        '@type': 'ImageObject',
        creator: {
          '@type': 'Organization',
          name: 'Dipartimento del territorio – Canton Ticino',
        },
      }),
    ]);

    expect(JSON.parse(serialized).creator).toMatchObject({
      '@id': TICINO_CUSTOMS_DEPARTMENT_ID,
      url: TICINO_CUSTOMS_DEPARTMENT_ID,
    });
  });

  it('leaves an external WebSite unchanged', () => {
    const source = JSON.stringify({
      '@type': 'WebPage',
      isPartOf: { '@type': 'WebSite', name: 'Partner site', url: 'https://example.com/' },
    });

    expect(normalizeStaticJsonLdScripts([source])).toEqual([source]);
  });

  it('preserves a distinct job subsite WebSite', () => {
    const source = JSON.stringify({
      '@type': 'WebPage',
      isPartOf: {
        '@type': 'WebSite',
        name: 'Offerte di Lavoro Ticino — Frontaliere Ticino',
        url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/',
      },
    });

    expect(normalizeStaticJsonLdScripts([source])).toEqual([source]);
  });

  it('preserves a customs organization with an explicit foreign identity', () => {
    const source = JSON.stringify({
      '@type': 'ImageObject',
      creator: {
        '@type': 'Organization',
        '@id': 'https://example.com/#department',
        name: 'Dipartimento del territorio – Canton Ticino',
        url: 'https://example.com/department',
      },
    });

    expect(normalizeStaticJsonLdScripts([source])).toEqual([source]);
  });

  it('gives repeated name-only external organizations a deterministic id', () => {
    const [serialized] = normalizeStaticJsonLdScripts([
      JSON.stringify({
        '@type': 'ItemList',
        itemListElement: [
          { '@type': 'ListItem', item: { '@type': 'Organization', name: 'EOC – Ente Ospedaliero Cantonale' } },
          { '@type': 'ListItem', item: { '@type': 'Organization', name: 'EOC – Ente Ospedaliero Cantonale' } },
        ],
      }),
    ]);

    const items = JSON.parse(serialized).itemListElement;
    expect(items[0].item['@id']).toBe(
      'https://frontaliereticino.ch/#organization-eoc-ente-ospedaliero-cantonale-50273b5f8a9088d1',
    );
    expect(items[1].item['@id']).toBe(items[0].item['@id']);
  });

  it('uses an official organization URL as its identity', () => {
    const [serialized] = normalizeStaticJsonLdScripts([
      JSON.stringify({ '@type': 'Organization', name: 'EOC', url: 'https://www.eoc.ch' }),
    ]);

    expect(JSON.parse(serialized)['@id']).toBe('https://www.eoc.ch/');
  });

  it('applies the same organization identity pass to article-engine JSON-LD', () => {
    const serialized = inlineScriptJson({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      image: {
        '@type': 'ImageObject',
        creator: { '@type': 'Organization', name: 'European Commission (Christophe Licoppe)' },
      },
    });

    expect(JSON.parse(serialized).image.creator['@id']).toBe(
      'https://frontaliereticino.ch/#organization-european-commission-christophe-licoppe-9c3bd3af9176f96b',
    );
  });
});

describe('static SEO hero LCP preload', () => {
  const heroBody = '<figure><img data-seo-hero="faq-hub/permesso/de" src="/og/seo/faq-hub/permesso-de.webp" width="1200" height="630"></figure>';

  it('derives a high-priority image preload from the shared hero marker', () => {
    expect(buildSeoHeroPreload(heroBody)).toBe(
      '<link rel="preload" as="image" href="/og/seo/faq-hub/permesso-de.webp" type="image/webp" fetchpriority="high">',
    );
  });

  it('does not duplicate an existing absolute preload for the same hero', () => {
    const existing = '<link rel="preload" as="image" href="https://frontaliereticino.ch/og/seo/faq-hub/permesso-de.webp" type="image/webp" fetchpriority="high">';
    expect(buildSeoHeroPreload(heroBody, existing)).toBe('');
  });

  it('keeps an unrelated image preload and adds the hero hint', () => {
    const existing = '<link rel="preload" as="image" href="/og-image.png">';
    expect(buildSeoHeroPreload(heroBody, existing)).toContain(
      'href="/og/seo/faq-hub/permesso-de.webp"',
    );
  });

  it('ignores pages without the generated hero marker', () => {
    expect(buildSeoHeroPreload('<img src="/images/logo.svg">')).toBe('');
  });

  it('injects the derived hint into the final document head', () => {
    const html = buildSeoPageHtml({
      locale: 'de',
      title: 'Grenzgänger',
      description: 'Arbeiten in der Schweiz',
      canonicalUrl: 'https://frontaliereticino.ch/de/grenzgaenger/',
      bodyHtml: heroBody,
    });

    expect(html).toContain(
      '<link rel=preload as=image href=/og/seo/faq-hub/permesso-de.webp type=image/webp fetchpriority=high>',
    );
  });
});
