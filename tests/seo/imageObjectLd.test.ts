/**
 * Unit tests for services/seo/imageObjectLd.ts.
 *
 * Verifies the contract that the GSC licensable-image quartet
 * (acquireLicensePage, copyrightNotice, license, creator) is *always* present
 * in the output, even when the caller passes a sparse input.
 */
import { describe, expect, it } from 'vitest';
import { imageObjectLd, imageObjectLdDocument, SITE_LICENSE_PAGE } from '@/services/seo/imageObjectLd';

const REQUIRED = ['acquireLicensePage', 'copyrightNotice', 'license', 'creator'] as const;

describe('imageObjectLd — GSC licensable-image quartet', () => {
  it('emits @type ImageObject with all 4 required fields when called with only contentUrl', () => {
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

  it('defaults creator to the site Organization', () => {
    const ld = imageObjectLd({ contentUrl: 'https://example.com/x.png' });
    expect(ld.creator).toEqual({
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: 'https://frontaliereticino.ch',
    });
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
      name: 'Frontaliere Ticino',
      url: 'https://frontaliereticino.ch',
    });
    expect(ld.license).toBe(SITE_LICENSE_PAGE);
    expect(ld.acquireLicensePage).toBe(SITE_LICENSE_PAGE);
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

  it('imageObjectLdDocument adds @context and keeps the quartet', () => {
    const ld = imageObjectLdDocument({ contentUrl: 'https://example.com/x.png' });
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('ImageObject');
    for (const f of REQUIRED) expect(ld).toHaveProperty(f);
  });
});
