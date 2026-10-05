import { describe, expect, it } from 'vitest';
import {
  normalizeStaticJsonLdScripts,
} from '../../build-plugins/shared/seoPageShell';
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
});
