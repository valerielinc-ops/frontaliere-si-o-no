/**
 * Unit tests for services/seo/imageObjectLd.ts.
 *
 * Verifies the contract that the GSC licensable-image quintet
 * (acquireLicensePage, copyrightNotice, license, creator, creditText) is
 * *always* present in the output, even when the caller passes a sparse input.
 */
import { describe, expect, it } from 'vitest';
import {
  imageObjectLd,
  imageObjectLdDocument,
  resolveHttpUrl,
  SITE_LICENSE_PAGE,
} from '@/services/seo/imageObjectLd';

const REQUIRED = ['acquireLicensePage', 'copyrightNotice', 'license', 'creator', 'creditText'] as const;

describe('imageObjectLd — GSC licensable-image quintet', () => {
  it('emits @type ImageObject with all 5 required fields when called with only contentUrl', () => {
    const ld = imageObjectLd({ contentUrl: 'https://example.com/img.png' });
    expect(ld['@type']).toBe('ImageObject');
    for (const f of REQUIRED) expect(ld).toHaveProperty(f);
  });

  it('mirrors `url` into contentUrl when only url is provided', () => {
    const ld = imageObjectLd({ url: 'https://example.com/img.png' });
    expect(ld.contentUrl).toBe('https://example.com/img.png');
    expect(ld.url).toBe('https://example.com/img.png');
  });

  it('throws when neither contentUrl nor url is provided', () => {
    expect(() => imageObjectLd({} as never)).toThrow(/contentUrl/);
  });

  it('defaults creator to the canonical site Organization', () => {
    const ld = imageObjectLd({ contentUrl: 'https://example.com/x.png' });
    expect(ld.creator).toEqual({
      '@type': 'Organization',
      '@id': 'https://frontaliereticino.ch/#organization',
      name: 'Frontaliere Ticino',
      url: 'https://frontaliereticino.ch/',
    });
  });

  it.each([
    'NewsMediaOrganization' as const,
    ['NewsMediaOrganization', 'Organization'] as const,
    ['Organization', 'NewsMediaOrganization'] as const,
  ].map((type) => ({ type })))('emits a supported creator type for legacy news-organization input $type', ({ type }) => {
    const creator = { '@type': type, '@id': 'https://example.com/#newsroom', name: 'External newsroom', url: 'https://example.com/' };
    expect(imageObjectLd({ contentUrl: 'https://example.com/image.jpg', creator }).creator)
      .toEqual({ ...creator, '@type': 'Organization' });
    expect(creator['@type']).toEqual(type);
  });

  it('keeps a site creator with array types attached to the canonical organization', () => {
    const creator = { '@type': ['NewsMediaOrganization', 'Organization'] as const, name: 'Frontaliere Ticino', url: 'https://frontaliereticino.ch/' };
    expect(imageObjectLd({ contentUrl: 'https://example.com/image.jpg', creator }).creator)
      .toEqual({ ...creator, '@type': 'Organization', '@id': 'https://frontaliereticino.ch/#organization' });
    expect(creator['@type']).toEqual(['NewsMediaOrganization', 'Organization']);
  });

  it.each([
    'Organization' as const,
    'NewsMediaOrganization' as const,
    ['NewsMediaOrganization', 'Organization'] as const,
  ].map((type) => ({ type })))('replaces a stale site creator id without mutating input $type', ({ type }) => {
    const creator = Object.freeze({
      '@type': type,
      '@id': 'https://example.com/#stale-organization',
      name: 'Frontaliere Ticino',
      url: 'https://frontaliereticino.ch/',
    });
    expect(imageObjectLd({ contentUrl: 'https://example.com/image.jpg', creator }).creator)
      .toEqual({ ...creator, '@type': 'Organization', '@id': 'https://frontaliereticino.ch/#organization' });
    expect(creator['@id']).toBe('https://example.com/#stale-organization');
  });

  it.each([
    { '@id': 'https://example.com/#newsroom' },
    { '@id': 'https://example.com/#newsroom', url: 'https://example.com/' },
    {},
  ])('does not infer site identity from a shared name: %j', (identity) => {
    const creator = Object.freeze({ '@type': 'NewsMediaOrganization' as const, name: 'Frontaliere Ticino', ...identity });
    expect(imageObjectLd({ contentUrl: 'https://example.com/image.jpg', creator }).creator)
      .toEqual({ ...creator, '@type': 'Organization' });
  });

  it('recognizes the canonical organization id without a URL', () => {
    const creator = { '@type': 'NewsMediaOrganization' as const, name: 'Frontaliere Ticino', '@id': 'https://frontaliereticino.ch/#organization' };
    expect(imageObjectLd({ contentUrl: 'https://example.com/image.jpg', creator }).creator)
      .toEqual({ ...creator, '@type': 'Organization' });
  });

  it('points license + acquireLicensePage to the site terms anchor by default', () => {
    const ld = imageObjectLd({ contentUrl: 'https://example.com/x.png' });
    expect(ld.license).toBe(SITE_LICENSE_PAGE);
    expect(ld.acquireLicensePage).toBe(SITE_LICENSE_PAGE);
  });

  it('respects explicit overrides for webcam / third-party images', () => {
    const ld = imageObjectLd({
      contentUrl: 'https://cam.example.org/snap.jpg',
      creator: { '@type': 'Organization', name: 'USTRA', url: 'https://www.astra.admin.ch' },
      license: 'https://www.astra.admin.ch/license',
      copyrightNotice: '© USTRA',
      creditText: 'USTRA',
    });
    expect(ld.creator).toEqual({ '@type': 'Organization', name: 'USTRA', url: 'https://www.astra.admin.ch' });
    expect(ld.license).toBe('https://www.astra.admin.ch/license');
    expect(ld.copyrightNotice).toBe('© USTRA');
    expect(ld.creditText).toBe('USTRA');
    expect(ld.acquireLicensePage).toBe(SITE_LICENSE_PAGE); // not overridden
  });

  it('falls back to defaults when override is undefined', () => {
    const ld = imageObjectLd({
      contentUrl: 'https://example.com/x.png',
      creator: undefined,
      license: undefined,
      copyrightNotice: undefined,
    });
    expect(ld.creator).toEqual({
      '@type': 'Organization',
      '@id': 'https://frontaliereticino.ch/#organization',
      name: 'Frontaliere Ticino',
      url: 'https://frontaliereticino.ch/',
    });
    expect(ld.license).toBe(SITE_LICENSE_PAGE);
    expect(ld.acquireLicensePage).toBe(SITE_LICENSE_PAGE);
  });

  it('rejects a non-URL license override', () => {
    expect(() =>
      imageObjectLd({
        contentUrl: 'https://example.com/x.png',
        license: 'Immagine pubblicata dal dataset ufficiale INFOMOB del SITG',
      }),
    ).toThrow(/license must be an absolute http\(s\) URL/);
  });

  it('rejects a non-URL acquireLicensePage override', () => {
    expect(() =>
      imageObjectLd({
        contentUrl: 'https://example.com/x.png',
        acquireLicensePage: 'Come ottenere la licenza',
      }),
    ).toThrow(/acquireLicensePage must be an absolute http\(s\) URL/);
  });

  it('normalizes whitespace around an explicit URL', () => {
    const ld = imageObjectLd({
      contentUrl: 'https://example.com/x.png',
      license: '  https://example.com/license  ',
    });
    expect(ld.license).toBe('https://example.com/license');
  });

  it('rejects non-string URL overrides before reading URL properties', () => {
    expect(() => imageObjectLd({
      contentUrl: 'https://example.com/x.png',
      license: 42 as never,
    })).toThrow(/license must be an absolute http\(s\) URL/);
    expect(() => imageObjectLd({
      contentUrl: 'https://example.com/x.png',
      acquireLicensePage: { href: 'https://example.com' } as never,
    })).toThrow(/acquireLicensePage must be an absolute http\(s\) URL/);
  });

  it('validates the fallback through the same URL resolver', () => {
    expect(() => resolveHttpUrl(undefined, 'ftp://example.com/license', 'license'))
      .toThrow(/license must be an absolute http\(s\) URL/);
    expect(() => resolveHttpUrl(undefined, 42, 'license'))
      .toThrow(/license must be an absolute http\(s\) URL/);
  });

  it('preserves optional fields when present', () => {
    const ld = imageObjectLd({
      contentUrl: 'https://example.com/x.png',
      caption: 'A caption',
      width: 1200,
      height: 675,
      datePublished: '2026-05-05T00:00:00Z',
      inLanguage: 'it',
    });
    expect(ld.caption).toBe('A caption');
    expect(ld.width).toBe(1200);
    expect(ld.height).toBe(675);
    expect(ld.datePublished).toBe('2026-05-05T00:00:00Z');
    expect(ld.inLanguage).toBe('it');
  });

  it('imageObjectLdDocument adds @context and keeps the quintet', () => {
    const ld = imageObjectLdDocument({ contentUrl: 'https://example.com/x.png' });
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('ImageObject');
    for (const f of REQUIRED) expect(ld).toHaveProperty(f);
  });

  it('defaults creditText to the site Organization name', () => {
    const ld = imageObjectLd({ contentUrl: 'https://example.com/x.png' });
    expect(ld.creditText).toBe('Frontaliere Ticino');
  });

  it('defaults creditText to the overridden creator name (e.g. third-party webcam)', () => {
    const ld = imageObjectLd({
      contentUrl: 'https://cam.example.org/snap.jpg',
      creator: { '@type': 'Organization', name: 'USTRA' },
    });
    expect(ld.creditText).toBe('USTRA');
  });

  it('respects an explicit creditText override over the creator-name fallback', () => {
    const ld = imageObjectLd({
      contentUrl: 'https://cam.example.org/snap.jpg',
      creator: { '@type': 'Organization', name: 'USTRA' },
      creditText: 'USTRA / © Cantone Ticino',
    });
    expect(ld.creditText).toBe('USTRA / © Cantone Ticino');
  });
});
