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
 * Common <head> prefix: charset + viewport + favicon.
 * Used as the opening of every static HTML page's <head>.
 */
export const HEAD_PREFIX = `<meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
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
 } = opts;

 const ogLocale = ogLocaleOverride || LOCALE_OG[locale] || 'it_IT';
 const extraHead = extraHeadHtml ? `\n${extraHeadHtml}` : '';
 const ldTags = jsonLdScripts.map(ld => ` <script type="application/ld+json">${ld}</script>`).join('\n');
 const cssLink = entryCss ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : '';
 const jsScript = entryJs ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : '';

 // Inner wrap — either the default `<main class="static-job-page">` (legacy
 // job SEO pages) or the caller's own `<main>` element (new SEO feature
 // plugins that bring custom layout markup).
 const innerHtml = skipMainWrap
 ? bodyHtml
 : ` <main class="static-job-page">\n ${bodyHtml}\n </main>`;

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
 <link rel="canonical" href="${canonicalUrl}">
${hreflangHtml}${extraHead}
${ldTags}${cssLink}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 </head>
 <body class="bg-surface-alt text-heading overflow-x-hidden">
 <div id="root">
${innerHtml}
 </div>${jsScript}
 </body>
</html>`;
}
