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
import { AD_SLOT_VIEWPORT_ROOT_MARGIN } from '@/services/adsenseSlots';

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

  it('embeds the IntersectionObserver-based lazy loader (via external /assets/adsense-loader.js)', () => {
    expect(ADSENSE_SNIPPET).toContain(ADSENSE_LAZY_LOADER);
    // ADSENSE_LAZY_LOADER is a tiny <script src="..."> tag pointing to the
    // externalised loader file written by staticScriptsPlugin. The filename is
    // STABLE (no query string, no content hash — vite.config.ts stable-name
    // policy, pinned by tests/stable-asset-names.test.ts): a loader-body change
    // propagates via the serving stack's max-age=600 revalidation instead of a
    // rename, so the ~822k pages embedding this tag never churn on it.
    expect(ADSENSE_LAZY_LOADER).toMatch(
      /<script\s+defer\s+src=["']\/assets\/adsense-loader\.js["']><\/script>/,
    );
    expect(ADSENSE_LOADER_CONTENT).toContain('IntersectionObserver');
    expect(ADSENSE_LOADER_CONTENT).toContain('rootMargin');
    // Funnel-critical symmetry with the SPA AdSenseBanner idle fallback: the
    // static-shell loader must also fall back to requestIdleCallback so Auto
    // Ads fire on no-scroll sessions across the ~200k SEO pages, not only when
    // a slot scrolls into view. Guards the rIC fallback against removal.
    expect(ADSENSE_LOADER_CONTENT).toContain('requestIdleCallback');
    // Pin the *post-IO* scheduling site specifically. The loader has two rIC
    // call sites — `timeout:1500` (IntersectionObserver-unavailable branch) and
    // `timeout:2500` (the no-scroll guard that fires after the observer is set
    // up). A bare `toContain('requestIdleCallback')` would stay green if a
    // refactor dropped only the 2500 site — the exact regression this guards.
    expect(ADSENSE_LOADER_CONTENT).toContain('timeout:2500');
    // First-interaction trigger: the loader must also load adsbygoogle.js on the
    // first real user engagement, not only on slot-scroll or idle. This closes
    // the dominant Auto Ads leak — quick-bounce mobile sessions (75% of traffic)
    // that tap/scroll but leave before the idle fallback fires never served the
    // anchor/vignette overlays (the top RPM earners). Crawlers don't interact,
    // so the no-synchronous-JS audit benefit is preserved. Guards against removal.
    expect(ADSENSE_LOADER_CONTENT).toContain('touchstart');
    expect(ADSENSE_LOADER_CONTENT).toContain('pointerdown');
    expect(ADSENSE_LOADER_CONTENT).toMatch(/addEventListener\(EV\[e\],loadScript/);
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

  it('guards loadScript() against duplicate injection via DOM check (AdSenseBanner idle-race fix)', () => {
    // On soft-landing pages, both adsense-loader.js and AdSenseBanner.tsx can fire
    // their rIC idle fallbacks. AdSenseBanner uses timeout:1500 (registered at
    // component mount, ~100ms after page load), while the static loader uses
    // timeout:2500 (registered at observe() time, before SPA hydration). In the
    // race window (~1700–2500ms from page load) AdSenseBanner may create the
    // <script> element first; without this DOM check the static loader would then
    // create a second one (its closure `loaded` flag is still false). The guard
    // mirrors the existing check in AdSenseBanner.tsx:loadAdSenseScript().
    expect(ADSENSE_LOADER_CONTENT).toContain(
      'script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]',
    );
  });

  it('gates the loader on the reader no-ads entitlement flag BEFORE any load path (#3655)', () => {
    // Static-shell counterpart to AdSenseBanner's hasActiveReaderNoAdsEntitlement()
    // check (services/readerEntitlement.ts). A signed-in reader with an active
    // CHF 2.99/month subscription must never have adsbygoogle.js loaded from the
    // static SEO shell either — this is a per-visitor client-state check, NEVER
    // a global/per-route toggle (AGENTS.md Non-Negotiable #7). Guards the exact
    // flag name so it can never silently drift from readerEntitlement.ts's
    // READER_NOADS_ACTIVE_KEY constant.
    expect(ADSENSE_LOADER_CONTENT).toContain("reader_noads_active");
    expect(ADSENSE_LOADER_CONTENT).toMatch(
      /localStorage\.getItem\(['"]reader_noads_active['"]\)\s*===\s*['"]true['"]/,
    );
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

  it('omits gtag but keeps the AdSense loader on SPA-backed pages without raw ad slots', () => {
    // ADSENSE_SNIPPET must always ship (hydration-independent AdSense
    // fallback for pages like companyHubBridgePlugin/locationHubBridgePlugin
    // whose bodyHtml has no raw <ins> slot and relies on AdSenseBanner, which
    // only renders post-hydration). Only GTAG is skipped here since
    // client-side analytics takes over once the SPA mounts.
    const html = buildSimplePage({
      ...basePage,
      bodyHtml: '<h1>Test</h1><p>Content</p>',
    });
    expect(html).toContain(ADSENSE_LAZY_LOADER);
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
    // The margin is no longer a literal here. It governs the SPA banner AND the
    // static-shell loader — two implementations of one policy — so it lives in
    // services/adsenseSlots.ts where neither can drift from the other (AGENTS.md
    // Non-Negotiable #6). Pin both ends: the component must read the shared
    // constant, and the constant must still be the 200px this test was written
    // for. What the observer now gates is asserted behaviourally in
    // tests/adsense-viewability-deferral.test.tsx.
    expect(adSenseBanner).toMatch(/rootMargin:\s*AD_SLOT_VIEWPORT_ROOT_MARGIN/);
    expect(AD_SLOT_VIEWPORT_ROOT_MARGIN).toBe('200px 0px');
  });

  it('still contains the singleton loadAdSenseScript helper', () => {
    expect(adSenseBanner).toContain('loadAdSenseScript');
  });

  it('idle-loads the script for Auto Ads even when no slot scrolls into view', () => {
    // Funnel-critical: on SPA routes whose static shell omits the external
    // adsense-loader (e.g. the homepage), a no-scroll mobile bounce must still
    // load adsbygoogle.js so anchor + in-page Auto Ads fire. Guard the idle
    // fallback (rIC with setTimeout fallback) and its cleanup against removal.
    // Pin the *idle-load* call sites specifically, not the bare symbols.
    // `setTimeout` appears at 4 sites in AdSenseBanner.tsx (fill timeout, idle
    // fallback, collapse defer, width poll) and `requestIdleCallback` could be
    // referenced elsewhere — a bare `toContain` would stay green if a refactor
    // dropped *only* the idle fallback that loads adsbygoogle.js on no-scroll
    // sessions. Match the exact `() => loadAdSenseScript()` scheduling sites so
    // removing the Auto Ads idle load (rIC branch OR its setTimeout fallback)
    // fails the test.
    expect(adSenseBanner).toMatch(
      /requestIdleCallback[\s\S]*?\(\s*\(\)\s*=>\s*loadAdSenseScript\(\),\s*\{\s*timeout:\s*1500\s*\}\s*\)/,
    );
    expect(adSenseBanner).toMatch(
      /setTimeout\(\s*\(\)\s*=>\s*loadAdSenseScript\(\),\s*1500\s*\)/,
    );
    // Cleanup must cancel both the idle handle and its setTimeout fallback so a
    // route change before the idle fires doesn't leak a load.
    expect(adSenseBanner).toContain('cancelIdleCallback');
    expect(adSenseBanner).toContain('clearTimeout');
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
