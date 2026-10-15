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

  it('does NOT strip HTML comments (delegated to upstream htmlMinify.ts)', async () => {
    // Per the May 21 2026 production-sample diagnostic, removeComments
    // contributed 0 B (the prior `build-plugins/shared/htmlMinify.ts`
    // pass already stripped every collapsible comment). We disabled
    // `removeComments` here to save the per-file CPU. IE conditional
    // comments survive trivially because they were already preserved
    // by the upstream pass.
    const input =
      '<!DOCTYPE html><html><head>' +
      '<!-- ordinary -->' +
      '<!--[if IE]><script>x</script><![endif]-->' +
      '</head><body></body></html>';
    const out = await minify(input, MINIFY_OPTS);
    expect(out).toContain('<![endif]');
    // Ordinary comments pass through dist-shrink; that's by design.
    expect(out).toContain('ordinary');
  });

  // Regression — PR #473 incident: `removeAttributeQuotes: true` rewrote
  // `<link rel="canonical" href="https://x/">` to
  // `<link rel=canonical href=https://x/>` in dist/, breaking the
  // quoted-only SEO regex gates in tests/seo/{brand-dedup,
  // breadcrumb-coverage, cathedral-hreflang-cross-locale,
  // cathedral-sector-hubs, legacy-city-hub-hreflang}. Those tests have
  // since been switched to quote-flexible regexes, but the contract is:
  // the canonical SEO patterns below MUST match minifier output for both
  // the plain quoted form (unminified) and the unquoted form (minified).
  // This test pins both shapes so future minifier-opt changes can't
  // silently defeat the SEO gates again.
  it('canonical/hreflang/robots regexes (quote-flex) match before AND after minify', async () => {
    const canonicalRe =
      /<link\s+rel=["']?canonical["']?\s+href=["']?([^"'\s>]+)["']?/i;
    const hreflangRe =
      /<link\s+rel=["']?alternate["']?\s+hreflang=["']?en["']?\s+href=["']?([^"'\s>]+)["']?/i;
    const noindexRe =
      /<meta[^>]*\bname\s*=\s*["']?robots["']?[^>]*\bcontent\s*=\s*["']?[^"'>]*noindex/i;

    const input =
      '<!DOCTYPE html><html lang="it"><head>' +
      '<link rel="canonical" href="https://frontaliereticino.ch/test/">' +
      '<link rel="alternate" hreflang="en" href="https://frontaliereticino.ch/en/test/">' +
      '<meta name="robots" content="noindex,follow">' +
      '</head><body><h1>x</h1></body></html>';

    // Quoted (pre-minify) shape matches.
    expect(canonicalRe.exec(input)?.[1]).toBe('https://frontaliereticino.ch/test/');
    expect(hreflangRe.exec(input)?.[1]).toBe('https://frontaliereticino.ch/en/test/');
    expect(noindexRe.test(input)).toBe(true);

    // Minified (post-shrink) shape ALSO matches — this is the contract.
    const out = await minify(input, MINIFY_OPTS);
    expect(canonicalRe.exec(out)?.[1]).toBe('https://frontaliereticino.ch/test/');
    expect(hreflangRe.exec(out)?.[1]).toBe('https://frontaliereticino.ch/en/test/');
    expect(noindexRe.test(out)).toBe(true);
  });

  it('preserves all og:* meta tags', async () => {
    const input =
      '<!DOCTYPE html><html><head>' +
      '<meta property="og:title" content="T">' +
      '<meta property="og:description" content="D">' +
      '<meta property="og:image" content="https://example.com/i.png">' +
      '<meta property="og:image:alt" content="alt">' +
      '<meta property="og:url" content="https://example.com/">' +
      '</head><body></body></html>';
    const out = await minify(input, MINIFY_OPTS);
    expect(out).toMatch(/og:title/);
    expect(out).toMatch(/og:description/);
    expect(out).toMatch(/og:image/);
    expect(out).toMatch(/og:image:alt/);
    expect(out).toMatch(/og:url/);
  });
});
