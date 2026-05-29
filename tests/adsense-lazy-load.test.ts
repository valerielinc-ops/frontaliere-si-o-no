/**
 * Lazy-load AdSense — regression tests for the Semrush "uncompressed JS"
 * fix (2026-04-23). Ensures adsbygoogle.js is NEVER eagerly loaded from
 * either index.html or the ADSENSE_SNIPPET used by static build plugins,
 * and that an IntersectionObserver-based loader is present instead.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ADSENSE_CLIENT_ID,
  ADSENSE_LAZY_LOADER,
  ADSENSE_LOADER_CONTENT,
  ADSENSE_SCRIPT_SRC,
  ADSENSE_SNIPPET,
} from '@/build-plugins/constants';
import { buildSimplePage } from '@/build-plugins/htmlTemplate';

const repoRoot = resolve(__dirname, '..');
const indexHtml = readFileSync(resolve(repoRoot, 'index.html'), 'utf8');
const adSenseBanner = readFileSync(
  resolve(repoRoot, 'components/shared/AdSenseBanner.tsx'),
  'utf8',
);

describe('AdSense lazy loading — index.html', () => {
  it('does NOT include an eager <script src=".../adsbygoogle.js"> tag in <head>', () => {
    // The whole point: Semrush crawlers must not encounter the script on every
    // static HTML fetch. A static <script src="...adsbygoogle.js"> is banned.
    expect(indexHtml).not.toMatch(
      /<script[^>]+src=["'][^"']*pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/i,
    );
  });

  it('keeps the google-adsense-account verification meta tag', () => {
    expect(indexHtml).toMatch(
      /<meta\s+name=["']google-adsense-account["']\s+content=["']ca-pub-8628054934855353["']/,
    );
  });

  it('includes a preconnect hint to pagead2.googlesyndication.com', () => {
    expect(indexHtml).toMatch(
      /<link\s+rel=["']preconnect["']\s+href=["']https:\/\/pagead2\.googlesyndication\.com["']/,
    );
  });
});

describe('AdSense lazy loading — ADSENSE_SNIPPET (static pages)', () => {
  it('does NOT emit an eager <script src=".../adsbygoogle.js"> tag', () => {
    // Matches any <script ...src="...adsbygoogle.js..."></script> — but not
    // our inline loader which builds the src at runtime via string concat.
    expect(ADSENSE_SNIPPET).not.toMatch(
      /<script[^>]+src=["'][^"']*pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/i,
    );
  });

  it('embeds the IntersectionObserver-based lazy loader (via external /assets/adsense-loader-{hash}.js)', () => {
    expect(ADSENSE_SNIPPET).toContain(ADSENSE_LAZY_LOADER);
    // ADSENSE_LAZY_LOADER is now a tiny <script src="..."> tag pointing to the
    // externalised loader file written by staticScriptsPlugin. The cachebuster
    // moved from `?v=BUILD_ID` (query string) into the filename itself —
    // `adsense-loader-{8charHash}.js` — so the per-page tag drops the query
    // string entirely while still invalidating browser caches whenever the
    // loader body changes.
    expect(ADSENSE_LAZY_LOADER).toMatch(
      /<script\s+defer\s+src=["']\/assets\/adsense-loader-[A-Za-z0-9_-]{8}\.js["']><\/script>/,
    );
    expect(ADSENSE_LOADER_CONTENT).toContain('IntersectionObserver');
    expect(ADSENSE_LOADER_CONTENT).toContain('rootMargin');
    // Funnel-critical symmetry with the SPA AdSenseBanner idle fallback: the
    // static-shell loader must also fall back to requestIdleCallback so Auto
    // Ads fire on no-scroll sessions across the ~200k SEO pages, not only when
    // a slot scrolls into view. Guards the rIC fallback against removal.
    expect(ADSENSE_LOADER_CONTENT).toContain('requestIdleCallback');
    // Pin the *post-IO* scheduling site specifically. The loader has two rIC
    // call sites — `timeout:4000` (IntersectionObserver-unavailable branch) and
    // `timeout:6000` (the no-scroll guard that fires after the observer is set
    // up). A bare `toContain('requestIdleCallback')` would stay green if a
    // refactor dropped only the 6000 site — the exact regression this guards.
    expect(ADSENSE_LOADER_CONTENT).toContain('timeout:6000');
  });

  it('exposes the correct client id + script URL', () => {
    expect(ADSENSE_CLIENT_ID).toBe('ca-pub-8628054934855353');
    expect(ADSENSE_SCRIPT_SRC).toBe(
      `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT_ID}`,
    );
  });

  it('includes preconnect + dns-prefetch for pagead2', () => {
    expect(ADSENSE_SNIPPET).toMatch(
      /<link\s+rel=["']preconnect["']\s+href=["']https:\/\/pagead2\.googlesyndication\.com["']\s+crossorigin/,
    );
    expect(ADSENSE_SNIPPET).toMatch(
      /<link\s+rel=["']dns-prefetch["']\s+href=["']https:\/\/pagead2\.googlesyndication\.com["']/,
    );
  });

  it('pushes queued slots after script onload (not synchronously on DOMContentLoaded)', () => {
    // Regression: ensure we call push({}) only after the dynamically-injected
    // script fires its onload event, not before it exists. Assertions moved to
    // ADSENSE_LOADER_CONTENT (the actual JS body) after the external-script
    // refactor.
    expect(ADSENSE_LOADER_CONTENT).toContain('s.onload');
    expect(ADSENSE_LOADER_CONTENT).toContain('adsbygoogle');
  });
});

describe('AdSense lazy loading — static SEO shell', () => {
  const basePage = {
    locale: 'it',
    title: 'Test page',
    description: 'Test description',
    canonicalUrl: 'https://frontaliereticino.ch/test/',
    entryJs: 'index-test.js',
    entryCss: 'index-test.css',
  };

  it('omits static analytics snippets on SPA-backed pages without raw ad slots', () => {
    const html = buildSimplePage({
      ...basePage,
      bodyHtml: '<h1>Test</h1><p>Content</p>',
    });
    expect(html).not.toContain(ADSENSE_LAZY_LOADER);
    expect(html).not.toContain('googletagmanager.com/gtag/js');
  });

  it('keeps the AdSense loader when SPA-backed static HTML contains raw ad slots', () => {
    const html = buildSimplePage({
      ...basePage,
      bodyHtml: '<ins class="adsbygoogle" data-ad-client="ca-pub-8628054934855353"></ins>',
    });
    expect(html).toContain(ADSENSE_LAZY_LOADER);
  });
});

describe('AdSense lazy loading — SPA AdSenseBanner component', () => {
  it('uses IntersectionObserver to defer script load', () => {
    expect(adSenseBanner).toContain('IntersectionObserver');
    expect(adSenseBanner).toMatch(/rootMargin:\s*['"]200px 0px['"]/);
  });

  it('still contains the singleton loadAdSenseScript helper', () => {
    expect(adSenseBanner).toContain('loadAdSenseScript');
  });

  it('idle-loads the script for Auto Ads even when no slot scrolls into view', () => {
    // Funnel-critical: on SPA routes whose static shell omits the external
    // adsense-loader (e.g. the homepage), a no-scroll mobile bounce must still
    // load adsbygoogle.js so anchor + in-page Auto Ads fire. Guard the idle
    // fallback (rIC with setTimeout fallback) and its cleanup against removal.
    expect(adSenseBanner).toContain('requestIdleCallback');
    expect(adSenseBanner).toContain('cancelIdleCallback');
    // setTimeout fallback for browsers without requestIdleCallback support.
    expect(adSenseBanner).toContain('setTimeout');
    // Bot-gated so the idle load never inflates AD_REQUESTS.
    expect(adSenseBanner).toMatch(/if\s*\(\s*!SKIP_FOR_BOT\s*\)/);
  });

  it('defers unfilled-slot collapse while the reserved box is visible', () => {
    expect(adSenseBanner).toContain('collapseWhenLayoutSafe');
    expect(adSenseBanner).toContain('isElementInViewport');
    expect(adSenseBanner).toContain('deferring collapse until offscreen');
    expect(adSenseBanner).not.toContain("currentStatus === 'unfilled') {\n console.info(`[AdSense] unfilled slot=${adSlot}, collapsing banner`)");
  });
});
