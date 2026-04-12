/**
 * Shared constants for Vite build plugins.
 *
 * BUILD_ID:  timestamp injected as __BUILD_ID__ — used by BlogArticles
 *            to detect stale caches.
 * COMMIT_HASH / SHORT_COMMIT_HASH: injected as __COMMIT_HASH__ /
 *            __SHORT_COMMIT_HASH__ for the version badge and GitHub link.
 * BASE_URL:  canonical site origin used across all static-page generators.
 */

import { execSync } from 'child_process';

export const BUILD_ID = String(Date.now());

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
 */
export const SPA_ACTION_REDIRECT_SCRIPT = `<script>(function(){
  var p=new URLSearchParams(location.search);
  if(p.get('action')||p.get('ac')||p.get('at')||p.get('authToken')||p.get('newsletter_autologin')||p.get('ne')){
    sessionStorage.redirect=location.href;
    location.replace('/');
  }
})()</script>`;

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
    ? '\n' + hreflangEntries.map(e => `    <link rel="alternate" hreflang="${e.hreflang}" href="${e.href}">`).join('\n')
    : '';

  return `<!DOCTYPE html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <meta name="description" content="${description}">
    <meta name="robots" content="${robotsContent}">
    <link rel="canonical" href="${canonicalUrl}">${hreflangHtml}
    ${GTAG_SNIPPET}
    ${SPA_ACTION_REDIRECT_SCRIPT}
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#f8fafc;color:#334155;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 4px 6px rgba(50,50,93,.11),0 1px 3px rgba(0,0,0,.08);max-width:480px;width:100%;padding:32px 24px;text-align:center}.logo{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:20px}.logo svg{width:28px;height:28px}.logo span{font-size:16px;font-weight:700;color:#1e293b}h1{font-size:20px;font-weight:700;color:#1e293b;margin-bottom:8px;line-height:1.3}p{font-size:14px;color:#64748b;line-height:1.6;margin-bottom:16px}.btn{display:inline-block;background:#533afd;color:#fff;font-size:14px;font-weight:600;padding:10px 24px;border-radius:6px;text-decoration:none;transition:background .15s}.btn:hover{background:#4529e6}.footer{margin-top:24px;font-size:12px;color:#94a3b8}</style>
  </head>
  <body>
    <main class="card">
      <div class="logo">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" rx="16" fill="#1e293b"/><rect x="22" y="22" width="56" height="20" rx="4" fill="#94a3b8"/><rect x="22" y="52" width="24" height="24" rx="6" fill="#dc2626"/><path d="M34 58v12M28 64h12" stroke="white" stroke-width="3" stroke-linecap="round"/><g><clipPath id="c"><rect x="54" y="52" width="24" height="24" rx="6"/></clipPath><g clip-path="url(#c)"><rect x="54" y="52" width="8" height="24" fill="#16a34a"/><rect x="62" y="52" width="8" height="24" fill="white"/><rect x="70" y="52" width="8" height="24" fill="#dc2626"/></g></g></svg>
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
  const desc = og ? esc(og.description) : 'Apri la versione canonica aggiornata di questa pagina su Frontaliere Ticino.';
  const ogTags = og
    ? `
    <meta property="og:type" content="article">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:title" content="${esc(og.title)}">
    <meta property="og:description" content="${desc}">
    <meta property="og:image" content="${esc(og.image)}">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="fb:app_id" content="891036063797338">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(og.title)}">
    <meta name="twitter:description" content="${desc}">
    <meta name="twitter:image" content="${esc(og.image)}">
    <meta name="twitter:site" content="@frontaliereticino">`
    : '';
  return `<!DOCTYPE html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <meta name="description" content="${desc}">
    <meta name="robots" content="index,follow">
    <link rel="canonical" href="${canonicalUrl}">${ogTags}
    ${GTAG_SNIPPET}
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#f8fafc;color:#334155;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 4px 6px rgba(50,50,93,.11),0 1px 3px rgba(0,0,0,.08);max-width:480px;width:100%;padding:32px 24px;text-align:center}.logo{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:20px}.logo svg{width:28px;height:28px}.logo span{font-size:16px;font-weight:700;color:#1e293b}h1{font-size:20px;font-weight:700;color:#1e293b;margin-bottom:8px;line-height:1.3}p{font-size:14px;color:#64748b;line-height:1.6;margin-bottom:16px}.btn{display:inline-block;background:#533afd;color:#fff;font-size:14px;font-weight:600;padding:10px 24px;border-radius:6px;text-decoration:none;transition:background .15s}.btn:hover{background:#4529e6}.footer{margin-top:24px;font-size:12px;color:#94a3b8}</style>
  </head>
  <body>
    <main class="card">
      <div class="logo">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" rx="16" fill="#1e293b"/><rect x="22" y="22" width="56" height="20" rx="4" fill="#94a3b8"/><rect x="22" y="52" width="24" height="24" rx="6" fill="#dc2626"/><path d="M34 58v12M28 64h12" stroke="white" stroke-width="3" stroke-linecap="round"/><g><clipPath id="c"><rect x="54" y="52" width="24" height="24" rx="6"/></clipPath><g clip-path="url(#c)"><rect x="54" y="52" width="8" height="24" fill="#16a34a"/><rect x="62" y="52" width="8" height="24" fill="white"/><rect x="70" y="52" width="8" height="24" fill="#dc2626"/></g></g></svg>
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
export const GTAG_SNIPPET = `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${GA4_MEASUREMENT_ID}',{transport_type:'beacon'})</script>`;

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
    return '\n    <meta name="robots" content="index,follow">';
  }
  return '\n    <meta name="robots" content="noindex,follow">';
}
