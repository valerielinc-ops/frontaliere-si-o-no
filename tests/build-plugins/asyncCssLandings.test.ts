/**
 * Regression gate (issue #1991, follow-up of PR #1984; updated 2026-07 for
 * the critical-CSS externalization): static SEO landing pages emitted
 * through the shared `buildSeoPageHtml` / `buildSimplePage` shell MUST load
 * the Vite entry stylesheet AND the s-* utility sheet `seo-static.css`
 * NON-render-blocking, while the first-paint critical CSS is loaded via a
 * render-BLOCKING `<link>` to `/assets/critical.css` ({@link CRITICAL_CSS_LINK})
 * so there is no FOUC. critical.css used to be an inline `<style>` block;
 * it is now an external, same-origin, browser-cached file (written by
 * `staticScriptsPlugin.ts`) — the ONLY synchronous stylesheet this path may
 * emit.
 *
 * Why this matters: render-blocking CSS delays LCP, a Core Web Vital that
 * feeds Google organic ranking — the site's traffic funnel. PR #1984 added the
 * CDN preconnect but left the sheets blocking; this gate locks the async swap
 * in so the buildSimplePage path cannot silently drift back to a synchronous
 * `<link rel="stylesheet">` for the entry/seo-static sheets.
 *
 * The async pattern is the same one the sibling static emitters already use:
 *   - `<link rel="preload" as="style">`  (start download immediately)
 *   - `<link rel="stylesheet" media="print" onload="this.media='all'">` (swap)
 *   - `<noscript><link rel="stylesheet"></noscript>` (no-JS + crawler fallback)
 *   - a 3s `setTimeout` belt-and-braces flip of any still-`media="print"` link.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildSimplePage, asyncCssHeadBlock, asyncCssLink, ASYNC_CSS_FALLBACK_SCRIPT } from '../../build-plugins/htmlTemplate';
import { CRITICAL_CSS_LINK } from '../../build-plugins/shared/criticalCss';
import { SEO_STATIC_CSS_FILENAME } from '../../build-plugins/constants';

const SEO_STATIC_HREF = `/assets/${SEO_STATIC_CSS_FILENAME}`;
const BUILD_PLUGINS_DIR = join(__dirname, '../../build-plugins');

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
  it('loads critical.css via a blocking link and async-loads both entry CSS and seo-static.css', () => {
    const out = asyncCssHeadBlock('index-deadbeef.css');
    // First-paint critical CSS is a blocking <link> (stable paint → no FOUC).
    expect(out).toContain(CRITICAL_CSS_LINK);
    // Entry sheet async.
    expect(out).toContain('href="/assets/index-deadbeef.css" media="print"');
    // seo-static.css async.
    expect(out).toContain(`href="${SEO_STATIC_HREF}" media="print"`);
    // 3s belt-and-braces flip present, covering MULTIPLE links (querySelectorAll).
    expect(out).toContain('querySelectorAll');
    expect(out).toMatch(/setTimeout\(function\(\)\{[^}]*media="print"/);
    // Fallback telemetry: queues _cssFallbackInfo for Analytics.trackCssFallback
    // (parity with the sibling fallbacks — keeps the revert-trigger observable).
    expect(out).toContain("sessionStorage.setItem('_cssFallbackInfo'");
    // issue #4304 triage: visibilityState captured at fire time so a
    // background-tab-throttling root cause can be confirmed/ruled out.
    expect(out).toContain('visibilityState:document.visibilityState');
  });

  it('omits the entry sheet when no SPA bundle is present but still async-loads seo-static.css', () => {
    const out = asyncCssHeadBlock(undefined);
    expect(out).toContain(CRITICAL_CSS_LINK);
    expect(out).toContain(`href="${SEO_STATIC_HREF}" media="print"`);
    expect(out).not.toContain('index-');
  });
});

/**
 * Regression gate (issue #4304): `ogPagesPlugin.ts` and `staticPagesPlugin.ts`
 * used to hand-copy the ASYNC_CSS_FALLBACK_SCRIPT literal instead of
 * importing the shared constant — a sibling-pattern drift risk flagged by
 * AGENTS.md §6 (the two copies had already gone stale relative to each other
 * before this fix). Both now import `ASYNC_CSS_FALLBACK_SCRIPT` from
 * `htmlTemplate.ts`; this locks that in so a future edit to the fallback
 * script can't silently reintroduce a second, un-synced copy.
 */
describe('ASYNC_CSS_FALLBACK_SCRIPT · no literal duplication in sibling emitters', () => {
  const siblingFiles = ['ogPagesPlugin.ts', 'staticPagesPlugin.ts'];

  it.each(siblingFiles)('%s imports the shared constant instead of inlining the setTimeout script', (file) => {
    const source = readFileSync(join(BUILD_PLUGINS_DIR, file), 'utf-8');
    expect(source).toMatch(/import\s*\{[^}]*\bASYNC_CSS_FALLBACK_SCRIPT\b[^}]*\}\s*from\s*['"]\.\/htmlTemplate['"]/);
    // The raw setTimeout literal must not appear verbatim — only the
    // `${ASYNC_CSS_FALLBACK_SCRIPT}` interpolation is allowed.
    expect(source).not.toContain("setTimeout(function(){var ls=document.querySelectorAll('link[media=\"print\"]");
  });

  it('the shared constant is the single source of truth for the fallback payload shape', () => {
    expect(ASYNC_CSS_FALLBACK_SCRIPT).toContain('_cssFallbackInfo');
    expect(ASYNC_CSS_FALLBACK_SCRIPT).toContain('visibilityState:document.visibilityState');
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

  it('loads critical.css via a blocking link and never emits another synchronous stylesheet for the entry or seo-static sheets', () => {
    const html = buildSimplePage(baseOpts);
    expect(html).toContain(CRITICAL_CSS_LINK);
    // Both sheets ride the media=print swap.
    expect(html).toContain('href="/assets/index-cafef00d.css" media="print"');
    expect(html).toContain(`href="${SEO_STATIC_HREF}" media="print"`);
    // The only synchronous <link rel="stylesheet"> tags are critical.css and the
    // <noscript> fallbacks — strip the noscript blocks and critical.css itself,
    // then assert nothing else render-blocking remains.
    const withoutNoscript = html.replace(/<noscript>.*?<\/noscript>/g, '');
    const withoutCriticalCss = withoutNoscript.replace(CRITICAL_CSS_LINK, '');
    const syncStylesheets = withoutCriticalCss.match(/<link rel="stylesheet"(?![^>]*media="print")[^>]*>/g) || [];
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
