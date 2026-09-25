import { afterEach, describe, expect, it } from 'vitest';
import { cdnImageUrl, CDN_OFFLOADED_IMAGE_PREFIXES } from '../services/cdnImageBase';

// cdnImageUrl rewrites a same-origin offloaded brand/logo/author image path to the
// CDN when window.__CDN_DATA_BASE__ is injected (deploy-time), else returns the
// input unchanged. It must NEVER touch external URLs or non-offloaded same-origin
// paths (so it is safe to wrap around the mixed output of the logo resolvers).

const BASE = 'https://cdn.frontaliereticino.ch';

function setBase(v: string | undefined): void {
  if (v === undefined) {
    delete (window as unknown as { __CDN_DATA_BASE__?: string }).__CDN_DATA_BASE__;
  } else {
    (window as unknown as { __CDN_DATA_BASE__?: string }).__CDN_DATA_BASE__ = v;
  }
}

afterEach(() => setBase(undefined));

describe('cdnImageUrl', () => {
  it('rewrites every offloaded same-origin prefix to the CDN when the base is set', () => {
    setBase(BASE);
    for (const prefix of CDN_OFFLOADED_IMAGE_PREFIXES) {
      const path = `${prefix}acme.png`;
      expect(cdnImageUrl(path)).toBe(`${BASE}${path}`);
    }
  });

  it('returns the same-origin path unchanged when no base is injected (dev / offload skipped)', () => {
    setBase(undefined);
    expect(cdnImageUrl('/images/brands/acme.png')).toBe('/images/brands/acme.png');
  });

  it('passes external / absolute URLs through verbatim (never prefixes them)', () => {
    setBase(BASE);
    expect(cdnImageUrl('https://logo.clearbit.com/acme.com')).toBe('https://logo.clearbit.com/acme.com');
    expect(cdnImageUrl('https://www.google.com/s2/favicons?domain=acme.com&sz=128')).toBe(
      'https://www.google.com/s2/favicons?domain=acme.com&sz=128',
    );
    expect(cdnImageUrl('//cdn.example.com/x.png')).toBe('//cdn.example.com/x.png');
    expect(cdnImageUrl('data:image/svg+xml;base64,AAAA')).toBe('data:image/svg+xml;base64,AAAA');
  });

  it('leaves non-offloaded same-origin paths untouched (places stays same-origin, icons, placeholder)', () => {
    setBase(BASE);
    expect(cdnImageUrl('/images/places/thumbnails/lugano.webp')).toBe('/images/places/thumbnails/lugano.webp');
    expect(cdnImageUrl('/icons/company-placeholder.svg')).toBe('/icons/company-placeholder.svg');
    expect(cdnImageUrl('/images/blog/hero.webp')).toBe('/images/blog/hero.webp');
  });

  it('passes nullish through (resolvers can return null when no logo)', () => {
    setBase(BASE);
    expect(cdnImageUrl(null)).toBeNull();
    expect(cdnImageUrl(undefined)).toBeUndefined();
  });
});
