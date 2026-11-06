/**
 * Issue 13018: ranged GETs of HTML pages made the Worker throw. The edge cache
 * slices the gzip representation it stores and decodes the slice, so a 206
 * page arrived as a few KB of HTML under a Content-Range counted in compressed
 * bytes (measured on 2026-10-14: `bytes 0-1023/16288` with a 3100-byte body,
 * for a page that is 58788 bytes uncompressed). The Worker no longer forwards
 * Range/If-Range for document routes: the origin answers the full page.
 */
import { afterEach, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import * as router from '../infra/cloudflare-worker/locale-router.js';

const { isDocumentPath } = router;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureOriginRequests() {
  const seen: Request[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    seen.push(input instanceof Request ? input : new Request(String(input)));
    return new Response('<!doctype html><title>t</title>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  };
  return seen;
}

const ranged = (url: string) => new Request(url, {
  headers: { Range: 'bytes=0-1023', 'If-Range': '"etag"', 'Accept-Encoding': 'gzip' },
});

describe('isDocumentPath', () => {
  it('matches directory routes and .html files only', () => {
    for (const path of ['/', '/agenzie-del-lavoro-lugano/', '/en/cross-border-articles/all/page-28/', '/en.html']) {
      expect(isDocumentPath(path), path).toBe(true);
    }
    for (const path of ['/guida.pdf', '/rss.xml', '/sitemap.xml', '/favicon.ico', '/assets/index.js', '']) {
      expect(isDocumentPath(path), path).toBe(false);
    }
  });
});

describe('the Worker does not forward Range for HTML pages', () => {
  it('apex page: the origin request carries neither Range nor If-Range, and the answer is the full 200', async () => {
    const seen = captureOriginRequests();
    const res = await router.default.fetch(
      ranged('https://frontaliereticino.ch/agenzie-del-lavoro-lugano/'),
      {},
      undefined,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.get('Range')).toBeNull();
    expect(seen[0].headers.get('If-Range')).toBeNull();
    expect(res.status).toBe(200);
  });

  it('locale shard page: Range is dropped next to Accept-Encoding identity', async () => {
    const seen = captureOriginRequests();
    const res = await router.default.fetch(
      ranged('https://frontaliereticino.ch/en/cross-border-articles/all/page-28/'),
      {},
      undefined,
    );
    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const request of seen) {
      expect(request.headers.get('Range')).toBeNull();
      expect(request.headers.get('If-Range')).toBeNull();
      expect(request.headers.get('Accept-Encoding')).toBe('identity');
    }
    expect(res.status).toBe(200);
  });

  it('NEGATIVE CASE — a non-document file keeps its Range (download resume still works)', async () => {
    const seen = captureOriginRequests();
    await router.default.fetch(ranged('https://frontaliereticino.ch/guida-frontaliere.pdf'), {}, undefined);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.get('Range')).toBe('bytes=0-1023');
  });
});
