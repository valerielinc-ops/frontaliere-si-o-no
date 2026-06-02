/**
 * Unit tests for build-plugins/shared/htmlMinify.ts.
 *
 * Coverage: the L2 minifier introduced in #336 + tightened in #343 (the
 * placeholder-comment preserve fix). Validates DOM-equivalence (the
 * relaxed C1 constraint) + opaque handling of safe blocks (vincolo N2).
 */
import { describe, expect, it } from 'vitest';
import { minifyHtml } from '../../build-plugins/shared/htmlMinify';

function stripScripts(s: string): string {
  return s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
}
function visibleText(s: string): string {
  return stripScripts(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('minifyHtml — basic safety', () => {
  it('returns input unchanged when not a string', () => {
    expect(minifyHtml(null as unknown as string)).toBe(null);
    expect(minifyHtml(undefined as unknown as string)).toBe(undefined);
    expect(minifyHtml(42 as unknown as string)).toBe(42);
  });

  it('returns empty string unchanged', () => {
    expect(minifyHtml('')).toBe('');
  });

  it('preserves the text content of every input', () => {
    const inputs = [
      '<div>foo bar</div>',
      '<p>Hello <strong>world</strong>!</p>',
      '<section>\n  <h1>Title</h1>\n  <p>Body text with    multiple spaces inside.</p>\n</section>',
    ];
    for (const i of inputs) {
      expect(visibleText(minifyHtml(i))).toBe(visibleText(i));
    }
  });
});

describe('minifyHtml — whitespace collapsing', () => {
  it('collapses inter-block whitespace', () => {
    const input = '<section>\n  <p>a</p>\n  <p>b</p>\n</section>';
    const out = minifyHtml(input);
    expect(out).toContain('<p>a</p>');
    expect(out).toContain('<p>b</p>');
    expect(out.length).toBeLessThan(input.length);
  });

  it('strips leading whitespace per line', () => {
    const input = ' <meta charset="utf-8">\n <meta name="viewport">';
    const out = minifyHtml(input);
    expect(out).not.toMatch(/\n /);
  });

  it('preserves whitespace inside text content with inline elements', () => {
    // Adjacent `<a>foo</a> bar` is DOM-different from `<a>foo</a>bar`
    const input = '<p><a href="/">link</a> text after</p>';
    const out = minifyHtml(input);
    expect(out).toContain('</a> text');
  });

  it('collapses CRLF line endings to LF', () => {
    const input = '<div>\r\n<p>x</p>\r\n</div>';
    const out = minifyHtml(input);
    expect(out).not.toContain('\r');
  });
});

describe('minifyHtml — comment handling', () => {
  it('strips ordinary HTML comments', () => {
    const input = '<div><!-- a comment with spaces --><p>x</p></div>';
    const out = minifyHtml(input);
    expect(out).not.toContain('a comment with spaces');
    expect(out).toContain('<p>x</p>');
  });

  it('preserves IE conditional comments', () => {
    const input = '<div><!--[if IE]>ie content<![endif]--><p>x</p></div>';
    const out = minifyHtml(input);
    expect(out).toContain('<!--[if IE]>ie content<![endif]-->');
  });

  it('preserves placeholder comments (ALL_CAPS + underscore convention)', () => {
    // <!--SIBLING_LINKS_PLACEHOLDER--> is the canonical example. Pattern:
    // /<!--[A-Z][A-Z0-9_]*-->/ — used as injection anchor by downstream
    // code (weeklyEmployersPlugin.injectSiblingLinks).
    const input =
      '<ul><!--SIBLING_LINKS_PLACEHOLDER--></ul>' +
      '<div><!--KEEP--><p>x</p></div>' +
      '<span><!--FOO_BAR_BAZ--></span>';
    const out = minifyHtml(input);
    expect(out).toContain('<!--SIBLING_LINKS_PLACEHOLDER-->');
    expect(out).toContain('<!--KEEP-->');
    expect(out).toContain('<!--FOO_BAR_BAZ-->');
  });

  it('strips lowercase-named comments while preserving ALL_CAPS placeholders', () => {
    const input = '<div><!-- LOWERCASE not preserved --><!--PRESERVED--></div>';
    const out = minifyHtml(input);
    expect(out).not.toContain('LOWERCASE');
    expect(out).toContain('<!--PRESERVED-->');
  });
});

describe('minifyHtml — safe block opaque handling (vincolo N2)', () => {
  it('preserves <script> body verbatim — including whitespace', () => {
    const scriptBody = "  const x = 'hello';\n  console.log(x);  ";
    const input = `<div><script>${scriptBody}</script></div>`;
    const out = minifyHtml(input);
    expect(out).toContain(scriptBody);
  });

  it('preserves <script type="application/ld+json"> body verbatim (vincolo N2)', () => {
    const jsonLd = '{\n  "@context": "https://schema.org",\n  "@type": "WebPage"\n}';
    const input = `<head><script type="application/ld+json">${jsonLd}</script></head>`;
    const out = minifyHtml(input);
    expect(out).toContain(jsonLd);
  });

  it('preserves <style> body verbatim', () => {
    const css = '\n  .foo { color: red; }\n  .bar { margin:   10px; }\n';
    const input = `<div><style>${css}</style></div>`;
    const out = minifyHtml(input);
    expect(out).toContain(css);
  });

  it('preserves <pre> content', () => {
    const preBody = '  line 1\n    line 2 indented';
    const input = `<div><pre>${preBody}</pre></div>`;
    const out = minifyHtml(input);
    expect(out).toContain(preBody);
  });

  it('preserves <title> exactly (case-sensitive content)', () => {
    const input = '<head><title>Test page · rif. stabio</title></head>';
    const out = minifyHtml(input);
    expect(out).toContain('<title>Test page · rif. stabio</title>');
  });

  it('preserves <textarea> content verbatim', () => {
    const input = '<form><textarea>  user text  </textarea></form>';
    const out = minifyHtml(input);
    expect(out).toContain('<textarea>  user text  </textarea>');
  });
});

describe('minifyHtml — real-world structure', () => {
  it('handles a complete SEO page shell without breaking DOM', () => {
    const input = `<!DOCTYPE html>
<html lang="it">
 <head>
 <meta charset="utf-8">
 <title>Test · rif. stabio</title>
 <!-- generation timestamp -->
 <script type="application/ld+json">{"@type":"WebPage"}</script>
 <link rel="canonical" href="https://example.com/">
 </head>
 <body>
 <div id="root">
 <main>
 <h1>Title</h1>
 <p>Body paragraph with <a href="/">link</a> in it.</p>
 </main>
 </div>
 <!--SIBLING_LINKS_PLACEHOLDER-->
 </body>
</html>`;
    const out = minifyHtml(input);

    // Structural assertions use quote-flexible matchers because the minifier
    // removes quotes from HTML5-safe attribute values.
    expect(out).toContain('<!DOCTYPE html>');
    expect(out).toMatch(/<html\s+lang=["']?it["']?>/);
    expect(out).toContain('<title>Test · rif. stabio</title>');
    expect(out).toMatch(/<script\s+type=["']?application\/ld\+json["']?>\{"@type":"WebPage"}<\/script>/);
    expect(out).toMatch(/<link\s+rel=["']?canonical["']?/);
    expect(out).toContain('<!--SIBLING_LINKS_PLACEHOLDER-->');
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('</a> in it');
    expect(out).not.toContain('generation timestamp');

    // Output is smaller
    expect(out.length).toBeLessThan(input.length);

    // Text content unchanged
    expect(visibleText(input)).toBe(visibleText(out));
  });

  it('idempotent on already-minified output', () => {
    const input = '<div><p>foo</p></div>';
    const once = minifyHtml(input);
    const twice = minifyHtml(once);
    expect(twice).toBe(once);
  });
});

describe('minifyHtml — safe attribute-quote removal', () => {
  it('removes attribute quotes on safe simple values', () => {
    const out = minifyHtml('<div class="hero" id="main"></div>');
    expect(out).toContain('class=hero');
    expect(out).toContain('id=main');
  });

  it('preserves quotes when value has whitespace', () => {
    const out = minifyHtml('<div class="hero big"></div>');
    expect(out).toContain('class="hero big"');
  });

  it('preserves trailing-slash URL quotes (no premature self-close clash)', () => {
    const out = minifyHtml('<link rel="canonical" href="https://example.com/">');
    expect(out).toContain('href="https://example.com/"');
  });

  it('removes URL quotes when the value cannot collide with />', () => {
    const out = minifyHtml('<link rel="stylesheet" href="/assets/index-abc.css">');
    expect(out).toContain('rel=stylesheet');
    expect(out).toContain('href=/assets/index-abc.css');
  });

  it('keeps the last attribute quoted before a self-closing slash (SVG icons)', () => {
    // `<circle r="10"/>` must NOT become `<circle r=10/>` — the unquoted value
    // would absorb the `/` (`r="10/"`) and the SVG renderer throws
    // "Expected length". hubChrome inline icons author attrs as `attr="n"/>`.
    const out = minifyHtml(
      '<svg><circle cx="12" cy="12" r="10"/><line x1="8" y1="2" x2="8" y2="18"/></svg>',
    );
    // The slash-adjacent attribute keeps its quotes…
    expect(out).toContain('r="10"/>');
    expect(out).toContain('y2="18"/>');
    // …no malformed unquoted self-close survives.
    expect(out).not.toMatch(/r=10\/>/);
    expect(out).not.toMatch(/y2=18\/>/);
    // …while earlier (space-separated) attributes still get unquoted.
    expect(out).toContain('cx=12');
    expect(out).toContain('x1=8');
  });

  it('preserves quotes inside JSON-LD body (opaque)', () => {
    const out = minifyHtml(
      '<script type="application/ld+json">{"@type":"Foo","key":"value"}</script>',
    );
    expect(out).toContain('{"@type":"Foo","key":"value"}');
  });

  it('never touches content text that looks like attrs', () => {
    const out = minifyHtml('<p>foo="bar"</p>');
    expect(out).toContain('foo="bar"');
  });

  it('never touches spaced content text that looks like attrs', () => {
    const out = minifyHtml('<p> foo="bar"</p>');
    expect(out).toContain(' foo="bar"');
  });

  it('preserves canonical/hreflang/robots — quote-flex matchers still work', () => {
    const out = minifyHtml(
      '<link rel="canonical" href="https://x.test/page">' +
      '<link rel="alternate" hreflang="en" href="https://x.test/en/page">' +
      '<meta name="robots" content="noindex,follow">',
    );
    expect(out).toMatch(/<link\s+rel=["']?canonical["']?\s+href=["']?https:\/\/x\.test\/page["']?\s*>/);
    expect(out).toMatch(/<link\s+rel=["']?alternate["']?\s+hreflang=["']?en["']?\s+href=["']?https:\/\/x\.test\/en\/page["']?\s*>/);
    expect(out).toMatch(/<meta[^>]*name=["']?robots["']?[^>]*content=["']?[^"'>]*noindex/i);
  });
});
