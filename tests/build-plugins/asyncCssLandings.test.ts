/**
 * Regression gate (issue #1991, follow-up of PR #1984): static SEO landing
 * pages emitted through the shared `buildSeoPageHtml` / `buildSimplePage` shell
 * MUST load their CSS NON-render-blocking — both the Vite entry stylesheet AND
 * the s-* utility sheet `seo-static.css` — while inlining the first-paint
 * `CRITICAL_CSS` block so there is no FOUC.
 *
 * Why this matters: render-blocking CSS delays LCP, a Core Web Vital that
 * feeds Google organic ranking — the site's traffic funnel. PR #1984 added the
 * CDN preconnect but left the sheets blocking; this gate locks the async swap
 * in so the buildSimplePage path cannot silently drift back to a synchronous
 * `<link rel="stylesheet">`.
 *
 * The async pattern is the same one the sibling static emitters already use:
 *   - `<link rel="preload" as="style">`  (start download immediately)
 *   - `<link rel="stylesheet" media="print" onload="this.media='all'">` (swap)
 *   - `<noscript><link rel="stylesheet"></noscript>` (no-JS + crawler fallback)
 *   - a 3s `setTimeout` belt-and-braces flip of any still-`media="print"` link.
 */
import { describe, it, expect } from 'vitest';
import { buildSimplePage, asyncCssHeadBlock, asyncCssLink } from '../../build-plugins/htmlTemplate';
import { CRITICAL_CSS } from '../../build-plugins/shared/criticalCss';
import { SEO_STATIC_CSS_FILENAME } from '../../build-plugins/constants';

const SEO_STATIC_HREF = `/assets/${SEO_STATIC_CSS_FILENAME}`;

describe('asyncCssLink', () => {
  it('emits preload + media=print swap + noscript fallback for a same-origin sheet', () => {
    const out = asyncCssLink('/assets/index-abc123.css');
    expect(out).toContain('<link rel="preload" as="style" crossorigin href="/assets/index-abc123.css"');
    expect(out).toContain('media="print" onload="this.media=\'all\'"');
    expect(out).toContain('<noscript><link rel="stylesheet" crossorigin href="/assets/index-abc123.css"');
    // The only synchronous stylesheet is the <noscript> fallback; outside it,
    // nothing is render-blocking.
    const withoutNoscript = out.replace(/<noscript>.*?<\/noscript>/g, '');
    expect(withoutNoscript).not.toMatch(/<link rel="stylesheet"(?![^>]*media="print")/);
  });

  it('preserves absolute CDN hrefs verbatim', () => {
    const out = asyncCssLink('https://cdn.example.com/assets/index-abc.css');
    expect(out).toContain('href="https://cdn.example.com/assets/index-abc.css"');
  });
});

describe('asyncCssHeadBlock', () => {
  it('inlines CRITICAL_CSS and async-loads both entry CSS and seo-static.css', () => {
    const out = asyncCssHeadBlock('index-deadbeef.css');
    // First-paint critical CSS is inlined (stable paint → no FOUC).
    expect(out).toContain(`<style>${CRITICAL_CSS}</style>`);
    // Entry sheet async.
    expect(out).toContain('href="/assets/index-deadbeef.css" media="print"');
    // seo-static.css async.
    expect(out).toContain(`href="${SEO_STATIC_HREF}" media="print"`);
    // 3s belt-and-braces flip present, covering MULTIPLE links (querySelectorAll).
    expect(out).toContain('querySelectorAll');
    expect(out).toMatch(/setTimeout\(function\(\)\{[^}]*media="print"/);
  });

  it('omits the entry sheet when no SPA bundle is present but still async-loads seo-static.css', () => {
    const out = asyncCssHeadBlock(undefined);
    expect(out).toContain(`<style>${CRITICAL_CSS}</style>`);
    expect(out).toContain(`href="${SEO_STATIC_HREF}" media="print"`);
    expect(out).not.toContain('index-');
  });
});

describe('buildSimplePage · non-render-blocking CSS', () => {
  const baseOpts = {
    locale: 'it',
    title: 'Test landing',
    description: 'Test',
    canonicalUrl: 'https://frontaliereticino.ch/test/',
    bodyHtml: '<main class="seo-static-content"><h1>Test</h1></main>',
    seoContentOutsideRoot: true,
    entryCss: 'index-cafef00d.css',
    entryJs: 'index-cafef00d.js',
  };

  it('inlines critical CSS and never emits a synchronous stylesheet for the entry or seo-static sheets', () => {
    const html = buildSimplePage(baseOpts);
    expect(html).toContain(`<style>${CRITICAL_CSS}</style>`);
    // Both sheets ride the media=print swap.
    expect(html).toContain('href="/assets/index-cafef00d.css" media="print"');
    expect(html).toContain(`href="${SEO_STATIC_HREF}" media="print"`);
    // The only synchronous <link rel="stylesheet"> tags are the <noscript>
    // fallbacks — strip them and assert nothing render-blocking remains.
    const withoutNoscript = html.replace(/<noscript>.*?<\/noscript>/g, '');
    const syncStylesheets = withoutNoscript.match(/<link rel="stylesheet"(?![^>]*media="print")[^>]*>/g) || [];
    expect(syncStylesheets, `unexpected render-blocking stylesheet(s): ${syncStylesheets.join(', ')}`).toHaveLength(0);
  });

  it('keeps the no-JS / crawler fallback so unstyled content never ships', () => {
    const html = buildSimplePage(baseOpts);
    // Two noscript fallbacks (entry + seo-static).
    const noscriptCount = (html.match(/<noscript><link rel="stylesheet"/g) || []).length;
    expect(noscriptCount).toBeGreaterThanOrEqual(2);
  });

  it('preserves the SPA hydration shell (root + footer-root) and static content', () => {
    const html = buildSimplePage(baseOpts);
    expect(html).toMatch(/<div\b[^>]*id="root"/);
    expect(html).toMatch(/<div\b[^>]*id="footer-root"/);
    expect(html).toContain('seo-static-content');
    expect(html).toContain('<h1>Test</h1>');
  });
});
