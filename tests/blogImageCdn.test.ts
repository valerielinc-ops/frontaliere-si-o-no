import { describe, expect, it } from 'vitest';

import {
  cdnBlogImage,
  rawFallbackForBlog,
  CDN_BLOG_BASE,
  RAW_BLOG_BASE,
} from '@/services/seo/blogImageCdn';

describe('cdnBlogImage', () => {
  it('rewrites a site-relative full blog image to the CDN', () => {
    const out = cdnBlogImage('/images/blog/inter-scudetto-chivu-2026.webp');
    expect(out).toBe(`${CDN_BLOG_BASE}/inter-scudetto-chivu-2026.webp`);
  });

  it('rewrites an absolute same-origin full blog image', () => {
    const out = cdnBlogImage('https://frontaliereticino.ch/images/blog/x.webp');
    expect(out).toBe(`${CDN_BLOG_BASE}/x.webp`);
  });

  it('leaves 480w thumbnails same-origin (extra path segment)', () => {
    const p = '/images/blog/thumbnails/x-480w.webp';
    expect(cdnBlogImage(p)).toBe(p);
  });

  it('passes through non-blog images (e.g. /images/places)', () => {
    const p = '/images/places/lugano-view.webp';
    expect(cdnBlogImage(p)).toBe(p);
  });

  it('is idempotent on an already-CDN URL', () => {
    const cdn = `${CDN_BLOG_BASE}/x.webp`;
    expect(cdnBlogImage(cdn)).toBe(cdn);
  });

  it('handles empty / nullish input safely', () => {
    expect(cdnBlogImage('')).toBe('');
    expect(cdnBlogImage(undefined)).toBe('');
    expect(cdnBlogImage(null)).toBe('');
  });
});

describe('rawFallbackForBlog', () => {
  it('maps a CDN blog URL to its raw.githubusercontent fallback', () => {
    const cdn = `${CDN_BLOG_BASE}/x.webp`;
    expect(rawFallbackForBlog(cdn)).toBe(`${RAW_BLOG_BASE}/x.webp`);
  });

  it('returns null for non-CDN URLs', () => {
    expect(rawFallbackForBlog('/images/blog/x.webp')).toBeNull();
    expect(rawFallbackForBlog('https://frontaliereticino.ch/images/blog/x.webp')).toBeNull();
  });
});
