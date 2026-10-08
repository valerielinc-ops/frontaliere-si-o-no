/**
 * Edge remedy for the 2026-10-08 outage: published HTML pinned `integrity`
 * hashes of cdn.frontaliereticino.ch/assets/* files that the next build's early
 * CDN push had already overwritten, and the browser blocked every script. The
 * Worker drops the attribute from first-party asset tags on the HTML it serves.
 *
 * HTMLRewriter does not exist in node, so the rewriter is faked: the test pins
 * WHICH responses are rewritten, the selector, and what the element handler
 * does to a tag — the three things the fix consists of.
 */
import { afterEach, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import * as router from '../infra/cloudflare-worker/locale-router.js';

const { FIRST_PARTY_ASSET_URL_RE, staleAssetIntegrityHandler, stripStaleAssetIntegrity } = router;

type Handler = { element(el: unknown): void };
const calls: Array<{ selector: string; handler: Handler }> = [];

class FakeRewriter {
  on(selector: string, handler: Handler) {
    calls.push({ selector, handler });
    return this;
  }
  transform(response: Response) {
    const headers = new Headers(response.headers);
    headers.set('x-test-rewritten', '1');
    return new Response(response.body, { status: response.status, headers });
  }
}

function fakeElement(attrs: Record<string, string>) {
  return {
    attrs,
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
    removeAttribute: (name: string) => {
      delete attrs[name];
    },
  };
}

const html = (init: ResponseInit = {}) =>
  new Response('<!doctype html><title>t</title>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    ...init,
  });

afterEach(() => {
  calls.length = 0;
  delete (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
});

describe('stripStaleAssetIntegrity — which responses are rewritten', () => {
  it('rewrites a GET HTML response through script[integrity], link[integrity]', () => {
    (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter = FakeRewriter;
    const out = stripStaleAssetIntegrity(new Request('https://frontaliereticino.ch/en/'), html());

    expect(out.headers.get('x-test-rewritten')).toBe('1');
    expect(calls).toHaveLength(1);
    expect(calls[0].selector).toBe('script[integrity], link[integrity]');
    expect(calls[0].handler).toBe(staleAssetIntegrityHandler);
  });

  it('rewrites an HTML error page too (the 404 shell loads the same scripts)', () => {
    (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter = FakeRewriter;
    const out = stripStaleAssetIntegrity(new Request('https://frontaliereticino.ch/en/x/'), html({ status: 404 }));
    expect(out.status).toBe(404);
    expect(out.headers.get('x-test-rewritten')).toBe('1');
  });

  it('NEGATIVE CASE — non-HTML, non-GET and body-less responses pass through untouched', () => {
    (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter = FakeRewriter;
    const xml = new Response('<urlset/>', { headers: { 'Content-Type': 'application/xml' } });
    const redirect = new Response(null, { status: 301, headers: { Location: '/en/' } });
    const posted = html();

    expect(stripStaleAssetIntegrity(new Request('https://frontaliereticino.ch/sitemap.xml'), xml)).toBe(xml);
    expect(stripStaleAssetIntegrity(new Request('https://frontaliereticino.ch/en'), redirect)).toBe(redirect);
    expect(
      stripStaleAssetIntegrity(new Request('https://frontaliereticino.ch/en/', { method: 'POST' }), posted),
    ).toBe(posted);
    expect(calls).toHaveLength(0);
  });

  it('fails open: no HTMLRewriter, or a rewriter that throws, returns the original response', () => {
    const plain = html();
    expect(stripStaleAssetIntegrity(new Request('https://frontaliereticino.ch/en/'), plain)).toBe(plain);

    (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter = class {
      on() {
        throw new Error('boom');
      }
    };
    const again = html();
    expect(stripStaleAssetIntegrity(new Request('https://frontaliereticino.ch/en/'), again)).toBe(again);
  });
});

describe('staleAssetIntegrityHandler — what happens to a tag', () => {
  it('drops integrity from the exact tags of the outage and keeps every other attribute', () => {
    const script = fakeElement({
      type: 'module',
      crossorigin: '',
      src: 'https://cdn.frontaliereticino.ch/assets/index-entry.js',
      integrity: 'sha384-Ujc37PdNiQQWfz65IQYrAwC7YsNIT5PRTm8PmdAq23GAMWWO5W6U3XLB2Zp7Szaw',
    });
    const preload = fakeElement({
      rel: 'modulepreload',
      href: 'https://cdn.frontaliereticino.ch/assets/App.js',
      crossorigin: 'anonymous',
      integrity: 'sha384-dmOgSvg5WZxGFWN39WrYEycvY5+ahQa2/c0GUAYI3/EnyS7+mhfvA0AD235H0DXv',
    });
    const relative = fakeElement({ rel: 'stylesheet', href: '/assets/critical.css', integrity: 'sha384-x' });

    for (const el of [script, preload, relative]) staleAssetIntegrityHandler.element(el);

    expect(script.attrs).toEqual({
      type: 'module',
      crossorigin: '',
      src: 'https://cdn.frontaliereticino.ch/assets/index-entry.js',
    });
    expect(preload.attrs).toEqual({
      rel: 'modulepreload',
      href: 'https://cdn.frontaliereticino.ch/assets/App.js',
      crossorigin: 'anonymous',
    });
    expect(relative.attrs).toEqual({ rel: 'stylesheet', href: '/assets/critical.css' });
  });

  it('NEGATIVE CASE — third-party integrity is left alone', () => {
    const thirdParty = fakeElement({ src: 'https://example.com/assets/lib.js', integrity: 'sha384-keep' });
    const lookalike = fakeElement({ src: 'https://frontaliereticino.ch.evil.example/assets/x.js', integrity: 'sha384-keep' });
    const notAsset = fakeElement({ src: 'https://cdn.frontaliereticino.ch/data/x.js', integrity: 'sha384-keep' });

    for (const el of [thirdParty, lookalike, notAsset]) staleAssetIntegrityHandler.element(el);

    expect(thirdParty.attrs.integrity).toBe('sha384-keep');
    expect(lookalike.attrs.integrity).toBe('sha384-keep');
    expect(notAsset.attrs.integrity).toBe('sha384-keep');
  });

  it('the URL rule accepts apex, subdomains, protocol-relative and root-relative asset URLs', () => {
    for (const ok of [
      '/assets/index.css',
      '//cdn.frontaliereticino.ch/assets/a.js',
      'https://frontaliereticino.ch/assets/a.js',
      'https://cdn.frontaliereticino.ch/assets/a.js?v=1',
    ]) {
      expect(FIRST_PARTY_ASSET_URL_RE.test(ok), ok).toBe(true);
    }
  });
});

describe('the Worker entrypoint applies the filter', () => {
  it('default.fetch returns the router response through stripStaleAssetIntegrity', async () => {
    (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter = FakeRewriter;
    // The retired 5x1000 calculator is answered by the router itself with an
    // HTML 410 page, no subrequest: the entrypoint can be exercised with no
    // fetch mock, and the marker proves the router's answer went through the
    // filter with its status preserved.
    const res = await router.default.fetch(
      new Request('https://frontaliereticino.ch/calcolatore-5x1000'),
      {},
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(410);
    expect(res.headers.get('x-test-rewritten')).toBe('1');
  });
});
