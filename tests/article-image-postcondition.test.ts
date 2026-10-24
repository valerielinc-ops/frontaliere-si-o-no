import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  declaredImageIsOwn,
  filterEntriesByImagePostcondition,
  isGenericOgImage,
  normalizeImagePath,
} from '../scripts/lib/article-image-postcondition.mjs';
import { heroPathOf, probeRemoteHeroSizes, publicHeroUrl } from '../scripts/lib/remote-hero-sizes.mjs';

/** Minimal VP8X WebP header: enough for intrinsicSizeFromBuffer. */
function webpHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function fakeFetch(routes: Record<string, { status: number; type?: string; body?: Buffer } | Error>) {
  const seen: Array<{ url: string; range: string | null }> = [];
  const impl = async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, range: init?.headers?.Range ?? null });
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    if (route instanceof Error) throw route;
    return new Response(route.body ?? Buffer.alloc(0), {
      status: route.status,
      headers: { 'content-type': route.type ?? 'image/webp' },
    });
  };
  return { impl: impl as unknown as typeof fetch, seen };
}

describe('remote hero sizes for sparse article re-renders', () => {
  it('serves blog heroes from the CDN and other heroes from the origin', () => {
    expect(publicHeroUrl('/images/blog/naspi.webp')).toBe('https://cdn.frontaliereticino.ch/images/blog/naspi.webp');
    expect(publicHeroUrl('/images/places/lugano-view.webp')).toBe('https://frontaliereticino.ch/images/places/lugano-view.webp');
    // thumbnails are not full heroes and are not on the blog CDN path
    expect(publicHeroUrl('/images/blog/thumbnails/a.webp')).toBe('https://frontaliereticino.ch/images/blog/thumbnails/a.webp');
  });

  it('only measures same-site /images/ declarations', () => {
    expect(heroPathOf('/images/blog/a.webp')).toBe('/images/blog/a.webp');
    expect(heroPathOf('images/blog/a.webp?v=2')).toBe('/images/blog/a.webp');
    expect(heroPathOf('https://upload.wikimedia.org/a.jpg')).toBeNull();
    expect(heroPathOf('/og-image.png')).toBeNull();
    expect(heroPathOf('')).toBeNull();
  });

  it('measures missing heroes from the served header bytes and skips the ones on disk', async () => {
    const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-probe-'));
    try {
      fs.mkdirSync(path.join(publicDir, 'images/blog'), { recursive: true });
      fs.writeFileSync(path.join(publicDir, 'images/blog/local.webp'), webpHeader(1200, 800));
      const { impl, seen } = fakeFetch({
        'https://cdn.frontaliereticino.ch/images/blog/naspi.webp': { status: 206, body: webpHeader(1200, 1200) },
        'https://frontaliereticino.ch/images/places/mendrisio.webp': { status: 200, body: webpHeader(1600, 900) },
        'https://cdn.frontaliereticino.ch/images/blog/broken.webp': { status: 200, body: Buffer.from('not an image') },
        'https://cdn.frontaliereticino.ch/images/blog/offline.webp': new Error('ECONNRESET'),
      });

      const result = await probeRemoteHeroSizes(
        [
          '/images/blog/naspi.webp',
          '/images/blog/naspi.webp', // duplicate declarations are probed once
          '/images/places/mendrisio.webp',
          '/images/blog/local.webp',
          '/images/blog/missing.webp',
          '/images/blog/broken.webp',
          '/images/blog/offline.webp',
          'https://example.test/x.webp',
        ],
        { publicDir, fetchImpl: impl, concurrency: 3 },
      );

      expect(result.sizes).toEqual({
        '/images/blog/naspi.webp': { width: 1200, height: 1200 },
        '/images/places/mendrisio.webp': { width: 1600, height: 900 },
      });
      expect(result.local).toBe(1);
      expect(result.probed).toBe(5);
      expect(result.failed.map((f) => f.path).sort()).toEqual([
        '/images/blog/broken.webp',
        '/images/blog/missing.webp',
        '/images/blog/offline.webp',
      ]);
      // A 404 answered with an HTML page is never read as an image.
      expect(result.failed.find((f) => f.path === '/images/blog/missing.webp')?.reason).toBe('HTTP 404');
      // Never the local file, always a bounded header read.
      expect(seen.some((s) => s.url.endsWith('/local.webp'))).toBe(false);
      expect(seen.every((s) => s.range === 'bytes=0-65535')).toBe(true);
    } finally {
      fs.rmSync(publicDir, { recursive: true, force: true });
    }
  });

  it('does not materialize a full 200 response when only the header is needed', async () => {
    const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-prefix-'));
    try {
      const payload = Buffer.concat([webpHeader(1920, 1080), Buffer.alloc(200_000)]);
      const fetchImpl = async () => {
        const response = new Response(payload, { status: 200, headers: { 'content-type': 'image/webp' } });
        Object.defineProperty(response, 'arrayBuffer', {
          value: () => Promise.reject(new Error('full response materialized')),
        });
        return response;
      };

      const result = await probeRemoteHeroSizes(['/images/blog/large.webp'], {
        publicDir,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result.sizes).toEqual({ '/images/blog/large.webp': { width: 1920, height: 1080 } });
      expect(result.failed).toEqual([]);
    } finally {
      fs.rmSync(publicDir, { recursive: true, force: true });
    }
  });
});

describe('article image postcondition', () => {
  it('does not reinterpret external declared images as site-owned paths', () => {
    expect(normalizeImagePath('//cdn.example/images/hero.webp')).toBeNull();
    expect(declaredImageIsOwn('//cdn.example/images/hero.webp')).toBe(false);
    expect(normalizeImagePath('https://frontaliereticino.ch/images/hero.webp')).toBe('/images/hero.webp');
  });

  it('only recognizes the same-origin generic image as the fallback', () => {
    expect(isGenericOgImage('<meta property="og:image" content="https://frontaliereticino.ch/og-image.png">')).toBe(true);
    expect(isGenericOgImage('<meta property="og:image" content="https://cdn.example/og-image.png">')).toBe(false);
  });

  it('withholds an article whose page fell back to the generic image', () => {
    const entries = [
      { articleId: 'a', paths: { it: 'a/index.html' }, flatPaths: {} },
      { articleId: 'b', paths: { it: 'b/index.html' }, flatPaths: {} },
    ];
    const result = filterEntriesByImagePostcondition({
      entries,
      declaredImages: { a: '/images/blog/a.webp', b: '/images/blog/b.webp' },
      htmlByPath: {
        'a/index.html': '<meta property="og:image" content="https://frontaliereticino.ch/og-image.png">',
        'b/index.html': '<meta property="og:image" content="https://cdn.frontaliereticino.ch/images/blog/b.webp">',
      },
    });
    expect(result.entries.map((e) => e.articleId)).toEqual(['b']);
    expect(result.firstExcludedArticleIds).toEqual(['a']);
  });
});
