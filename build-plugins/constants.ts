/**
 * Shared constants for Vite build plugins.
 *
 * BUILD_ID: timestamp injected as __BUILD_ID__ — used by BlogArticles
 * to detect stale caches.
 * COMMIT_HASH / SHORT_COMMIT_HASH: injected as __COMMIT_HASH__ /
 * __SHORT_COMMIT_HASH__ for the version badge and GitHub link.
 * BASE_URL: canonical site origin used across all static-page generators.
 */

import { execSync } from 'child_process';
import { BOT_UA_PATTERNS } from '../services/botPatterns';

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
export const SPA_ACTION_REDIRECT_SCRIPT = `<script>(function(){
 var p=new URLSearchParams(location.search);
 if(p.get('action')||p.get('at')||p.get('authToken')||p.get('newsletter_autologin')){
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
 ? '\n' + hreflangEntries.map(e => ` <link rel="alternate" hreflang="${e.hreflang}" href="${e.href}">`).join('\n')
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
 ${ANALYTICS_SNIPPET}
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
 <meta name="robots" content="noindex,follow">
 <link rel="canonical" href="${canonicalUrl}">${ogTags}
 ${ANALYTICS_SNIPPET}
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
export const GTAG_SNIPPET = `<script async crossorigin="anonymous" src="https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}"></script>
 <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${GA4_MEASUREMENT_ID}',{transport_type:'beacon'})</script>`;

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
export const POSTHOG_SNIPPET = `<script>
 !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags identify setPersonProperties group resetGroups reset opt_in_capturing opt_out_capturing".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
 posthog.init('${POSTHOG_KEY}',{api_host:'${POSTHOG_HOST}',capture_pageview:true,capture_pageleave:true,autocapture:false,persistence:'localStorage'});
</script>`;

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
 *  - a requestIdleCallback fallback that still loads the script after idle so
 *    Auto Ads (anchor, vignette, in-page) continue to earn on pages with no
 *    manual <ins> slots.
 */
export const ADSENSE_CLIENT_ID = 'ca-pub-8628054934855353';
export const ADSENSE_SCRIPT_SRC = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT_ID}`;

/**
 * Inline lazy-loader injected at the bottom of every static page (and also
 * emitted from index.html). Runs once per page and:
 *  0. Bot gate: if the UA matches a BOT_UA_PATTERNS substring or
 *     navigator.webdriver === true, the loader returns immediately. This is
 *     the static-HTML counterpart to `<AdSenseBanner>`'s SKIP_FOR_BOT and
 *     extends the bot filter to Auto Ads (Anchor / In-page / Vignette) which
 *     are injected by adsbygoogle.js itself, bypassing the React component.
 *     ~95% of revenue comes from those Auto Ads formats — without this gate,
 *     bots still triggered the script load and inflated AD_REQUESTS at near-
 *     zero RPM. See services/botPatterns.ts for the shared pattern source.
 *  1. Watches every <ins class="adsbygoogle"> with IntersectionObserver
 *     (rootMargin 200px) — on first visible slot, loads adsbygoogle.js.
 *  2. Falls back to requestIdleCallback (4s timeout) for pages without manual
 *     slots so Auto Ads still serve.
 *  3. On script load, pushes {} for every slot currently in the DOM.
 */
const BOT_PATTERNS_LITERAL = JSON.stringify(BOT_UA_PATTERNS);
export const ADSENSE_LAZY_LOADER = `<script>
(function(){
  var ua=(navigator.userAgent||'').toLowerCase();
  if(!ua||navigator.webdriver===true)return;
  var P=${BOT_PATTERNS_LITERAL};
  for(var k=0;k<P.length;k++)if(ua.indexOf(P[k])>=0)return;
  if(ua.indexOf('chrome')>=0&&!('chrome' in window))return;
  // Modern stealth signals — only fire on a UA claiming desktop Chrome.
  // Mirror the layered logic in services/adAnalytics.ts isLikelyBot().
  if(ua.indexOf('chrome')>=0&&ua.indexOf('mobile')<0){
    var L=navigator.languages;
    if(L&&L.length===0)return;
    if(navigator.plugins&&navigator.plugins.length===0)return;
    if(typeof navigator.permissions==='undefined')return;
  }
  var loaded=false;
  function loadScript(){
    if(loaded)return;loaded=true;
    var s=document.createElement('script');
    s.async=true;s.crossOrigin='anonymous';
    s.src='${ADSENSE_SCRIPT_SRC}';
    s.setAttribute('data-overlays','bottom');
    s.setAttribute('data-ad-frequency-hint','120s');
    s.onload=function(){
      var slots=document.querySelectorAll('ins.adsbygoogle:not([data-adsbygoogle-status])');
      for(var i=0;i<slots.length;i++){
        try{(window.adsbygoogle=window.adsbygoogle||[]).push({});}catch(e){}
      }
    };
    document.head.appendChild(s);
  }
  function observe(){
    var slots=document.querySelectorAll('ins.adsbygoogle');
    if(!('IntersectionObserver' in window)||slots.length===0){
      // No manual slots or old browser — still load for Auto Ads, but deferred.
      (window.requestIdleCallback||function(cb){return setTimeout(cb,2000);})(loadScript,{timeout:4000});
      return;
    }
    var io=new IntersectionObserver(function(entries){
      for(var i=0;i<entries.length;i++){
        if(entries[i].isIntersecting){io.disconnect();loadScript();return;}
      }
    },{rootMargin:'200px 0px'});
    for(var j=0;j<slots.length;j++)io.observe(slots[j]);
    // Always also schedule an idle fallback so Auto Ads can run even if no
    // manual slot ever enters the viewport (e.g. short pages above the fold).
    (window.requestIdleCallback||function(cb){return setTimeout(cb,3000);})(loadScript,{timeout:6000});
  }
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',observe,{once:true});
  }else{observe();}
})();
</script>`;

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
