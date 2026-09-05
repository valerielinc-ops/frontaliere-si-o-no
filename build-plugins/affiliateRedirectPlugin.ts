/**
 * Affiliate Redirect Plugin — /go/{partner} static redirect pages.
 *
 * Generates a lightweight redirect page for each affiliate partner.
 * Users land on /go/wise, /go/fineco, etc. and get redirected to the
 * partner URL with UTM tracking. The static page also contains a visible
 * fallback link, so the redirect works even with JS disabled.
 *
 * Pages are noindex (no SEO value, just a tracking intermediary).
 */
import path from 'node:path';
import type { Plugin } from 'vite';
import {
 PARTNERS,
 PUBREF_INVALID_RE,
 PUBREF_MAX_LEN,
 buildAffiliateUrl,
 isPartnerizeUrl,
 partnerRelAttr,
} from '../services/affiliateService';
import {
 ADSENSE_SNIPPET,
 BASE_URL,
 CF_BEACON_SNIPPET,
 GA4_MEASUREMENT_ID,
 GTAG_LOADER_SNIPPET,
 PARTNERIZE_TAG_SNIPPET,
 POSTHOG_SNIPPET,
 SEO_STATIC_CSS_LINK,
} from './constants';
import { WriteCollector } from './batchWrite';

/**
 * How long the redirect waits for the GA4 pageview beacon before firing
 * anyway. The shared `ANALYTICS_SNIPPET`/`GTAG_SNIPPET` load gtag.js `async`
 * and their config bootstrap `defer` (build-plugins/constants.ts), so a plain
 * `location.replace()` right after used to navigate away before either
 * script got a chance to run — the pageview never queued, let alone sent.
 * This bootstraps gtag inline and synchronously (queueing works regardless
 * of load order) and gates the redirect on the pageview's `event_callback`,
 * with this timeout as the ceiling so a blocked/slow/absent gtag.js never
 * delays a real user.
 *
 * This page deliberately uses `GTAG_LOADER_SNIPPET` (library only) instead of
 * the shared `GTAG_SNIPPET`/`ANALYTICS_SNIPPET`, which also queue a SECOND,
 * deferred `gtag('config', ...)` call (`gtag-init.js`) — a second config call
 * for the same measurement ID fires its own automatic page_view (config's
 * `send_page_view:false` isn't sticky across calls), which would double-count
 * every redirect on top of the explicit page_view below.
 */
const REDIRECT_TRACKING_TIMEOUT_MS = 400;

/**
 * Query parameter every surface may append to `/go/{partner}/` to declare WHICH
 * slot the click came from (`/go/wise/?pos=nl-partner-2`). The redirect turns it
 * into the Partnerize `pubref`, which is the per-position signal the dashboard
 * reports on. Without it the page falls back to the referring path, so surfaces
 * that don't (yet) pass `pos` still land in a distinguishable bucket instead of
 * collapsing into one undifferentiated count.
 */
const PLACEMENT_PARAM = 'pos';

function buildRedirectPage(partner: typeof PARTNERS[number]): string {
 const targetUrl = buildAffiliateUrl(partner, 'go-redirect');
 // Same normalisation as `sanitizePubref`, inlined because this snippet runs in
 // the browser with no bundler — the character class and the cap come from the
 // single definition in services/affiliateService.ts.
 const pubrefRewriteJs = isPartnerizeUrl(partner.url)
 ? `try{
var q=new URLSearchParams(location.search);
var raw=q.get(${JSON.stringify(PLACEMENT_PARAM)})||q.get('utm_content')||q.get('utm_campaign')||'';
if(!raw&&document.referrer){try{raw='ref-'+new URL(document.referrer).pathname;}catch(e){}}
var ref=String(raw).toLowerCase().replace(new RegExp(${JSON.stringify(PUBREF_INVALID_RE.source)},'g'),'-').replace(/^-+|-+$/g,'').slice(0,${PUBREF_MAX_LEN}).replace(/-+$/,'');
if(ref){var t=new URL(u);t.searchParams.set('pubref',ref);u=t.toString();var a=document.getElementById('go-link');if(a)a.setAttribute('href',u);}
}catch(e){}
`
 : '';
 const esc = (s: string) =>
 s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

 return `<!DOCTYPE html>
<html lang="it">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 <title>${esc(partner.name)} | Frontaliere Ticino</title>
 <meta name="robots" content="noindex,nofollow">
 <link rel="canonical" href="${BASE_URL}/go/${partner.id}/">
 ${SEO_STATIC_CSS_LINK}
 ${GTAG_LOADER_SNIPPET}
 ${CF_BEACON_SNIPPET}
 ${POSTHOG_SNIPPET}
 ${ADSENSE_SNIPPET}
 ${PARTNERIZE_TAG_SNIPPET}
 <script>(function(){
var u=${JSON.stringify(targetUrl)};
${pubrefRewriteJs}var redirected=false;
function go(){if(redirected)return;redirected=true;window.location.replace(u);}
window.dataLayer=window.dataLayer||[];
function gtag(){dataLayer.push(arguments)}
gtag('js',new Date());
gtag('config',${JSON.stringify(GA4_MEASUREMENT_ID)},{transport_type:'beacon',send_page_view:false});
gtag('event','page_view',{event_callback:go,event_timeout:${REDIRECT_TRACKING_TIMEOUT_MS}});
setTimeout(go,${REDIRECT_TRACKING_TIMEOUT_MS});
})();</script>
 </head>
 <body>
 <main class="s-9MsAg7">
 <p class="s-16ZGVZ">${partner.emoji}</p>
 <h1 class="s-0Ns7AE">Stai per visitare ${esc(partner.name)}</h1>
 <p class="s-a4vtCV">Verrai reindirizzato automaticamente. Se non succede, clicca il link qui sotto.</p>
 <p><a id="go-link" class="s-uJ0x5V" href="${esc(targetUrl)}" rel="${partnerRelAttr(partner)}">Vai a ${esc(partner.name)} &rarr;</a></p>
 </main>
 </body>
</html>`;
}

export function affiliateRedirectPlugin(rootDir: string): Plugin {
 return {
 name: 'affiliate-redirect-pages',
 apply: 'build',
 async closeBundle() {
 const distDir = path.resolve(rootDir, 'dist');
 const writer = new WriteCollector({ distDir, pluginName: 'affiliateRedirectPlugin' });

 // Disabled partners are dormant config (no surface links them) → no
 // redirect page. Flipping `enabled` re-emits /go/{id}/ on the next
 // build, before any surface can link it.
 for (const partner of PARTNERS.filter((p) => p.enabled)) {
 const html = buildRedirectPage(partner);
 const filePath = path.join(distDir, 'go', partner.id, 'index.html');
 writer.add(filePath, html);
 }

 const written = await writer.flush();
 console.log(` [affiliate-redirects] ${written} /go/{partner} redirect pages`);
 },
 };
}
