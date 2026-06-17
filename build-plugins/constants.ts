/**
 * Shared constants for Vite build plugins.
 *
 * BUILD_ID: per-build timestamp. Emitted to dist/build-id.txt by buildIdPlugin
 * and read at runtime (staleness checks). NOT injected as a Vite `define` —
 * baking it into the bundle changed the entry hash every build → ~100% page
 * churn (see vite.config define removal).
 * COMMIT_HASH / SHORT_COMMIT_HASH: build commit. Emitted to dist/commit-hash.txt
 * and read at runtime (version badge fetches it). Also NOT a `define`, same reason.
 * BASE_URL: canonical site origin used across all static-page generators.
 */

import { execSync } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BOT_UA_PATTERNS } from '../services/botPatterns';
import { adSlotHtml } from './lib/adSlotHtml';
import { REDIRECT_STUB_MARKER } from './shared/redirectStubMarker';
import { clampMetaDescription } from './shared/titleSuffix';

export const BUILD_ID = String(Date.now());

/**
 * Fail-fast guard for the externalised stylesheets that live in
 * `public/assets/` (Vite copies the public/ tree to dist/ at the start of
 * the build, so the file lands in dist/assets/ under the same name). The
 * read at module-load time keeps the historical invariant that a missing
 * source file fails the build immediately instead of shipping ~822k pages
 * whose `<link>` 404s.
 *
 * The filenames are STABLE (no content hash) like every other bundler
 * asset — see vite.config.ts `chunkFileNames`/`assetFileNames` for the full
 * rationale (the serving stack revalidates at max-age=600, so a content
 * change propagates without a rename, while a rename re-churned ~822k
 * prerendered pages and 404'd from HTML cached under the old name). This
 * invariant is pinned by `tests/stable-asset-names.test.ts`.
 */
function assertPublicAssetExists(relPath: string): void {
  // Walk up from `build-plugins/constants.ts` to the repo root.
  // process.cwd() is unreliable (depends on how Vite was invoked); the
  // file's own location is the stable anchor.
  // __dirname is not available in ESM — resolve via import.meta.url.
  const here = path.dirname(new URL(import.meta.url).pathname);
  let dir = here;
  while (dir !== '/' && !fs.existsSync(path.join(dir, 'package.json'))) {
    dir = path.dirname(dir);
  }
  fs.readFileSync(path.join(dir, 'public', 'assets', relPath), 'utf-8');
}

assertPublicAssetExists('seo-static.css');
assertPublicAssetExists('bridge.css');

export const SEO_STATIC_CSS_FILENAME = 'seo-static.css';
export const SEO_STATIC_CSS_LINK = `<link rel="stylesheet" href="/assets/${SEO_STATIC_CSS_FILENAME}">`;
export const BRIDGE_CSS_FILENAME = 'bridge.css';
export const BRIDGE_CSS_LINK = `<link rel="stylesheet" href="/assets/${BRIDGE_CSS_FILENAME}">`;

/**
 * Cross-origin preconnect to the asset CDN (the frontaliere-cdn Pages site).
 *
 * On deploy builds every render-blocking resource on static + locale-shard
 * pages — index.css, seo-static.css, the SPA bundle, early-boot.js,
 * gtag-init.js — is rebased to `${ASSET_CDN}` (cdn.frontaliereticino.ch) by
 * vite.config.ts `renderBuiltUrl`. Without an early hint the browser only
 * opens that cross-origin socket when it reaches the stylesheet `<link>` ~8.6
 * KB into the `<head>` (after the JSON-LD blocks), paying a full DNS+TCP+TLS
 * round-trip (~50-300 ms) BEFORE the blocking CSS can even start downloading —
 * and static pages carry NO `modulepreload` to the CDN to warm it first.
 * Emitting one `<link rel="preconnect">` as an early head hint overlaps that
 * handshake with head parsing → shaves the round-trip off first paint on every
 * page in every locale.
 *
 * `crossorigin` makes it an anonymous (uncredentialed) connection — the same
 * mode the CDN stylesheet/script/font fetches use — so the warmed socket is
 * reused for all of them (HTTP/2 coalesces the no-cors seo-static.css onto the
 * same uncredentialed connection). A single hint therefore covers every CDN
 * fetch; no `dns-prefetch` fallback is emitted (preconnect already resolves
 * DNS, and the ~57 extra bytes ride on ~822k pages).
 *
 * Built from process.env.ASSET_CDN (deploy builds only — the same env that
 * drives renderBuiltUrl). Empty string on dev / non-CDN builds, where assets
 * stay same-origin and no preconnect is needed. constants.ts is build-only
 * (it already imports child_process/node:fs), so reading process.env here is
 * safe — no client bundle pulls it in.
 */
const ASSET_CDN_ORIGIN = ((): string => {
  const raw = (process.env.ASSET_CDN || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
})();
export const CDN_PRECONNECT_HINT = ASSET_CDN_ORIGIN
  ? `<link rel="preconnect" href="${ASSET_CDN_ORIGIN}" crossorigin>`
  : '';

/**
 * Generate a lightweight canonical bridge page for alias URLs.
 * These pages avoid GitHub Pages redirect quirks while keeping the canonical target explicit
 * without shipping a hard noindex/meta-refresh combination that can accumulate in Search Console.
 */
/**
 * Inline <script> added to every static bridge/archive page.
 * If the URL carries SPA-relevant query params (newsletter confirmation,
 * auth tokens, unsubscribe, etc.), save the full URL in sessionStorage and
 * redirect to / so the React app can process the action.
 *
 * IMPORTANT: tracking + autologin params (`ne`, `ac`) are intentionally NOT
 * in the trigger set. They appear on EVERY newsletter content link (article,
 * job detail, company hub) and are processed in-place by `App.tsx` after
 * hydration — App.tsx exchanges `ac` for a fresh auth token and strips both
 * params from the URL via `history.replaceState`. Triggering a redirect on
 * `ne`/`ac` destroys the static document the user just landed on (and any
 * window-seeded data like `__EXPIRED_JOB_DATA__` / `__BRIDGE_TARGET_SLUG__`)
 * because `location.replace('/')` loads a fresh `index.html` that no longer
 * has those globals — soft-landing pages then fall back to the generic
 * "annuncio non trovato" view instead of the rich expired-job content.
 */
/**
 * Plain JS body (no <script> wrapper) — written to dist/assets/spa-action-redirect.js
 * by staticScriptsPlugin and referenced via <script src="..."> from SPA_ACTION_REDIRECT_SCRIPT.
 * Externalising this snippet saves ~150 B/page across ~200k SEO pages (~30 MB dist).
 */
export const SPA_ACTION_REDIRECT_SCRIPT_CONTENT = `(function(){var p=new URLSearchParams(location.search);if(p.get('action')||p.get('at')||p.get('authToken')||p.get('newsletter_autologin')){sessionStorage.redirect=location.href;location.replace('/');}})();`;

/**
 * Plain JS body for the dark-mode init — written to dist/assets/dark-mode-init.js
 * by staticScriptsPlugin. Adds 'dark' class to <html> before first paint to avoid
 * FOUC on dark-mode pages. Used by soft-landing + staticPagesPlugin templates.
 * Externalising drops ~140 B/page across the ~100k pages that emit it (~14 MB dist).
 *
 * Loaded synchronously (no defer/async) — must run before paint so dark-mode
 * styles in seo-static.css apply on first render.
 */
export const DARK_MODE_INIT_CONTENT = `(function(){if(localStorage.theme==='dark'||((!('theme' in localStorage))&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}})();`;

/**
 * Combined early-boot script — concatenates dark-mode-init (which MUST run
 * before paint to apply the `dark` class) and spa-action-redirect (which is
 * cheap to run synchronously). Replaces TWO separate `<script src>` tags
 * per static page (~140 B each) with ONE tag pointing at
 * `/assets/early-boot.js`. Across ~822k SEO static pages this drops
 * ~80 B/page = ~65 MB dist.
 *
 * Order of concatenation matters: dark-mode FIRST (must paint with the
 * correct theme), then spa-action-redirect (sets sessionStorage and may
 * `location.replace('/')` away — running it after dark-mode keeps the
 * theme decision committed for the next page).
 */
export const EARLY_BOOT_CONTENT = `${DARK_MODE_INIT_CONTENT}${SPA_ACTION_REDIRECT_SCRIPT_CONTENT}`;
export const EARLY_BOOT_FILENAME = 'early-boot.js';
export const EARLY_BOOT_SCRIPT = `<script src="/assets/${EARLY_BOOT_FILENAME}"></script>`;

/**
 * Range-selector wiring for the fuel history chart, shared by every page under
 * /prezzi-benzina/ + /prezzi-diesel/ (4 locales × 2 fuels). Previously a ~600 B
 * inline IIFE repeated on every chart page; externalising it to one cached
 * `/assets/fuel-chart.js` strips that per-page weight across the whole fuel
 * corpus and lets the browser cache it once.
 *
 * Self-wires ALL `[data-fuel-history-chart]` blocks on the page (no
 * `currentScript.previousElementSibling` dependency), guarded by a global flag
 * so a duplicate tag (a page with >1 chart) is a no-op. Button visuals follow
 * the `aria-pressed` attribute via seo-static.css; content/stats visibility is
 * toggled with the `.s-on` class.
 */
export const FUEL_CHART_SCRIPT_CONTENT = `(function(){if(window.__fuelChartWired)return;window.__fuelChartWired=1;function wire(root){var btns=root.querySelectorAll('[data-range-btn]');var contents=root.querySelectorAll('[data-range-content]');var statsEls=root.querySelectorAll('[data-range-stats]');function setActive(r){btns.forEach(function(b){b.setAttribute('aria-pressed',b.getAttribute('data-range-btn')===r?'true':'false');});contents.forEach(function(c){c.classList.toggle('s-on',c.getAttribute('data-range-content')===r);});statsEls.forEach(function(s){s.classList.toggle('s-on',s.getAttribute('data-range-stats')===r);});}btns.forEach(function(b){b.addEventListener('click',function(){setActive(b.getAttribute('data-range-btn'));});});}document.querySelectorAll('[data-fuel-history-chart]').forEach(wire);})();`;
export const FUEL_CHART_SCRIPT_FILENAME = 'fuel-chart.js';
export const FUEL_CHART_SCRIPT_TAG = `<script src="/assets/${FUEL_CHART_SCRIPT_FILENAME}" defer></script>`;

/**
 * Back-compat shims for callers that still reference the legacy split-script
 * constants by name (e.g., constants.ts itself in the canonical-bridge / flat
 * redirect helpers). These now point at the merged EARLY_BOOT_SCRIPT — the
 * spa-action-redirect behaviour is included, dark-mode is harmless on bridge
 * pages, and the browser-cached early-boot.js is shared across all surfaces.
 */
export const SPA_ACTION_REDIRECT_SCRIPT = EARLY_BOOT_SCRIPT;
export const DARK_MODE_SCRIPT = EARLY_BOOT_SCRIPT;

export function buildCanonicalBridgePage(options: {
 canonicalUrl: string;
 pathLabel: string;
 title?: string;
 description?: string;
 body?: string;
 ctaLabel?: string;
 lang?: string;
 noindex?: boolean;
 hreflangEntries?: Array<{ hreflang: string; href: string }>;
}): string {
 const {
 canonicalUrl,
 pathLabel,
 title = 'Pagina aggiornata | Frontaliere Ticino',
 description = 'Questa URL ha una versione canonica aggiornata su Frontaliere Ticino.',
 body = 'Questa URL ha una versione aggiornata. Apri la pagina canonica per consultare il contenuto corretto.',
 ctaLabel = 'Apri la pagina corretta',
 lang = 'it',
 noindex = false,
 hreflangEntries,
 } = options;

 const robotsContent = noindex ? 'noindex,follow' : 'index,follow';
 const hreflangHtml = hreflangEntries && hreflangEntries.length > 0
 ? '\n' + hreflangEntries.map(e => ` <link rel="alternate" hreflang="${e.hreflang}" href="${e.href}">`).join('\n')
 : '';

 return `<!DOCTYPE html>
<html lang="${lang}">
 <head>${REDIRECT_STUB_MARKER}
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width, initial-scale=1">
 <title>${title}</title>
 <meta name="description" content="${clampMetaDescription(description)}">
 <meta name="robots" content="${robotsContent}">
 <link rel="canonical" href="${canonicalUrl}">${hreflangHtml}
 ${ANALYTICS_SNIPPET}
 ${SPA_ACTION_REDIRECT_SCRIPT}
 ${BRIDGE_CSS_LINK}
 </head>
 <body>
 <main class="card">
 <div class="logo">
 <img src="/assets/logo.svg" width="28" height="28" alt="" loading="eager" decoding="async">
 <span>Frontaliere Ticino</span>
 </div>
 <h1>${title}</h1>
 <p>${body}</p>
 <a href="${pathLabel}" class="btn">${ctaLabel}</a>
 </main>
 <div class="footer">&copy; 2026 Frontaliere Ticino</div>
 </body>
</html>`;
}

export interface FlatRedirectOgMeta {
 title: string;
 description: string;
 image: string;
 lang?: string;
}

export function buildFlatRedirect(
 canonicalUrl: string,
 trailingSlashPath: string,
 og?: FlatRedirectOgMeta,
): string {
 const esc = (s: string) =>
 s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
 const lang = og?.lang ?? 'it';
 const title = og ? `${esc(og.title)} | Frontaliere Ticino` : 'Versione canonica disponibile | Frontaliere Ticino';
 // Clamp before escaping: truncating after esc() could amputate an HTML entity
 // (e.g. "&am…"). The SERP budget applies to both the <meta description> and the
 // og:description below. This bridge is always noindex, but clamping keeps the
 // emit path consistent with every other generator (the deferred #2230 sibling).
 const desc = og ? esc(clampMetaDescription(og.description)) : 'Apri la versione canonica aggiornata di questa pagina su Frontaliere Ticino.';
 const ogTags = og
 ? `
 <meta property="og:type" content="article">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:title" content="${esc(og.title)}">
 <meta property="og:description" content="${desc}">
 <meta property="og:image" content="${esc(og.image)}">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="fb:app_id" content="891036063797338">`
 : '';
 return `<!DOCTYPE html>
<html lang="${lang}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width, initial-scale=1">
 <title>${title}</title>
 <meta name="description" content="${desc}">
 <meta name="robots" content="noindex,follow">
 <link rel="canonical" href="${canonicalUrl}">${ogTags}
 ${ANALYTICS_SNIPPET}
 ${BRIDGE_CSS_LINK}
 </head>
 <body>
 <main class="card">
 <div class="logo">
 <img src="/assets/logo.svg" width="28" height="28" alt="" loading="eager" decoding="async">
 <span>Frontaliere Ticino</span>
 </div>
 <h1>Versione canonica disponibile</h1>
 <p>Questa e una versione alias dell URL. Per contenuto e metadata aggiornati usa la versione canonica con slash finale.</p>
 <a href="${trailingSlashPath}" class="btn">Apri la versione canonica</a>
 </main>
 <div class="footer">&copy; 2026 Frontaliere Ticino</div>
 </body>
</html>`;
}

let _commitHash = 'unknown';
try {
 _commitHash = execSync('git rev-parse HEAD').toString().trim();
} catch { /* CI or shallow clone — safe to ignore */ }

export const COMMIT_HASH = _commitHash;
export const SHORT_COMMIT_HASH = COMMIT_HASH.slice(0, 8);

export const BASE_URL = 'https://frontaliereticino.ch';

/**
 * GA4 measurement ID — same as Firebase Analytics measurementId.
 * Used in the lightweight gtag.js snippet injected into static HTML pages
 * so that page views are tracked even for users who bounce before React hydrates.
 */
export const GA4_MEASUREMENT_ID = 'G-LGJ9LE360F';

/**
 * Lightweight gtag.js snippet for static HTML pages.
 *
 * WHY: Users who bounce before React hydrates and Firebase Analytics
 * initializes would have no page_view at all. This inline snippet fires
 * a page_view immediately on load, capturing those sessions.
 *
 * PERFORMANCE: gtag.js is loaded with `async` and the config uses
 * `transport_type: 'beacon'` so it doesn't block page rendering or
 * interfere with SPA hydration.
 *
 * NOTE: We no longer set `window.__GTAG_PAGE_VIEW_SENT__` here.
 * Previously the flag was used by analytics.ts to skip the Firebase
 * page_view and avoid a duplicate. But the flag was set synchronously
 * before gtag.js loaded, so when gtag.js was blocked (ad blockers,
 * ~30-40% of users), Firebase also skipped → sessions had no page_view
 * → GA4 landing page = "(not set)" for ~25% of sessions.
 * Firebase now always fires page_view, accepting a minor duplicate for
 * non-blocked users in exchange for correct landing page in all sessions.
 */
/**
 * Plain JS body for the gtag init — written to dist/assets/gtag-init.js by
 * staticScriptsPlugin. The googletagmanager loader stays inline (it's already
 * external + async). Saves ~260 B/page across ~200k SEO pages (~52 MB dist).
 */
export const GTAG_INIT_CONTENT = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${GA4_MEASUREMENT_ID}',{transport_type:'beacon'});`;
export const GTAG_INIT_FILENAME = 'gtag-init.js';
// gtag-init.js only pushes the GA4 page_view onto window.dataLayer; it does
// NOT need to run before paint. `defer` takes it off the render-blocking path
// (it ran synchronously in <head> before) so first paint no longer waits on a
// cross-origin script fetch — the deferred order still runs it before the
// async gtag/js library consumes the queue. The library tag stays `async`.
export const GTAG_SNIPPET = `<script async crossorigin="anonymous" src="https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}"></script>
 <script defer src="/assets/${GTAG_INIT_FILENAME}"></script>`;

/**
 * PostHog EU Cloud init snippet for standalone static pages that don't load the
 * SPA bundle (self-healing bridges, flat redirects, salary-hub landing pages,
 * legacy "pagina spostata" pages). Mirrors the config used by services/posthog.ts
 * but with `capture_pageview: true` so pageviews fire without React.
 *
 * The snippet guards against double-init via `e.__SV`, so it's safe to include
 * on pages that may later hydrate with the SPA bundle — the React import path
 * (services/posthog.ts) detects the existing `window.posthog` instance.
 *
 * Keys mirror services/posthog.ts — keep in sync if the key ever rotates.
 */
export const POSTHOG_KEY = 'phc_u8jsgXxFQNB6WcQt9JBcdj9tJrR4NsMws3nQoKdigjbT';
export const POSTHOG_HOST = 'https://t.frontaliereticino.ch';

/**
 * Client-side bot-detection literals shared by every static inline script.
 *
 * `BOT_PATTERNS_LITERAL` serialises services/botPatterns.ts `BOT_UA_PATTERNS`.
 * `BOT_GATE_FN` is the inline-JS twin of services/botPatterns.ts `isLikelyBot()`
 * — a function-expression string returning `true` for bot sessions. It is the
 * SINGLE source for the bot gate in BOTH static inline scripts below
 * (`ADSENSE_LOADER_CONTENT` + `POSTHOG_INIT_CONTENT`), so the logic is never
 * copy-pasted. Behaviour is kept aligned with the TS `isLikelyBot()` by
 * tests/bot-gate-parity.test.ts (same UA matrix, identical verdicts).
 *
 * Why a string and not the TS function: these run inside externalised plain-JS
 * assets emitted at build time (no module graph), so the detection must be
 * embedded literally. botPatterns.ts stays the source of truth for the pattern
 * list; only the wrapper logic is necessarily re-expressed here.
 */
const BOT_PATTERNS_LITERAL = JSON.stringify(BOT_UA_PATTERNS);
export const BOT_GATE_FN = `function(){var ua=(navigator.userAgent||'').toLowerCase();if(!ua||navigator.webdriver===true)return true;var P=${BOT_PATTERNS_LITERAL};for(var k=0;k<P.length;k++)if(ua.indexOf(P[k])>=0)return true;if(ua.indexOf('chrome')>=0&&!('chrome' in window))return true;if(ua.indexOf('chrome')>=0&&ua.indexOf('mobile')<0){var L=navigator.languages;if(L&&L.length===0)return true;if(navigator.plugins&&navigator.plugins.length===0)return true;if(typeof navigator.permissions==='undefined')return true;}return false;}`;

/**
 * Plain JS body for the PostHog snippet — written to dist/assets/posthog-init.js
 * by staticScriptsPlugin. The previous inline version was 1.2 KB embedded in every
 * static page using ANALYTICS_SNIPPET (~14k bridges + ~600 static-pages = ~17 MB).
 * After externalising, per-page cost drops from ~1.2 KB → ~80 B (the <script src> tag).
 *
 * BOT GATE: the entire stub-install + `posthog.init` runs only when `BOT_GATE_FN`
 * reports a real user. On static pages this snippet sets `capture_pageview:true`,
 * so without the gate every bot hit on a bridge/landing page fired a $pageview —
 * a large slice of the free-tier 1M/mo event budget at zero analytics value.
 * Mirrors the SPA gate in services/posthog.ts `ensurePostHog()`.
 */
export const POSTHOG_INIT_CONTENT = `if(!(${BOT_GATE_FN})()){!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags identify setPersonProperties group resetGroups reset opt_in_capturing opt_out_capturing".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init('${POSTHOG_KEY}',{api_host:'${POSTHOG_HOST}',capture_pageview:true,capture_pageleave:true,autocapture:false,persistence:'localStorage'});}`;
export const POSTHOG_INIT_FILENAME = 'posthog-init.js';
export const POSTHOG_SNIPPET = `<script src="/assets/${POSTHOG_INIT_FILENAME}"></script>`;

/**
 * Google AdSense loader snippet. Included in every statically-generated page
 * (job detail, hubs, fuel, health premiums, orphan queries, etc.) so Auto Ads
 * can serve on pages that do not mount the <AdSenseBanner> React component.
 * The client ID must match the meta `google-adsense-account` in index.html.
 *
 * LAZY LOADING (2026-04-23): adsbygoogle.js is no longer eagerly injected in
 * <head>. Semrush flagged 8129 "uncompressed JS" notices because every static
 * crawl fetched the script synchronously. Instead we ship:
 *  - preconnect hints to pagead2 so when we do load it's fast
 *  - google-adsense-account meta (required for AdSense site verification)
 *  - an inline IntersectionObserver loader that injects the script and pushes
 *    each <ins class="adsbygoogle"> slot the first time it scrolls within
 *    200px of the viewport. If no slot ever becomes visible, the script is
 *    never loaded — Semrush/Google crawlers stop seeing it in audits.
 *  - a first-interaction trigger (scroll/touchstart/pointerdown/keydown/
 *    mousemove, once+passive) that loads the script on the first real user
 *    engagement. This closes the biggest Auto Ads leak: quick-bounce mobile
 *    sessions (75% of traffic) that tap/scroll but leave before the idle
 *    fallback fires, so the anchor/vignette overlays never serve. Crawlers
 *    don't interact, so the Semrush "no synchronous JS" benefit is preserved.
 *  - a requestIdleCallback fallback that still loads the script after idle so
 *    Auto Ads (anchor, vignette, in-page) continue to earn on pages with no
 *    manual <ins> slots and no interaction.
 */
export const ADSENSE_CLIENT_ID = 'ca-pub-8628054934855353';
export const ADSENSE_SCRIPT_SRC = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT_ID}`;

/**
 * Inline lazy-loader injected at the bottom of every static page (and also
 * emitted from index.html). Runs once per page and:
 *  0. Bot gate: `BOT_GATE_FN` (shared with POSTHOG_INIT_CONTENT, the inline-JS
 *     twin of services/botPatterns.ts `isLikelyBot()`) returns true for bots —
 *     the loader then returns immediately. This is the static-HTML counterpart
 *     to `<AdSenseBanner>`'s SKIP_FOR_BOT and extends the bot filter to Auto Ads
 *     (Anchor / In-page / Vignette) which are injected by adsbygoogle.js itself,
 *     bypassing the React component. ~95% of revenue comes from those Auto Ads
 *     formats — without this gate, bots still triggered the script load and
 *     inflated AD_REQUESTS at near-zero RPM. See services/botPatterns.ts for the
 *     shared pattern source.
 *  1. Watches every <ins class="adsbygoogle"> with IntersectionObserver
 *     (rootMargin 200px) — on first visible slot, loads adsbygoogle.js.
 *  2. Falls back to requestIdleCallback for pages without manual slots so Auto
 *     Ads still serve. Browsers lacking requestIdleCallback (legacy iOS Safari
 *     < 16.4 — has IntersectionObserver since 12.2 but no rIC until 16.4) use
 *     `ricFb`, which defers the ad fetch past the `load` event (i.e. after LCP)
 *     instead of a flat sub-second setTimeout. A fixed 0.8–1.2s timeout could
 *     fire the script *before* LCP on slow connections, regressing LCP; gating
 *     on `load` bounds that structurally. Engaged users are unaffected — the
 *     first-interaction triggers load the script immediately regardless. The
 *     index.html googlefc loader uses the same `ricFb` load-gating for its
 *     no-rIC path, so both static-shell ad/CMP fetch paths are load-gated (not
 *     timer-gated). AdSenseBanner.tsx keeps a flat 1.5s no-rIC timer because it
 *     runs in a post-hydration effect (already after LCP), so it needs no gate.
 *  3. On script load, pushes {} for every slot currently in the DOM.
 */
/**
 * Plain JS body for the AdSense lazy loader — written to dist/assets/adsense-loader.js
 * by staticScriptsPlugin. This was the LARGEST inline script in every static page:
 * ~2 KB minified × ~200k SEO pages = ~400 MB dist. Externalising drops per-page cost
 * from ~2200 B to ~90 B (the <script src=...> tag).
 */
export const ADSENSE_LOADER_CONTENT = `(function(){if((${BOT_GATE_FN})())return;var loaded=false;function loadScript(){if(loaded)return;loaded=true;if(document.querySelector('script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]'))return;var s=document.createElement('script');s.async=true;s.crossOrigin='anonymous';s.src='${ADSENSE_SCRIPT_SRC}';s.setAttribute('data-overlays','bottom');s.setAttribute('data-ad-frequency-hint','60s');s.onload=function(){var slots=document.querySelectorAll('ins.adsbygoogle:not([data-adsbygoogle-status])');for(var i=0;i<slots.length;i++){try{(window.adsbygoogle=window.adsbygoogle||[]).push({});}catch(e){}}};document.head.appendChild(s);}function ricFb(cb){if(document.readyState==='complete'){setTimeout(cb,200);}else{window.addEventListener('load',function(){setTimeout(cb,200);},{once:true});}}function observe(){var EV=['scroll','touchstart','pointerdown','keydown','mousemove'];for(var e=0;e<EV.length;e++)document.addEventListener(EV[e],loadScript,{once:true,passive:true,capture:true});var slots=document.querySelectorAll('ins.adsbygoogle');if(!('IntersectionObserver' in window)||slots.length===0){(window.requestIdleCallback||ricFb)(loadScript,{timeout:1500});return;}var io=new IntersectionObserver(function(entries){for(var i=0;i<entries.length;i++){if(entries[i].isIntersecting){io.disconnect();loadScript();return;}}},{rootMargin:'200px 0px'});for(var j=0;j<slots.length;j++)io.observe(slots[j]);(window.requestIdleCallback||ricFb)(loadScript,{timeout:2500});}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',observe,{once:true});}else{observe();}})();`;
export const ADSENSE_LOADER_FILENAME = 'adsense-loader.js';
export const ADSENSE_LAZY_LOADER = `<script defer src="/assets/${ADSENSE_LOADER_FILENAME}"></script>`;

/**
 * Publisher id (no `ca-` prefix) for the Funding Choices endpoints, derived
 * from {@link ADSENSE_CLIENT_ID} so it never drifts from the AdSense account.
 */
export const FC_PUBLISHER_ID = ADSENSE_CLIENT_ID.replace(/^ca-/, ''); // pub-8628054934855353

/**
 * Offerwall custom-choice registry + Funding Choices MESSAGING loader, injected
 * PARSE-TIME into the <head> of in-scope STATIC article pages.
 *
 * WHY THIS EXISTS (2026-06-16): the GAM Offerwall is scoped to the article
 * sections, which are emitted as static SSG HTML (staticPagesPlugin) whose head
 * does NOT carry index.html's inline Offerwall block. On those pages the only
 * Funding Choices loader that ever runs is the network-code one pulled in by
 * adsbygoogle.js AFTER hydration — it fetches the Offerwall /f/ message (200,
 * incl. our custom choice) but never instantiates the overlay. The publisher-id
 * MESSAGING loader (`/i/pub-XXX`) — the one index.html uses on SPA roots and the
 * one that actually renders FC messages — is absent. Injecting the registry +
 * pub-id loader at PARSE TIME (before hydration and before adsbygoogle's
 * network-code loader claims the singleton FC instance) brings article pages to
 * parity with index.html's proven render path. (#2312 injected the same loader
 * POST-hydration via the React gate and it never rendered, because FC was
 * already singleton-initialised by the network-code loader — parse-time is the
 * differentiator.)
 *
 * MUST stay byte-aligned with index.html's loadFc()/registry on the essentials
 * (same pub-id loader URL, `data-fc-loader` dedup marker, NO crossOrigin — see
 * tests/index-html-fc-loader.test.ts for the CORS rationale — googlefcPresent
 * signal, requestIdleCallback/DOMContentLoaded deferral for LCP). The drift
 * guard lives in tests/offerwall-static-fc-snippet.test.ts. The registry's
 * behaviour mirrors components/community/OfferwallNewsletterGate.tsx
 * (ensureOfferwallRegistry), which is idempotent (`if (cc.registry) return`) and
 * so no-ops when this parse-time copy already set it — the gate still installs
 * the window.__ftOfferwallSubscribe hook this registry delegates to.
 *
 * The anti-adblock fallback IIFE that index.html also runs from loadFc() is
 * deliberately NOT included here — it is a separate feature, out of scope for
 * the Offerwall render fix.
 */
export const OFFERWALL_FC_SNIPPET = `<script>(function(){var g=window.googlefc=window.googlefc||{};var ow=g.offerwall=g.offerwall||{};var cc=ow.customchoice=ow.customchoice||{};if(cc.registry)return;function hasAccess(){try{if(window.localStorage.getItem('newsletter_subscribed')==='true')return true;for(var i=0;i<window.localStorage.length;i++){var k=window.localStorage.key(i);if(k&&k.indexOf('firebase:authUser:')===0)return true;}}catch(e){}return false;}cc.registry={initialize:function(params){var E=cc.InitializeResponseEnum||{};if(hasAccess()){return Promise.resolve(E.ACCESS_GRANTED||'ACCESS_GRANTED');}window.__ftOfferwallLang=(params&&params.offerwallLanguageCode)||null;return Promise.resolve(E.ACCESS_NOT_GRANTED||'ACCESS_NOT_GRANTED');},show:function(){var fn=window.__ftOfferwallSubscribe;function run(f){try{return Promise.resolve(f(window.__ftOfferwallLang)).then(function(ok){return !!ok;});}catch(e){return Promise.resolve(false);}}if(typeof fn!=='function'){return new Promise(function(resolve){var settled=false;function settle(ok){if(settled)return;settled=true;resolve(!!ok);}var q=window.__ftOfferwallShowQueue=window.__ftOfferwallShowQueue||[];var timer=setTimeout(function(){settle(false);},10000);q.push(function(hook){if(settled)return;clearTimeout(timer);run(hook).then(settle,function(){settle(false);});});});}return run(fn);}};})();</script>
 <script>(function(){function loadFc(){if(!document.querySelector('script[data-fc-loader]')){var s=document.createElement('script');s.async=true;s.src='https://fundingchoicesmessages.google.com/i/${FC_PUBLISHER_ID}?ers=1';s.setAttribute('data-fc-loader','1');document.head.appendChild(s);}(function sig(){if(!window.frames['googlefcPresent']){if(document.body){var f=document.createElement('iframe');f.style='width:0;height:0;border:none;z-index:-1000;left:-1000px;top:-1000px;';f.style.display='none';f.name='googlefcPresent';document.body.appendChild(f);}else{setTimeout(sig,0);}}})();}function ricFb(cb){if(document.readyState==='complete'){setTimeout(cb,200);}else{window.addEventListener('load',function(){setTimeout(cb,200);},{once:true});}}function schedule(){(window.requestIdleCallback||ricFb)(loadFc,{timeout:4000});}if(document.readyState==='loading'){window.addEventListener('DOMContentLoaded',schedule,{once:true});}else{schedule();}})();</script>`;

/**
 * Above-the-fold manual slot for drive-by SEO landings (health premiums,
 * fuel daily, border wait) — pages with 7-11s median sessions whose only
 * manual unit was the end-of-page ARTICLE_END_MULTIPLEX, far below the
 * fold (2026-06 revenue deep dive). A slot near the primary data area makes
 * the adsense lazy loader's IntersectionObserver fire at first paint, so
 * adsbygoogle.js loads immediately instead of waiting for the idle
 * fallback. Markup comes from adSlotHtml('HOMEPAGE_MID_DISPLAY') so format
 * (autorelaxed multiplex) and the CLS-reserving min-height stay driven by
 * the services/adsenseSlots registry — never hand-roll the <ins> here
 * (PR #1910 review). Reuses that ACTIVE unit because ad-unit creation via
 * API needs a write-scope OAuth token the automation does not hold.
 */
export const DRIVEBY_AD_SNIPPET = `<div class="my-6">
    ${adSlotHtml('HOMEPAGE_MID_DISPLAY')}
  </div>`;

export const ADSENSE_SNIPPET = `<meta name="google-adsense-account" content="${ADSENSE_CLIENT_ID}">
 <link rel="preconnect" href="https://pagead2.googlesyndication.com" crossorigin>
 <link rel="dns-prefetch" href="https://pagead2.googlesyndication.com">
 ${ADSENSE_LAZY_LOADER}`;

/** Combined analytics snippet (GA4 + PostHog + AdSense) for static pages without the SPA bundle. */
export const ANALYTICS_SNIPPET = `${GTAG_SNIPPET}
 ${POSTHOG_SNIPPET}
 ${ADSENSE_SNIPPET}`;

/** Favicon link tags shared across all static HTML pages. */
export const FAVICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="48x48">
 <link rel="icon" type="image/svg+xml" href="/favicon.svg">`;

/**
 * Count words of visible text in an HTML string, stripping all tags.
 * Used to decide whether a static page has enough content to be indexed (>= 50 words).
 */
export function countHtmlBodyWords(html: string): number {
 // Strip HTML tags
 const text = html.replace(/<[^>]+>/g, ' ');
 // Collapse whitespace and split into words
 const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(w => w.length > 0);
 return words.length;
}

/** Minimum word count for a page to be considered indexable (not thin content). */
export const MIN_INDEXABLE_WORDS = 50;

/**
 * Returns the appropriate robots meta tag based on the word count of the page body.
 * Pages with >= MIN_INDEXABLE_WORDS get `index,follow`; below that, `noindex,follow`.
 * Always returns an explicit tag -- never relies on browser defaults.
 */
export function robotsMetaForContent(bodyHtml: string): string {
 const wordCount = countHtmlBodyWords(bodyHtml);
 if (wordCount >= MIN_INDEXABLE_WORDS) {
 return '\n <meta name="robots" content="index,follow">';
 }
 return '\n <meta name="robots" content="noindex,follow">';
}
