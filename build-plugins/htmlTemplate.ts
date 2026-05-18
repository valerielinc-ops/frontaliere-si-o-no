/**
 * Shared HTML template fragments for build plugins.
 *
 * Pre-computes common HTML boilerplate (meta charset, viewport, favicon,
 * gtag) into reusable fragments. These constants are evaluated once at
 * module load time, not per-page.
 *
 * Phase 3 optimization: reduces string concatenation overhead for 55k+ pages.
 */
import { FAVICON_LINKS, GTAG_SNIPPET, ADSENSE_SNIPPET, BASE_URL, SPA_ACTION_REDIRECT_SCRIPT } from './constants';

/**
 * Common <head> prefix: charset + viewport + favicon + security meta.
 * Used as the opening of every static HTML page's <head>.
 *
 * Security meta rationale (GitHub Pages can't set HTTP response headers):
 *  - X-Content-Type-Options: blocks MIME-sniffing attacks.
 *  - Referrer-Policy: limits referrer info leaked to third parties.
 *  - Permissions-Policy: disables sensor APIs we don't use.
 *  - Content-Security-Policy: `upgrade-insecure-requests` auto-upgrades any
 *    stray http:// asset to https:// + `frame-ancestors 'self'` blocks
 *    clickjacking (modern replacement for X-Frame-Options).
 *  NOTE: HSTS cannot be set via meta tag — requires a real HTTP header,
 *  not supported by GitHub Pages. Future: Cloudflare proxy / edge worker.
 *  Restrictive script-src/style-src deliberately omitted — would break
 *  Firebase, AdSense, PostHog, Clarity, GTM and Vite inline styles.
 */
export const HEAD_PREFIX = `<meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 <meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests; frame-ancestors 'self';">
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
 /** Additional <head> HTML (prev/next links, twitter cards, etc.). */
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
 const extraHead = extraHeadHtml ? `\n${extraHeadHtml}` : '';
 const ldTags = jsonLdScripts.map(ld => ` <script type="application/ld+json">${ld}</script>`).join('\n');
 const cssLink = entryCss ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : '';
 const jsScript = entryJs ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : '';

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
 const bodySection = seoContentOutsideRoot
   ? ` <div id="root"></div>${preMainSection}
 <main class="${seoMainClass}">
${bodyHtml}
 </main>
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
 <meta name="description" content="${esc(description)}">
 <meta name="robots" content="${robots}">
 <meta property="og:type" content="${ogType}">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${ogLocale}">
 <meta property="og:title" content="${esc(title)}">
 <meta property="og:description" content="${esc(description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:image" content="${BASE_URL}/og-image.png">
 <link rel="canonical" href="${canonicalUrl}">
${hreflangHtml}${extraHead}
${ldTags}${cssLink}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 </head>
 <body class="bg-surface-alt text-heading overflow-x-hidden"${disableAutoAds ? ' data-no-auto-ads' : ''}>
${bodySection}${jsScript}
 </body>
</html>`;
}