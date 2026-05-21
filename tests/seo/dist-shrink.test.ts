/**
 * Unit tests for scripts/dist-shrink.mjs — the post-build dist shrinker.
 *
 * Covers:
 *  - MINIFY_OPTS treats <script type="application/ld+json"> as opaque
 *    (vincolo N2 from build-plugins/shared/htmlMinify.ts — Google Rich
 *    Results consumer tolerance for whitespace-collapsed JSON-LD is
 *    unknown so the contract is byte-equality)
 *  - opts produce DOM-equivalent output on a representative SEO page
 *  - opts drop ordinary HTML comments but preserve IE conditionals
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { MINIFY_OPTS } from '../../scripts/dist-shrink.mjs';

const require = createRequire(import.meta.url);
const { minify } = require('html-minifier-terser');

describe('dist-shrink: html-minifier-terser opts', () => {
  it('treats application/ld+json as opaque (preserves whitespace)', async () => {
    const ld = '{\n  "@type": "Article",\n  "name": "x"\n}';
    const input = `<!DOCTYPE html><html><head><script type="application/ld+json">${ld}</script></head><body><p>hi</p></body></html>`;
    const out = await minify(input, MINIFY_OPTS);
    // The exact JSON-LD body, including its whitespace, must survive.
    expect(out).toContain(ld);
  });

  it('preserves visible text', async () => {
    const input =
      '<!DOCTYPE html><html><head><title>T</title></head>' +
      '<body><h1>Frontaliere   Ticino</h1><p>Hello   world</p></body></html>';
    const out = await minify(input, MINIFY_OPTS);
    const stripped = out.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    expect(stripped).toContain('Frontaliere Ticino');
    expect(stripped).toContain('Hello world');
  });

  it('drops HTML comments but preserves IE conditional comments', async () => {
    const input =
      '<!DOCTYPE html><html><head>' +
      '<!-- ordinary -->' +
      '<!--[if IE]><script>x</script><![endif]-->' +
      '</head><body></body></html>';
    const out = await minify(input, MINIFY_OPTS);
    expect(out).not.toContain('ordinary');
    expect(out).toContain('<![endif]');
  });

  it('preserves og:* and the safe twitter:* allow-list', async () => {
    const input =
      '<!DOCTYPE html><html><head>' +
      '<meta property="og:title" content="T">' +
      '<meta property="og:description" content="D">' +
      '<meta property="og:image" content="https://x.com/i.png">' +
      '<meta name="twitter:card" content="summary_large_image">' +
      '<meta name="twitter:site" content="@x">' +
      '<meta name="twitter:creator" content="@y">' +
      '<meta name="twitter:image:alt" content="alt">' +
      '</head><body></body></html>';
    const out = await minify(input, MINIFY_OPTS);
    expect(out).toMatch(/og:title/);
    expect(out).toMatch(/og:description/);
    expect(out).toMatch(/og:image/);
    expect(out).toMatch(/twitter:card/);
    expect(out).toMatch(/twitter:site/);
    expect(out).toMatch(/twitter:creator/);
    expect(out).toMatch(/twitter:image:alt/);
  });
});
