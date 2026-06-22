/**
 * Shared HTML template fragments for build plugins.
 *
 * Pre-computes common HTML boilerplate (meta charset, viewport, favicon,
 * gtag) into reusable fragments. These constants are evaluated once at
 * module load time, not per-page.
 *
 * Phase 3 optimization: reduces string concatenation overhead for 55k+ pages.
 */
import { FAVICON_LINKS, GTAG_SNIPPET, ADSENSE_SNIPPET, BASE_URL, SPA_ACTION_REDIRECT_SCRIPT, SEO_STATIC_CSS_FILENAME, CDN_PRECONNECT_HINT } from './constants';
import { escapeInlineScript } from './shared/inlineJsonScript';
import { clampMetaDescription } from './shared/titleSuffix';
import { CRITICAL_CSS } from './shared/criticalCss';

/**
 * Async-CSS swap snippet shared by every static page emitted through
 * {@link buildSimplePage}.
 *
 * Renders a stylesheet `<link>` non-render-blocking via the `media="print"` →
 * `media='all'` onload swap trick, with:
 *  - a `<link rel="preload" as="style">` to start the download immediately,
 *  - a `<noscript>` synchronous fallback so no-JS clients + crawlers still get
 *    the full stylesheet,
 *  - `data-clarity-unmask="true"` so Microsoft Clarity keeps the href in
 *    session recordings.
 *
 * First paint is rendered from the inline {@link CRITICAL_CSS} block, so the
 * static SEO content (rendered immediately, not behind a skeleton) does not
 * FOUC while the full sheet streams in. This is the SAME pattern the sibling
 * static emitters already use (`staticPagesPlugin.ts`, `ogPagesPlugin.ts`,
 * `asyncCssPlugin.ts`, and the hand-rolled job-detail head in
 * `jobsSeoPagesPlugin.ts`) — kept in one helper here so the buildSimplePage
 * path can't drift back to render-blocking CSS.
 *
 * `href` may be same-origin (`/assets/…`) or an absolute CDN URL
 * (`https://cdn.…/assets/…`) when ASSET_CDN/renderBuiltUrl is active.
 */
export function asyncCssLink(href: string): string {
  return (
    `<link rel="preload" as="style" crossorigin href="${href}" data-clarity-unmask="true">` +
    `<link rel="stylesheet" crossorigin href="${href}" media="print" onload="this.media='all'" data-clarity-unmask="true">` +
    `<noscript><link rel="stylesheet" crossorigin href="${href}" data-clarity-unmask="true"></noscript>`
  );
}

/**
 * Belt-and-braces timer that flips any still-`media="print"` async stylesheet
 * to `media='all'` after 3s in case the `onload` handler never fired (cached
 * 304 with no load event on some engines, blocked onload, etc.). Mirrors the
 * identical fallback in `staticPagesPlugin.ts` / `ogPagesPlugin.ts`, and the
 * `link[media="print"][href*="/assets/"]` selector the SPA boot path waits on
 * (`index.tsx#waitForAsyncStylesheet`). Emitted once per page.
 *
 * When the timer fires (i.e. the async swap fell back to the 3s timeout — the
 * signal of an onload failure that can cause FOUC/CLS) it queues
 * `sessionStorage._cssFallbackInfo`, which `services/analytics.ts` drains into
 * the GA4 `css_fallback` event (`Analytics.trackCssFallback`). Keeping this
 * telemetry here — identical to the sibling fallbacks — is what makes the
 * post-deploy revert-trigger observable on every page that goes through
 * `asyncCssHeadBlock` (job-detail, collection/faq, soft-landing, recency,
 * sector, hub).
 */
export const ASYNC_CSS_FALLBACK_SCRIPT =
  `<script>setTimeout(function(){var ls=document.querySelectorAll('link[media="print"][href*="/assets/"]');for(var i=0;i<ls.length;i++){ls[i].media='all'}if(ls[0]){try{sessionStorage.setItem('_cssFallbackInfo',JSON.stringify({href:ls[0].href,delayMs:3000,pagePath:location.pathname+location.search,ts:new Date().toISOString()}))}catch(e){}}},3000)</script>`;

/**
 * Full non-render-blocking CSS `<head>` block for static SEO landing pages:
 *   1. inline `<style>` with the first-paint {@link CRITICAL_CSS},
 *   2. async-swapped Vite entry stylesheet (optional — only when a SPA bundle
 *      is present for the page),
 *   3. async-swapped `seo-static.css` (the s-* utility sheet),
 *   4. the 3s belt-and-braces flip script.
 *
 * This is the SINGLE source of truth so the hand-rolled heads in the
 * job/sector/recency/hub SEO emitters and the buildSimplePage shell can't
 * drift apart (AGENTS.md §6 — one shared module, not copy-pasted async
 * markup). `entryCss` may be a same-origin filename (e.g. `index-abc.css`) or
 * an absolute CDN URL; an empty/undefined value omits the entry sheet.
 */
export function asyncCssHeadBlock(entryCss?: string): string {
  const entryCssHref = entryCss ? (/^https?:\/\//.test(entryCss) ? entryCss : `/assets/${entryCss}`) : '';
  const entryLink = entryCssHref ? `\n    ${asyncCssLink(entryCssHref)}` : '';
  return (
    `<style>${CRITICAL_CSS}</style>` +
    `${entryLink}\n    ${asyncCssLink(`/assets/${SEO_STATIC_CSS_FILENAME}`)}` +
    `\n    ${ASYNC_CSS_FALLBACK_SCRIPT}`
  );
}

/**
 * Common <head> prefix: charset + viewport + favicon + security meta.
 * Used as the opening of every static HTML page's <head>.
 *
 * Security meta rationale (GitHub Pages can't set HTTP response headers):
 *  - X-Content-Type-Options: blocks MIME-sniffing attacks.
 *  - Referrer-Policy: limits referrer info leaked to third parties.
 *  - Permissions-Policy: disables sensor APIs we don't use.
 *  - Content-Security-Policy: `upgrade-insecure-requests` auto-upgrades any
 *    stray http:// asset to https:// (this directive works via <meta>).
 *  NOTE: frame-ancestors (anti-clickjacking) and HSTS are IGNORED when set via
 *  <meta> (spec: header-only) — they logged a console error on every page load
 *  and enforced nothing, so they are omitted. Real anti-framing/HSTS needs an
 *  HTTP-header layer (future: Cloudflare proxy / edge worker).
 *  Restrictive script-src/style-src deliberately omitted — would break
 *  Firebase, AdSense, PostHog, Clarity, GTM and Vite inline styles.
 */
export const HEAD_PREFIX = `<meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n ` : ''}<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests;">
 <meta http-equiv="X-Content-Type-Options" content="nosniff">
 <meta name="referrer" content="strict-origin-when-cross-origin">
 <meta http-equiv="Permissions-Policy" content="camera=(), microphone=(), geolocation=()">
 ${FAVICON_LINKS}`;

/**
 * Common <head> suffix: GTAG snippet + SPA action redirect.
 * Appended before </head> on pages that need both.
 */
export const HEAD_SUFFIX_WITH_SPA = ` ${SPA_ACTION_REDIRECT_SCRIPT}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}`;

/**
 * Common <head> suffix: GTAG snippet only (no SPA redirect).
 * For pages that don't need the SPA action redirect (editorial, search, etc.)
 */
export const HEAD_SUFFIX_GTAG = ` ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}`;

/** HTML escape for attribute values and text content. */
export function esc(s: string): string {
 return s
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;');
}

/** Ensure path ends with trailing slash. */
export function withSlash(p: string): string {
 return p.endsWith('/') ? p : p + '/';
}

/** OG locale mapping (e.g., 'it' → 'it_IT'). */
export const LOCALE_OG: Record<string, string> = {
 it: 'it_IT',
 en: 'en_GB',
 de: 'de_CH',
 fr: 'fr_CH',
};

/**
 * Build a complete HTML page with the standard boilerplate.
 *
 * This is a convenience function for simpler page types (search, category,
 * pagination, editorial). Complex pages (job detail, company) use inline
 * templates due to their extensive per-page customization.
 */
export interface SimplePageOpts {
 locale: string;
 title: string;
 description: string;
 canonicalUrl: string;
 robots?: string;
 ogType?: string;
 /** Override the default OG locale (e.g. 'en_US' instead of 'en_GB'). */
 ogLocale?: string;
 hreflangHtml?: string;
 /**
  * Per-page og:image override. Defaults to `${BASE_URL}/og-image.png` (1200×630).
  * When passing a custom image (e.g. webcam snapshot at 640×360), set ogImageWidth/Height too.
  * Twitter image mirrors this URL.
  */
 ogImage?: string;
 ogImageWidth?: number;
 ogImageHeight?: number;
 ogImageType?: string;
 ogImageAlt?: string;
 /** Additional <head> HTML (prev/next links, extra meta, etc.). MUST NOT contain og:image — use ogImage. */
 extraHeadHtml?: string;
 jsonLdScripts?: string[];
 entryJs?: string;
 entryCss?: string;
 bodyHtml: string;
 /**
  * When true, `bodyHtml` is inserted directly inside `<div id="root">` without
  * being wrapped in an inner `<main class="static-job-page">`. Use this when
  * the caller emits its own `<main>` element (e.g. SEO feature plugins that
  * need custom layout markup). Default: false (preserves legacy job SEO
  * pages that pass raw inner content and rely on the default wrapper).
  */
 skipMainWrap?: boolean;
 /**
  * When true, `bodyHtml` is emitted OUTSIDE `<div id="root">` (which is left
  * empty). The static SEO content is wrapped in a `<main class="seo-static-content">`
  * sibling element so the React SPA hydrating into `#root` cannot overwrite it.
  *
  * This is the fix for the bait-and-switch bug where the SPA router would
  * resolve a per-station/per-canton SEO URL to a generic comparator tab and
  * render that tab's React component INSIDE `#root` — visually replacing
  * the static SEO content the user came to read.
  *
  * The hosting page also signals to App.tsx (via the presence of
  * `main.seo-static-content` in the DOM at boot time) that it should render
  * a "lite shell" with header + footer only, and skip the main router area.
  *
  * Implies {@link skipMainWrap} (the caller's bodyHtml must already contain
  * its own `<main>` element semantics — but we still wrap it in
  * `<main class="seo-static-content">` for the lite-shell detection hook).
  *
  * Default: false (legacy behavior — content stays inside `#root`).
  */
 seoContentOutsideRoot?: boolean;
 /**
  * HTML rendered BETWEEN `<div id="root">` and `<main class="seo-static-content">`.
  * Use for chrome that should render as a SIBLING of `<main>` (not inside it),
  * to match the SPA DOM where sub-navigation is a sibling of the main area.
  *
  * Only emitted when {@link seoContentOutsideRoot} is true. The hub sub-nav
  * (see `renderHubChromeSplit` in shared/hubChrome.ts) is the canonical use.
  */
 preMainHtml?: string;
 /**
  * When true, emits the AdSense `data-no-auto-ads` attribute on `<body>` so
  * Google Auto Ads (Anchor, In-page, Vignette) skip the entire page. Used by
  * "drive-by" SEO landings where engagement is sub-5s and ad serving wastes
  * frequency caps without earning (e.g. F8 border wait, F6 fuel daily, F2
  * health premiums — bounce ≥97%, dwell <5s).
  */
 disableAutoAds?: boolean;
 /**
  * Class applied to the `<main>` wrapper emitted around `bodyHtml` when
  * {@link seoContentOutsideRoot} is true. Defaults to `'seo-static-content'`,
  * which is the marker the SPA's `useNavigationState` hook detects to switch
  * to lite-shell mode (header + footer only, leaves static content visible).
  *
  * Callers may opt OUT of lite-shell mode by passing a different class
  * (e.g. `'cluster-seo-prose'`). With a non-`seo-static-content` class the
  * SPA does NOT detect lite-shell and hydrates `#root` with its full UI as
  * it would on any other route. The static `<main>` then lives below
  * `#root` purely as crawler-facing prose. Used by per-cluster
  * related-search pages (the SPA's JobBoard already renders the working
  * search-query UI for those URLs).
  */
 seoMainClass?: string;
}

export function buildSimplePage(opts: SimplePageOpts): string {
 const {
 locale,
 title,
 description,
 canonicalUrl,
 robots = 'index,follow',
 ogType = 'website',
 ogLocale: ogLocaleOverride,
 hreflangHtml = '',
 ogImage,
 ogImageWidth,
 ogImageHeight,
 ogImageType,
 ogImageAlt,
 extraHeadHtml = '',
 jsonLdScripts = [],
 entryJs,
 entryCss,
 bodyHtml,
 skipMainWrap = false,
 seoContentOutsideRoot = false,
 preMainHtml = '',
 disableAutoAds = false,
 seoMainClass = 'seo-static-content',
 } = opts;

 const ogLocale = ogLocaleOverride || LOCALE_OG[locale] || 'it_IT';
 // Clamp the <meta name="description"> / og:description to the SERP snippet
 // budget (word-aware, ≤160 char). JSON-LD `description` in jsonLdScripts is
 // untouched. Mirrors the runtime clamp in services/seoService.ts so the
 // static HTML and the JS-rendered DOM expose the same complete snippet.
 const metaDescription = clampMetaDescription(description);
 const extraHead = extraHeadHtml ? `\n${extraHeadHtml}` : '';
 // Escape `<` in each (already-serialized) JSON-LD string so a "</script>" in
 // arbitrary content (titles, names) can't break out of the inline tag and
 // invalidate the structured data on indexed pages. Shared choke point for
 // every plugin that renders via this shell / seoPageShell.
 const ldTags = jsonLdScripts.map(ld => ` <script type="application/ld+json">${escapeInlineScript(ld)}</script>`).join('\n');
 // Both the Vite entry sheet AND seo-static.css are loaded NON-render-blocking
 // via the `media="print"` swap, with first paint rendered from the inline
 // CRITICAL_CSS block (see {@link asyncCssHeadBlock}). Static SEO content is
 // shown immediately (not behind a skeleton), so the inline critical CSS keeps
 // first paint stable while the full sheets stream in — no FOUC. Issue #1991 /
 // follow-up of PR #1984: removes the last render-blocking CSS on the
 // buildSimplePage static-landing path (LCP/CWV → organic ranking).
 //
 // PR #454 extracted ~3 920 static inline `style=` attributes into content-
 // hashed s-{6char} classes in public/assets/seo-static.css; this link makes
 // those s-* anchors paint on every buildSimplePage page (the hand-rolled
 // HTML in jobsSeoPagesPlugin / seoHubsPlugin links it too, now also async).
 const cssHead = `\n ${asyncCssHeadBlock(entryCss)}`;
 const jsScript = entryJs ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : '';
 const hasStaticAdSlot = bodyHtml.includes('adsbygoogle');
 // SPA-backed pages already initialise analytics; keep the static loader only
 // when raw HTML ad slots need the non-React AdSense observer.
 const staticAnalyticsHtml = entryJs && !hasStaticAdSlot ? '' : `\n ${GTAG_SNIPPET}\n ${ADSENSE_SNIPPET}`;

 // Body composition — three modes:
 //
 // 1. seoContentOutsideRoot=true (NEW, used by 6 SEO feature plugins):
 //    `<div id="root">` is empty. Static SEO content is emitted as a
 //    `<main class="seo-static-content">` SIBLING element so the React SPA
 //    hydrating into `#root` cannot visually replace it. App.tsx detects
 //    `main.seo-static-content` at boot and renders only header+footer
 //    chrome (lite shell), leaving the static content untouched.
 //
 // 2. skipMainWrap=true (existing — used by SEO feature plugins until now):
 //    Caller's bodyHtml lives inside `<div id="root">` directly. Kept for
 //    backward compat, but bait-and-switch bug applies — prefer mode 1.
 //
 // 3. default (skipMainWrap=false, seoContentOutsideRoot=false):
 //    Caller's bodyHtml gets wrapped in `<main class="static-job-page">`
 //    inside `<div id="root">` — legacy job SEO pages.
 const preMainSection = preMainHtml ? `\n${preMainHtml}` : '';
 // Full-height left/right side-rail gutters for the static SEO content, mirroring
 // the article-detail / job-detail rail layout (BlogArticles, JobBoard). The
 // <main> becomes the centre column of a 3-col grid that only materialises at
 // `xlw` (≥1400px) — below that the page is an unchanged single column. The two
 // <aside> elements are PORTAL TARGETS: App.tsx mounts <ArticleRailAdStack> into
 // `#rail-left-root` / `#rail-right-root` on staticOverlay pages (same pattern as
 // the `#footer-root` portal), so the GPT half-page ads reuse the React slot and
 // its Remote Config kill-switch instead of duplicating GPT in static HTML.
 // Reserved 300px columns mean zero CLS. Suppressed on `disableAutoAds` drive-by
 // pages (≥97% bounce) to honour their deliberate no-ad opt-out.
 const railsEnabled = seoContentOutsideRoot && !disableAutoAds;
 const railGridOpen = railsEnabled
   ? ` <div class="xlw:grid xlw:grid-cols-[300px_minmax(0,1fr)_300px] xlw:gap-6 xlw:mx-auto xlw:max-w-[1768px]">
 <aside id="rail-left-root" class="hidden xlw:flex xlw:flex-col" aria-hidden="true"></aside>`
   : '';
 const railGridClose = railsEnabled
   ? `
 <aside id="rail-right-root" class="hidden xlw:flex xlw:flex-col" aria-hidden="true"></aside>
 </div>`
   : '';
 const bodySection = seoContentOutsideRoot
   ? ` <div id="root"></div>${preMainSection}
${railGridOpen}
 <main class="${seoMainClass}">
${bodyHtml}
 </main>${railGridClose}
 <div id="footer-root"></div>`
   : ` <div id="root">
${skipMainWrap ? bodyHtml : ` <main class="static-job-page">\n ${bodyHtml}\n </main>`}
 </div>`;

 // `bg-surface-alt text-heading overflow-x-hidden` mirrors the canonical
 // SPA body class from index.html — ensures theme tokens apply before React
 // hydrates so the static shell never flashes a bare white page with
 // system-ui font.
 return `<!doctype html>
<html lang="${locale}">
 <head>
 ${HEAD_PREFIX}
 <title>${esc(title)}</title>
 <meta name="description" content="${esc(metaDescription)}">
 <meta name="robots" content="${robots}">
 <meta property="og:type" content="${ogType}">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${ogLocale}">
 <meta property="og:title" content="${esc(title)}">
 <meta property="og:description" content="${esc(metaDescription)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${esc(ogImage ?? `${BASE_URL}/og-image.png`)}">
 <meta property="og:image:width" content="${ogImageWidth ?? 1200}">
 <meta property="og:image:height" content="${ogImageHeight ?? 630}">
 <meta property="og:image:type" content="${esc(ogImageType ?? 'image/png')}">${ogImageAlt ? `\n <meta property="og:image:alt" content="${esc(ogImageAlt)}">` : ''}
 <link rel="canonical" href="${canonicalUrl}">
${hreflangHtml}${extraHead}
${ldTags}${cssHead}${staticAnalyticsHtml}
 </head>
 <body class="bg-surface-alt text-heading overflow-x-hidden"${disableAutoAds ? ' data-no-auto-ads' : ''}>
${bodySection}${jsScript}
 </body>
</html>`;
}
